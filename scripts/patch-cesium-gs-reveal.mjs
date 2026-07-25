#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const engineRoot = path.join(projectRoot, "node_modules", "@cesium", "engine");
const packageJsonPath = path.join(engineRoot, "package.json");
const targetPath = path.join(engineRoot, "Source", "Scene", "GaussianSplatPrimitive.js");
const shaderPath = path.join(engineRoot, "Source", "Shaders", "PrimitiveGaussianSplatVS.glsl");
const snippetsRoot = path.join(projectRoot, "patches", "cesium-engine-26.1.0");
const expectedVersion = "26.1.0";
const marker = "SPIKIVE_GS_REVEAL_PATCH_BEGIN v6";
const version5Marker = "SPIKIVE_GS_REVEAL_PATCH_BEGIN v5";
const version4Marker = "SPIKIVE_GS_REVEAL_PATCH_BEGIN v4";
const version3Marker = "SPIKIVE_GS_REVEAL_PATCH_BEGIN v3";
const version2Marker = "SPIKIVE_GS_REVEAL_PATCH_BEGIN v2";
const legacyMarker = "SPIKIVE_GS_REVEAL_PATCH_BEGIN v1";

const requiredMarkers = [
  marker,
  "spikiveGaussianSplatRevealSupported = 1",
  "spikiveGaussianSplatRevealPatchVersion = 6",
  "spikiveGaussianSplatRevealShaderActive =",
  "u_spikiveRevealCenter",
  "SPIKIVE_GS_REVEAL_CULL_ANCHOR",
  "spikiveMajorLength",
  "u_spikiveScaleProgress",
  "spikiveRadialSolid",
  "spikiveScaleProgress",
  "u_spikiveSeedAlpha",
  "spikiveScaleAlphaProgress",
  "mix(spikiveRevealAlpha, spikiveSolid, 0.70)",
  "spikiveAdjustedAlpha",
  "_spikiveRetiredDrawResources",
  "releaseSpikiveGaussianDrawResources(this, frameState.frameNumber)",
  "retireSpikiveGaussianDrawResources(",
  "spikivePreviousDrawCommand",
  "spikiveRevealState.enabled = false",
  "spikiveGaussianSplatVertexShader",
  "synchronizeSpikiveGaussianRevealShader(this, frameState)"
];

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
if (packageJson.version !== expectedVersion) {
  throw new Error(
    `Cesium GS Reveal 补丁仅支持 @cesium/engine ${expectedVersion}，当前为 ${packageJson.version}；请先重新审计 GaussianSplatPrimitive`,
  );
}

let source = await readFile(targetPath, "utf8");
const replaceOnce = (input, anchor, replacement, label) => {
  const first = input.indexOf(anchor);
  const last = input.lastIndexOf(anchor);
  if (first < 0 || first !== last) {
    throw new Error(`Cesium 源码锚点 ${label} 数量异常，拒绝应用补丁`);
  }
  return input.replace(anchor, replacement);
};

const constantsAnchor = "const UNIT_SCALE_FAST_PATH_EPSILON = 1e-7;\n";
const tilesetAnchor = "  this._tileset = options.tileset;\n";
const uniformMapAnchor = "  const uniformMap = renderResources.uniformMap;\n";
const vertexShaderAnchor = "  shaderBuilder.addVertexLines(GaussianSplatVS);";
const patchedVertexShaderAnchor = "  shaderBuilder.addVertexLines(spikiveGaussianSplatVertexShader);";
const updateAnchor = `  if (!tileset.show) {
    return;
  }

`;

