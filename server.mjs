import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, freemem, totalmem } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  buildOfficialSog,
  createLodRatios,
  getSogWorkerCount,
  projectRoot,
  validateSogArtifact
} from './scripts/sog-build-lib.mjs';
import {
  buildOfficialCollision,
  DEFAULT_VOXEL_OPACITY,
  DEFAULT_VOXEL_SIZE,
  validateCollisionOptions
} from './scripts/collision-build-lib.mjs';
import { LabelStore, LABEL_TYPES } from './server/label-store.mjs';
import { MissionStore } from './server/mission-store.mjs';
import { planMission } from './server/route-planner.mjs';
import {
  PLY_SOURCE_TO_VOXEL_IDENTITY,
  VoxelWorldRepository
} from './server/voxel-world.mjs';

const production = process.argv.includes('--production');
const port = Number(process.env.SPIKIVE_PORT || 5173);
const dataRoot = resolve(process.env.SPIKIVE_DATA_ROOT || resolve(projectRoot, 'var'));
const datasetsRoot = resolve(dataRoot, 'local-datasets');
const labelDatabasePath = resolve(dataRoot, 'labels.sqlite');
const publicRoot = resolve(process.env.SPIKIVE_PUBLIC_ROOT || resolve(projectRoot, 'public'));
const distRoot = resolve(process.env.SPIKIVE_DIST_ROOT || resolve(projectRoot, 'dist'));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_PATTERN = /^[0-9A-Za-z_-]+$/;
const FIXED_SELECTION_RADIUS_PIXELS = 5;
const SURFACE_SELECTION_METHOD = 'playcanvas-picker-depth-pca-v2';
const SURFACE_PICK_BACKEND = 'playcanvas-native-depth-picker';
const SURFACE_SELECTION_DATA_SOURCE = 'rendered-alpha-front-surface';

let activeBuildId;
let activeCollisionId;
let activeChild;
const buildRuntime = new Map();
const collisionRuntime = new Map();
let vite;
let labelStore;
let missionStore;
const voxelRepository = new VoxelWorldRepository(2 * 1024 ** 3, {
  coordinateTransform: PLY_SOURCE_TO_VOXEL_IDENTITY
});

const datasetDirectory = (id) => {
  if (!UUID_PATTERN.test(id)) {
    throw Object.assign(new Error('数据集编号无效。'), { statusCode: 400 });
  }
  return resolve(datasetsRoot, id);
};

const isMissing = (error) => error && typeof error === 'object' && error.code === 'ENOENT';

const sendJson = (response, statusCode, body) => {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store'
  });
  response.end(payload);
};

const readJsonBody = async (request, maxBytes = 64 * 1024) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw Object.assign(new Error('请求内容过大。'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('请求内容格式无效。'), { statusCode: 400 });
  }
};

const readDataset = async (id) => {
  try {
    return JSON.parse(await readFile(resolve(datasetDirectory(id), 'dataset.json'), 'utf8'));
  } catch (error) {
    if (isMissing(error)) {
      throw Object.assign(new Error('数据集不存在。'), { statusCode: 404 });
    }
    throw error;
  }
};

