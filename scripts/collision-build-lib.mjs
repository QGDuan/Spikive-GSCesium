import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';

import { directorySize, runSplatTransform } from './sog-build-lib.mjs';

export const DEFAULT_VOXEL_SIZE = 0.2;
export const DEFAULT_VOXEL_OPACITY = 0.1;
export const MIN_VOXEL_SIZE = 0.02;
export const MAX_VOXEL_SIZE = 5;
export const MAX_SOG_WORKERS = 4;

export const recommendedWorkerCount = () =>
  Math.max(1, Math.min(MAX_SOG_WORKERS, availableParallelism() - 1));

const asFiniteNumber = (value, name, minimum, maximum) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw Object.assign(new Error(`${name}必须在 ${minimum}–${maximum} 之间。`), { statusCode: 400 });
  }
  return number;
};

export const validateCollisionOptions = (options = {}) => ({
  voxelSize: asFiniteNumber(
    options.voxelSize ?? DEFAULT_VOXEL_SIZE,
    '体素边长',
    MIN_VOXEL_SIZE,
    MAX_VOXEL_SIZE
  ),
  voxelOpacity: asFiniteNumber(
    options.voxelOpacity ?? DEFAULT_VOXEL_OPACITY,
    '体素透明度阈值',
    0,
    1
  )
});

const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
};

const assertBounds = (bounds, name) => {
  if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max) ||
      bounds.min.length !== 3 || bounds.max.length !== 3) {
    throw new Error(`${name}格式无效。`);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis]) ||
        bounds.min[axis] >= bounds.max[axis]) {
      throw new Error(`${name}第 ${axis + 1} 轴范围无效。`);
    }
  }
};

const validateGlb = async (path) => {
  const stats = await stat(path);
  if (!stats.isFile() || stats.size < 20) {
    throw new Error('体素调试网格为空或文件过短。');
  }
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'glTF' ||
        header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== stats.size) {
      throw new Error('体素调试网格不是有效的 GLB 2.0 文件。');
    }
  } finally {
    await handle.close();
  }
  return stats;
};

export const validateCollisionArtifact = async (
  outputDirectory,
  expectedOptions,
  { requireCollisionMesh = false } = {}
) => {
  const jsonPath = resolve(outputDirectory, 'scene.voxel.json');
  const binPath = resolve(outputDirectory, 'scene.voxel.bin');
  const meshPath = resolve(outputDirectory, 'scene.collision.glb');
  const metadata = JSON.parse(await readFile(jsonPath, 'utf8'));

  if (metadata.version !== '1.1') {
    throw new Error(`不支持的体素格式版本：${metadata.version ?? '未知'}`);
  }
  if (metadata.leafSize !== 4 || !Number.isInteger(metadata.treeDepth) || metadata.treeDepth < 1) {
    throw new Error('体素八叉树结构无效。');
  }
  for (const key of ['numInteriorNodes', 'numMixedLeaves', 'nodeCount', 'leafDataCount']) {
    if (!Number.isSafeInteger(metadata[key]) || metadata[key] < 0) {
      throw new Error(`体素统计 ${key} 无效。`);
    }
  }
  if (metadata.nodeCount === 0 || metadata.leafDataCount === 0) {
    throw new Error('体素产物为空。');
  }
  assertBounds(metadata.gridBounds, 'gridBounds');
  assertBounds(metadata.sceneBounds, 'sceneBounds');

  const expected = validateCollisionOptions(expectedOptions);
  if (Math.abs(metadata.voxelResolution - expected.voxelSize) > 1e-9) {
    throw new Error(
      `体素分辨率不一致：期望 ${expected.voxelSize}，实际 ${metadata.voxelResolution}`
    );
  }

  const expectedBytes = (metadata.nodeCount + metadata.leafDataCount) * Uint32Array.BYTES_PER_ELEMENT;
  const binStats = await stat(binPath);
  if (!binStats.isFile() || binStats.size !== expectedBytes) {
    throw new Error(`体素二进制长度无效：期望 ${expectedBytes}，实际 ${binStats.size}`);
  }

  const meshStats = requireCollisionMesh ? await validateGlb(meshPath) : undefined;
  const disk = await directorySize(outputDirectory);
  const [metadataSha256, binarySha256, meshSha256] = await Promise.all([
    hashFile(jsonPath),
    hashFile(binPath),
    meshStats ? hashFile(meshPath) : undefined
  ]);
  const checksums = {
    'scene.voxel.json': metadataSha256,
    'scene.voxel.bin': binarySha256
  };
  if (meshSha256) checksums['scene.collision.glb'] = meshSha256;
  return {
    metadata,
    bytes: disk.bytes,
    files: disk.files,
    binaryBytes: binStats.size,
    collisionMesh: meshStats ? { file: 'scene.collision.glb', bytes: meshStats.size } : null,
    checksums
  };
};