if (source.includes(version5Marker)) {
  if (process.argv.includes("--check")) {
    throw new Error("检测到 Cesium GS Reveal v5，请运行 npm run patch:cesium 升级到 v6");
  }

  const version5End = "// SPIKIVE_GS_REVEAL_PATCH_END v5";
  const helpersStart = source.indexOf(`// ${version5Marker}`);
  const helpersEnd = source.indexOf(version5End);
  if (helpersStart < 0 || helpersEnd < helpersStart) {
    throw new Error("Cesium GS Reveal v5 helper 边界异常，拒绝自动升级");
  }
  source = source.slice(0, helpersStart) + source.slice(helpersEnd + version5End.length);

  const version5Constructor = `  // Public extension seam owned by Spikive. The application writes reveal
  // uniforms to the tileset and never reaches into this private primitive.
  this._tileset.spikiveGaussianSplatRevealSupported = 1;
  this._tileset.spikiveGaussianSplatRevealPatchVersion = 5;
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._spikiveRevealShaderEnabled = false;
  this._spikiveRetiredDrawResources = [];
`;
  const version5Build = `  const spikiveGaussianRevealEnabled =
    isSpikiveGaussianRevealEnabled(primitive._tileset);
  const spikiveGaussianSplatVertexShader = spikiveGaussianRevealEnabled
    ? SPIKIVE_GS_REVEAL_VS
    : GaussianSplatVS;
  if (spikiveGaussianRevealEnabled) {
    addSpikiveGaussianRevealShaderResources(
      primitive,
      shaderBuilder,
      uniformMap,
    );
  }
  primitive._spikiveRevealShaderEnabled = spikiveGaussianRevealEnabled;
`;
  const version5BuildFunction = `GaussianSplatPrimitive.buildGSplatDrawCommand = function (
  primitive,
  frameState,
) {
`;
  const version5BuildStart = `  const spikivePreviousDrawCommand = primitive._drawCommand;
  const spikivePreviousVertexArray = primitive._vertexArray;
`;
  const version5Command = `  // This flag is diagnostic and lifecycle-facing. It becomes true only after
  // the reveal draw command was built successfully, and false after baseline
  // rebuild or primitive destruction.
  primitive._tileset.spikiveGaussianSplatRevealShaderActive =
    primitive._spikiveRevealShaderEnabled;
  retireSpikiveGaussianDrawResources(
    primitive,
    frameState.frameNumber,
    spikivePreviousDrawCommand,
    spikivePreviousVertexArray !== primitive._vertexArray
      ? spikivePreviousVertexArray
      : undefined,
  );
`;
  const version5Commit = `  retireSpikiveGaussianDrawResources(
    primitive,
    frameNumber,
    primitive._drawCommand,
    primitive._vertexArray,
  );
`;
  const version5Destroy = `  const spikiveRevealState = this._tileset.spikiveGaussianSplatReveal;
  if (defined(spikiveRevealState)) {
    spikiveRevealState.enabled = false;
  }
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._tileset.spikiveGaussianSplatRevealSupported = 0;
  this._tileset.spikiveGaussianSplatReveal = undefined;

  if (defined(this._spikiveRetiredDrawResources)) {
    for (let i = 0; i < this._spikiveRetiredDrawResources.length; i++) {
      const entry = this._spikiveRetiredDrawResources[i];
      if (defined(entry.shaderProgram)) {
        entry.shaderProgram.destroy();
      }
      if (defined(entry.vertexArray)) {
        entry.vertexArray.destroy();
      }
    }
  }
  this._spikiveRetiredDrawResources = [];
`;
  const version5Release = "  releaseSpikiveGaussianDrawResources(this, frameState.frameNumber);\n";
  const version5Update = "  synchronizeSpikiveGaussianRevealShader(this, frameState);\n";
  const commandAnchor = "  primitive._drawCommand = command;\n";
  const commitAnchor = "  primitive._vertexArray = undefined;\n";
  const destroyAnchor = "  const drawCommand = this._drawCommand;\n";
  const releaseAnchor = "  releaseRetiredTextures(this, frameState.frameNumber);\n";

  source = replaceOnce(source, `${tilesetAnchor}${version5Constructor}`, tilesetAnchor, "v5-constructor");
  source = replaceOnce(source, `${uniformMapAnchor}\n${version5Build}`, uniformMapAnchor, "v5-build");
  source = replaceOnce(source, `${version5BuildFunction}${version5BuildStart}`, version5BuildFunction, "v5-build-start");
  source = replaceOnce(source, patchedVertexShaderAnchor, vertexShaderAnchor, "v5-vertex-shader");
  source = replaceOnce(source, `${commandAnchor}${version5Command}`, commandAnchor, "v5-command");
  source = replaceOnce(source, `${version5Commit}${commitAnchor}`, commitAnchor, "v5-commit");
  source = replaceOnce(source, `${version5Destroy}\n${destroyAnchor}`, destroyAnchor, "v5-destroy");
  source = replaceOnce(source, `${releaseAnchor}${version5Release}`, releaseAnchor, "v5-release");
  source = replaceOnce(source, `${updateAnchor}${version5Update}`, updateAnchor, "v5-update");
  console.log("正在将 Cesium GS Reveal v5 升级到 v6");
}