const writeDataset = async (dataset) => {
  const directory = datasetDirectory(dataset.id);
  await mkdir(directory, { recursive: true });
  dataset.updatedAt = new Date().toISOString();
  const temporary = resolve(directory, `dataset.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(dataset, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, resolve(directory, 'dataset.json'));
  return dataset;
};

const labelsPath = (id) => resolve(datasetDirectory(id), 'labels.json');

const readLabels = async (id) => {
  try {
    const parsed = JSON.parse(await readFile(labelsPath(id), 'utf8'));
    return Array.isArray(parsed.labels) ? parsed.labels : [];
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

const parseVector = (value, name) => {
  if (!value || !['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]))) {
    throw Object.assign(new Error(`${name}必须是有限的三维坐标。`), { statusCode: 400 });
  }
  return { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
};

const parseSelectionRadius = (value) => {
  const radius = Number(value);
  if (radius !== FIXED_SELECTION_RADIUS_PIXELS) {
    throw Object.assign(new Error(`巡检点圆形选择半径固定为 ${FIXED_SELECTION_RADIUS_PIXELS} 像素。`), { statusCode: 400 });
  }
  return FIXED_SELECTION_RADIUS_PIXELS;
};

const parseNormal = (value) => {
  const normal = parseVector(value, '表面法向');
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (length < 0.9 || length > 1.1) {
    throw Object.assign(new Error('表面法向必须是单位向量。'), { statusCode: 400 });
  }
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
};

const parseRouteNumber = (value, name, { minimum = 0, exclusiveMinimum = false, maximum = 10_000 } = {}) => {
  const number = Number(value);
  const belowMinimum = exclusiveMinimum ? number <= minimum : number < minimum;
  if (!Number.isFinite(number) || belowMinimum || number > maximum) {
    const operator = exclusiveMinimum ? '大于' : '不小于';
    throw Object.assign(new Error(`${name}必须${operator} ${minimum} 且不超过 ${maximum}。`), { statusCode: 400 });
  }
  if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-8) {
    throw Object.assign(new Error(`${name}最多保留一位小数。`), { statusCode: 400 });
  }
  return Math.round(number * 10) / 10;
};

const parseMissionProfile = (value) => {
  if (!value || typeof value !== 'object') {
    throw Object.assign(new Error('缺少航线参数。'), { statusCode: 400 });
  }
  const profile = {
    speed: parseRouteNumber(value.speed, '飞行速度', { exclusiveMinimum: true }),
    inflationRadius: parseRouteNumber(value.inflationRadius, '无人机膨胀系数', { exclusiveMinimum: true }),
    observationDistance: parseRouteNumber(value.observationDistance, '观察距离', { exclusiveMinimum: true }),
    minimumSpacing: parseRouteNumber(value.minimumSpacing, '最小点间距'),
    maximumSpacing: parseRouteNumber(value.maximumSpacing, '最大点间距', { exclusiveMinimum: true })
  };
  if (profile.maximumSpacing < profile.minimumSpacing) {
    throw Object.assign(new Error('最大点间距不能小于最小点间距。'), { statusCode: 400 });
  }
  return profile;
};

const getMissionOrThrow = (id) => {
  if (!UUID_PATTERN.test(id)) {
    throw Object.assign(new Error('航线编号无效。'), { statusCode: 400 });
  }
  const mission = missionStore.get(id);
  if (!mission) throw Object.assign(new Error('航线不存在。'), { statusCode: 404 });
  return mission;
};

const validateMissionInput = (dataset, input) => {
  if (dataset.builtin || !dataset.visual || !dataset.source?.sha256) {
    throw Object.assign(new Error('航线只能绑定已切片的自定义场景。'), { statusCode: 409 });
  }
  const startLabelId = typeof input.startLabelId === 'string' ? input.startLabelId : '';
  const labelIds = Array.isArray(input.labelIds) ? input.labelIds : [];
  if (!UUID_PATTERN.test(startLabelId)) {
    throw Object.assign(new Error('航线必须指定有效的起点标签。'), { statusCode: 400 });
  }
  if (labelIds.length === 0) {
    throw Object.assign(new Error('航线至少需要一个巡检标签。'), { statusCode: 400 });
  }
  if (labelIds.some((id) => !UUID_PATTERN.test(id)) || new Set(labelIds).size !== labelIds.length) {
    throw Object.assign(new Error('巡检标签列表包含无效或重复编号。'), { statusCode: 400 });
  }
  if (labelIds.includes(startLabelId)) {
    throw Object.assign(new Error('起点不能重复加入巡检标签序列。'), { statusCode: 400 });
  }
  const startLabel = labelStore.get(startLabelId);
  if (!startLabel || startLabel.datasetId !== dataset.id || startLabel.type !== '起点') {
    throw Object.assign(new Error('指定标签不是当前场景的起点。'), { statusCode: 400 });
  }
  const labels = labelIds.map((id) => labelStore.get(id));
  if (labels.some((label) => !label || label.datasetId !== dataset.id || label.type === '起点')) {
    throw Object.assign(new Error('巡检标签必须全部属于当前场景，且不能是起点。'), { statusCode: 400 });
  }
  const staleStart = !startLabel.resolved || !startLabel.normal || startLabel.visualRevision !== dataset.activeVisualRevision ||
    startLabel.sourceSha256 !== dataset.source.sha256;
  const stale = labels.find((label) => !label.resolved || !label.normal ||
    label.visualRevision !== dataset.activeVisualRevision || label.sourceSha256 !== dataset.source.sha256);
  if (staleStart) {
    throw Object.assign(new Error(`起点“${startLabel.title}”不属于当前视觉版本，请重新选择。`), { statusCode: 409 });
  }
  if (stale) {
    throw Object.assign(new Error(`标签“${stale.title}”缺少当前视觉版本的可靠位置或法向，请重新选择。`), { statusCode: 409 });
  }
  return {
    name: input.name,
    startLabelId,
    labelIds,
    profile: parseMissionProfile(input.profile),
    startLabel,
    labels
  };
};

const emptyCollision = () => ({
  status: 'not-built',
  progress: 0,
  stage: '尚未计算体素',
  error: null,
  revision: null,
  voxelSize: DEFAULT_VOXEL_SIZE,
  voxelOpacity: DEFAULT_VOXEL_OPACITY
});

const exposeDataset = (dataset) => {
  const runtime = buildRuntime.get(dataset.id);
  const collision = {
    ...emptyCollision(),
    ...(dataset.collision || {}),
    ...(collisionRuntime.get(dataset.id) || {})
  };
  if (collision.revision) {
    collision.coordinateSystem = 'source-ply-local-z-up-meters';
    collision.sourceToVoxelTransform = 'rotate-z-180';
  }
  return {
    ...dataset,
    ...(runtime || {}),
    collision,
    labelCount: dataset.id === 'builtin' ? 0 : labelStore.count(dataset.id),
    missionCount: dataset.id === 'builtin' ? 0 : missionStore.count(dataset.id),
    source: dataset.source
      ? { bytes: dataset.source.bytes, sha256: dataset.source.sha256 }
      : undefined
  };
};

let builtInDatasetPromise;

const readBuiltInDataset = async () => {
  if (builtInDatasetPromise) {
    return builtInDatasetPromise;
  }
  builtInDatasetPromise = (async () => {
    const path = resolve(publicRoot, 'data/point_cloud-lod/lod-meta.json');
    try {
      const meta = JSON.parse(await readFile(path, 'utf8'));
      return {
        id: 'builtin',
        name: '内置示例场景',
        status: 'ready',
        progress: 100,
        stage: '可视化就绪',
        lodLevels: meta.lodLevels,
        ratios: meta.counts.map((count) => Math.round((count / meta.counts[0]) * 100)),
        activeVisualRevision: 'builtin',
        visual: {
          revision: 'builtin',
          renderUrl: '/data/point_cloud-lod/lod-meta.json',
          counts: meta.counts,
          gaussianEntries: meta.count,
          chunkCount: meta.filenames?.length ?? 0
        },
        collision: {
          ...emptyCollision(),
          status: 'unavailable',
          stage: '内置场景不提供体素计算'
        },
        labelCount: 0,
        missionCount: 0,
        createdAt: null,
        updatedAt: null,
        builtin: true
      };
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      console.warn('内置场景元数据读取失败：', error);
      return undefined;
    }
  })();
  return builtInDatasetPromise;
};

const listDatasets = async () => {
  await mkdir(datasetsRoot, { recursive: true });
  const entries = await readdir(datasetsRoot, { withFileTypes: true });
  const datasets = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) {
      continue;
    }
    try {
      datasets.push(exposeDataset(await readDataset(entry.name)));
    } catch (error) {
      console.warn(`忽略无法读取的数据集 ${entry.name}：`, error);
    }
  }
  datasets.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const builtIn = await readBuiltInDataset();
  return builtIn ? [builtIn, ...datasets] : datasets;
};

const appendBuildLog = (id, line) => {
  const runtime = buildRuntime.get(id);
  if (!runtime) {
    return;
  }
  runtime.logTail.push(line);
  if (runtime.logTail.length > 24) {
    runtime.logTail.splice(0, runtime.logTail.length - 24);
  }
};

const createRevision = () =>
  `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;

const runBuild = async (id) => {
  const directory = datasetDirectory(id);
  const source = resolve(directory, 'source.ply');
  const revision = createRevision();
  const workDirectory = resolve(directory, 'work', revision);
  const stagedOutputDirectory = resolve(workDirectory, 'sog');
  const finalDirectory = resolve(directory, 'visual-revisions', revision);
  let published = false;

  try {
    const dataset = await readDataset(id);
    const runtime = buildRuntime.get(id);
    await mkdir(stagedOutputDirectory, { recursive: true });
    const buildResult = await buildOfficialSog({
      source,
      output: resolve(stagedOutputDirectory, 'lod-meta.json'),
      workDirectory: resolve(workDirectory, 'levels'),
      levelCount: dataset.lodLevels,
      onProgress: ({ progress, stage }) => {
        if (runtime) {
          runtime.progress = progress;
          runtime.stage = stage;
        }
      },
      onLog: (line) => appendBuildLog(id, line),
      onChild: (child) => {
        activeChild = child;
      }
    });

    if (runtime) {
      runtime.progress = 96;
      runtime.stage = '正在校验并发布切片';
    }
    const report = await validateSogArtifact(stagedOutputDirectory, dataset.lodLevels);
    if (report.counts[0] <= 0) {
      throw new Error('第零层未保留有效高斯点。');
    }
    await mkdir(resolve(directory, 'visual-revisions'), { recursive: true });
    await rename(stagedOutputDirectory, finalDirectory);
    published = true;

    const current = await readDataset(id);
    current.status = 'ready';
    current.progress = 100;
    current.stage = '可视化就绪';
    current.error = null;
    current.activeVisualRevision = revision;
    current.visual = {
      revision,
      renderUrl: `/api/datasets/${id}/visual-revisions/${revision}/lod-meta.json`,
      counts: report.counts,
      gaussianEntries: report.gaussianEntries,
      chunkCount: report.chunkCount,
      files: report.files,
      bytes: report.bytes,
      generator: report.meta.asset?.generator ?? '@playcanvas/splat-transform',
      workerCount: buildResult.workerCount
    };
    missionStore.invalidateDatasetVisual(id);
    await writeDataset(current);
    await rm(workDirectory, { recursive: true, force: true });
  } catch (error) {
    const current = await readDataset(id);
    const hasActiveVisual = Boolean(current.activeVisualRevision && current.visual);
    current.status = hasActiveVisual ? 'ready' : 'failed';
    current.progress = buildRuntime.get(id)?.progress ?? current.progress ?? 0;
    current.stage = hasActiveVisual ? '切片任务失败，保留当前切片' : '切片失败';
    current.error = error instanceof Error ? error.message : String(error);
    current.buildLogTail = buildRuntime.get(id)?.logTail ?? [];
    await writeDataset(current);
    console.error(`数据集 ${id} 构建失败：`, error);
    if (published) {
      console.error(`注意：新产物已发布但未激活，目录为 ${finalDirectory}`);
    }
  } finally {
    activeChild = undefined;
    activeBuildId = undefined;
    buildRuntime.delete(id);
  }
};

const appendCollisionLog = (id, line) => {
  const runtime = collisionRuntime.get(id);
  if (!runtime) {
    return;
  }
  runtime.logTail.push(line);
  if (runtime.logTail.length > 24) {
    runtime.logTail.splice(0, runtime.logTail.length - 24);
  }
};

const runCollisionBuild = async (id, options) => {
  const directory = datasetDirectory(id);
  const revision = createRevision();
  const workDirectory = resolve(directory, 'collision-work', revision);
  const stagedOutputDirectory = resolve(workDirectory, 'collision');
  const finalDirectory = resolve(directory, 'collision-revisions', revision);
  let published = false;

  try {
    const dataset = await readDataset(id);
    const runtime = collisionRuntime.get(id);
    const report = await buildOfficialCollision({
      source: resolve(directory, 'source.ply'),
      outputDirectory: stagedOutputDirectory,
      ...options,
      onProgress: ({ progress, stage }) => {
        if (runtime) {
          runtime.progress = progress;
          runtime.stage = stage;
        }
      },
      onLog: (line) => appendCollisionLog(id, line),
      onChild: (child) => {
        activeChild = child;
      }
    });

    if (runtime) {
      runtime.progress = 98;
      runtime.stage = '正在原子发布体素版本';
    }
    await mkdir(resolve(directory, 'collision-revisions'), { recursive: true });
    await rename(stagedOutputDirectory, finalDirectory);
    published = true;

    const current = await readDataset(id);
    current.activeCollisionRevision = revision;
    current.collision = {
      status: 'ready',
      progress: 100,
      stage: '体素碰撞数据已就绪',
      error: null,
      revision,
      voxelSize: options.voxelSize,
      voxelOpacity: options.voxelOpacity,
      sourceSha256: dataset.source.sha256,
      sourceVisualRevision: dataset.activeVisualRevision,
      coordinateSystem: 'source-ply-local-z-up-meters',
      sourceToVoxelTransform: 'rotate-z-180',
      generator: report.metadata.asset?.generator ?? '@playcanvas/splat-transform',
      execution: 'WebGPU parallel',
      bytes: report.bytes,
      files: report.files,
      nodeCount: report.metadata.nodeCount,
      leafDataCount: report.metadata.leafDataCount,
      treeDepth: report.metadata.treeDepth,
      gridBounds: report.metadata.gridBounds,
      checksums: report.checksums,
      debugMeshUrl:
        `/api/datasets/${id}/collision-revisions/${revision}/${report.collisionMesh.file}`,
      debugMeshBytes: report.collisionMesh.bytes,
      debugMeshMode: 'faces',
      createdAt: new Date().toISOString()
    };
    missionStore.invalidateDatasetCollision(id, revision);
    await writeDataset(current);
    voxelRepository.invalidateDataset(id);
    await rm(workDirectory, { recursive: true, force: true });
  } catch (error) {
    const current = await readDataset(id);
    const previous = current.activeCollisionRevision && current.collision?.revision
      ? current.collision
      : emptyCollision();
    current.collision = {
      ...previous,
      status: previous.revision ? 'ready' : 'failed',
      progress: collisionRuntime.get(id)?.progress ?? 0,
      stage: previous.revision ? '重新计算失败，保留上一版体素' : '体素计算失败',
      error: error instanceof Error ? error.message : String(error),
      failedLogTail: collisionRuntime.get(id)?.logTail ?? [],
      requestedOptions: options
    };
    await writeDataset(current);
    console.error(`数据集 ${id} 体素构建失败：`, error);
    if (published) {
      console.error(`注意：新体素已发布但未激活，目录为 ${finalDirectory}`);
    }
  } finally {
    activeChild = undefined;
    activeCollisionId = undefined;
    collisionRuntime.delete(id);
  }
};

const streamUpload = async (request, dataset) => {
  const expectedBytes = Number(dataset.expectedBytes);
  const contentLength = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(contentLength) || contentLength !== expectedBytes) {
    throw Object.assign(new Error(`上传大小不一致：期望 ${expectedBytes} 字节。`), { statusCode: 400 });
  }

  const directory = datasetDirectory(dataset.id);
  const temporary = resolve(directory, `source.${randomUUID()}.part`);
  const destination = resolve(directory, 'source.ply');
  const hash = createHash('sha256');
  let receivedBytes = 0;
  const observer = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > expectedBytes) {
        callback(new Error('上传数据超过声明大小。'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(request, observer, createWriteStream(temporary, { flags: 'wx' }));
    if (receivedBytes !== expectedBytes) {
      throw new Error(`上传不完整：收到 ${receivedBytes} / ${expectedBytes} 字节。`);
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  dataset.status = 'uploaded';
  dataset.progress = 0;
  dataset.stage = '高斯点云文件已上传，等待切片';
  dataset.error = null;
  dataset.source = { bytes: receivedBytes, sha256: hash.digest('hex') };
  await writeDataset(dataset);
};

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.glb', 'model/gltf-binary'],
  ['.ply', 'application/octet-stream'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

const serveFile = async (request, response, path, cacheControl = 'no-cache') => {
  const fileStats = await stat(path);
  if (!fileStats.isFile()) {
    return false;
  }
  const type = contentTypes.get(extname(path).toLowerCase()) || 'application/octet-stream';
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` });
      response.end();
      return true;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : fileStats.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= fileStats.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${fileStats.size}` });
      response.end();
      return true;
    }
    response.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${fileStats.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl
    });
    createReadStream(path, { start, end }).pipe(response);
    return true;
  }

  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': fileStats.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl
  });
  createReadStream(path).pipe(response);
  return true;
};

