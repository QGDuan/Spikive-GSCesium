#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(projectRoot, "apps", "web");
const failures = [];

const webPackage = JSON.parse(await readFile(path.join(webRoot, "package.json"), "utf8"));
const patchVersionSource = await readFile(path.join(webRoot, "src", "cesium-patch-version.ts"), "utf8");
const viteConfigSource = await readFile(path.join(webRoot, "vite.config.ts"), "utf8");
if (!/CESIUM_GS_REVEAL_PATCH_VERSION\s*=\s*6\s*;/.test(patchVersionSource)) {
  failures.push("前端 Cesium GS 补丁版本未与 engine v6 扩展保持一致");
}
if (!viteConfigSource.includes(".vite-spikive-gs-v${CESIUM_GS_REVEAL_PATCH_VERSION}")) {
  failures.push("Vite 依赖优化缓存未绑定 Cesium GS 补丁版本，可能复用旧 Shader Bundle");
}
const declaredPackages = {
  ...(webPackage.dependencies ?? {}),
  ...(webPackage.devDependencies ?? {}),
  ...(webPackage.optionalDependencies ?? {})
};
for (const forbidden of ["three", "@lumaai/luma-web", "@react-three/fiber"]) {
  if (Object.hasOwn(declaredPackages, forbidden)) {
    failures.push(`前端不得声明第二渲染器依赖：${forbidden}`);
  }
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(absolute));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

for (const file of await collectSourceFiles(path.join(webRoot, "src"))) {
  const source = await readFile(file, "utf8");
  if (/\bfrom\s+["'](?:three|@lumaai\/luma-web|@react-three\/fiber)(?:\/[^"']*)?["']/.test(source)) {
    failures.push(`前端源码引入了第二渲染器：${path.relative(projectRoot, file)}`);
  }
  if (/\.getContext\(\s*["'](?:webgl2?|experimental-webgl)["']/.test(source)) {
    failures.push(`前端源码创建了额外 WebGL context：${path.relative(projectRoot, file)}`);
  }
}

const primitivePath = path.join(
  projectRoot,
  "node_modules",
  "@cesium",
  "engine",
  "Source",
  "Scene",
  "GaussianSplatPrimitive.js"
);
const primitiveSource = await readFile(primitivePath, "utf8");
const selectedCall = "shaderBuilder.addVertexLines(spikiveGaussianSplatVertexShader);";
const directBaselineCall = "shaderBuilder.addVertexLines(GaussianSplatVS);";
const count = (source, value) => source.split(value).length - 1;

if (count(primitiveSource, selectedCall) !== 1) {
  failures.push("Gaussian Primitive 必须且只能向 ShaderBuilder 提交一个阶段选择后的顶点 Shader");
}
if (count(primitiveSource, directBaselineCall) !== 0) {
  failures.push("Gaussian Primitive 同时提交了基线与阶段选择 Shader，存在重复渲染路径风险");
}
if (!primitiveSource.includes("? SPIKIVE_GS_REVEAL_VS\n    : GaussianSplatVS;")) {
  failures.push("Gaussian Primitive 缺少 Reveal/基线互斥选择器");
}

if (failures.length) {
  throw new Error(`Cesium GS 渲染架构检查失败：\n- ${failures.join("\n- ")}`);
}

console.log("Cesium GS 渲染架构检查通过：单一阶段 Shader 提交路径，无前端第二渲染器依赖或额外 WebGL context");