if (source.includes(version4Marker)) {
  if (process.argv.includes("--check")) {
    throw new Error("检测到 Cesium GS Reveal v4，请运行 npm run patch:cesium 升级到 v6");
  }

  const version4End = "// SPIKIVE_GS_REVEAL_PATCH_END v4";
  const helpersStart = source.indexOf(`// ${version4Marker}`);
  const helpersEnd = source.indexOf(version4End);
  if (helpersStart < 0 || helpersEnd < helpersStart) {
    throw new Error("Cesium GS Reveal v4 helper 边界异常，拒绝自动升级");
  }
  source = source.slice(0, helpersStart) + source.slice(helpersEnd + version4End.length);

  const version4Constructor = `  // Public extension seam owned by Spikive. The application writes reveal
  // uniforms to the tileset and never reaches into this private primitive.
  this._tileset.spikiveGaussianSplatRevealSupported = 1;
  this._tileset.spikiveGaussianSplatRevealPatchVersion = 4;
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._spikiveRevealShaderEnabled = false;
  this._spikiveRetiredDrawResources = [];
`;
  const version4Build = `  const spikiveGaussianRevealEnabled =
    isSpikiveGaussianRevealEnabled(primitive._tileset);
  const spikiveGaussianSplatVertexShader = spikiveGaussianRevealEnabled
    ? SPIKIVE_GS_REVEAL_VS
    : GaussianSplatVS;
  if (spikiveGaussianRevealEnabled) {
    addSpikiveGaussianRevealShaderResources(
      primitive,
      shaderBuilder,
      uniformMap,
    );
  }
  primitive._spikiveRevealShaderEnabled = spikiveGaussianRevealEnabled;
`;
  const version4BuildFunction = `GaussianSplatPrimitive.buildGSplatDrawCommand = function (
  primitive,
  frameState,
) {
`;
  const version4BuildStart = `  const spikivePreviousDrawCommand = primitive._drawCommand;
  const spikivePreviousVertexArray = primitive._vertexArray;
`;
  const version4Command = `  // This flag is diagnostic and lifecycle-facing. It becomes true only after
  // the reveal draw command was built successfully, and false after baseline
  // rebuild or primitive destruction.
  primitive._tileset.spikiveGaussianSplatRevealShaderActive =
    primitive._spikiveRevealShaderEnabled;
  retireSpikiveGaussianDrawResources(
    primitive,
    frameState.frameNumber,
    spikivePreviousDrawCommand,
    spikivePreviousVertexArray !== primitive._vertexArray
      ? spikivePreviousVertexArray
      : undefined,
  );
`;
  const version4Commit = `  retireSpikiveGaussianDrawResources(
    primitive,
    frameNumber,
    primitive._drawCommand,
    primitive._vertexArray,
  );
`;
  const version4Destroy = `  const spikiveRevealState = this._tileset.spikiveGaussianSplatReveal;
  if (defined(spikiveRevealState)) {
    spikiveRevealState.enabled = false;
  }
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._tileset.spikiveGaussianSplatRevealSupported = 0;
  this._tileset.spikiveGaussianSplatReveal = undefined;

  if (defined(this._spikiveRetiredDrawResources)) {
    for (let i = 0; i < this._spikiveRetiredDrawResources.length; i++) {
      const entry = this._spikiveRetiredDrawResources[i];
      if (defined(entry.shaderProgram)) {
        entry.shaderProgram.destroy();
      }
      if (defined(entry.vertexArray)) {
        entry.vertexArray.destroy();
      }
    }
  }
  this._spikiveRetiredDrawResources = [];
`;
  const version4Release = "  releaseSpikiveGaussianDrawResources(this, frameState.frameNumber);\n";
  const version4Update = "  synchronizeSpikiveGaussianRevealShader(this, frameState);\n";
  const commandAnchor = "  primitive._drawCommand = command;\n";
  const commitAnchor = "  primitive._vertexArray = undefined;\n";
  const destroyAnchor = "  const drawCommand = this._drawCommand;\n";
  const releaseAnchor = "  releaseRetiredTextures(this, frameState.frameNumber);\n";

  source = replaceOnce(source, `${tilesetAnchor}${version4Constructor}`, tilesetAnchor, "v4-constructor");
  source = replaceOnce(source, `${uniformMapAnchor}\n${version4Build}`, uniformMapAnchor, "v4-build");
  source = replaceOnce(source, `${version4BuildFunction}${version4BuildStart}`, version4BuildFunction, "v4-build-start");
  source = replaceOnce(source, patchedVertexShaderAnchor, vertexShaderAnchor, "v4-vertex-shader");
  source = replaceOnce(source, `${commandAnchor}${version4Command}`, commandAnchor, "v4-command");
  source = replaceOnce(source, `${version4Commit}${commitAnchor}`, commitAnchor, "v4-commit");
  source = replaceOnce(source, `${version4Destroy}\n${destroyAnchor}`, destroyAnchor, "v4-destroy");
  source = replaceOnce(source, `${releaseAnchor}${version4Release}`, releaseAnchor, "v4-release");
  source = replaceOnce(source, `${updateAnchor}${version4Update}`, updateAnchor, "v4-update");
  console.log("正在将 Cesium GS Reveal v4 升级到 v6");
}