let previousCpuTimes;
let previousProcessCpu = process.cpuUsage();
let previousProcessTime = process.hrtime.bigint();

const sampleSystemMetrics = () => {
  const cores = cpus();
  const totals = cores.reduce(
    (result, core) => {
      const total = Object.values(core.times).reduce((sum, value) => sum + value, 0);
      result.total += total;
      result.idle += core.times.idle;
      return result;
    },
    { total: 0, idle: 0 }
  );
  let systemCpuPercent = null;
  if (previousCpuTimes) {
    const totalDelta = totals.total - previousCpuTimes.total;
    const idleDelta = totals.idle - previousCpuTimes.idle;
    if (totalDelta > 0) {
      systemCpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
    }
  }
  previousCpuTimes = totals;

  const now = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const elapsedMicroseconds = Number(now - previousProcessTime) / 1_000;
  const processCpuDelta = cpu.user + cpu.system - previousProcessCpu.user - previousProcessCpu.system;
  const processCpuPercent = elapsedMicroseconds > 0 ? (processCpuDelta / elapsedMicroseconds) * 100 : null;
  previousProcessCpu = cpu;
  previousProcessTime = now;
  const memory = process.memoryUsage();

  return {
    sampledAt: new Date().toISOString(),
    cpu: {
      logicalCores: cores.length,
      systemPercent: systemCpuPercent,
      serverProcessPercent: processCpuPercent
    },
    memory: {
      systemTotalBytes: totalmem(),
      systemUsedBytes: totalmem() - freemem(),
      serverRssBytes: memory.rss,
      serverHeapUsedBytes: memory.heapUsed
    },
    gpu: {
      utilizationPercent: null,
      physicalVramUsedBytes: null,
      reason: '浏览器与跨平台服务端接口不提供可靠的物理图形处理器利用率和显存占用。'
    }
  };
};