export const createCollisionArguments = (source, output, options = {}) => {
  const validated = validateCollisionOptions(options);
  return [
    '--memory',
    source,
    '--voxel-size', String(validated.voxelSize),
    '--voxel-opacity', String(validated.voxelOpacity),
    '--collision-mesh', 'faces',
    output
  ];
};

const progressForLine = (line) => {
  const normalized = line.toLowerCase();
  if (normalized.includes('writing')) return { progress: 92, stage: '正在写入稀疏八叉树' };
  if (normalized.includes('cropping')) return { progress: 84, stage: '正在裁剪空体素边界' };
  if (normalized.includes('filtering')) return { progress: 72, stage: '正在整理体素块' };
  if (normalized.includes('voxelizing')) return { progress: 48, stage: '正在进行 GPU 并行体素化' };
  if (normalized.includes('building bvh')) return { progress: 18, stage: '正在构建 Gaussian BVH' };
  if (normalized.includes('build voxels')) return { progress: 10, stage: '正在准备体素计算' };
  return undefined;
};

export const buildOfficialCollision = async ({
  source,
  outputDirectory,
  voxelSize = DEFAULT_VOXEL_SIZE,
  voxelOpacity = DEFAULT_VOXEL_OPACITY,
  onProgress,
  onLog,
  onChild
}) => {
  const options = validateCollisionOptions({ voxelSize, voxelOpacity });
  await mkdir(outputDirectory, { recursive: true });
  const output = resolve(outputDirectory, 'scene.voxel.json');

  onProgress?.({ progress: 3, stage: '正在启动官方 GPU 体素化' });
  await runSplatTransform(
    createCollisionArguments(source, output, options),
    {
      onChild,
      onLog: (line) => {
        onLog?.(line);
        const update = progressForLine(line);
        if (update) onProgress?.(update);
      }
    }
  );

  onProgress?.({ progress: 96, stage: '正在校验体素碰撞产物' });
  const report = await validateCollisionArtifact(outputDirectory, options, {
    requireCollisionMesh: true
  });
  const manifest = {
    schemaVersion: 1,
    strategy: 'official-sparse-voxel-octree-v1',
    coordinateSystem: 'source-ply-local-z-up-meters',
    sourceToVoxelTransform: 'rotate-z-180',
    collisionMeshGenerated: true,
    collisionMeshMode: 'faces',
    collisionMeshFile: report.collisionMesh.file,
    collisionMeshDebugOnly: true,
    execution: {
      voxelization: 'WebGPU parallel',
      note: 'CPU worker 数不适用于官方体素写入；SOG 编码使用独立 worker pool。'
    },
    options,
    metadata: report.metadata,
    checksums: report.checksums,
    bytes: report.bytes,
    files: report.files,
    createdAt: new Date().toISOString()
  };
  await writeFile(
    resolve(outputDirectory, 'collision-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const disk = await directorySize(outputDirectory);
  onProgress?.({ progress: 100, stage: '体素碰撞数据构建完成' });
  return { ...report, bytes: disk.bytes, files: disk.files, manifest };
};