if (source.includes(version3Marker)) {
  if (process.argv.includes("--check")) {
    throw new Error("检测到 Cesium GS Reveal v3，请运行 npm run patch:cesium 升级到 v6");
  }

  const version3End = "// SPIKIVE_GS_REVEAL_PATCH_END v3";
  const helpersStart = source.indexOf(`// ${version3Marker}`);
  const helpersEnd = source.indexOf(version3End);
  if (helpersStart < 0 || helpersEnd < helpersStart) {
    throw new Error("Cesium GS Reveal v3 helper 边界异常，拒绝自动升级");
  }
  source = source.slice(0, helpersStart) + source.slice(helpersEnd + version3End.length);

  const version3Constructor = `  // Public extension seam owned by Spikive. The application writes reveal
  // uniforms to the tileset and never reaches into this private primitive.
  this._tileset.spikiveGaussianSplatRevealSupported = 1;
  this._tileset.spikiveGaussianSplatRevealPatchVersion = 3;
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._spikiveRevealShaderEnabled = false;
  this._spikiveRetiredDrawResources = [];
`;
  const version3Build = `  const spikiveGaussianRevealEnabled =
    isSpikiveGaussianRevealEnabled(primitive._tileset);
  const spikiveGaussianSplatVertexShader = spikiveGaussianRevealEnabled
    ? SPIKIVE_GS_REVEAL_VS
    : GaussianSplatVS;
  if (spikiveGaussianRevealEnabled) {
    addSpikiveGaussianRevealShaderResources(
      primitive,
      shaderBuilder,
      uniformMap,
    );
  }
  primitive._spikiveRevealShaderEnabled = spikiveGaussianRevealEnabled;
`;
  const version3BuildFunction = `GaussianSplatPrimitive.buildGSplatDrawCommand = function (
  primitive,
  frameState,
) {
`;
  const version3BuildStart = `  const spikivePreviousDrawCommand = primitive._drawCommand;
  const spikivePreviousVertexArray = primitive._vertexArray;
`;
  const version3Command = `  // This flag is diagnostic and lifecycle-facing. It becomes true only after
  // the reveal draw command was built successfully, and false after baseline
  // rebuild or primitive destruction.
  primitive._tileset.spikiveGaussianSplatRevealShaderActive =
    primitive._spikiveRevealShaderEnabled;
  retireSpikiveGaussianDrawResources(
    primitive,
    frameState.frameNumber,
    spikivePreviousDrawCommand,
    spikivePreviousVertexArray !== primitive._vertexArray
      ? spikivePreviousVertexArray
      : undefined,
  );
`;
  const version3Commit = `  retireSpikiveGaussianDrawResources(
    primitive,
    frameNumber,
    primitive._drawCommand,
    primitive._vertexArray,
  );
`;
  const version3Destroy = `  const spikiveRevealState = this._tileset.spikiveGaussianSplatReveal;
  if (defined(spikiveRevealState)) {
    spikiveRevealState.enabled = false;
  }
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._tileset.spikiveGaussianSplatRevealSupported = 0;
  this._tileset.spikiveGaussianSplatReveal = undefined;

  if (defined(this._spikiveRetiredDrawResources)) {
    for (let i = 0; i < this._spikiveRetiredDrawResources.length; i++) {
      const entry = this._spikiveRetiredDrawResources[i];
      if (defined(entry.shaderProgram)) {
        entry.shaderProgram.destroy();
      }
      if (defined(entry.vertexArray)) {
        entry.vertexArray.destroy();
      }
    }
  }
  this._spikiveRetiredDrawResources = [];
`;
  const version3Release = "  releaseSpikiveGaussianDrawResources(this, frameState.frameNumber);\n";
  const version3Update = "  synchronizeSpikiveGaussianRevealShader(this, frameState);\n";
  const commandAnchor = "  primitive._drawCommand = command;\n";
  const commitAnchor = "  primitive._vertexArray = undefined;\n";
  const destroyAnchor = "  const drawCommand = this._drawCommand;\n";
  const releaseAnchor = "  releaseRetiredTextures(this, frameState.frameNumber);\n";

  source = replaceOnce(source, `${tilesetAnchor}${version3Constructor}`, tilesetAnchor, "v3-constructor");
  source = replaceOnce(source, `${uniformMapAnchor}\n${version3Build}`, uniformMapAnchor, "v3-build");
  source = replaceOnce(source, `${version3BuildFunction}${version3BuildStart}`, version3BuildFunction, "v3-build-start");
  source = replaceOnce(source, patchedVertexShaderAnchor, vertexShaderAnchor, "v3-vertex-shader");
  source = replaceOnce(source, `${commandAnchor}${version3Command}`, commandAnchor, "v3-command");
  source = replaceOnce(source, `${version3Commit}${commitAnchor}`, commitAnchor, "v3-commit");
  source = replaceOnce(source, `${version3Destroy}\n${destroyAnchor}`, destroyAnchor, "v3-destroy");
  source = replaceOnce(source, `${releaseAnchor}${version3Release}`, releaseAnchor, "v3-release");
  source = replaceOnce(source, `${updateAnchor}${version3Update}`, updateAnchor, "v3-update");
  console.log("正在将 Cesium GS Reveal v3 升级到 v6");
}

