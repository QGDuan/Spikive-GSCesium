import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dataset, LodLevelReport, LodReport } from "@spikive/shared";

export const GS_LOD_POLICY_VERSION = "gs-lod-hd-v2.1";
export const VISUAL_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const MAX_VISUAL_ARTIFACT_BYTES = 700 * 1024 * 1024;
export const PREVIOUS_VISUAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface VisualRevisionRecord {
  revision: string;
  policyVersion: string;
  sourceSha256: string;
  collisionRevision: string;
  relativeTilesPath: string;
  lodReportPath: string | null;
  tilesBytes: number;
  tilesPayloadSha256: string;
  createdAt: string;
  retainUntil: string | null;
}

export interface ArtifactManifest {
  schemaVersion: typeof VISUAL_ARTIFACT_SCHEMA_VERSION;
  datasetId: string;
  activeVisualRevision: string;
  previousVisualRevision: string | null;
  visualRevisions: VisualRevisionRecord[];
  updatedAt: string;
}

interface BuildSummary extends Record<string, unknown> {
  input_splats?: number;
  converted_splats?: number;
  removed_invalid_splats?: number;
  removed_opacity_filtered_splats?: number;
  opacity_filter?: number;
  sh_degree?: number;
  source_coordinate_system?: string;
  max_depth?: number;
  sampling_rate_per_level?: number;
  lod_multiplier_preset?: string;
  max_leaf_limit?: number;
  min_leaf_limit?: number;
  coverage_boost_scale?: number;
  geometric_error_layer_multiplier?: number;
  geometric_error_scale?: number;
  bounds_mode?: string;
  diagnostics?: {
    tree?: { physical_levels?: number };
  };
}

interface TilesetNode {
  boundingVolume?: { box?: number[] };
  geometricError?: number;
  content?: { uri?: string; url?: string };
  contents?: Array<{ uri?: string; url?: string }>;
  children?: TilesetNode[];
}

interface TilesetJson {
  root?: TilesetNode;
}

interface FileDigest {
  sha256: string;
  bytes: number;
}

