import { DatabaseSync } from 'node:sqlite';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { BoundingBox, Mat4, Quat, Vec3 } from 'playcanvas';
import { createChunkDataPool, writeSource } from '@playcanvas/splat-transform';
import { nativeFileSystem, openPly } from './native-file-system.mjs';
import {
  atomicJson,
  checkCancelled,
  checkDisk,
  hashFile,
  readJson,
  safePath,
  TOOL_VERSION
} from './build-support.mjs';
import {
  buildOfficialCollision,
  validateCollisionArtifact,
  validateCollisionOptions
} from './collision-build-lib.mjs';
import { directorySize } from './sog-build-lib.mjs';

export const PARTITION_POLICY = 'native-voxel-partitions-v1';
export const MAX_PARTITION_GAUSSIANS = 1_000_000;
const MAX_PARTITIONS = 100_000;
const matchSql = 'minX<=? AND maxX>=? AND minY<=? AND maxY>=? AND minZ<=? AND maxZ>=?';

// Same public PlayCanvas box transform as upstream gaussian-aabb.ts (3-sigma).
// This only selects complete input contributors. The official GPU kernel owns occupancy.
export const createExtentCalculator = () => {
  const local = new BoundingBox(Vec3.ZERO.clone(), Vec3.ONE.clone());
  const world = new BoundingBox();
  const matrix = new Mat4();
  const q = new Quat();
  return (p, rotation, scale) => {
    if (![...p, ...rotation, ...scale].every(Number.isFinite) || Math.hypot(...rotation) < 1e-12) {
      throw new Error('源高斯包含无效位置、尺度或旋转，不能安全建立碰撞分区。');
    }
    q.set(rotation[1], rotation[2], rotation[3], rotation[0]).normalize();
    local.halfExtents.set(...scale.map((v) => 3 * Math.exp(v)));
    matrix.setTRS(new Vec3(...p), q, Vec3.ONE);
    world.setFromTransformedAabb(local, matrix);
    const e = [world.halfExtents.x, world.halfExtents.y, world.halfExtents.z].map(Math.fround);
    if (!e.every(Number.isFinite)) throw new Error('源高斯影响范围溢出，分区任务停止。');
    const c = [-p[0], -p[1], p[2]];
    // Account conservatively for float32 quaternion baking / GPU bounds rounding.
    // This expands candidate selection only, never Gaussian scales or occupancy.
    const margin = c.map((v, i) => Math.max(1, Math.abs(v), e[i]) * 2 ** -20);
    return { min: c.map((v, i) => v - e[i] - margin[i]), max: c.map((v, i) => v + e[i] + margin[i]) };
  };
};

