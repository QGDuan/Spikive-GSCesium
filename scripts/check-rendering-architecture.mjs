#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const webRoot = path.join(projectRoot, "apps", "web");
const failures = [];
const [rootPackage, webPackage, serverPackage] = await Promise.all([
  readJson(path.join(projectRoot, "package.json")),
  readJson(path.join(webRoot, "package.json")),
  readJson(path.join(projectRoot, "apps", "server", "package.json"))
]);

const webDependencies = allDependencies(webPackage);
const serverDependencies = allDependencies(serverPackage);
if (webDependencies["@manycore/aholo-viewer"] !== "1.8.1") failures.push("AHoLo Renderer 必须精确锁定 @manycore/aholo-viewer@1.8.1");
if (serverDependencies["@manycore/aholo-splat-transform"] !== "1.7.4") failures.push("AHoLo 转换器必须精确锁定 @manycore/aholo-splat-transform@1.7.4");

for (const dependency of ["cesium", "@cesium/engine", "@cesium/widgets", "3dgs-ply-3dtiles-converter", "three", "@lumaai/luma-web", "@react-three/fiber"]) {
  if (Object.hasOwn(webDependencies, dependency) || Object.hasOwn(serverDependencies, dependency)) failures.push(`AHoLo-only 主线不得声明依赖：${dependency}`);
}
if (JSON.stringify(rootPackage.scripts ?? {}).toLowerCase().includes("cesium")) failures.push("根脚本仍包含 Cesium 构建或补丁链");

for (const file of await collectSourceFiles(path.join(projectRoot, "apps"))) {
  const source = await readFile(file, "utf8");
  if (/\bfrom\s+["'](?:cesium|@cesium\/[^"']*|three|@lumaai\/luma-web|@react-three\/fiber)(?:\/[^"']*)?["']/.test(source)) {
    failures.push(`源码引入了非 AHoLo Renderer：${path.relative(projectRoot, file)}`);
  }
  if (/\.getContext\(\s*["'](?:webgl2?|experimental-webgl)["']/.test(source)) failures.push(`源码绕过 AHoLo 创建了额外 WebGL context：${path.relative(projectRoot, file)}`);
}

const appSource = await readFile(path.join(webRoot, "src", "App.tsx"), "utf8");
const mainSource = await readFile(path.join(webRoot, "src", "main.tsx"), "utf8");
if (!appSource.includes("<AholoScene") || appSource.includes("CesiumScene") || appSource.includes("visualBackend")) failures.push("生产首页必须只挂载 AHoLoScene");
if (mainSource.includes("RendererLabApp") || mainSource.includes("renderer-lab")) failures.push("AHoLo-only 主线不得保留候选 Renderer Lab 入口");

if (failures.length) throw new Error(`AHoLo-only 渲染架构检查失败：\n- ${failures.join("\n- ")}`);
console.log("GS 渲染架构检查通过：生产首页仅使用一个 AHoLo Viewer/WebGL context");

function allDependencies(packageJson) {
  return { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}), ...(packageJson.optionalDependencies ?? {}) };
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ["node_modules", "dist"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(absolute));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}
