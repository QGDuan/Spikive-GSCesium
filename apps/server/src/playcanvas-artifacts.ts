import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlayCanvasLodLevelReport, PlayCanvasVisualReport } from "@spikive/shared";

export const PLAYCANVAS_POLICY_VERSION = "playcanvas-upstream-streamed-sog-v1";
export const PLAYCANVAS_ARTIFACT_SCHEMA_VERSION = 2 as const;
export const PLAYCANVAS_PREVIOUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The unmodified upstream walkthrough: full source plus 50%, 25% and 10%. */
export const PLAYCANVAS_OFFICIAL_LOD_RATIOS = Object.freeze([1, 0.5, 0.25, 0.1] as const);

export const PLAYCANVAS_SOG_POLICY = Object.freeze({
  // These are splat-transform's upstream defaults. They are recorded for
  // provenance only and are deliberately not passed as CLI arguments.
  lodChunkCount: 512,
  lodChunkExtent: 16,
  fineLodFormat: "sog" as const,
  coarseLodFormat: "sog" as const,
  ratios: PLAYCANVAS_OFFICIAL_LOD_RATIOS
} as const);

export interface PlayCanvasLodMeta {
  version: 1;
  asset?: { generator?: string };
  count: number;
  counts: number[];
  lodLevels: number;
  filenames: string[];
  tree: PlayCanvasLodTreeNode;
}

interface PlayCanvasLodTreeNode {
  bound?: { min: [number, number, number]; max: [number, number, number] };
  lods?: Record<string, { file: number; offset: number; count: number }>;
  children?: PlayCanvasLodTreeNode[];
}

export interface PlayCanvasRevisionRecord {
  revision: string;
  backend: "playcanvas-sog";
  policyVersion: string;
  sourceSha256: string;
  collisionRevision: string;
  relativeRootPath: string;
  reportPath: string;
  createdAt: string;
  retainUntil: string | null;
}

export interface PlayCanvasArtifactManifest {
  schemaVersion: typeof PLAYCANVAS_ARTIFACT_SCHEMA_VERSION;
  datasetId: string;
  activeRevision: string;
  previousRevision: string | null;
  revisions: PlayCanvasRevisionRecord[];
  updatedAt: string;
}