export const createSpatialIndex = async (
  sourcePath,
  directory,
  sourceSha256,
  { signal, onProgress } = {}
) => {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, 'spatial.sqlite');
  const index = new DatabaseSync(path);
  let source, pool;
  try {
    index.exec(
      'PRAGMA journal_mode=WAL; PRAGMA cache_size=-32768; CREATE TABLE IF NOT EXISTS info(key TEXT PRIMARY KEY,value TEXT);'
    );
    const saved = index.prepare("SELECT value FROM info WHERE key='complete'").get();
    if (saved) {
      const info = JSON.parse(saved.value);
      if (
        info.sourceSha256 === sourceSha256 &&
        info.tool === TOOL_VERSION &&
        info.policy === PARTITION_POLICY &&
        index.prepare('SELECT count(*) AS n FROM bounds').get().n === info.count &&
        index.prepare('PRAGMA quick_check').get().quick_check === 'ok'
      )
        return { index, info };
    }
    index.exec(
      'DROP TABLE IF EXISTS bounds; DELETE FROM info; CREATE VIRTUAL TABLE bounds USING rtree(id,minX,maxX,minY,maxY,minZ,maxZ);'
    );
    const insert = index.prepare('INSERT INTO bounds VALUES(?,?,?,?,?,?,?)');
    source = await openPly(sourcePath);
    pool = createChunkDataPool({ chunkSize: source.meta.chunkSize, maxPooledBytes: 64 * 1024 ** 2 });
    const extent = createExtentCalculator();
    const scene = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    if (!source.meta.layouts.geometric || !source.meta.layouts.position)
      throw new Error('源文件没有完整高斯几何数据。');
    if (!source.meta.numGaussians) throw new Error('源高斯为空，不能生成碰撞数据。');
    if (source.meta.numGaussians > 0xffffffff) throw new Error('当前官方源行索引不能表示超过四十亿个高斯。');
    for (let k = 0; k < source.meta.numChunks[0]; k++) {
      checkCancelled(signal);
      const count = Math.min(source.meta.chunkSize, source.meta.numGaussians - k * source.meta.chunkSize);
      const pos = pool.acquire('position', source.meta.layouts.position, count);
      const geo = pool.acquire('geometric', source.meta.layouts.geometric, count);
      try {
        await source.read({ chunkIndex: k, position: pos, geometric: geo });
        const p = pos.field('position');
        const rotations = geo.field('rotation');
        const scales = geo.field('scale');
        index.exec('BEGIN');
        try {
          for (let i = 0; i < count; i++) {
            const b = extent(
              p.subarray(i * 3, i * 3 + 3),
              rotations.subarray(i * 4, i * 4 + 4),
              scales.subarray(i * 3, i * 3 + 3)
            );
            insert.run(
              k * source.meta.chunkSize + i,
              b.min[0],
              b.max[0],
              b.min[1],
              b.max[1],
              b.min[2],
              b.max[2]
            );
            for (let a = 0; a < 3; a++) {
              scene.min[a] = Math.min(scene.min[a], b.min[a]);
              scene.max[a] = Math.max(scene.max[a], b.max[a]);
            }
          }
          index.exec('COMMIT');
        } catch (error) {
          index.exec('ROLLBACK');
          throw error;
        }
      } finally {
        pos.release();
        geo.release();
      }
      onProgress?.({
        progress: Math.round(2 + (13 * (k + 1)) / source.meta.numChunks[0]),
        stage: `正在建立磁盘空间索引 ${k + 1}/${source.meta.numChunks[0]}`
      });
      await yieldLoop();
    }
    const info = {
      sourceSha256,
      tool: TOOL_VERSION,
      policy: PARTITION_POLICY,
      count: source.meta.numGaussians,
      sceneBounds: scene
    };
    index.prepare("INSERT INTO info VALUES('complete',?)").run(JSON.stringify(info));
    index.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { index, info };
  } catch (error) {
    index.close();
    throw error;
  } finally {
    pool?.destroy();
    await source?.close();
  }
};

export const splitCore = (core) => {
  const widths = core.max.map((v, a) => v - core.min[a]);
  const axis = widths.indexOf(Math.max(...widths));
  if (widths[axis] <= 1)
    throw Object.assign(
      new Error('最小体素块仍包含过多重叠高斯或超出设备能力，不能在不改变精度的条件下继续分区。'),
      { code: 'PARTITION_LIMIT' }
    );
  const middle = core.min[axis] + Math.floor(widths[axis] / 2);
  const first = structuredClone(core),
    second = structuredClone(core);
  first.max[axis] = middle;
  second.min[axis] = middle;
  return [first, second];
};
const parameters = (core, h) => {
  const min = core.min.map((v) => (v - 1) * 4 * h);
  const max = core.max.map((v) => (v + 1) * 4 * h);
  return [max[0], min[0], max[1], min[1], max[2], min[2]];
};
const coreKey = (core) => [...core.min, ...core.max].join('_');

export const occupiedQueryBounds = (partitions, root, voxelSize) => {
  const blockSize = 4 * voxelSize;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const part of partitions) {
    if (part.empty || part.metadata.nodeCount === 0) continue;
    const lo = part.core.min.map((v, a) =>
      Math.max(v, Math.round(part.metadata.gridBounds.min[a] / blockSize))
    );
    const hi = part.core.max.map((v, a) =>
      Math.min(v, Math.round(part.metadata.gridBounds.max[a] / blockSize))
    );
    if (lo.some((v, a) => v >= hi[a])) continue;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], lo[a]);
      max[a] = Math.max(max[a], hi[a]);
    }
  }
  // Upstream leaves the original grid bounds in place for an entirely empty SVO.
  return {
    min: (Number.isFinite(min[0]) ? min : root.min).map((v) => v * blockSize),
    max: (Number.isFinite(max[0]) ? max : root.max).map((v) => v * blockSize)
  };
};

