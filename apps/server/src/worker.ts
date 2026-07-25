import { spawn } from "node:child_process";
import { cp, mkdir, open, rename, rm, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type { Dataset } from "@spikive/shared";
import { Database } from "./db.js";
import { config } from "./config.js";
import { CollisionRepository } from "./collision.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules");
const tilerCli = path.join(packageRoot, "3dgs-ply-3dtiles-converter/bin/3dgs-ply-3dtiles-converter.js");
const splatCli = path.join(packageRoot, "@playcanvas/splat-transform/bin/cli.mjs");

/** Fixed high-definition policy. Depth remains count-adaptive instead of forcing a global layer count. */
export const GS_LOD_POLICY = Object.freeze({
  maxLeafSplats: 25_000,
  minLeafSplats: 2_500,
  samplingRatePerLevel: 0.5,
  lodMultiplier: "max",
  coverageBoostScale: 0.8,
  opacityFilter: 0.05,
  geometricErrorLayerMultiplier: 1,
  geometricErrorScale: 1,
  boundsMode: "aabb"
} as const);

/** Guidance is advisory only: collision fidelity parameters are never changed without an operator retry. */
export const COLLISION_VOXEL_GUIDANCE = Object.freeze({
  targetMutableGridMiB: 640,
  minimumGrowthFactor: 1.25,
  maximumVoxelSize: 2,
  resolutionStep: 0.001
} as const);

export function isCollisionMutableGridLimit(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Voxel mutation would require approximately\s+[\d.]+[KMG]?\s+MiB/i.test(message)
    || /Voxel mutation requires .*exceeding the 32-bit mutable-grid limit/i.test(message);
}

export function recommendedCollisionVoxelSize(error: unknown, currentVoxelSize: number): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const memoryLimit = /Voxel mutation would require approximately\s+([\d.]+)([KMG]?)\s+MiB/i.exec(message);
  const addressLimit = /Voxel mutation requires .*exceeding the 32-bit mutable-grid limit/i.test(message);
  if (!memoryLimit && !addressLimit) return null;

  let growthFactor = 2;
  if (memoryLimit) {
    const suffixMultiplier = memoryLimit[2]?.toUpperCase() === "G" ? 1_000_000_000
      : memoryLimit[2]?.toUpperCase() === "M" ? 1_000_000
        : memoryLimit[2]?.toUpperCase() === "K" ? 1_000 : 1;
    const estimatedMiB = Number(memoryLimit[1]) * suffixMultiplier;
    if (Number.isFinite(estimatedMiB)) {
      growthFactor = Math.max(
        COLLISION_VOXEL_GUIDANCE.minimumGrowthFactor,
        Math.cbrt(estimatedMiB / COLLISION_VOXEL_GUIDANCE.targetMutableGridMiB) * 1.05
      );
    }
  }
  const next = Math.ceil(currentVoxelSize * growthFactor / COLLISION_VOXEL_GUIDANCE.resolutionStep)
    * COLLISION_VOXEL_GUIDANCE.resolutionStep;
  if (next <= currentVoxelSize || next > COLLISION_VOXEL_GUIDANCE.maximumVoxelSize) return null;
  return Number(next.toFixed(3));
}

export function calculateGsLodDepth(effectiveSplatCount: number) {
  if (!Number.isFinite(effectiveSplatCount) || effectiveSplatCount <= GS_LOD_POLICY.maxLeafSplats) return 0;
  return Math.ceil(Math.log(GS_LOD_POLICY.maxLeafSplats / effectiveSplatCount) / Math.log(GS_LOD_POLICY.samplingRatePerLevel));
}

export function fixedGsTilerArguments() {
  return [
    "--max-leaf-limit", String(GS_LOD_POLICY.maxLeafSplats),
    "--min-leaf-limit", String(GS_LOD_POLICY.minLeafSplats),
    "--sampling-rate-per-level", String(GS_LOD_POLICY.samplingRatePerLevel),
    "--lod-multiplier", GS_LOD_POLICY.lodMultiplier,
    "--coverage-boost-scale", String(GS_LOD_POLICY.coverageBoostScale),
    "--opacity-filter", String(GS_LOD_POLICY.opacityFilter),
    "--geometric-error-layer-multiplier", String(GS_LOD_POLICY.geometricErrorLayerMultiplier),
    "--geometric-error-scale", String(GS_LOD_POLICY.geometricErrorScale),
    `--${GS_LOD_POLICY.boundsMode}`
  ];
}

