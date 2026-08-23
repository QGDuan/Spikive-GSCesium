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
if (webDependencies.playcanvas !== "2.21.4") failures.push("PlayCanvas Renderer 必须精确锁定 playcanvas@2.21.4");
if (serverDependencies["@playcanvas/splat-transform"] !== "3.3.0") failures.push("SOG/碰撞转换器必须使用官方未修改的 @playcanvas/splat-transform@3.3.0");
if (Object.hasOwn(serverDependencies, "@manycore/aholo-splat-transform")) failures.push("PlayCanvas 主线不得继续生成 AHoLo 视觉产物");
if (Object.hasOwn(webDependencies, "@manycore/aholo-viewer")) failures.push("官方 PlayCanvas 主线不得声明 AHoLo Renderer 依赖");

for (const dependency of ["cesium", "@cesium/engine", "@cesium/widgets", "3dgs-ply-3dtiles-converter", "three", "@lumaai/luma-web", "@react-three/fiber"]) {
  if (Object.hasOwn(webDependencies, dependency) || Object.hasOwn(serverDependencies, dependency)) failures.push(`PlayCanvas-only 主线不得声明依赖：${dependency}`);
}
if (JSON.stringify(rootPackage.scripts ?? {}).toLowerCase().includes("cesium")) failures.push("根脚本仍包含 Cesium 构建或补丁链");

for (const file of await collectSourceFiles(path.join(projectRoot, "apps"))) {
  const source = await readFile(file, "utf8");
  if (/\bfrom\s+["'](?:cesium|@cesium\/[^"']*|three|@lumaai\/luma-web|@react-three\/fiber)(?:\/[^"']*)?["']/.test(source)) {
    failures.push(`源码引入了被排除的 Renderer：${path.relative(projectRoot, file)}`);
  }
  if (/\.getContext\(\s*["'](?:webgl2?|experimental-webgl)["']/.test(source)) failures.push(`源码绕过 PlayCanvas GraphicsDevice 创建了额外 WebGL context：${path.relative(projectRoot, file)}`);
}

const appSource = await readFile(path.join(webRoot, "src", "App.tsx"), "utf8");
const mainSource = await readFile(path.join(webRoot, "src", "main.tsx"), "utf8");
const sceneSource = await readFile(path.join(webRoot, "src", "PlayCanvasScene.tsx"), "utf8");
const workerSource = await readFile(path.join(projectRoot, "apps", "server", "src", "worker.ts"), "utf8");
if (!appSource.includes("<PlayCanvasScene") || appSource.includes("<AholoScene") || appSource.includes("CesiumScene")) failures.push("生产首页必须只挂载 PlayCanvasScene");
if (mainSource.includes("AholoScene") || mainSource.includes("CesiumScene")) failures.push("生产入口不得直接挂载回滚 Renderer");
if (JSON.stringify(rootPackage.scripts ?? {}).includes("patch:splat-transform") || JSON.stringify(rootPackage.scripts ?? {}).includes("postinstall")) failures.push("官方 splat-transform 基线不得安装本地补丁");
for (const setting of ["splatBudget =", "lodRangeMin =", "lodRangeMax =", "lodUnderfillLimit =", "minContribution =", "dataFormat ="]) {
  if (sceneSource.includes(setting)) failures.push(`PlayCanvas 原生 GS 基线不得写入运行时参数：${setting.trim()}`);
}
for (const option of ["--lod-chunk-count", "--lod-chunk-extent", "--lod-payload-format", "--lod-fine-format", "--rotate", "--scale"]) {
  if (workerSource.includes(option)) failures.push(`官方 Streamed SOG 构建不得附加视觉参数：${option}`);
}
if (!workerSource.includes('"--decimate", `${ratio * 100}%`') || !workerSource.includes('"--tag-lod", String(level)')) {
  failures.push("视觉构建必须使用官方 decimate + tag-lod Streamed SOG 流程");
}

if (failures.length) throw new Error(`PlayCanvas-only 渲染架构检查失败：\n- ${failures.join("\n- ")}`);
console.log("GS 渲染架构检查通过：生产首页仅使用一个 PlayCanvas GraphicsDevice/context");

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