export const materializePartition = async (source, pool, index, core, h, destination, signal) => {
  const entries = index
    .prepare(`SELECT id FROM bounds WHERE ${matchSql} ORDER BY id`)
    .all(...parameters(core, h));
  if (entries.length > MAX_PARTITION_GAUSSIANS) throw new Error('分区贡献数据超过上限。');
  const indices = Uint32Array.from(entries, (entry) => entry.id);
  if (!indices.length) return 0;
  const subset = {
    meta: {
      ...source.meta,
      numGaussians: indices.length,
      numLods: 1,
      lodCounts: [indices.length],
      numChunks: [Math.ceil(indices.length / source.meta.chunkSize)]
    },
    async read(request) {
      checkCancelled(signal);
      const start = request.chunkIndex * source.meta.chunkSize;
      const count = Math.min(source.meta.chunkSize, indices.length - start);
      const { chunkIndex: _ignored, ...target } = request;
      await source.read({ ...target, indices, indexOffset: start, count });
    },
    async close() {}
  };
  await writeSource(
    { filename: destination, outputFormat: 'ply', source: subset, pool, options: {} },
    nativeFileSystem
  );
  return indices.length;
};

const hashesMatch = async (root, checksums) => {
  try {
    for (const [name, hash] of Object.entries(checksums || {}))
      if ((await hashFile(safePath(root, name))) !== hash) return false;
  } catch {
    return false;
  }
  return Object.keys(checksums || {}).length >= 2;
};

