import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AholoLodLevelReport, AholoVisualReport } from "@spikive/shared";

export const AHOLO_POLICY_VERSION = "aholo-chunk-lod-v1";
export const AHOLO_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const AHOLO_PREVIOUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const AHOLO_CHUNK_LOD_POLICY = Object.freeze({
  maxChunkCounts: 400_000,
  maxBudget: 6_000_000,
  minLevel: 0,
  backgroundPenalty: 0.5,
  hysteresisTicks: 4,
  schedulerParallelCounts: 4,
  schedulerExistingTaskLimit: 64,
  schedulerMinDuration: 160,
  levels: [
    { precision: 1, scaleBoost: 1, permanent: false, merged: false },
    { precision: 0.5, scaleBoost: 1, permanent: false, merged: false },
    { precision: 0.25, scaleBoost: 1, permanent: false, merged: false },
    { precision: 0.05, scaleBoost: 1.01, permanent: true, merged: true },
    { precision: 0.01, scaleBoost: 1.02, permanent: true, merged: true }
  ]
} as const);

export interface AholoRevisionRecord {
  revision: string;
  policyVersion: string;
  sourceSha256: string;
  collisionRevision: string;
  relativeRootPath: string;
  reportPath: string;
  createdAt: string;
  retainUntil: string | null;
}

export interface AholoArtifactManifest {
  schemaVersion: typeof AHOLO_ARTIFACT_SCHEMA_VERSION;
  datasetId: string;
  activeRevision: string;
  previousRevision: string | null;
  revisions: AholoRevisionRecord[];
  updatedAt: string;
}

export interface AholoLodMeta {
  magicCode: 2500660;
  type: "lod-splat";
  version: string;
  counts: number;
  shDegree: number;
  levels: number;
  files: string[];
  forwardBox: { min: [number, number, number]; max: [number, number, number] };
  permanentFiles: number[];
  tree: Array<{
    bound: { min: [number, number, number]; max: [number, number, number] };
    lods: Array<{ file: number; offset: number; count: number }>;
  }>;
}

export function createAholoPipeline(sourcePath: string, outputDirectory: string) {
  return {
    version: 1,
    tasks: [
      { id: "read", type: "Read", config: { inputs: [sourcePath], output: "source" } },
      {
        id: "lod", type: "AutoChunkLod", config: {
          input: "source", output: "lod", type: "ply",
          maxChunkCounts: AHOLO_CHUNK_LOD_POLICY.maxChunkCounts,
          levels: AHOLO_CHUNK_LOD_POLICY.levels
        }
      },
      {
        id: "write", type: "Write", config: {
          input: "lod", output: outputDirectory, parallelCounts: 4
        }
      }
    ]
  };
}

/** Convert the already partitioned lossless reference one chunk at a time and release each decoded chunk. */
export function createAholoEszConversionPipeline(referenceDirectory: string, eszDirectory: string, files: string[]) {
  const tasks: Array<Record<string, unknown>> = [];
  for (const [index, file] of files.entries()) {
    const cache = `chunk-${index}`;
    tasks.push({
      id: `read-${index}`,
      type: "Read",
      config: { inputs: [path.join(referenceDirectory, file)], output: cache }
    });
    tasks.push({
      id: `write-${index}`,
      type: "Write",
      config: {
        input: cache,
        output: path.join(eszDirectory, `${path.basename(file, path.extname(file))}.esz`),
        version: 2,
        highPrecision: true,
        parallelCounts: 1
      },
      release: [cache]
    });
  }
  return { version: 1, tasks };
}

export async function prepareAholoEszMeta(referenceDirectory: string, eszDirectory: string) {
  const meta = await readAndValidateLodMeta(referenceDirectory, "ply");
  await mkdir(eszDirectory, { recursive: true });
  const eszMeta: AholoLodMeta = {
    ...meta,
    files: meta.files.map(file => `${path.basename(file, path.extname(file))}.esz`)
  };
  await writeFile(path.join(eszDirectory, "lod-meta.json"), `${JSON.stringify(eszMeta, null, 2)}\n`);
  return meta.files;
}