const handleApi = async (request, response, url) => {
  if (request.method === 'GET' && url.pathname === '/api/datasets') {
    sendJson(response, 200, {
      datasets: await listDatasets(),
      activeTask: activeBuildId
        ? { type: 'visual', datasetId: activeBuildId }
        : activeCollisionId
          ? { type: 'collision', datasetId: activeCollisionId }
          : null,
      sogWorkerCount: getSogWorkerCount()
    });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/system-metrics') {
    sendJson(response, 200, sampleSystemMetrics());
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/datasets') {
    const body = await readJsonBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const expectedBytes = Number(body.size);
    const lodLevels = body.lodLevels === undefined ? 5 : Number(body.lodLevels);
    if (!name || name.length > 180 || !name.toLowerCase().endsWith('.ply')) {
      throw Object.assign(new Error('请选择有效的高斯点云文件。'), { statusCode: 400 });
    }
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
      throw Object.assign(new Error('高斯点云文件大小无效。'), { statusCode: 400 });
    }
    const ratios = createLodRatios(lodLevels);
    const now = new Date().toISOString();
    const dataset = {
      id: randomUUID(),
      name,
      expectedBytes,
      lodLevels,
      ratios,
      status: 'awaiting-upload',
      progress: 0,
      stage: '等待上传高斯点云文件',
      error: null,
      activeVisualRevision: null,
      visual: null,
      activeCollisionRevision: null,
      collision: emptyCollision(),
      labelCount: 0,
      coordinateSystem: 'local-z-up-meters',
      createdAt: now,
      updatedAt: now
    };
    await writeDataset(dataset);
    sendJson(response, 201, exposeDataset(dataset));
    return true;
  }

  const uploadMatch = /^\/api\/datasets\/([^/]+)\/source$/.exec(url.pathname);
  if (request.method === 'PUT' && uploadMatch) {
    const dataset = await readDataset(uploadMatch[1]);
    if (dataset.status !== 'awaiting-upload') {
      throw Object.assign(new Error('当前数据集状态不允许重新上传。'), { statusCode: 409 });
    }
    await streamUpload(request, dataset);
    sendJson(response, 200, exposeDataset(dataset));
    return true;
  }

  const buildMatch = /^\/api\/datasets\/([^/]+)\/build$/.exec(url.pathname);
  if (request.method === 'POST' && buildMatch) {
    const dataset = await readDataset(buildMatch[1]);
    if (!['uploaded', 'failed'].includes(dataset.status) || dataset.visual || dataset.activeVisualRevision) {
      throw Object.assign(new Error('切片成功后视觉版本锁定，不允许重新切片。'), { statusCode: 409 });
    }
    const body = await readJsonBody(request);
    const lodLevels = body.lodLevels === undefined ? dataset.lodLevels : Number(body.lodLevels);
    const ratios = createLodRatios(lodLevels);
    await access(resolve(datasetDirectory(dataset.id), 'source.ply'));
    if (activeBuildId || activeCollisionId) {
      throw Object.assign(new Error('已有切片或体素重任务正在执行，请等待其完成。'), { statusCode: 409 });
    }
    activeBuildId = dataset.id;
    buildRuntime.set(dataset.id, { progress: 0, stage: '准备切片', logTail: [] });
    dataset.lodLevels = lodLevels;
    dataset.ratios = ratios;
    dataset.status = 'building';
    dataset.progress = 0;
    dataset.stage = '准备切片';
    dataset.error = null;
    await writeDataset(dataset);
    void runBuild(dataset.id);
    sendJson(response, 202, exposeDataset(dataset));
    return true;
  }

  const collisionBuildMatch = /^\/api\/datasets\/([^/]+)\/collision\/build$/.exec(url.pathname);
  if (request.method === 'POST' && collisionBuildMatch) {
    const dataset = await readDataset(collisionBuildMatch[1]);
    if (!dataset.visual || !dataset.activeVisualRevision || dataset.status === 'building') {
      throw Object.assign(new Error('必须先完成切片，才能计算体素碰撞数据。'), { statusCode: 409 });
    }
    if (activeBuildId || activeCollisionId) {
      throw Object.assign(new Error('已有切片或体素重任务正在执行，请等待其完成。'), { statusCode: 409 });
    }
    const options = validateCollisionOptions(await readJsonBody(request));
    await access(resolve(datasetDirectory(dataset.id), 'source.ply'));
    activeCollisionId = dataset.id;
    collisionRuntime.set(dataset.id, {
      status: 'building',
      progress: 0,
      stage: '准备体素计算',
      error: null,
      logTail: []
    });
    dataset.collision = {
      ...(dataset.collision || emptyCollision()),
      status: 'building',
      progress: 0,
      stage: dataset.activeCollisionRevision ? '准备重新计算体素' : '准备体素计算',
      error: null,
      requestedOptions: options
    };
    await writeDataset(dataset);
    void runCollisionBuild(dataset.id, options);
    sendJson(response, 202, exposeDataset(dataset));
    return true;
  }

  const missionsMatch = /^\/api\/datasets\/([^/]+)\/missions$/.exec(url.pathname);
  if (missionsMatch) {
    const dataset = await readDataset(missionsMatch[1]);
    if (request.method === 'GET') {
      sendJson(response, 200, { datasetId: dataset.id, missions: missionStore.list(dataset.id) });
      return true;
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request);
      const input = validateMissionInput(dataset, body);
      const mission = missionStore.create({ id: randomUUID(), datasetId: dataset.id, ...input });
      sendJson(response, 201, mission);
      return true;
    }
  }

  const missionPlanMatch = /^\/api\/missions\/([^/]+)\/plan$/.exec(url.pathname);
  if (request.method === 'POST' && missionPlanMatch) {
    const mission = getMissionOrThrow(missionPlanMatch[1]);
    const dataset = await readDataset(mission.datasetId);
    if (!dataset.activeCollisionRevision || dataset.collision?.status !== 'ready' ||
        dataset.collision.revision !== dataset.activeCollisionRevision) {
      throw Object.assign(new Error('当前场景尚无可用体素，请先完成体素计算。'), { statusCode: 409 });
    }
    if (dataset.collision.sourceSha256 !== dataset.source?.sha256) {
      throw Object.assign(new Error('体素数据与当前源高斯点云不一致，请重新计算体素。'), { statusCode: 409 });
    }
    const input = validateMissionInput(dataset, mission);
    const jsonPath = resolve(
      datasetDirectory(dataset.id), 'collision-revisions', dataset.activeCollisionRevision, 'scene.voxel.json'
    );
    const collision = await voxelRepository.get(`${dataset.id}:${dataset.activeCollisionRevision}`, jsonPath);
    const currentDataset = await readDataset(dataset.id);
    const currentMission = missionStore.get(mission.id);
    if (!currentMission || currentMission.updatedAt !== mission.updatedAt ||
        currentDataset.activeCollisionRevision !== dataset.activeCollisionRevision) {
      throw Object.assign(new Error('航线或体素版本在计算准备期间已变化，请重新规划。'), { statusCode: 409 });
    }
    const result = planMission({
      startLabel: input.startLabel,
      labels: input.labels,
      profile: input.profile,
      collision
    });
    const saved = missionStore.savePlan(mission.id, {
      ...result,
      collisionRevision: dataset.activeCollisionRevision
    });
    sendJson(response, 200, saved);
    return true;
  }

  const missionMatch = /^\/api\/missions\/([^/]+)$/.exec(url.pathname);
  if (missionMatch) {
    const mission = getMissionOrThrow(missionMatch[1]);
    if (request.method === 'GET') {
      sendJson(response, 200, mission);
      return true;
    }
    if (request.method === 'PATCH') {
      const dataset = await readDataset(mission.datasetId);
      const body = await readJsonBody(request);
      const merged = {
        name: body.name ?? mission.name,
        startLabelId: body.startLabelId ?? mission.startLabelId,
        labelIds: body.labelIds ?? mission.labelIds,
        profile: body.profile ? { ...mission.profile, ...body.profile } : mission.profile
      };
      const input = validateMissionInput(dataset, merged);
      sendJson(response, 200, missionStore.update(mission.id, input));
      return true;
    }
    if (request.method === 'DELETE') {
      sendJson(response, 200, { deleted: true, mission: missionStore.delete(mission.id) });
      return true;
    }
  }

  const labelsMatch = /^\/api\/datasets\/([^/]+)\/labels$/.exec(url.pathname);
  if (request.method === 'GET' && labelsMatch) {
    const dataset = await readDataset(labelsMatch[1]);
    const type = url.searchParams.get('type') || undefined;
    const query = url.searchParams.get('q') || '';
    const limit = Number(url.searchParams.get('limit') || 200);
    const offset = Number(url.searchParams.get('offset') || 0);
    const result = labelStore.list(dataset.id, { type, query, limit, offset });
    const startLabel = labelStore.getStart(dataset.id);
    sendJson(response, 200, {
      datasetId: dataset.id,
      sourceSha256: dataset.source?.sha256 ?? null,
      visualRevision: dataset.activeVisualRevision ?? null,
      startLabelId: startLabel?.id ?? null,
      selectionDefaults: { selectionRadiusPixels: FIXED_SELECTION_RADIUS_PIXELS },
      labelTypes: LABEL_TYPES,
      ...result
    });
    return true;
  }

  const labelSpatialMatch = /^\/api\/datasets\/([^/]+)\/labels\/spatial$/.exec(url.pathname);
  if (request.method === 'GET' && labelSpatialMatch) {
    const dataset = await readDataset(labelSpatialMatch[1]);
    if (!['x', 'y', 'z', 'radius'].every((name) => url.searchParams.has(name))) {
      throw Object.assign(new Error('空间查询缺少横坐标、纵坐标、竖坐标或半径。'), { statusCode: 400 });
    }
    const labels = labelStore.spatial(dataset.id, {
      x: Number(url.searchParams.get('x')),
      y: Number(url.searchParams.get('y')),
      z: Number(url.searchParams.get('z')),
      radius: Number(url.searchParams.get('radius')),
      type: url.searchParams.get('type') || undefined,
      limit: Number(url.searchParams.get('limit') || 200)
    });
    sendJson(response, 200, {
      datasetId: dataset.id,
      center: {
        x: Number(url.searchParams.get('x')),
        y: Number(url.searchParams.get('y')),
        z: Number(url.searchParams.get('z'))
      },
      radius: Number(url.searchParams.get('radius')),
      labels
    });
    return true;
  }

  const labelSelectMatch = /^\/api\/datasets\/([^/]+)\/labels\/select$/.exec(url.pathname);
  if (request.method === 'POST' && labelSelectMatch) {
    const dataset = await readDataset(labelSelectMatch[1]);
    if (!dataset.source?.sha256 || !dataset.visual || !dataset.activeVisualRevision) {
      throw Object.assign(new Error('必须先上传并完成可视化切片，才能选择巡检点。'), { statusCode: 409 });
    }
    const body = await readJsonBody(request);
    if (body.visualRevision !== dataset.activeVisualRevision) {
      throw Object.assign(new Error('前表面选择结果不属于当前视觉版本，请重新选择。'), { statusCode: 409 });
    }
    const position = parseVector(body.position, '可见高斯表面点');
    const normal = parseNormal(body.normal);
    const selectionRadiusPixels = parseSelectionRadius(body.selectionRadiusPixels);
    const neighborCount = Number(body.neighborCount);
    if (!Number.isInteger(neighborCount) || neighborCount < 3) {
      throw Object.assign(new Error('5 像素区域至少需要 3 个图形处理器前表面深度采样点。'), { statusCode: 400 });
    }
    if (body.pickBackend !== SURFACE_PICK_BACKEND ||
        body.selectionDataSource !== SURFACE_SELECTION_DATA_SOURCE) {
      throw Object.assign(new Error('巡检点必须来自原生深度选择器的 5 像素透明度前表面选择。'), { statusCode: 400 });
    }
    const eigenvalues = Array.isArray(body.normalEigenvalues)
      ? body.normalEigenvalues.slice(0, 3).map(Number)
      : [];
    if (eigenvalues.length !== 3 || !eigenvalues.every(Number.isFinite)) {
      throw Object.assign(new Error('主成分特征值无效。'), { statusCode: 400 });
    }
    const normalPlanarity = Number(body.normalPlanarity);
    if (!Number.isFinite(normalPlanarity) || normalPlanarity < 0 || normalPlanarity > 1) {
      throw Object.assign(new Error('主成分平面度无效。'), { statusCode: 400 });
    }
    const label = labelStore.create({
      id: randomUUID(),
      datasetId: dataset.id,
      title: body.title,
      description: body.description,
      type: body.type,
      position,
      normal,
      selectionMethod: SURFACE_SELECTION_METHOD,
      selectionRadiusPixels,
      neighborCount,
      normalPlanarity,
      normalEigenvalues: eigenvalues,
      residentLodLevels: [],
      residentFileCount: 0,
      pickBackend: body.pickBackend,
      selectionDataSource: body.selectionDataSource,
      visualRevision: dataset.activeVisualRevision,
      sourceSha256: dataset.source.sha256,
      resolved: true
    });
    sendJson(response, 201, label);
    return true;
  }

  const labelMatch = /^\/api\/labels\/([^/]+)$/.exec(url.pathname);
  if (labelMatch) {
    const labelId = labelMatch[1];
    if (!UUID_PATTERN.test(labelId)) {
      throw Object.assign(new Error('巡检点编号无效。'), { statusCode: 400 });
    }
    const label = labelStore.get(labelId);
    if (!label) {
      throw Object.assign(new Error('巡检点不存在。'), { statusCode: 404 });
    }
    await readDataset(label.datasetId);
    if (request.method === 'GET') {
      sendJson(response, 200, label);
      return true;
    }
    if (request.method === 'PATCH') {
      const updated = labelStore.updateMetadata(labelId, await readJsonBody(request));
      sendJson(response, 200, updated);
      return true;
    }
    if (request.method === 'DELETE') {
      const deleted = labelStore.delete(labelId);
      sendJson(response, 200, { deleted: true, label: deleted });
      return true;
    }
  }

  const labelDeleteMatch = /^\/api\/datasets\/([^/]+)\/labels\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && labelDeleteMatch) {
    const [,, labelId] = labelDeleteMatch;
    const dataset = await readDataset(labelDeleteMatch[1]);
    if (!UUID_PATTERN.test(labelId)) {
      throw Object.assign(new Error('巡检点编号无效。'), { statusCode: 400 });
    }
    const label = labelStore.get(labelId);
    if (!label || label.datasetId !== dataset.id) {
      throw Object.assign(new Error('巡检点不存在。'), { statusCode: 404 });
    }
    const deleted = labelStore.delete(labelId);
    sendJson(response, 200, { deleted: true, label: deleted });
    return true;
  }

  const datasetMatch = /^\/api\/datasets\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && datasetMatch) {
    sendJson(response, 200, exposeDataset(await readDataset(datasetMatch[1])));
    return true;
  }
  if (request.method === 'DELETE' && datasetMatch) {
    const id = datasetMatch[1];
    await readDataset(id);
    if (activeBuildId === id || activeCollisionId === id) {
      throw Object.assign(new Error('该数据正在执行重任务，完成后才能删除。'), { statusCode: 409 });
    }
    missionStore.deleteDataset(id);
    labelStore.deleteDataset(id);
    voxelRepository.invalidateDataset(id);
    await rm(datasetDirectory(id), { recursive: true, force: true });
    sendJson(response, 200, { deleted: true, id });
    return true;
  }

  const visualMatch = /^\/api\/datasets\/([^/]+)\/visual-revisions\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (request.method === 'GET' && visualMatch) {
    const [, id, revision, relativePath] = visualMatch;
    if (!REVISION_PATTERN.test(revision)) {
      throw Object.assign(new Error('视觉版本无效。'), { statusCode: 400 });
    }
    const root = resolve(datasetDirectory(id), 'visual-revisions', revision);
    const decoded = decodeURIComponent(relativePath);
    const path = resolve(root, decoded);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw Object.assign(new Error('视觉资源路径越界。'), { statusCode: 400 });
    }
    const cache = decoded === 'lod-meta.json' ? 'no-store' : 'public, max-age=31536000, immutable';
    try {
      const served = await serveFile(request, response, path, cache);
      if (!served) {
        throw Object.assign(new Error('视觉资源不存在。'), { statusCode: 404 });
      }
    } catch (error) {
      if (isMissing(error)) {
        throw Object.assign(new Error('视觉资源不存在。'), { statusCode: 404 });
      }
      throw error;
    }
    return true;
  }

  const collisionResourceMatch =
    /^\/api\/datasets\/([^/]+)\/collision-revisions\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (request.method === 'GET' && collisionResourceMatch) {
    const [, id, revision, relativePath] = collisionResourceMatch;
    if (!REVISION_PATTERN.test(revision)) {
      throw Object.assign(new Error('体素版本无效。'), { statusCode: 400 });
    }
    const root = resolve(datasetDirectory(id), 'collision-revisions', revision);
    const decoded = decodeURIComponent(relativePath);
    const path = resolve(root, decoded);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw Object.assign(new Error('体素资源路径越界。'), { statusCode: 400 });
    }
    try {
      const served = await serveFile(request, response, path, 'public, max-age=31536000, immutable');
      if (!served) {
        throw Object.assign(new Error('体素资源不存在。'), { statusCode: 404 });
      }
    } catch (error) {
      if (isMissing(error)) {
        throw Object.assign(new Error('体素资源不存在。'), { statusCode: 404 });
      }
      throw error;
    }
    return true;
  }

  return false;
};