export async function validatePlayCanvasRevision(options: {
  datasetId: string;
  revision: string;
  sourcePath: string;
  collisionDirectory: string;
  stagedRoot: string;
  toolVersion: string;
}): Promise<PlayCanvasVisualReport> {
  const sogDirectory = path.join(options.stagedRoot, "sog");
  const [meta, source, collision, artifact, lodMetaDigest] = await Promise.all([
    readAndValidateLodMeta(sogDirectory),
    inspectPly(options.sourcePath),
    hashNamedFiles(options.collisionDirectory, ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"]),
    hashDirectory(sogDirectory),
    hashFile(path.join(sogDirectory, "lod-meta.json"))
  ]);
  if (meta.counts[0] !== source.splatCount) {
    throw new Error(`PlayCanvas LOD0 不完整：source=${source.splatCount}, lod0=${meta.counts[0]}`);
  }
  if (!meta.counts.every((count, index) => index === 0 || count <= meta.counts[index - 1]!)) {
    throw new Error("上游 Streamed SOG 的 LOD 点数没有单调递减");
  }

  const references = collectReferences(meta);
  if (meta.filenames.some(filename => path.basename(filename) !== "meta.json")) {
    throw new Error("上游 Streamed SOG Chunk 必须引用标准 meta.json payload");
  }
  const treeStats = inspectLodTree(meta.tree);
  const ratios = meta.counts.map(count => count / source.splatCount);
  const levels: PlayCanvasLodLevelReport[] = [];
  for (let level = 0; level < meta.lodLevels; level += 1) {
    const files = references.get(level) ?? new Set<number>();
    let bytes = 0;
    for (const file of files) bytes += await payloadBytes(sogDirectory, meta.filenames[file]!);
    levels.push({
      level,
      ratio: ratios[level]!,
      splatCount: meta.counts[level]!,
      chunkCount: files.size,
      bytes
    });
  }
  return {
    schemaVersion: 2,
    datasetId: options.datasetId,
    visualBackend: "playcanvas-sog",
    visualRevision: options.revision,
    policyVersion: PLAYCANVAS_POLICY_VERSION,
    source: {
      sha256: source.sha256,
      bytes: source.bytes,
      splatCount: source.splatCount,
      shDegree: source.shDegree,
      coordinateSystem: "tile_local_z_up"
    },
    transform: { localToRender: "render=(x,z,-y)", renderToLocal: "local=(x,-z,y)" },
    artifact: {
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      chunkCount: meta.filenames.length,
      lodMetaSha256: lodMetaDigest.sha256
    },
    collisionRevision: collision.sha256,
    tool: { name: "@playcanvas/splat-transform", version: options.toolVersion },
    policy: {
      lodChunkCount: PLAYCANVAS_SOG_POLICY.lodChunkCount,
      lodChunkExtent: PLAYCANVAS_SOG_POLICY.lodChunkExtent,
      fineLodFormat: PLAYCANVAS_SOG_POLICY.fineLodFormat,
      coarseLodFormat: PLAYCANVAS_SOG_POLICY.coarseLodFormat,
      ratios,
      spatialTreeDepth: treeStats.maxDepth,
      spatialNodeCount: treeStats.nodeCount,
      spatialLeafCount: treeStats.leafCount
    },
    levels,
    builtAt: new Date().toISOString()
  };
}

export async function writePlayCanvasReport(stagedRoot: string, report: PlayCanvasVisualReport) {
  await writeFile(path.join(stagedRoot, "visual-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

export async function readPlayCanvasManifest(datasetRoot: string): Promise<PlayCanvasArtifactManifest | null> {
  try {
    const value = JSON.parse(await readFile(path.join(datasetRoot, "visual-artifact-manifest.json"), "utf8")) as PlayCanvasArtifactManifest;
    if (value.schemaVersion !== PLAYCANVAS_ARTIFACT_SCHEMA_VERSION || !value.datasetId || !value.activeRevision || !Array.isArray(value.revisions)) {
      throw new Error("PlayCanvas visual manifest 内容无效");
    }
    return value;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function publishPlayCanvasRevision(options: {
  datasetRoot: string;
  stagedRoot: string;
  report: PlayCanvasVisualReport;
}) {
  const before = await readPlayCanvasManifest(options.datasetRoot);
  const now = new Date();
  const relativeRootPath = path.posix.join("visual-revisions", options.report.visualRevision);
  const destination = path.join(options.datasetRoot, relativeRootPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(options.stagedRoot, destination);
  const record: PlayCanvasRevisionRecord = {
    revision: options.report.visualRevision,
    backend: "playcanvas-sog",
    policyVersion: options.report.policyVersion,
    sourceSha256: options.report.source.sha256,
    collisionRevision: options.report.collisionRevision,
    relativeRootPath,
    reportPath: path.posix.join(relativeRootPath, "visual-report.json"),
    createdAt: options.report.builtAt,
    retainUntil: null
  };
  const previousRevision = before?.activeRevision ?? null;
  const retainedPrevious = before?.revisions.find(value => value.revision === previousRevision);
  const retainUntil = new Date(now.getTime() + PLAYCANVAS_PREVIOUS_RETENTION_MS).toISOString();
  const revisions = [...(retainedPrevious ? [{ ...retainedPrevious, retainUntil }] : []), record];
  const next: PlayCanvasArtifactManifest = {
    schemaVersion: PLAYCANVAS_ARTIFACT_SCHEMA_VERSION,
    datasetId: options.report.datasetId,
    activeRevision: record.revision,
    previousRevision,
    revisions,
    updatedAt: now.toISOString()
  };
  await writeManifestAtomic(options.datasetRoot, next);
  for (const old of before?.revisions ?? []) {
    if (!revisions.some(value => value.revision === old.revision)) {
      await rm(path.join(options.datasetRoot, old.relativeRootPath), { recursive: true, force: true });
    }
  }
  return next;
}

export async function resolvePlayCanvasRevision(datasetRoot: string, revision?: string) {
  const manifest = await readPlayCanvasManifest(datasetRoot);
  if (!manifest) return null;
  const wanted = revision ?? manifest.activeRevision;
  const record = manifest.revisions.find(value => value.revision === wanted);
  if (!record) return null;
  const root = path.join(datasetRoot, record.relativeRootPath);
  await stat(path.join(root, "sog", "lod-meta.json"));
  return { manifest, record, root };
}

export async function activatePlayCanvasRevision(options: {
  datasetRoot: string;
  revision: string;
  sourcePath: string;
  collisionDirectory: string;
}) {
  const manifest = await readPlayCanvasManifest(options.datasetRoot);
  if (!manifest) throw new Error("当前数据集还没有 PlayCanvas 视觉产物");
  if (manifest.activeRevision === options.revision) return manifest;
  const target = manifest.revisions.find(value => value.revision === options.revision);
  if (!target) throw new Error("目标 PlayCanvas revision 不存在或已超过保留期");
  if (target.retainUntil !== null && Date.parse(target.retainUntil) <= Date.now()) throw new Error("目标 PlayCanvas revision 已超过七天保留期");
  const [source, collision] = await Promise.all([
    inspectPly(options.sourcePath),
    hashNamedFiles(options.collisionDirectory, ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"])
  ]);
  if (source.sha256 !== target.sourceSha256) throw new Error("目标 PlayCanvas revision 与当前源 PLY 不一致");
  if (collision.sha256 !== target.collisionRevision) throw new Error("目标 PlayCanvas revision 与当前碰撞产物不一致");
  const now = new Date();
  const previous = manifest.activeRevision;
  const retainUntil = new Date(now.getTime() + PLAYCANVAS_PREVIOUS_RETENTION_MS).toISOString();
  const next: PlayCanvasArtifactManifest = {
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
  await writeManifestAtomic(options.datasetRoot, next);
  return next;
}

export async function readPlayCanvasReport(datasetRoot: string, record: PlayCanvasRevisionRecord) {
  return JSON.parse(await readFile(path.join(datasetRoot, record.reportPath), "utf8")) as PlayCanvasVisualReport;
}

export async function readPlayCanvasLodMeta(root: string) {
  return readAndValidateLodMeta(path.join(root, "sog"));
}

async function writeManifestAtomic(datasetRoot: string, manifest: PlayCanvasArtifactManifest) {
  await mkdir(datasetRoot, { recursive: true });
  const temporary = path.join(datasetRoot, `.visual-artifact-manifest.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path.join(datasetRoot, "visual-artifact-manifest.json"));
}

async function readAndValidateLodMeta(directory: string): Promise<PlayCanvasLodMeta> {
  const meta = JSON.parse(await readFile(path.join(directory, "lod-meta.json"), "utf8")) as PlayCanvasLodMeta;
  if (meta.version !== 1 || !Number.isInteger(meta.lodLevels) || meta.lodLevels < 1 || !Array.isArray(meta.counts) || meta.counts.length !== meta.lodLevels) {
    throw new Error("PlayCanvas lod-meta 层级无效");
  }
  if (!Number.isInteger(meta.count) || meta.count !== meta.counts.reduce((sum, count) => sum + count, 0)) throw new Error("PlayCanvas lod-meta 总点数无效");
  if (meta.counts.some(count => !Number.isInteger(count) || count <= 0) || !Array.isArray(meta.filenames) || !meta.filenames.length || !meta.tree) {
    throw new Error("PlayCanvas lod-meta 内容不完整");
  }
  for (const filename of meta.filenames) {
    if (!isSafeRelativePath(filename)) throw new Error(`PlayCanvas LOD 路径无效：${filename}`);
    const value = await stat(path.join(directory, filename));
    if (!value.isFile() || value.size <= 0) throw new Error(`PlayCanvas LOD 文件为空：${filename}`);
  }
  const refs = collectReferences(meta);
  for (let level = 0; level < meta.lodLevels; level += 1) {
    if (!(refs.get(level)?.size)) throw new Error(`PlayCanvas LOD ${level} 没有可用 Chunk`);
  }
  return meta;
}

function collectReferences(meta: PlayCanvasLodMeta) {
  const result = new Map<number, Set<number>>();
  const counts = new Array(meta.lodLevels).fill(0) as number[];
  const visit = (node: PlayCanvasLodTreeNode) => {
    if (node.bound) assertBox(node.bound);
    for (const [key, ref] of Object.entries(node.lods ?? {})) {
      const level = Number(key);
      if (!Number.isInteger(level) || level < 0 || level >= meta.lodLevels || !Number.isInteger(ref.file) || ref.file < 0 || ref.file >= meta.filenames.length || !Number.isInteger(ref.offset) || ref.offset < 0 || !Number.isInteger(ref.count) || ref.count <= 0) {
        throw new Error("PlayCanvas lod-meta 包含无效 Chunk 引用");
      }
      if (!result.has(level)) result.set(level, new Set());
      result.get(level)!.add(ref.file);
      counts[level] = counts[level]! + ref.count;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(meta.tree);
  if (!counts.every((count, level) => count === meta.counts[level])) throw new Error("PlayCanvas lod-meta 层级计数与树引用不一致");
  return result;
}

function assertBox(box: { min: [number, number, number]; max: [number, number, number] }) {
  if (![...box.min, ...box.max].every(Number.isFinite) || box.min.some((value, index) => value > box.max[index]!)) {
    throw new Error("PlayCanvas lod-meta 包围体无效");
  }
}

function inspectLodTree(tree: PlayCanvasLodTreeNode) {
  let nodeCount = 0;
  let leafCount = 0;
  let maxDepth = 0;
  const visit = (node: PlayCanvasLodTreeNode, depth: number) => {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    const children = node.children ?? [];
    if (!children.length) leafCount += 1;
    for (const child of children) visit(child, depth + 1);
  };
  visit(tree, 0);
  return { nodeCount, leafCount, maxDepth };
}

function isSafeRelativePath(value: string) {
  return Boolean(value) && !value.includes("\0") && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

async function inspectPly(filename: string) {
  const digestPromise = hashFile(filename);
  const header = await readPlyHeader(filename);
  const splatCount = Number(/^element vertex\s+(\d+)/m.exec(header.text)?.[1]);
  if (!Number.isSafeInteger(splatCount) || splatCount <= 0) throw new Error("PLY 顶点数量无效");
  const restCount = [...header.text.matchAll(/^property\s+\S+\s+f_rest_\d+/gm)].length;
  const shDegree = restCount === 0 ? 0 : Math.round(Math.sqrt(restCount / 3 + 1) - 1);
  return { ...await digestPromise, splatCount, shDegree };
}

async function payloadBytes(directory: string, filename: string) {
  const absolute = path.join(directory, filename);
  if (path.basename(filename) !== "meta.json") return (await stat(absolute)).size;
  return (await hashDirectory(path.dirname(absolute))).bytes;
}

async function readPlyHeader(filename: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(filename, { start: 0, end: 65_535 })) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const marker = Buffer.from("end_header", "ascii");
  const markerOffset = buffer.indexOf(marker);
  if (markerOffset < 0) throw new Error("PLY 文件头超过 64 KiB 或缺少 end_header");
  let dataOffset = markerOffset + marker.length;
  // Consume only the line ending that belongs to `end_header`. The binary
  // payload may legitimately begin with 0x0a or 0x0d and must stay intact.
  if (buffer[dataOffset] === 13 && buffer[dataOffset + 1] === 10) {
    dataOffset += 2;
  } else if (buffer[dataOffset] === 10 || buffer[dataOffset] === 13) {
    dataOffset += 1;
  }
  return { text: buffer.subarray(0, dataOffset).toString("latin1"), dataOffset };
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