export async function readArtifactManifest(datasetRoot: string): Promise<ArtifactManifest | null> {
  try {
    const value = JSON.parse(await readFile(path.join(datasetRoot, "artifact-manifest.json"), "utf8")) as ArtifactManifest;
    if (
      value.schemaVersion !== VISUAL_ARTIFACT_SCHEMA_VERSION ||
      typeof value.datasetId !== "string" ||
      typeof value.activeVisualRevision !== "string" ||
      !Array.isArray(value.visualRevisions)
    ) throw new Error("artifact manifest 格式无效");
    return value;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function pruneExpiredVisualRevisions(datasetRoot: string) {
  const manifest = await readArtifactManifest(datasetRoot);
  if (!manifest) return null;
  return cleanupExpiredVisualRevisions(datasetRoot, manifest);
}

export async function resolveActiveVisual(datasetRoot: string, dataset: Dataset) {
  const manifest = await readArtifactManifest(datasetRoot);
  if (manifest) {
    const record = manifest.visualRevisions.find(value => value.revision === manifest.activeVisualRevision);
    if (!record) throw new Error("活动视觉 revision 不在 artifact manifest 中");
    return { revision: record.revision, record, tilesDirectory: path.join(datasetRoot, record.relativeTilesPath) };
  }
  const tilesDirectory = path.join(datasetRoot, "tiles");
  await stat(path.join(tilesDirectory, "tileset.json"));
  return { revision: dataset.activeVisualRevision ?? `legacy-${dataset.updatedAt}`, record: null, tilesDirectory };
}

export async function resolveVisualRevision(datasetRoot: string, revision: string) {
  const manifest = await readArtifactManifest(datasetRoot);
  if (!manifest) return null;
  const record = manifest.visualRevisions.find(value => value.revision === revision);
  return record ? { record, tilesDirectory: path.join(datasetRoot, record.relativeTilesPath) } : null;
}

export async function buildLodReport(options: {
  datasetId: string;
  visualRevision: string;
  sourcePath: string;
  tilesDirectory: string;
  collisionDirectory: string;
  tilerVersion: string;
}): Promise<LodReport> {
  const summary = JSON.parse(await readFile(path.join(options.tilesDirectory, "build_summary.json"), "utf8")) as BuildSummary;
  const tileset = JSON.parse(await readFile(path.join(options.tilesDirectory, "tileset.json"), "utf8")) as TilesetJson;
  if (!tileset.root) throw new Error("LOD 报告生成失败：tileset 缺少 root");

  const sourceDigest = await hashFile(options.sourcePath);
  const collisionDigest = await hashNamedFiles(options.collisionDirectory, [
    "scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"
  ]);
  const scaleAudit = await auditGraphdecoScales(options.sourcePath);
  const levelMap = new Map<number, { tileCount: number; splatCount: number; bytes: number; min: number; max: number; sum: number }>();
  let terminalSplatCount = 0;
  let terminalTileCount = 0;

  const visit = async (node: TilesetNode, depth: number): Promise<void> => {
    const contents = node.contents ?? (node.content ? [node.content] : []);
    const level = levelMap.get(depth) ?? { tileCount: 0, splatCount: 0, bytes: 0, min: Number.POSITIVE_INFINITY, max: 0, sum: 0 };
    level.tileCount += 1;
    const geometricError = finiteNumber(node.geometricError, `depth ${depth} geometricError`);
    level.min = Math.min(level.min, geometricError);
    level.max = Math.max(level.max, geometricError);
    level.sum += geometricError;
    let nodeSplats = 0;
    for (const content of contents) {
      const uri = content.uri ?? content.url;
      if (!uri) continue;
      const filename = safeContentPath(options.tilesDirectory, uri);
      const file = await stat(filename);
      const splats = await readGlbSplatCount(filename);
      nodeSplats += splats;
      level.splatCount += splats;
      level.bytes += file.size;
    }
    levelMap.set(depth, level);
    const children = node.children ?? [];
    if (!children.length) {
      if (nodeSplats <= 0) throw new Error(`LOD 覆盖校验失败：终端 depth ${depth} 没有 Gaussian 内容`);
      terminalSplatCount += nodeSplats;
      terminalTileCount += 1;
    }
    for (const child of children) await visit(child, depth + 1);
  };
  await visit(tileset.root, 0);

  const levels: LodLevelReport[] = [...levelMap.entries()].sort(([a], [b]) => a - b).map(([depth, value]) => ({
    depth,
    tileCount: value.tileCount,
    splatCount: value.splatCount,
    bytes: value.bytes,
    geometricError: { min: value.min, max: value.max, average: value.sum / value.tileCount }
  }));
  const convertedSplats = finiteInteger(summary.converted_splats, "converted_splats");
  const expectedLevels = finiteInteger(summary.max_depth, "max_depth") + 1;
  const levelSplatCountsMonotonic = levels.every((level, index) => index === 0 || level.splatCount >= levels[index - 1]!.splatCount);
  const complete = terminalSplatCount === convertedSplats && levels.length === expectedLevels && levelSplatCountsMonotonic;
  if (!complete) {
    throw new Error(
      `LOD 覆盖校验失败：terminal=${terminalSplatCount}, converted=${convertedSplats}, levels=${levels.length}/${expectedLevels}, monotonic=${levelSplatCountsMonotonic}`
    );
  }
  const payloadDigest = await hashDirectory(options.tilesDirectory, new Set(["lod-report.json"]));
  if (payloadDigest.bytes > MAX_VISUAL_ARTIFACT_BYTES) {
    throw new Error(`高清 Tiles 为 ${(payloadDigest.bytes / 1024 / 1024).toFixed(1)} MiB，超过固定 700 MiB 发布上限；系统未自动调参`);
  }
  const shDegree = finiteInteger(summary.sh_degree, "sh_degree");
  if (scaleAudit.shDegree !== null && scaleAudit.shDegree !== shDegree) {
    throw new Error(`SH 保真校验失败：源 PLY 为 ${scaleAudit.shDegree} 阶，转换结果为 ${shDegree} 阶`);
  }
  const box = tileset.root.boundingVolume?.box;
  if (!Array.isArray(box) || box.length !== 12 || box.some(value => !Number.isFinite(value))) {
    throw new Error("LOD 报告生成失败：根包围体不是有效 3D Tiles box");
  }

  return {
    schemaVersion: 1,
    datasetId: options.datasetId,
    visualRevision: options.visualRevision,
    policyVersion: GS_LOD_POLICY_VERSION,
    source: {
      sha256: sourceDigest.sha256,
      bytes: sourceDigest.bytes,
      inputSplats: finiteInteger(summary.input_splats, "input_splats"),
      convertedSplats,
      removedInvalidSplats: finiteInteger(summary.removed_invalid_splats, "removed_invalid_splats"),
      removedOpacitySplats: finiteInteger(summary.removed_opacity_filtered_splats, "removed_opacity_filtered_splats"),
      opacityFilter: finiteNumber(summary.opacity_filter, "opacity_filter"),
      coordinateSystem: String(summary.source_coordinate_system ?? "unknown"),
      shDegree
    },
    tiler: {
      name: "3dgs-ply-3dtiles-converter",
      version: options.tilerVersion,
      parameters: {
        maxLeafSplats: finiteInteger(summary.max_leaf_limit, "max_leaf_limit"),
        minLeafSplats: finiteInteger(summary.min_leaf_limit, "min_leaf_limit"),
        samplingRatePerLevel: finiteNumber(summary.sampling_rate_per_level, "sampling_rate_per_level"),
        lodMultiplier: String(summary.lod_multiplier_preset ?? "unknown"),
        coverageBoostScale: finiteNumber(summary.coverage_boost_scale, "coverage_boost_scale"),
        opacityFilter: finiteNumber(summary.opacity_filter, "opacity_filter"),
        geometricErrorLayerMultiplier: finiteNumber(summary.geometric_error_layer_multiplier, "geometric_error_layer_multiplier"),
        geometricErrorScale: finiteNumber(summary.geometric_error_scale, "geometric_error_scale"),
        boundsMode: String(summary.bounds_mode ?? "unknown")
      }
    },
    artifact: {
      payloadSha256: payloadDigest.sha256,
      bytes: payloadDigest.bytes,
      logicalLevels: levels.length,
      physicalLevels: Number(summary.diagnostics?.tree?.physical_levels ?? levels.length),
      rootBoundingVolume: box
    },
    collisionRevision: collisionDigest.sha256,
    scaleAudit: {
      encoding: scaleAudit.available ? "graphdeco_log_scale" : "unavailable",
      above1m: scaleAudit.above1m,
      above2m: scaleAudit.above2m,
      above5m: scaleAudit.above5m
    },
    coverage: { complete, terminalSplatCount, terminalTileCount, levelSplatCountsMonotonic },
    levels,
    builtAt: new Date().toISOString()
  };
}

export async function writeLodReport(tilesDirectory: string, report: LodReport) {
  const content = `${JSON.stringify(report, null, 2)}\n`;
  if (report.artifact.bytes + Buffer.byteLength(content) > MAX_VISUAL_ARTIFACT_BYTES) {
    throw new Error("高清 Tiles 加质量报告后超过固定 700 MiB 发布上限；系统未自动调参");
  }
  await writeFile(path.join(tilesDirectory, "lod-report.json"), content);
}

export function visualRecordFromReport(report: LodReport): VisualRevisionRecord {
  return {
    revision: report.visualRevision,
    policyVersion: report.policyVersion,
    sourceSha256: report.source.sha256,
    collisionRevision: report.collisionRevision,
    relativeTilesPath: path.posix.join("visual-revisions", report.visualRevision, "tiles"),
    lodReportPath: path.posix.join("visual-revisions", report.visualRevision, "tiles", "lod-report.json"),
    tilesBytes: report.artifact.bytes,
    tilesPayloadSha256: report.artifact.payloadSha256,
    createdAt: report.builtAt,
    retainUntil: null
  };
}

export async function prepareInitialVisualLayout(datasetId: string, outputRoot: string, tilesDirectory: string, record: VisualRevisionRecord) {
  const revisionRoot = path.join(outputRoot, "visual-revisions", record.revision);
  await mkdir(revisionRoot, { recursive: true });
  await rename(tilesDirectory, path.join(revisionRoot, "tiles"));
  const now = new Date().toISOString();
  const manifest: ArtifactManifest = {
    schemaVersion: VISUAL_ARTIFACT_SCHEMA_VERSION,
    datasetId,
    activeVisualRevision: record.revision,
    previousVisualRevision: null,
    visualRevisions: [record],
    updatedAt: now
  };
  return manifest;
}

export async function writeArtifactManifestAtomic(datasetRoot: string, manifest: ArtifactManifest) {
  await mkdir(datasetRoot, { recursive: true });
  const temporary = path.join(datasetRoot, `.artifact-manifest.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path.join(datasetRoot, "artifact-manifest.json"));
}

export async function publishVisualRevision(options: {
  datasetRoot: string;
  stagedTilesDirectory: string;
  record: VisualRevisionRecord;
}) {
  let manifest = await readArtifactManifest(options.datasetRoot);
  if (!manifest) {
    manifest = await createLegacyManifest(options.datasetRoot, options.record);
  }
  if (manifest.datasetId !== path.basename(options.datasetRoot)) throw new Error("artifact manifest 与数据集目录不一致");
  if (manifest.visualRevisions.some(value => value.revision === options.record.revision)) {
    throw new Error(`视觉 revision ${options.record.revision} 已存在`);
  }
  const revisionRoot = path.join(options.datasetRoot, "visual-revisions", options.record.revision);
  await mkdir(revisionRoot, { recursive: true });
  await rename(options.stagedTilesDirectory, path.join(revisionRoot, "tiles"));

  const now = new Date();
  const retainUntil = new Date(now.getTime() + PREVIOUS_VISUAL_RETENTION_MS).toISOString();
  const previousRevision = manifest.activeVisualRevision;
  const revisions = manifest.visualRevisions.map(value => value.revision === previousRevision
    ? { ...value, retainUntil }
    : value);
  revisions.push(options.record);
  const next: ArtifactManifest = {
    ...manifest,
    activeVisualRevision: options.record.revision,
    previousVisualRevision: previousRevision,
    visualRevisions: revisions.filter(value => value.revision === previousRevision || value.revision === options.record.revision),
    updatedAt: now.toISOString()
  };
  await writeArtifactManifestAtomic(options.datasetRoot, next);
  await removeDroppedVisualRevisionBytes(options.datasetRoot, revisions, next.visualRevisions);
  await cleanupExpiredVisualRevisions(options.datasetRoot, next);
  return next;
}

export async function activateVisualRevision(options: {
  datasetRoot: string;
  revision: string;
  sourcePath: string;
}) {
  const manifest = await readArtifactManifest(options.datasetRoot);
  if (!manifest) throw new Error("当前数据集还没有版本化视觉产物");
  if (manifest.activeVisualRevision === options.revision) return manifest;
  const target = manifest.visualRevisions.find(value => value.revision === options.revision);
  if (!target) throw new Error("目标视觉 revision 不存在或已超过保留期");
  if (target.retainUntil !== null && Date.parse(target.retainUntil) <= Date.now()) {
    await cleanupExpiredVisualRevisions(options.datasetRoot, manifest);
    throw new Error("目标视觉 revision 已超过七天保留期");
  }
  await stat(path.join(options.datasetRoot, target.relativeTilesPath, "tileset.json"));
  const sourceDigest = await hashFile(options.sourcePath);
  if (sourceDigest.sha256 !== target.sourceSha256) throw new Error("目标视觉 revision 与当前源 PLY 不一致");
  const collisionDigest = await hashNamedFiles(path.join(options.datasetRoot, "collision"), [
    "scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"
  ]);
  if (collisionDigest.sha256 !== target.collisionRevision) throw new Error("目标视觉 revision 与当前碰撞产物不一致");

  const now = new Date();
  const retainUntil = new Date(now.getTime() + PREVIOUS_VISUAL_RETENTION_MS).toISOString();
  const previous = manifest.activeVisualRevision;
  const next: ArtifactManifest = {
    ...manifest,
    activeVisualRevision: target.revision,
    previousVisualRevision: previous,
    visualRevisions: manifest.visualRevisions.map(value => {
      if (value.revision === previous) return { ...value, retainUntil };
      if (value.revision === target.revision) return { ...value, retainUntil: null };
      return value;
    }).filter(value => value.revision === previous || value.revision === target.revision),
    updatedAt: now.toISOString()
  };
  await writeArtifactManifestAtomic(options.datasetRoot, next);
  await removeDroppedVisualRevisionBytes(options.datasetRoot, manifest.visualRevisions, next.visualRevisions);
  await cleanupExpiredVisualRevisions(options.datasetRoot, next);
  return next;
}

async function removeDroppedVisualRevisionBytes(
  datasetRoot: string,
  before: VisualRevisionRecord[],
  retained: VisualRevisionRecord[]
) {
  const retainedIds = new Set(retained.map(value => value.revision));
  for (const record of before) {
    if (retainedIds.has(record.revision)) continue;
    const target = path.join(datasetRoot, record.relativeTilesPath);
    if (record.relativeTilesPath === "tiles") await rm(target, { recursive: true, force: true });
    else await rm(path.dirname(target), { recursive: true, force: true });
  }
}

export async function readLodReport(datasetRoot: string, record: VisualRevisionRecord): Promise<LodReport> {
  if (!record.lodReportPath) throw new Error("该 legacy 视觉版本没有完整 LOD 报告，请先执行高清重建");
  return JSON.parse(await readFile(path.join(datasetRoot, record.lodReportPath), "utf8")) as LodReport;
}

async function createLegacyManifest(datasetRoot: string, replacement: VisualRevisionRecord): Promise<ArtifactManifest> {
  const legacyTiles = path.join(datasetRoot, "tiles");
  await stat(path.join(legacyTiles, "tileset.json"));
  const digest = await hashDirectory(legacyTiles, new Set(["lod-report.json"]));
  const summary = JSON.parse(await readFile(path.join(legacyTiles, "build_summary.json"), "utf8")) as BuildSummary;
  const created = await stat(path.join(legacyTiles, "tileset.json"));
  const legacyRevision = `legacy-${replacement.sourceSha256.slice(0, 12)}-${Math.trunc(created.mtimeMs).toString(36)}`;
  const legacy: VisualRevisionRecord = {
    revision: legacyRevision,
    policyVersion: summary.sampling_rate_per_level === 0.5 ? "gs-lod-hd-v1" : "legacy-unversioned",
    sourceSha256: replacement.sourceSha256,
    collisionRevision: replacement.collisionRevision,
    relativeTilesPath: "tiles",
    lodReportPath: null,
    tilesBytes: digest.bytes,
    tilesPayloadSha256: digest.sha256,
    createdAt: created.mtime.toISOString(),
    retainUntil: null
  };
  return {
    schemaVersion: VISUAL_ARTIFACT_SCHEMA_VERSION,
    datasetId: path.basename(datasetRoot),
    activeVisualRevision: legacyRevision,
    previousVisualRevision: null,
    visualRevisions: [legacy],
    updatedAt: new Date().toISOString()
  };
}

async function cleanupExpiredVisualRevisions(datasetRoot: string, manifest: ArtifactManifest) {
  const now = Date.now();
  const removable = manifest.visualRevisions.filter(record =>
    record.revision !== manifest.activeVisualRevision &&
    record.retainUntil !== null &&
    Date.parse(record.retainUntil) <= now
  );
  if (!removable.length) return manifest;
  const removableIds = new Set(removable.map(value => value.revision));
  const next: ArtifactManifest = {
    ...manifest,
    previousVisualRevision: manifest.previousVisualRevision && removableIds.has(manifest.previousVisualRevision)
      ? null
      : manifest.previousVisualRevision,
    visualRevisions: manifest.visualRevisions.filter(value => !removableIds.has(value.revision)),
    updatedAt: new Date().toISOString()
  };
  await writeArtifactManifestAtomic(datasetRoot, next);
  for (const record of removable) {
    const target = path.join(datasetRoot, record.relativeTilesPath);
    if (record.relativeTilesPath === "tiles") await rm(target, { recursive: true, force: true });
    else await rm(path.dirname(target), { recursive: true, force: true });
  }
  return next;
}

async function hashDirectory(directory: string, excludedBasenames: Set<string>): Promise<FileDigest> {
  const files = await listFiles(directory);
  const aggregate = createHash("sha256");
  let bytes = 0;
  for (const filename of files) {
    if (excludedBasenames.has(path.basename(filename))) continue;
    const digest = await hashFile(filename);
    const relative = path.relative(directory, filename).split(path.sep).join("/");
    aggregate.update(relative).update("\0").update(digest.sha256).update("\0");
    bytes += digest.bytes;
  }
  return { sha256: aggregate.digest("hex"), bytes };
}

async function hashNamedFiles(directory: string, names: string[]): Promise<FileDigest> {
  const aggregate = createHash("sha256");
  let bytes = 0;
  for (const name of names) {
    const digest = await hashFile(path.join(directory, name));
    aggregate.update(name).update("\0").update(digest.sha256).update("\0");
    bytes += digest.bytes;
  }
  return { sha256: aggregate.digest("hex"), bytes };
}

async function hashFile(filename: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function listFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}

async function readGlbSplatCount(filename: string) {
  const buffer = await readFile(filename);
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "glTF") throw new Error(`Tile 不是有效 GLB：${filename}`);
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8").replace(/[\u0000 ]+$/u, "")) as {
    meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
    accessors?: Array<{ count?: number }>;
  };
  const positionAccessor = json.meshes?.[0]?.primitives?.[0]?.attributes?.POSITION;
  const count = positionAccessor === undefined ? undefined : json.accessors?.[positionAccessor]?.count;
  return finiteInteger(count, `GLB POSITION count (${filename})`);
}

async function auditGraphdecoScales(filename: string) {
  const handle = await open(filename, "r");
  try {
    const headerBuffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(headerBuffer, 0, headerBuffer.length, 0);
    const headerText = headerBuffer.subarray(0, bytesRead).toString("latin1");
    const newlineMarker = headerText.includes("end_header\r\n") ? "end_header\r\n" : "end_header\n";
    const headerEnd = headerText.indexOf(newlineMarker);
    if (headerEnd < 0) return { available: false, above1m: 0, above2m: 0, above5m: 0, shDegree: null };
    const header = headerText.slice(0, headerEnd + newlineMarker.length);
    const format = /^format\s+(\S+)/m.exec(header)?.[1];
    const vertexCount = Number(/^element vertex\s+(\d+)/m.exec(header)?.[1]);
    const vertexSection = header.split(/\r?\n/);
    const properties: Array<{ name: string; size: number }> = [];
    let inVertex = false;
    for (const line of vertexSection) {
      if (line.startsWith("element ")) inVertex = line.startsWith("element vertex ");
      else if (inVertex && line.startsWith("property ")) {
        const match = /^property\s+(\S+)\s+(\S+)$/.exec(line);
        if (!match || match[1] === "list") return { available: false, above1m: 0, above2m: 0, above5m: 0, shDegree: null };
        const size = plyTypeSize(match[1]!);
        if (!size) return { available: false, above1m: 0, above2m: 0, above5m: 0, shDegree: null };
        properties.push({ name: match[2]!, size });
      }
    }
    const offsets = new Map<string, number>();
    let stride = 0;
    for (const property of properties) { offsets.set(property.name, stride); stride += property.size; }
    const scaleOffsets = ["scale_0", "scale_1", "scale_2"].map(name => offsets.get(name));
    const shRestCount = properties.filter(value => value.name.startsWith("f_rest_")).length;
    const shDegree = shRestCount === 0 ? 0 : Math.round(Math.sqrt(shRestCount / 3 + 1) - 1);
    if (format !== "binary_little_endian" || !Number.isInteger(vertexCount) || scaleOffsets.some(value => value === undefined)) {
      return { available: false, above1m: 0, above2m: 0, above5m: 0, shDegree };
    }
    const verticesPerChunk = Math.max(1, Math.floor(16 * 1024 * 1024 / stride));
    const buffer = Buffer.allocUnsafe(verticesPerChunk * stride);
    const dataOffset = headerEnd + newlineMarker.length;
    let above1m = 0; let above2m = 0; let above5m = 0; let seen = 0;
    while (seen < vertexCount) {
      const count = Math.min(verticesPerChunk, vertexCount - seen);
      const byteCount = count * stride;
      const read = await handle.read(buffer, 0, byteCount, dataOffset + seen * stride);
      if (read.bytesRead !== byteCount) throw new Error("PLY 尺度审计遇到截断的顶点数据");
      for (let index = 0; index < count; index += 1) {
        const base = index * stride;
        const maxLogScale = Math.max(...scaleOffsets.map(offset => buffer.readFloatLE(base + offset!)));
        const scale = Math.exp(maxLogScale);
        if (scale > 1) above1m += 1;
        if (scale > 2) above2m += 1;
        if (scale > 5) above5m += 1;
      }
      seen += count;
    }
    return { available: true, above1m, above2m, above5m, shDegree };
  } finally {
    await handle.close();
  }
}

function plyTypeSize(type: string) {
  const sizes: Record<string, number> = {
    char: 1, int8: 1, uchar: 1, uint8: 1,
    short: 2, int16: 2, ushort: 2, uint16: 2,
    int: 4, int32: 4, uint: 4, uint32: 4,
    float: 4, float32: 4, double: 8, float64: 8
  };
  return sizes[type] ?? 0;
}

function safeContentPath(tilesDirectory: string, uri: string) {
  const pathname = decodeURIComponent(uri.split(/[?#]/, 1)[0] ?? "");
  if (!pathname || path.isAbsolute(pathname) || pathname.split(/[\\/]/).includes("..")) {
    throw new Error(`Tileset 包含不安全的内容 URI：${uri}`);
  }
  return path.join(tilesDirectory, pathname);
}

function finiteNumber(value: unknown, name: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`LOD 报告缺少有效的 ${name}`);
  return number;
}

function finiteInteger(value: unknown, name: string) {
  const number = finiteNumber(value, name);
  if (!Number.isInteger(number) || number < 0) throw new Error(`LOD 报告缺少有效的 ${name}`);
  return number;
}

function isMissingFile(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