const recoverInterruptedBuilds = async () => {
  const datasets = await listDatasets();
  for (const dataset of datasets) {
    if (dataset.builtin) {
      continue;
    }
    const stored = await readDataset(dataset.id);
    let changed = false;
    if (stored.status === 'building') {
      const hasActiveVisual = Boolean(stored.activeVisualRevision && stored.visual);
      stored.status = hasActiveVisual ? 'ready' : 'failed';
      stored.stage = hasActiveVisual ? '上次切片任务被中断，保留当前切片' : '上次切片被服务中断';
      stored.error = '本地服务在切片完成前退出，请重新点击切片。';
      changed = true;
    }
    if (stored.collision?.status === 'building') {
      const hasActiveCollision = Boolean(stored.activeCollisionRevision && stored.collision.revision);
      stored.collision = {
        ...stored.collision,
        status: hasActiveCollision ? 'ready' : 'failed',
        stage: hasActiveCollision ? '上次重新计算被中断，保留当前体素' : '上次体素计算被服务中断',
        error: '本地服务在体素完成前退出，请重新点击计算体素。'
      };
      changed = true;
    }
    if (changed) await writeDataset(stored);
  }
};

const migrateLegacyLabels = async () => {
  const entries = await readdir(datasetsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    try {
      const labels = await readLabels(entry.name);
      const inserted = labelStore.migrateLegacy(entry.name, labels);
      const dataset = await readDataset(entry.name);
      const labelCount = labelStore.count(entry.name);
      if (dataset.labelCount !== labelCount) {
        dataset.labelCount = labelCount;
        await writeDataset(dataset);
      }
      if (inserted > 0) {
        console.log(`已迁移 ${entry.name} 的 ${inserted} 个历史标签到 SQLite。`);
      }
    } catch (error) {
      console.warn(`历史标签迁移失败 ${entry.name}：`, error);
    }
  }
};