export const buildPartitionedCollision = async ({
  source: sourcePath,
  outputDirectory,
  workDirectory,
  indexDirectory = workDirectory,
  sourceSha256,
  voxelSize,
  voxelOpacity,
  onProgress,
  onLog,
  onChild,
  signal,
  logPath
}) => {
  const options = validateCollisionOptions({ voxelSize, voxelOpacity });
  await mkdir(workDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await checkDisk(workDirectory, (await stat(sourcePath)).size * 2);
  const digest = sourceSha256 ?? (await hashFile(sourcePath));
  const { index, info } = await createSpatialIndex(sourcePath, indexDirectory, digest, {
    signal,
    onProgress
  });
  let source, pool;
  try {
    source = await openPly(sourcePath);
    pool = createChunkDataPool({ chunkSize: source.meta.chunkSize, maxPooledBytes: 64 * 1024 ** 2 });
    const h = options.voxelSize;
    const root = {
      min: info.sceneBounds.min.map((v) => Math.floor(v / (4 * h))),
      max: info.sceneBounds.max.map((v) => Math.ceil(v / (4 * h)))
    };
    for (let a = 0; a < 3; a++) if (root.max[a] <= root.min[a]) root.max[a] = root.min[a] + 1;
    if (![...root.min, ...root.max].every(Number.isSafeInteger))
      throw new Error('场景范围超出可精确表示的整数网格；请检查异常高斯，未改变源数据或分辨率。');
    const checkpointPath = resolve(workDirectory, 'partitions.json');
    const key = JSON.stringify({ digest, options, policy: PARTITION_POLICY, tool: TOOL_VERSION });
    let state = await readJson(checkpointPath);
    if (state?.key !== key) state = { key, pending: [{ core: root, retries: 0 }], completed: [] };
    const countQuery = index.prepare(
      `SELECT count(*) AS n FROM (SELECT id FROM bounds WHERE ${matchSql} LIMIT ${MAX_PARTITION_GAUSSIANS + 1})`
    );
    // Revalidate checkpoint payloads before skipping work, including empty records' provenance.
    for (const part of [...state.completed]) {
      if (part.empty) {
        if (countQuery.get(...parameters(part.core, h)).n !== 0)
          throw new Error('空分区检查点与源数据不一致，拒绝继续。');
        continue;
      }
      if (!(await hashesMatch(outputDirectory, part.checksums))) {
        state.completed = state.completed.filter((p) => p.id !== part.id);
        state.pending.push({ core: part.core, retries: 0 });
      }
    }
    while (state.pending.length) {
      checkCancelled(signal);
      if (state.completed.length + state.pending.length > MAX_PARTITIONS)
        throw new Error('分区数量超过十万，请检查场景尺度和异常高斯；没有修改体素参数。');
      const task = state.pending[state.pending.length - 1];
      const { core } = task;
      const id = coreKey(core);
      const n = countQuery.get(...parameters(core, h)).n;
      if (n && (n > MAX_PARTITION_GAUSSIANS || core.max.some((v, a) => v - core.min[a] > 32))) {
        state.pending.pop();
        state.pending.push(...splitCore(core).map((c) => ({ core: c, retries: task.retries })));
        await atomicJson(checkpointPath, state);
        continue;
      }
      if (!n) {
        state.completed.push({ id, core, empty: true, count: 0 });
        state.pending.pop();
        await atomicJson(checkpointPath, state);
        continue;
      }
      onProgress?.({
        progress:
          15 + Math.floor((75 * state.completed.length) / (state.completed.length + state.pending.length)),
        stage: `正在计算体素分区，已完成 ${state.completed.length}，待处理 ${state.pending.length}`
      });
      await checkDisk(workDirectory, n * 512);
      const input = resolve(workDirectory, 'partition-input.ply');
      await materializePartition(source, pool, index, core, h, input, signal);
      pool.trim(0);
      const directory = resolve(outputDirectory, 'parts', id);
      try {
        const report = await buildOfficialCollision({
          source: input,
          outputDirectory: directory,
          ...options,
          onLog,
          onChild,
          signal,
          logPath
        });
        checkCancelled(signal);
        const checksums = Object.fromEntries(
          Object.entries(report.checksums).map(([name, hash]) => [`parts/${id}/${name}`, hash])
        );
        state.completed.push({
          id,
          core,
          count: n,
          empty: false,
          occupancyEmpty: report.metadata.nodeCount === 0,
          file: `parts/${id}/scene.voxel.json`,
          metadata: report.metadata,
          checksums
        });
        state.pending.pop();
      } catch (error) {
        const resourceFailure = ['GPU_LOST', 'GPU_MEMORY', 'RAM'].includes(error.code);
        if (!resourceFailure || task.retries >= 2) throw error;
        const children = splitCore(core);
        await rm(directory, { recursive: true, force: true });
        onLog?.(`分区设备资源失败，缩小任务范围重试 ${task.retries + 1}/2；体素参数保持不变。`);
        state.pending.pop();
        state.pending.push(...children.map((c) => ({ core: c, retries: task.retries + 1 })));
      }
      await atomicJson(checkpointPath, state);
      await rm(input, { force: true });
      await yieldLoop();
    }
    const manifest = {
      schemaVersion: 2,
      strategy: PARTITION_POLICY,
      toolVersion: TOOL_VERSION,
      sourceSha256: digest,
      coordinateSystem: 'source-ply-local-z-up-meters',
      sourceToVoxelTransform: 'rotate-z-180',
      options,
      root,
      gridBounds: { min: root.min.map((v) => v * 4 * h), max: root.max.map((v) => v * 4 * h) },
      queryBounds: occupiedQueryBounds(state.completed, root, h),
      sourceGaussianCount: info.count,
      partitions: state.completed,
      complete: true,
      debugMesh: { status: 'not-built' },
      createdAt: new Date().toISOString()
    };
    await validatePartitionManifest(manifest, outputDirectory);
    checkCancelled(signal);
    await atomicJson(resolve(outputDirectory, 'collision-manifest.json'), manifest);
    return { manifest, ...(await directorySize(outputDirectory)) };
  } finally {
    index.close();
    pool?.destroy();
    await source?.close();
  }
};

// Debug is an independent attachment. Re-run the same official contribution set,
// verify occupancy binary against the active SVO, then publish only the GLB.
export const buildCollisionDebugMesh = async ({
  source: sourcePath,
  collisionDirectory,
  indexDirectory,
  workDirectory,
  partitionIndex = 0,
  signal,
  onLog,
  onChild,
  logPath
}) => {
  const manifest = await readJson(resolve(collisionDirectory, 'collision-manifest.json'));
  const parts =
    manifest.schemaVersion === 2 ? manifest.partitions.filter((p) => !p.empty && !p.occupancyEmpty) : [null];
  if (!Number.isInteger(partitionIndex) || partitionIndex < 0 || partitionIndex >= parts.length) {
    throw Object.assign(new Error(`调试分区编号必须在 1–${parts.length} 之间。`), { statusCode: 400 });
  }
  const part = parts[partitionIndex];
  await mkdir(workDirectory, { recursive: true });
  let input = sourcePath;
  if (part) {
    const { index } = await createSpatialIndex(sourcePath, indexDirectory, manifest.sourceSha256, { signal });
    let source, pool;
    input = resolve(workDirectory, 'partition.ply');
    try {
      source = await openPly(sourcePath);
      pool = createChunkDataPool({ chunkSize: source.meta.chunkSize, maxPooledBytes: 64 * 1024 ** 2 });
      await materializePartition(source, pool, index, part.core, manifest.options.voxelSize, input, signal);
    } finally {
      index.close();
      pool?.destroy();
      await source?.close();
    }
  }
  const outputDirectory = resolve(workDirectory, 'mesh');
  const report = await buildOfficialCollision({
    source: input,
    outputDirectory,
    ...manifest.options,
    debugMesh: true,
    signal,
    onLog,
    onChild,
    logPath
  });
  const original = part
    ? safePath(collisionDirectory, part.file)
    : resolve(collisionDirectory, 'scene.voxel.json');
  const metadata = await readJson(original);
  if (
    JSON.stringify(metadata.gridBounds) !== JSON.stringify(report.metadata.gridBounds) ||
    (await hashFile(original.replace('.voxel.json', '.voxel.bin'))) !== report.checksums['scene.voxel.bin']
  ) {
    throw new Error('调试网格重算与活动碰撞数据不一致，拒绝挂载；原碰撞数据未修改。');
  }
  checkCancelled(signal);
  return {
    meshPath: resolve(outputDirectory, report.collisionMesh.file),
    bytes: report.collisionMesh.bytes,
    partitionIndex,
    partitionCount: parts.length,
    core: part?.core ?? null
  };
};

export const validatePartitionManifest = async (manifest, directory) => {
  if (manifest.schemaVersion !== 2 || !manifest.complete || !manifest.partitions?.length)
    throw new Error('分区碰撞清单不完整。');
  validateCollisionOptions(manifest.options);
  const root = manifest.root;
  if (
    !root ||
    !Array.isArray(root.min) ||
    !Array.isArray(root.max) ||
    root.min.length !== 3 ||
    root.max.length !== 3 ||
    !root.min.every((v, a) => Number.isSafeInteger(v) && Number.isSafeInteger(root.max[a]) && v < root.max[a])
  )
    throw new Error('全局网格无效。');
  for (const edge of ['min', 'max'])
    if (!manifest.gridBounds?.[edge]?.every((v, a) => v === root[edge][a] * 4 * manifest.options.voxelSize))
      throw new Error('全局坐标与网格不一致。');
  const volume = (c) => c.max.reduce((v, x, a) => v * BigInt(x - c.min[a]), 1n);
  let total = 0n;
  const seen = new Set();
  for (const part of manifest.partitions) {
    if (seen.has(part.id)) throw new Error('重复分区。');
    seen.add(part.id);
    for (let a = 0; a < 3; a++)
      if (
        !Number.isSafeInteger(part.core.min[a]) ||
        !Number.isSafeInteger(part.core.max[a]) ||
        part.core.min[a] < root.min[a] ||
        part.core.max[a] > root.max[a] ||
        part.core.min[a] >= part.core.max[a]
      )
        throw new Error('分区范围无效。');
    total += volume(part.core);
    if (!part.empty) {
      if (
        part.file !== `parts/${part.id}/scene.voxel.json` ||
        !part.checksums?.[part.file] ||
        !part.checksums?.[part.file.replace('.json', '.bin')]
      )
        throw new Error('分区清单缺少必要产物校验值。');
      if (!(await hashesMatch(directory, part.checksums))) throw new Error(`分区 ${part.id} 校验失败。`);
      const artifact = await validateCollisionArtifact(
        resolve(safePath(directory, part.file), '..'),
        manifest.options
      );
      if (JSON.stringify(artifact.metadata) !== JSON.stringify(part.metadata))
        throw new Error('分区元数据与产物不一致。');
    }
  }
  if (total !== volume(root)) throw new Error('分区没有覆盖完整场景。');
  if (
    manifest.queryBounds &&
    JSON.stringify(manifest.queryBounds) !==
      JSON.stringify(occupiedQueryBounds(manifest.partitions, root, manifest.options.voxelSize))
  )
    throw new Error('全局有效查询边界与分区占用范围不一致。');
  // A spatial index detects overlap without an O(n²) pairwise scan.
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE boxes USING rtree(id,a,b,c,d,e,f)');
    const overlap = db.prepare('SELECT id FROM boxes WHERE a<? AND b>? AND c<? AND d>? AND e<? AND f>?');
    const add = db.prepare('INSERT INTO boxes VALUES(?,?,?,?,?,?,?)');
    for (const [i, p] of manifest.partitions.entries()) {
      const { min, max } = p.core;
      // rtree coordinates round outward; perform the exact integer check too.
      for (const hit of overlap.all(max[0], min[0], max[1], min[1], max[2], min[2])) {
        const q = manifest.partitions[hit.id].core;
        if ([0, 1, 2].every((a) => min[a] < q.max[a] && max[a] > q.min[a]))
          throw new Error('分区核心范围重叠。');
      }
      add.run(i, min[0], max[0], min[1], max[1], min[2], max[2]);
    }
  } finally {
    db.close();
  }
};