export class ProcessingWorker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeDatasetId: string | null = null;
  private activeController: AbortController | null = null;
  private activeDone: Promise<void> | null = null;
  private finishActive: (() => void) | null = null;
  private readonly cancelledDatasets = new Set<string>();
  constructor(private readonly db: Database, private readonly collisions: CollisionRepository, private readonly logger: FastifyBaseLogger) {}

  start() {
    if (this.timer) return;
    for (const dataset of this.db.listDatasets()) {
      if (["tiling", "collision_processing"].includes(dataset.status)) {
        this.db.updateDataset(dataset.id, { status: "queued", collisionStatus: "pending", stage: "服务恢复后重新排队" });
      }
    }
    this.timer = setInterval(() => this.scheduleTick(), 1000);
    this.scheduleTick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const done = this.activeDone;
    this.activeController?.abort(new Error("服务停止，取消数据处理"));
    if (done) await done;
  }
  wake() { this.scheduleTick(); }
  async cancelDataset(datasetId: string) {
    this.cancelledDatasets.add(datasetId);
    if (this.activeDatasetId !== datasetId || !this.activeController) return;
    const done = this.activeDone;
    this.activeController.abort();
    if (done) await done;
  }
  forgetDataset(datasetId: string) { this.cancelledDatasets.delete(datasetId); }

  private scheduleTick() {
    void this.tick().catch(error => this.logger.error({ err: error }, "processing worker tick failed"));
  }

  private async tick() {
    if (this.running || !config.conversionEnabled) return;
    const dataset = this.db.listDatasets().find(value => ["queued", "rebuilding"].includes(value.status) && !this.cancelledDatasets.has(value.id));
    if (!dataset) return;
    this.running = true;
    const controller = new AbortController();
    this.activeDatasetId = dataset.id; this.activeController = controller;
    this.activeDone = new Promise(resolve => { this.finishActive = resolve; });
    try { await this.process(dataset, controller.signal); }
    catch (error) {
      if (controller.signal.aborted || this.cancelledDatasets.has(dataset.id)) {
        this.logger.info({ datasetId: dataset.id }, "dataset processing cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ datasetId: dataset.id, err: error }, "dataset processing failed");
      if (dataset.status === "rebuilding") {
        this.db.updateDataset(dataset.id, {
          status: "ready", progress: 100, stage: "高清 LOD 重建失败，继续使用上一已发布版本",
          error: message.slice(0, 4000)
        });
      } else {
        this.db.updateDataset(dataset.id, { status: "failed", collisionStatus: "failed", stage: "处理失败", error: message.slice(0, 4000) });
      }
    } finally {
      this.finishActive?.(); this.finishActive = null; this.activeDone = null;
      this.activeDatasetId = null; this.activeController = null; this.running = false;
    }
  }

  private async process(dataset: Dataset, signal: AbortSignal) {
    signal.throwIfAborted();
    const visualOnlyRebuild = dataset.status === "rebuilding";
    const source = path.join(config.sourcesDir, `${dataset.id}.ply`);
    await validatePly(source);
    const root = path.join(config.workDir, dataset.id);
    const output = path.join(root, "output");
    const tiles = path.join(output, "tiles");
    const collision = path.join(output, "collision");
    const destination = path.join(config.publishedDir, dataset.id);
    const previousPublished = path.join(root, "previous-published");
    await recoverInterruptedPublication(destination, previousPublished);
    let buildSummary = await reusableGsTilesSummary(tiles);
    if (buildSummary) {
      await rm(collision, { recursive: true, force: true });
      if (!visualOnlyRebuild) await mkdir(collision, { recursive: true });
      this.db.updateDataset(dataset.id, {
        status: visualOnlyRebuild ? "rebuilding" : "tiling", progress: 55,
        stage: visualOnlyRebuild ? "复用已验收的高清 Gaussian 3D Tiles" : "复用已验收的 Gaussian 3D Tiles", error: null
      });
    } else {
      await rm(output, { recursive: true, force: true });
      await mkdir(tiles, { recursive: true });
      if (!visualOnlyRebuild) await mkdir(collision, { recursive: true });
      this.db.updateDataset(dataset.id, {
        status: visualOnlyRebuild ? "rebuilding" : "tiling", progress: 15,
        stage: visualOnlyRebuild ? "生成高清 Gaussian 3D Tiles（旧版本继续服务）" : "生成 Gaussian 3D Tiles", error: null
      });
      await runProcess(process.execPath, [tilerCli, source, tiles, "--input-convention", dataset.inputConvention, "--memory-budget", "4", ...fixedGsTilerArguments(), "--no-open-inspector"], this.logger, dataset.id, signal);
      signal.throwIfAborted();
      await stat(path.join(tiles, "tileset.json"));
      buildSummary = JSON.parse(await readFile(path.join(tiles, "build_summary.json"), "utf8")) as LodBuildSummary;
      validateFixedGsLodSummary(buildSummary);
    }

    if (visualOnlyRebuild) {
      const publishedCollision = path.join(destination, "collision");
      await validateCollisionArtifacts(publishedCollision);
      await cp(publishedCollision, collision, { recursive: true, force: false, errorOnExist: true });
      signal.throwIfAborted();
      await promotePublishedOutput(output, destination, previousPublished);
      this.collisions.invalidate(dataset.id);
      this.db.updateDataset(dataset.id, {
        status: "ready", collisionStatus: "ready", progress: 100,
        stage: "高清 Gaussian 3D Tiles 已发布，碰撞、标签和航迹保持不变", error: null
      });
      return;
    }

    this.db.updateDataset(dataset.id, { status: "collision_processing", collisionStatus: "processing", progress: 60, stage: "生成体素碰撞数据" });
    const args = [splatCli, "-g", config.gpuDevice, source];
    for (const coordinateRotation of sourceCoordinateRotations(buildSummary.source_coordinate_system)) args.push("--rotate", coordinateRotation);
    args.push("--voxel-size", String(dataset.voxelSize), "--voxel-opacity", String(dataset.voxelOpacity));
    if (dataset.sceneType === "outdoor") args.push("--voxel-floor-fill", "1.6");
    else {
      if (!dataset.indoorSeed) throw new Error("室内场景必须提供自由空间 indoorSeed 才能生成封闭碰撞体");
      args.push("--seed-pos", `${dataset.indoorSeed.x},${dataset.indoorSeed.y},${dataset.indoorSeed.z}`, "--voxel-external-fill", "1.6");
    }
    args.push("--collision-mesh", "faces", path.join(collision, "scene.voxel.json"));
    try {
      await runProcess(process.execPath, args, this.logger, dataset.id, signal);
    } catch (error) {
      const recommendation = recommendedCollisionVoxelSize(error, dataset.voxelSize);
      if (!isCollisionMutableGridLimit(error) || signal.aborted) throw error;
      if (recommendation === null) {
        throw new Error(
          `碰撞体可变网格超过内存安全上限，且当前 ${dataset.voxelSize} m 体素已无法在平台允许的 2 m 上限内给出有效降级建议。系统未自动修改参数；请缩小源场景空间范围，或在分区碰撞架构完成后再处理。原始错误：${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw new Error(
        `碰撞体可变网格超过内存安全上限。当前体素尺寸 ${dataset.voxelSize} m；建议人工确认后改为不小于 ${recommendation} m（尺寸越大、分辨率越低）再重试。系统未自动修改参数。原始错误：${error instanceof Error ? error.message : String(error)}`
      );
    }
    signal.throwIfAborted();
    const collisionMetadataPath = path.join(collision, "scene.voxel.json");
    await validateCollisionArtifacts(collision);
    const collisionMetadata: unknown = JSON.parse(await readFile(collisionMetadataPath, "utf8"));
    if (!collisionMetadata || typeof collisionMetadata !== "object" || Array.isArray(collisionMetadata)) {
      throw new Error("碰撞体元数据格式无效");
    }
    const collisionMetadataObject = collisionMetadata as Record<string, unknown>;
    collisionMetadataObject.coordinateFrame = "tile_local_z_up";
    await writeFile(collisionMetadataPath, `${JSON.stringify(collisionMetadataObject, null, 2)}\n`);

    signal.throwIfAborted();
    await promotePublishedOutput(output, destination, previousPublished);
    this.collisions.invalidate(dataset.id);
    this.db.updateDataset(dataset.id, { status: "ready", collisionStatus: "ready", progress: 100, stage: "可视化与碰撞数据已发布", error: null });
  }
}

async function validateCollisionArtifacts(directory: string) {
  await stat(path.join(directory, "scene.voxel.json"));
  await stat(path.join(directory, "scene.voxel.bin"));
  await stat(path.join(directory, "scene.collision.glb"));
}

async function pathExists(filename: string) {
  try { await stat(filename); return true; } catch { return false; }
}

async function recoverInterruptedPublication(destination: string, previousPublished: string) {
  if (!(await pathExists(previousPublished))) return;
  if (await pathExists(destination)) await rm(previousPublished, { recursive: true, force: true });
  else {
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(previousPublished, destination);
  }
}

async function promotePublishedOutput(output: string, destination: string, previousPublished: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(previousPublished, { recursive: true, force: true });
  let hasPrevious = false;
  if (await pathExists(destination)) {
    await rename(destination, previousPublished);
    hasPrevious = true;
  }
  try {
    await rename(output, destination);
  } catch (error) {
    if (hasPrevious && !(await pathExists(destination))) await rename(previousPublished, destination);
    throw error;
  }
  if (hasPrevious) await rm(previousPublished, { recursive: true, force: true });
}

interface LodBuildSummary {
  source_coordinate_system?: string;
  converted_splats?: number;
  max_depth?: number;
  max_depth_source?: string;
  max_leaf_limit?: number;
  min_leaf_limit?: number;
  sampling_rate_per_level?: number;
  lod_multiplier_preset?: string;
  coverage_boost_scale?: number;
  opacity_filter?: number;
  bounds_mode?: string;
}

async function reusableGsTilesSummary(tilesDirectory: string): Promise<LodBuildSummary | null> {
  try {
    await stat(path.join(tilesDirectory, "tileset.json"));
    const summary = JSON.parse(await readFile(path.join(tilesDirectory, "build_summary.json"), "utf8")) as LodBuildSummary;
    validateFixedGsLodSummary(summary);
    return summary;
  } catch {
    return null;
  }
}

export function validateFixedGsLodSummary(summary: LodBuildSummary) {
  const effectiveSplats = Number(summary.converted_splats);
  if (!Number.isFinite(effectiveSplats) || effectiveSplats <= 0) {
    throw new Error("GS LOD 产物缺少有效的 converted_splats");
  }
  const expectedDepth = calculateGsLodDepth(effectiveSplats);
  const mismatches: string[] = [];
  if (summary.max_depth_source !== "auto") mismatches.push("max_depth_source");
  if (summary.max_depth !== expectedDepth) mismatches.push(`max_depth=${summary.max_depth}, expected=${expectedDepth}`);
  if (summary.max_leaf_limit !== GS_LOD_POLICY.maxLeafSplats) mismatches.push("max_leaf_limit");
  if (summary.min_leaf_limit !== GS_LOD_POLICY.minLeafSplats) mismatches.push("min_leaf_limit");
  if (summary.sampling_rate_per_level !== GS_LOD_POLICY.samplingRatePerLevel) mismatches.push("sampling_rate_per_level");
  if (summary.lod_multiplier_preset !== GS_LOD_POLICY.lodMultiplier) mismatches.push("lod_multiplier_preset");
  if (summary.coverage_boost_scale !== GS_LOD_POLICY.coverageBoostScale) mismatches.push("coverage_boost_scale");
  if (summary.opacity_filter !== GS_LOD_POLICY.opacityFilter) mismatches.push("opacity_filter");
  if (summary.bounds_mode !== GS_LOD_POLICY.boundsMode) mismatches.push("bounds_mode");
  if (mismatches.length) throw new Error(`GS LOD 产物不符合平台固定策略：${mismatches.join(", ")}`);
}

/** Match the tiler's audited source basis so tags and collision voxels share tile-local Z-up coordinates. */
export function sourceCoordinateRotations(sourceCoordinateSystem?: string) {
  // splat-transform imports PLY data with an X/Y handedness flip. Compose
  // rotations so its collision output exactly matches the tiler's Z-up frame.
  if (sourceCoordinateSystem === "z_up") return ["0,0,180"];
  if (sourceCoordinateSystem === "gltf_y_up") return ["90,0,0", "0,180,0"];
  if (sourceCoordinateSystem === "camera_y_down_z_forward") return ["270,0,0", "0,180,0"];
  throw new Error(`3D Tiles 转换器返回未知源坐标系：${sourceCoordinateSystem ?? "未提供"}`);
}

async function runProcess(command: string, args: string[], logger: FastifyBaseLogger, datasetId: string, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stderr = ""; let settled = false; let forceKillTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", data => logger.info({ datasetId, tool: path.basename(args[0] ?? command) }, String(data).trim()));
    child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-12000); logger.warn({ datasetId }, String(data).trim()); });
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true; cleanup(); callback();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 5000);
      forceKillTimer.unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", error => settle(() => reject(error)));
    child.once("exit", code => {
      settle(() => {
        if (signal.aborted) reject(signal.reason ?? new Error("处理任务已取消"));
        else if (code === 0) resolve();
        else reject(new Error(`处理程序退出码 ${code}: ${stderr.slice(-2000)}`));
      });
    });
    if (signal.aborted) onAbort();
  });
}

export async function validatePly(filename: string) {
  const handle = await open(filename, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024); const result = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, result.bytesRead).toString("utf8");
    if (!header.startsWith("ply\n") && !header.startsWith("ply\r\n")) throw new Error("文件不是有效 PLY：缺少 ply 文件头");
    const end = header.indexOf("end_header"); if (end < 0) throw new Error("PLY 文件头超过 64 KiB 或缺少 end_header");
    for (const property of [
      "property float x", "property float y", "property float z", "property float opacity",
      "property float scale_0", "property float scale_1", "property float scale_2",
      "property float rot_0", "property float rot_1", "property float rot_2", "property float rot_3"
    ]) {
      if (!header.includes(property)) throw new Error(`PLY 缺少 Gaussian 属性：${property}`);
    }
  } finally { await handle.close(); }
}