if (source.includes(version2Marker)) {
  if (process.argv.includes("--check")) {
    throw new Error("检测到 Cesium GS Reveal v2，请运行 npm run patch:cesium 升级到 v6");
  }

  const version2End = "// SPIKIVE_GS_REVEAL_PATCH_END v2";
  const helpersStart = source.indexOf(`// ${version2Marker}`);
  const helpersEnd = source.indexOf(version2End);
  if (helpersStart < 0 || helpersEnd < helpersStart) {
    throw new Error("Cesium GS Reveal v2 helper 边界异常，拒绝自动升级");
  }
  source = source.slice(0, helpersStart) + source.slice(helpersEnd + version2End.length);

  const version2Constructor = `  // Public extension seam owned by Spikive. The application writes reveal
  // uniforms to the tileset and never reaches into this private primitive.
  this._tileset.spikiveGaussianSplatRevealSupported = 1;
  this._tileset.spikiveGaussianSplatRevealPatchVersion = 2;
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._spikiveRevealShaderEnabled = false;
`;
  const version2Build = `  const spikiveGaussianRevealEnabled =
    isSpikiveGaussianRevealEnabled(primitive._tileset);
  const spikiveGaussianSplatVertexShader = spikiveGaussianRevealEnabled
    ? SPIKIVE_GS_REVEAL_VS
    : GaussianSplatVS;
  if (spikiveGaussianRevealEnabled) {
    addSpikiveGaussianRevealShaderResources(
      primitive,
      shaderBuilder,
      uniformMap,
    );
  }
  primitive._spikiveRevealShaderEnabled = spikiveGaussianRevealEnabled;
`;
  const version2Command = `  // This flag is diagnostic and lifecycle-facing. It becomes true only after
  // the reveal draw command was built successfully, and false after baseline
  // rebuild or primitive destruction.
  primitive._tileset.spikiveGaussianSplatRevealShaderActive =
    primitive._spikiveRevealShaderEnabled;
`;
  const version2Destroy = `  const spikiveRevealState = this._tileset.spikiveGaussianSplatReveal;
  if (defined(spikiveRevealState)) {
    spikiveRevealState.enabled = false;
  }
  this._tileset.spikiveGaussianSplatRevealShaderActive = false;
  this._tileset.spikiveGaussianSplatRevealSupported = 0;
  this._tileset.spikiveGaussianSplatReveal = undefined;
`;
  const version2Update = "  synchronizeSpikiveGaussianRevealShader(this, frameState);\n";
  const destroyAnchor = "  const drawCommand = this._drawCommand;\n";

  source = replaceOnce(source, `${tilesetAnchor}${version2Constructor}`, tilesetAnchor, "v2-constructor");
  source = replaceOnce(source, `${uniformMapAnchor}\n${version2Build}`, uniformMapAnchor, "v2-build");
  source = replaceOnce(source, patchedVertexShaderAnchor, vertexShaderAnchor, "v2-vertex-shader");
  source = replaceOnce(source, `  primitive._drawCommand = command;\n${version2Command}`, "  primitive._drawCommand = command;\n", "v2-command");
  source = replaceOnce(source, `${version2Destroy}\n${destroyAnchor}`, destroyAnchor, "v2-destroy");
  source = replaceOnce(source, `${updateAnchor}${version2Update}`, updateAnchor, "v2-update");
  console.log("正在将 Cesium GS Reveal v2 升级到 v6");
}