export async function validateAholoRevision(options: {
  datasetId: string;
  revision: string;
  sourcePath: string;
  collisionDirectory: string;
  stagedRoot: string;
  toolVersion: string;
}): Promise<AholoVisualReport> {
  const eszDirectory = path.join(options.stagedRoot, "esz");
  const referenceDirectory = path.join(options.stagedRoot, "ply-reference");
  const [eszMeta, referenceMeta, source, collision, eszPayload, referencePayload] = await Promise.all([
    readAndValidateLodMeta(eszDirectory, "esz"),
    readAndValidateLodMeta(referenceDirectory, "ply"),
    inspectPly(options.sourcePath),
    hashNamedFiles(options.collisionDirectory, ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"]),
    hashDirectory(eszDirectory),
    hashDirectory(referenceDirectory)
  ]);
  if (eszMeta.counts !== source.splatCount || referenceMeta.counts !== source.splatCount) {
    throw new Error(`AHoLo LOD0 不完整：source=${source.splatCount}, esz=${eszMeta.counts}, ply=${referenceMeta.counts}`);
  }
  if (eszMeta.shDegree !== source.shDegree || referenceMeta.shDegree !== source.shDegree) {
    throw new Error(`AHoLo SH 保真校验失败：source=${source.shDegree}, esz=${eszMeta.shDegree}, ply=${referenceMeta.shDegree}`);
  }
  assertEquivalentTopology(eszMeta, referenceMeta);
  const levels: AholoLodLevelReport[] = AHOLO_CHUNK_LOD_POLICY.levels.map((policy, level) => ({
    level,
    precision: policy.precision,
    scaleBoost: policy.scaleBoost,
    permanent: policy.permanent,
    merged: policy.merged,
    splatCount: eszMeta.tree.reduce((sum, node) => sum + node.lods[level]!.count, 0)
  }));
  if (levels[0]!.splatCount !== source.splatCount) {
    throw new Error(`AHoLo 终端覆盖校验失败：LOD0=${levels[0]!.splatCount}, source=${source.splatCount}`);
  }
  if (!levels.every((level, index) => index === 0 || level.splatCount <= levels[index - 1]!.splatCount)) {
    throw new Error("AHoLo LOD 点数必须随层级递减");
  }
  return {
    schemaVersion: 1,
    datasetId: options.datasetId,
    visualRevision: options.revision,
    policyVersion: AHOLO_POLICY_VERSION,
    source: {
      sha256: source.sha256,
      bytes: source.bytes,
      splatCount: source.splatCount,
      shDegree: source.shDegree,
      coordinateSystem: "tile_local_z_up"
    },
    transform: { localToRender: "render=(x,z,-y)", renderToLocal: "local=(x,-z,y)" },
    artifact: {
      eszBytes: eszPayload.bytes,
      eszPayloadSha256: eszPayload.sha256,
      referencePlyBytes: referencePayload.bytes,
      referencePlyPayloadSha256: referencePayload.sha256,
      chunkCount: eszMeta.files.length,
      referenceChunkCount: referenceMeta.files.length
    },
    collisionRevision: collision.sha256,
    tool: { name: "@manycore/aholo-splat-transform", version: options.toolVersion },
    levels,
    builtAt: new Date().toISOString()
  };
}

export async function writeAholoReport(stagedRoot: string, report: AholoVisualReport) {
  await writeFile(path.join(stagedRoot, "aholo-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

export async function readAholoManifest(datasetRoot: string): Promise<AholoArtifactManifest | null> {
  try {
    const value = JSON.parse(await readFile(path.join(datasetRoot, "aholo-artifact-manifest.json"), "utf8")) as AholoArtifactManifest;
    if (value.schemaVersion !== AHOLO_ARTIFACT_SCHEMA_VERSION || !value.datasetId || !value.activeRevision || !Array.isArray(value.revisions)) {
      throw new Error("AHoLo artifact manifest 格式无效");
    }
    return value;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function publishAholoRevision(options: {
  datasetRoot: string;
  stagedRoot: string;
  report: AholoVisualReport;
}) {
  const before = await readAholoManifest(options.datasetRoot);
  if (before && before.datasetId !== options.report.datasetId) throw new Error("AHoLo manifest 与数据集目录不一致");
  if (before?.revisions.some(value => value.revision === options.report.visualRevision)) throw new Error("AHoLo revision 已存在");
  const relativeRootPath = path.posix.join("aholo-visual-revisions", options.report.visualRevision);
  const revisionRoot = path.join(options.datasetRoot, relativeRootPath);
  await mkdir(path.dirname(revisionRoot), { recursive: true });
  await rename(options.stagedRoot, revisionRoot);
  const now = new Date();
  const record: AholoRevisionRecord = {
    revision: options.report.visualRevision,
    policyVersion: options.report.policyVersion,
    sourceSha256: options.report.source.sha256,
    collisionRevision: options.report.collisionRevision,
    relativeRootPath,
    reportPath: path.posix.join(relativeRootPath, "aholo-report.json"),
    createdAt: options.report.builtAt,
    retainUntil: null
  };
  const previousRevision = before?.activeRevision ?? null;
  const retainUntil = new Date(now.getTime() + AHOLO_PREVIOUS_RETENTION_MS).toISOString();
  const retainedPrevious = before?.revisions.find(value => value.revision === previousRevision);
  const revisions = [
    ...(retainedPrevious ? [{ ...retainedPrevious, retainUntil }] : []),
    record
  ];
  const next: AholoArtifactManifest = {
    schemaVersion: AHOLO_ARTIFACT_SCHEMA_VERSION,
    datasetId: options.report.datasetId,
    activeRevision: record.revision,
    previousRevision,
    revisions,
    updatedAt: now.toISOString()
  };
  await writeAholoManifestAtomic(options.datasetRoot, next);
  for (const old of before?.revisions ?? []) {
    if (revisions.some(value => value.revision === old.revision)) continue;
    await rm(path.join(options.datasetRoot, old.relativeRootPath), { recursive: true, force: true });
  }
  return next;
}

export async function resolveAholoRevision(datasetRoot: string, revision?: string) {
  const manifest = await readAholoManifest(datasetRoot);
  if (!manifest) return null;
  const wanted = revision ?? manifest.activeRevision;
  const record = manifest.revisions.find(value => value.revision === wanted);
  if (!record) return null;
  const root = path.join(datasetRoot, record.relativeRootPath);
  await stat(path.join(root, "esz", "lod-meta.json"));
  await stat(path.join(root, "ply-reference", "lod-meta.json"));
  return { manifest, record, root };
}

export async function activateAholoRevision(options: {
  datasetRoot: string;
  revision: string;
  sourcePath: string;
  collisionDirectory: string;
}) {
  const manifest = await readAholoManifest(options.datasetRoot);
  if (!manifest) throw new Error("当前数据集还没有 AHoLo 视觉产物");
  if (manifest.activeRevision === options.revision) return manifest;
  const target = manifest.revisions.find(value => value.revision === options.revision);
  if (!target) throw new Error("目标 AHoLo revision 不存在或已超过保留期");
  if (target.retainUntil !== null && Date.parse(target.retainUntil) <= Date.now()) throw new Error("目标 AHoLo revision 已超过七天保留期");
  const [source, collision] = await Promise.all([
    inspectPly(options.sourcePath),
    hashNamedFiles(options.collisionDirectory, ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"])
  ]);
  if (source.sha256 !== target.sourceSha256) throw new Error("目标 AHoLo revision 与当前源 PLY 不一致");
  if (collision.sha256 !== target.collisionRevision) throw new Error("目标 AHoLo revision 与当前碰撞产物不一致");
  const now = new Date();
  const previous = manifest.activeRevision;
  const retainUntil = new Date(now.getTime() + AHOLO_PREVIOUS_RETENTION_MS).toISOString();
  const next: AholoArtifactManifest = {
    ...manifest,
    activeRevision: target.revision,
    previousRevision: previous,
    revisions: manifest.revisions.map(value => {
      if (value.revision === previous) return { ...value, retainUntil };
      if (value.revision === target.revision) return { ...value, retainUntil: null };
      return value;
    }).filter(value => value.revision === previous || value.revision === target.revision),
    updatedAt: now.toISOString()
  };
  await writeAholoManifestAtomic(options.datasetRoot, next);
  return next;
}

export async function readAholoReport(datasetRoot: string, record: AholoRevisionRecord) {
  return JSON.parse(await readFile(path.join(datasetRoot, record.reportPath), "utf8")) as AholoVisualReport;
}

export async function readVersionedLodMeta(options: {
  datasetId: string;
  revision: string;
  format: "esz" | "ply-reference";
  root: string;
}) {
  const meta = await readAndValidateLodMeta(path.join(options.root, options.format), options.format === "esz" ? "esz" : "ply");
  const base = `/api/datasets/${options.datasetId}/aholo-visual-revisions/${encodeURIComponent(options.revision)}/${options.format}`;
  return { ...meta, files: meta.files.map(file => `${base}/${encodeURIComponent(file)}`) };
}

async function writeAholoManifestAtomic(datasetRoot: string, manifest: AholoArtifactManifest) {
  await mkdir(datasetRoot, { recursive: true });
  const temporary = path.join(datasetRoot, `.aholo-artifact-manifest.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path.join(datasetRoot, "aholo-artifact-manifest.json"));
}

async function readAndValidateLodMeta(directory: string, expectedExtension: "esz" | "ply"): Promise<AholoLodMeta> {
  const meta = JSON.parse(await readFile(path.join(directory, "lod-meta.json"), "utf8")) as AholoLodMeta;
  if (meta.magicCode !== 0x262834 || meta.type !== "lod-splat" || meta.version !== "1.0") throw new Error("AHoLo lod-meta 标识无效");
  if (!Number.isInteger(meta.counts) || meta.counts <= 0 || meta.levels !== AHOLO_CHUNK_LOD_POLICY.levels.length) {
    throw new Error("AHoLo lod-meta 点数或层级不符合固定策略");
  }
  if (!Number.isInteger(meta.shDegree) || meta.shDegree < 0 || !Array.isArray(meta.files) || !meta.files.length || !Array.isArray(meta.tree) || !meta.tree.length) {
    throw new Error("AHoLo lod-meta 内容不完整");
  }
  assertBox(meta.forwardBox, "forwardBox");
  for (const [index, file] of meta.files.entries()) {
    if (!isSafeFilename(file) || path.extname(file).slice(1).toLowerCase() !== expectedExtension) throw new Error(`AHoLo chunk 文件名无效：${file}`);
    const fileStat = await stat(path.join(directory, file));
    if (!fileStat.isFile() || fileStat.size <= 0) throw new Error(`AHoLo chunk ${index} 为空`);
  }
  if (!meta.permanentFiles.every(index => Number.isInteger(index) && index >= 0 && index < meta.files.length)) throw new Error("AHoLo permanentFiles 越界");
  for (const [nodeIndex, node] of meta.tree.entries()) {
    assertBox(node.bound, `tree[${nodeIndex}].bound`);
    if (!Array.isArray(node.lods) || node.lods.length !== meta.levels) throw new Error(`AHoLo node ${nodeIndex} 层级不完整`);
    for (const lod of node.lods) {
      if (!Number.isInteger(lod.file) || lod.file < 0 || lod.file >= meta.files.length || !Number.isInteger(lod.offset) || lod.offset < 0 || !Number.isInteger(lod.count) || lod.count <= 0) {
        throw new Error(`AHoLo node ${nodeIndex} 包含无效 chunk 引用`);
      }
    }
  }
  return meta;
}

function assertEquivalentTopology(a: AholoLodMeta, b: AholoLodMeta) {
  if (a.counts !== b.counts || a.shDegree !== b.shDegree || a.levels !== b.levels || a.tree.length !== b.tree.length) {
    throw new Error("高精度 ESZ 与无损 PLY 对照产物的 LOD 拓扑不一致");
  }
  const aCounts = a.tree.map(node => node.lods.map(lod => lod.count));
  const bCounts = b.tree.map(node => node.lods.map(lod => lod.count));
  if (JSON.stringify(aCounts) !== JSON.stringify(bCounts)) throw new Error("高精度 ESZ 与无损 PLY 对照产物的层级点数不一致");
}

function assertBox(box: AholoLodMeta["forwardBox"], name: string) {
  if (!box || !Array.isArray(box.min) || !Array.isArray(box.max) || box.min.length !== 3 || box.max.length !== 3 || [...box.min, ...box.max].some(value => !Number.isFinite(value))) {
    throw new Error(`AHoLo ${name} 包围体无效`);
  }
  if (box.min.some((value, index) => value > box.max[index]!)) throw new Error(`AHoLo ${name} 包围体倒置`);
}

function isSafeFilename(value: string) {
  return Boolean(value) && path.basename(value) === value && !value.includes("\0") && !value.includes("..") && !path.isAbsolute(value);
}

async function inspectPly(filename: string) {
  const digestPromise = hashFile(filename);
  const stream = createReadStream(filename, { start: 0, end: 65_535 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const header = Buffer.concat(chunks).toString("latin1");
  const end = header.indexOf("end_header");
  if (end < 0) throw new Error("PLY 文件头无效");
  const splatCount = Number(/^element vertex\s+(\d+)/m.exec(header)?.[1]);
  if (!Number.isInteger(splatCount) || splatCount <= 0) throw new Error("PLY 缺少有效 vertex 数量");
  const restCount = [...header.matchAll(/^property\s+\S+\s+f_rest_\d+/gm)].length;
  const shDegree = restCount === 0 ? 0 : Math.round(Math.sqrt(restCount / 3 + 1) - 1);
  return { ...await digestPromise, splatCount, shDegree };
}

async function hashDirectory(directory: string) {
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const digest = await hashFile(file);
    hash.update(path.relative(directory, file).split(path.sep).join("/")).update("\0").update(digest.sha256).update("\0");
    bytes += digest.bytes;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function hashNamedFiles(directory: string, names: string[]) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const name of names) {
    const digest = await hashFile(path.join(directory, name));
    hash.update(name).update("\0").update(digest.sha256).update("\0");
    bytes += digest.bytes;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function hashFile(filename: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}

function isMissingFile(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
