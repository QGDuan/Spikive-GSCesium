import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import type { Dataset } from "@spikive/shared";
import { Database } from "./db.js";
import { config } from "./config.js";
import { CollisionRepository } from "./collision.js";
import {
  AHOLO_POLICY_VERSION, createAholoEszConversionPipeline, createAholoPipeline, prepareAholoEszMeta,
  publishAholoRevision, validateAholoRevision, writeAholoReport
} from "./aholo-artifacts.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules");
const splatCli = path.join(packageRoot, "@playcanvas/splat-transform/bin/cli.mjs");
const aholoSplatCli = path.join(packageRoot, "@manycore/aholo-splat-transform/bin/cli.js");

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
          status: "ready", progress: 100,
          stage: dataset.aholoVisualRevision
            ? "AHoLo 视觉重建失败，继续使用上一已发布版本"
            : "AHoLo 视觉构建失败；碰撞、标签和航迹保持不变",
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
    if (dataset.sourceCoordinateSystem !== "z_up") {
      throw new Error("AHoLo-only 主线只接受已明确声明为 z_up 的 GraphDECO PLY；旧数据请先完成坐标审计");
    }
    if (dataset.status === "rebuilding") {
      await this.processAholoVisual(dataset, signal);
      return;
    }
    const source = path.join(config.sourcesDir, `${dataset.id}.ply`);
    await validatePly(source);
    const root = path.join(config.workDir, dataset.id);
    const output = path.join(root, "output");
    const collision = path.join(output, "collision");
    const destination = path.join(config.publishedDir, dataset.id);
    const previousPublished = path.join(root, "previous-published");
    await recoverInterruptedPublication(destination, previousPublished);
    if (await hasValidCollisionArtifacts(collision)) {
      this.db.updateDataset(dataset.id, {
        status: "collision_processing", collisionStatus: "processing", progress: 55,
        stage: "复用已完成的体素碰撞数据", error: null
      });
    } else {
      await rm(collision, { recursive: true, force: true });
      await mkdir(collision, { recursive: true });
      this.db.updateDataset(dataset.id, {
        status: "collision_processing", collisionStatus: "processing", progress: 15,
        stage: "生成体素碰撞数据", error: null
      });
      await this.buildCollision(dataset, source, collision, signal);
    }

    signal.throwIfAborted();
    await rm(path.join(output, "aholo-artifact-manifest.json"), { force: true });
    await rm(path.join(output, "aholo-visual-revisions"), { recursive: true, force: true });
    const revision = await this.buildAndPublishAholoVisual(dataset, signal, collision, output, false);
    await promotePublishedOutput(output, destination, previousPublished);
    this.collisions.invalidate(dataset.id);
    this.db.updateDataset(dataset.id, {
      status: "ready", collisionStatus: "ready", progress: 100, stage: "可视化与碰撞数据已发布", error: null,
      aholoVisualRevision: revision, aholoPolicyVersion: AHOLO_POLICY_VERSION
    });
  }

  private async processAholoVisual(dataset: Dataset, signal: AbortSignal) {
    const source = path.join(config.sourcesDir, `${dataset.id}.ply`);
    await validatePly(source);
    const destination = path.join(config.publishedDir, dataset.id);
    const collisionDirectory = path.join(destination, "collision");
    await validateCollisionArtifacts(collisionDirectory);
    const revision = await this.buildAndPublishAholoVisual(dataset, signal, collisionDirectory, destination, true);
    this.db.updateDataset(dataset.id, {
      status: "ready", collisionStatus: "ready", progress: 100,
      stage: "AHoLo 视觉已发布，碰撞、标签和航迹保持不变",
      error: null,
      aholoVisualRevision: revision,
      aholoPolicyVersion: AHOLO_POLICY_VERSION
    });
  }

  private async buildAndPublishAholoVisual(
    dataset: Dataset,
    signal: AbortSignal,
    collisionDirectory: string,
    datasetRoot: string,
    rebuilding: boolean
  ) {
    const source = path.join(config.sourcesDir, `${dataset.id}.ply`);
    const revision = randomUUID();
    const workRoot = path.join(config.workDir, dataset.id, "aholo-visual");
    const stagedRoot = path.join(workRoot, revision);
    const eszDirectory = path.join(stagedRoot, "esz");
    const referenceDirectory = path.join(stagedRoot, "ply-reference");
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(stagedRoot, { recursive: true });

    this.db.updateDataset(dataset.id, {
      status: rebuilding ? "rebuilding" : "tiling", progress: rebuilding ? 10 : 62,
      stage: rebuilding ? "重建 AHoLo 无损 Chunk LOD；上一版本继续服务" : "构建 AHoLo 无损 Chunk LOD", error: null
    });
    const referencePipelinePath = path.join(workRoot, "ply-reference-pipeline.json");
    await writeFile(referencePipelinePath, `${JSON.stringify(createAholoPipeline(source, referenceDirectory), null, 2)}\n`);
    await runProcess(process.execPath, [aholoSplatCli, referencePipelinePath], this.logger, dataset.id, signal);
    signal.throwIfAborted();

    this.db.updateDataset(dataset.id, {
      status: rebuilding ? "rebuilding" : "tiling", progress: rebuilding ? 58 : 82,
      stage: "逐 Chunk 编码高精度 ESZ；每个 Chunk 完成后立即释放解码内存", error: null
    });
    const referenceFiles = await prepareAholoEszMeta(referenceDirectory, eszDirectory);
    const eszPipelinePath = path.join(workRoot, "esz-pipeline.json");
    await writeFile(eszPipelinePath, `${JSON.stringify(createAholoEszConversionPipeline(referenceDirectory, eszDirectory, referenceFiles), null, 2)}\n`);
    await runProcess(process.execPath, [aholoSplatCli, eszPipelinePath], this.logger, dataset.id, signal);
    signal.throwIfAborted();

    this.db.updateDataset(dataset.id, { status: rebuilding ? "rebuilding" : "tiling", progress: 92, stage: "校验 AHoLo LOD0、层级覆盖、SH 与碰撞 revision" });
    const report = await validateAholoRevision({
      datasetId: dataset.id,
      revision,
      sourcePath: source,
      collisionDirectory,
      stagedRoot,
      toolVersion: await installedAholoTilerVersion()
    });
    await writeAholoReport(stagedRoot, report);
    signal.throwIfAborted();
    await publishAholoRevision({ datasetRoot, stagedRoot, report });
    await rm(workRoot, { recursive: true, force: true });
    return revision;
  }

  private async buildCollision(dataset: Dataset, source: string, collision: string, signal: AbortSignal) {
    const args = [splatCli, "-g", config.gpuDevice, source, "--rotate", "0,0,180"];
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
    await validateCollisionFiles(collision);
    const collisionMetadata: unknown = JSON.parse(await readFile(collisionMetadataPath, "utf8"));
    if (!collisionMetadata || typeof collisionMetadata !== "object" || Array.isArray(collisionMetadata)) throw new Error("碰撞体元数据格式无效");
    (collisionMetadata as Record<string, unknown>).coordinateFrame = "tile_local_z_up";
    await writeFile(collisionMetadataPath, `${JSON.stringify(collisionMetadata, null, 2)}\n`);
    await validateCollisionArtifacts(collision);
  }
}

async function validateCollisionFiles(directory: string) {
  for (const name of ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"]) {
    const value = await stat(path.join(directory, name));
    if (!value.isFile() || value.size <= 0) throw new Error(`碰撞产物 ${name} 无效`);
  }
}

async function validateCollisionArtifacts(directory: string) {
  await validateCollisionFiles(directory);
  const metadata = JSON.parse(await readFile(path.join(directory, "scene.voxel.json"), "utf8")) as { coordinateFrame?: unknown };
  if (metadata.coordinateFrame !== "tile_local_z_up") throw new Error("碰撞产物缺少 tile_local_z_up 坐标契约");
}

async function hasValidCollisionArtifacts(directory: string) {
  try { await validateCollisionArtifacts(directory); return true; }
  catch { return false; }
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

async function installedAholoTilerVersion() {
  const value = JSON.parse(
    await readFile(path.join(packageRoot, "@manycore/aholo-splat-transform", "package.json"), "utf8")
  ) as { version?: unknown };
  if (typeof value.version !== "string" || !value.version) throw new Error("无法读取 AHoLo 转换器版本");
  return value.version;
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