if (source.includes(legacyMarker)) {
  if (process.argv.includes("--check")) {
    throw new Error("检测到 Cesium GS Reveal v1，请运行 npm run patch:cesium 升级到 v6");
  }

  const legacyEnd = "// SPIKIVE_GS_REVEAL_PATCH_END v1";
  const helpersStart = source.indexOf(`// ${legacyMarker}`);
  const helpersEnd = source.indexOf(legacyEnd);
  if (helpersStart < 0 || helpersEnd < helpersStart) {
    throw new Error("Cesium GS Reveal v1 helper 边界异常，拒绝自动升级");
  }
  source = source.slice(0, helpersStart) + source.slice(helpersEnd + legacyEnd.length);

  const legacyConstructor = `  // Public extension seam owned by Spikive. The application writes reveal
  // uniforms to the tileset and never reaches into this private primitive.
  this._tileset.spikiveGaussianSplatRevealSupported = 1;
  this._spikiveRevealShaderEnabled = false;
`;
  const legacyBuild = `  const spikiveGaussianRevealEnabled =
    isSpikiveGaussianRevealEnabled(primitive._tileset);
  const spikiveGaussianSplatVertexShader = spikiveGaussianRevealEnabled
    ? SPIKIVE_GS_REVEAL_VS
    : GaussianSplatVS;
  if (spikiveGaussianRevealEnabled) {
    addSpikiveGaussianRevealShaderResources(
      primitive,
      shaderBuilder,
      uniformMap,
    );
  }
  primitive._spikiveRevealShaderEnabled = spikiveGaussianRevealEnabled;
`;
  const legacyUpdate = "  synchronizeSpikiveGaussianRevealShader(this, frameState);\n";
  source = replaceOnce(source, `${tilesetAnchor}${legacyConstructor}`, tilesetAnchor, "legacy-constructor");
  source = replaceOnce(source, `${uniformMapAnchor}\n${legacyBuild}`, uniformMapAnchor, "legacy-build");
  source = replaceOnce(source, patchedVertexShaderAnchor, vertexShaderAnchor, "legacy-vertex-shader");
  source = replaceOnce(source, `${updateAnchor}${legacyUpdate}`, updateAnchor, "legacy-update");
  console.log("正在将 Cesium GS Reveal v1 升级到 v6");
}