await mkdir(dataRoot, { recursive: true });
await mkdir(datasetsRoot, { recursive: true });
labelStore = new LabelStore(labelDatabasePath);
missionStore = new MissionStore(labelStore.database);
await migrateLegacyLabels();
await recoverInterruptedBuilds();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(request, response, url);
      if (!handled) {
        sendJson(response, 404, { error: 'API 不存在。' });
      }
      return;
    }

    if (vite) {
      vite.middlewares(request, response, (error) => {
        if (error) {
          console.error(error);
          if (!response.headersSent) {
            sendJson(response, 500, { error: '开发服务器错误。' });
          }
        }
      });
      return;
    }

    const decodedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const staticPath = resolve(distRoot, `.${decodedPath}`);
    if (staticPath !== distRoot && !staticPath.startsWith(`${distRoot}${sep}`)) {
      throw Object.assign(new Error('静态资源路径越界。'), { statusCode: 400 });
    }
    try {
      if (await serveFile(request, response, staticPath, 'no-cache')) {
        return;
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    await serveFile(request, response, resolve(distRoot, 'index.html'), 'no-cache');
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    if (statusCode >= 500) {
      console.error(error);
    }
    if (!response.headersSent) {
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : '服务器内部错误。'
      });
    } else {
      response.destroy();
    }
  }
});

if (!production) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server } }
  });
} else {
  await access(resolve(distRoot, 'index.html'));
}

const host = process.env.SPIKIVE_HOST || '0.0.0.0';
server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`实景三维底座已启动：http://${displayHost}:${actualPort}（${production ? '生产模式' : '开发模式'}）`);
});

const shutdown = async () => {
  activeChild?.kill('SIGTERM');
  server.close();
  await vite?.close();
  labelStore.close();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