const shaderSource = await readFile(shaderPath, "utf8");
const shaderAnchors = [
  "if (dot(covVectors.xy, covVectors.xy) < 4.0 && dot(covVectors.zw, covVectors.zw) < 4.0)",
  "v_splatColor = vec4(covariance.w & 0xffu"
];
const missingShaderAnchors = shaderAnchors.filter(value => !shaderSource.includes(value));
if (missingShaderAnchors.length) {
  throw new Error("Cesium Gaussian 顶点着色器结构已变化，拒绝应用 Reveal 补丁；请重新审计该版本");
}
const verifyPatched = () => {
  const missing = requiredMarkers.filter(value => !source.includes(value));
  if (missing.length) throw new Error(`Cesium GS Reveal 补丁不完整：${missing.join(", ")}`);
  const selectedShaderCallCount = source.split(patchedVertexShaderAnchor).length - 1;
  const directBaselineCallCount = source.split(vertexShaderAnchor).length - 1;
  if (selectedShaderCallCount !== 1 || directBaselineCallCount !== 0) {
    throw new Error("Cesium Gaussian Primitive 必须且只能提交一个 Reveal/基线阶段选择后的 Shader");
  }
  const helpersEnd = source.indexOf("// SPIKIVE_GS_REVEAL_PATCH_END v6");
  const helpersStart = source.indexOf(`// ${marker}`);
  const helperSource = source.slice(helpersStart, helpersEnd);
  if (helperSource.includes("if (spikiveRevealAlpha <= 0.001)")) {
    throw new Error("Cesium GS Reveal v6 仍在按半径剔除外围种子，拒绝继续");
  }
};

if (source.includes(marker)) {
  verifyPatched();
  console.log(`Cesium GS Reveal 补丁已就绪（engine ${expectedVersion}）`);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  throw new Error("Cesium GS Reveal 补丁尚未应用");
}

const [
  helpers,
  constructorPatch,
  buildStartPatch,
  buildPatch,
  commandPatch,
  commitPatch,
  destroyPatch,
  releasePatch,
  updatePatch,
] = await Promise.all([
  "spikive-gs-reveal.helpers.js.txt",
  "spikive-gs-reveal.constructor.js.txt",
  "spikive-gs-reveal.build-start.js.txt",
  "spikive-gs-reveal.build.js.txt",
  "spikive-gs-reveal.command.js.txt",
  "spikive-gs-reveal.commit.js.txt",
  "spikive-gs-reveal.destroy.js.txt",
  "spikive-gs-reveal.release.js.txt",
  "spikive-gs-reveal.update.js.txt"
].map(filename => readFile(path.join(snippetsRoot, filename), "utf8")));

source = replaceOnce(source, constantsAnchor, `${constantsAnchor}\n${helpers}\n`, "constants");

source = replaceOnce(source, tilesetAnchor, `${tilesetAnchor}${constructorPatch}`, "constructor");

source = replaceOnce(source, uniformMapAnchor, `${uniformMapAnchor}\n${buildPatch}`, "uniform-map");

const buildFunctionAnchor = `GaussianSplatPrimitive.buildGSplatDrawCommand = function (
  primitive,
  frameState,
) {
`;
source = replaceOnce(
  source,
  buildFunctionAnchor,
  `${buildFunctionAnchor}${buildStartPatch}`,
  "build-start",
);

source = replaceOnce(
  source,
  vertexShaderAnchor,
  patchedVertexShaderAnchor,
  "vertex-shader",
);

const commandAnchor = "  primitive._drawCommand = command;\n";
source = replaceOnce(source, commandAnchor, `${commandAnchor}${commandPatch}`, "command-built");

const commitAnchor = "  primitive._vertexArray = undefined;\n";
source = replaceOnce(source, commitAnchor, `${commitPatch}${commitAnchor}`, "snapshot-commit");

const destroyAnchor = "  const drawCommand = this._drawCommand;\n";
source = replaceOnce(source, destroyAnchor, `${destroyPatch}\n${destroyAnchor}`, "destroy");

const releaseAnchor = "  releaseRetiredTextures(this, frameState.frameNumber);\n";
source = replaceOnce(source, releaseAnchor, `${releaseAnchor}${releasePatch}`, "resource-release");

source = replaceOnce(source, updateAnchor, `${updateAnchor}${updatePatch}`, "update");

const temporaryPath = `${targetPath}.spikive-tmp`;
await writeFile(temporaryPath, source);
await rename(temporaryPath, targetPath);
verifyPatched();
console.log(`已应用 Cesium GS Reveal 补丁（engine ${expectedVersion}）`);
