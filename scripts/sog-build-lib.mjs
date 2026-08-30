import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_LOD_LEVELS = 1;
export const MAX_LOD_LEVELS = 20;
export const MAX_SOG_WORKERS = 4;

export const getSogWorkerCount = () =>
  Math.max(1, Math.min(MAX_SOG_WORKERS, availableParallelism() - 1));

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(process.env.SPIKIVE_APP_ROOT || resolve(moduleDirectory, '..'));
const cliPath = resolve(
  process.env.SPIKIVE_SPLAT_CLI ||
  resolve(projectRoot, 'node_modules/@playcanvas/splat-transform/bin/cli.mjs')
);

export const createLodRatios = (levelCount = 5) => {
  if (!Number.isInteger(levelCount) || levelCount < MIN_LOD_LEVELS || levelCount > MAX_LOD_LEVELS) {
    throw new RangeError(`切片层数必须是 ${MIN_LOD_LEVELS}–${MAX_LOD_LEVELS} 的整数。`);
  }

  return Array.from({ length: levelCount }, (_, index) =>
    Math.ceil((100 * (levelCount - index)) / levelCount)
  );
};

const parseLogLines = (chunk) => {
  const text = chunk.toString('utf8').replaceAll('\r', '\n');
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
};

export const runSplatTransform = async (args, { cwd = projectRoot, onLog, onChild } = {}) => {
  await access(cliPath);

  return new Promise((resolveRun, rejectRun) => {
    const logTail = [];
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    onChild?.(child);
    const capture = (chunk) => {
      for (const line of parseLogLines(chunk)) {
        logTail.push(line);
        if (logTail.length > 12) {
          logTail.shift();
        }
        onLog?.(line);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      onChild?.(undefined);
      if (code === 0) {
        resolveRun();
        return;
      }
      const failure = new Error(`官方转换程序失败：退出码 ${code ?? '未知'}，终止信号 ${signal ?? '无'}。`);
      if (logTail.length > 0) failure.cause = new Error(logTail.join('\n'));
      rejectRun(failure);
    });
  });
};

export const buildOfficialSog = async ({
  source,
  output,
  workDirectory,
  levelCount = 5,
  onProgress,
  onLog,
  onChild
}) => {
  const ratios = createLodRatios(levelCount);
  const workerCount = getSogWorkerCount();
  await access(source);
  await mkdir(workDirectory, { recursive: true });
  await mkdir(dirname(output), { recursive: true });

  const generatedLevels = [];
  for (let index = 1; index < ratios.length; index += 1) {
    const ratio = ratios[index];
    const levelPath = resolve(workDirectory, `lod-${index}-${ratio}.ply`);
    onProgress?.({
      progress: Math.floor((index / ratios.length) * 80),
      stage: `正在生成第 ${index} 层（${ratio}%）`
    });
    await runSplatTransform([source, '--decimate', `${ratio}%`, levelPath], {
      onLog,
      onChild
    });
    generatedLevels.push({ lod: index, ratio, path: levelPath });
  }

  onProgress?.({ progress: 85, stage: '正在生成官方流式切片' });
  const tagArguments = ['--max-workers', String(workerCount), source, '--tag-lod', '0'];
  for (const level of generatedLevels) {
    tagArguments.push(level.path, '--tag-lod', String(level.lod));
  }
  tagArguments.push(output);
  await runSplatTransform(tagArguments, { onLog, onChild });
  onProgress?.({ progress: 100, stage: '切片构建完成' });

  return { ratios, workerCount };
};

const assertInside = (root, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) {
    throw new Error('切片产物包含无效文件路径。');
  }
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, relativePath);
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`切片产物路径越界：${relativePath}`);
  }
  return absolutePath;
};

const collectPayloadFiles = (chunkMeta) => {
  const result = [];
  for (const key of ['means', 'scales', 'quats', 'sh0', 'shN']) {
    const files = chunkMeta?.[key]?.files;
    if (Array.isArray(files)) {
      result.push(...files);
    }
  }
  return result;
};

export const directorySize = async (directory) => {
  let bytes = 0;
  let files = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await directorySize(path);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      bytes += (await stat(path)).size;
      files += 1;
    }
  }
  return { bytes, files };
};

export const validateSogArtifact = async (outputDirectory, expectedLevels) => {
  const metaPath = resolve(outputDirectory, 'lod-meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  if (meta.lodLevels !== expectedLevels) {
    throw new Error(`切片层数不一致：期望 ${expectedLevels}，实际 ${meta.lodLevels}`);
  }
  if (!Array.isArray(meta.counts) || meta.counts.length !== expectedLevels) {
    throw new Error('切片数量表与层数不一致。');
  }
  for (let index = 0; index < meta.counts.length; index += 1) {
    const count = meta.counts[index];
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`第 ${index} 层高斯点数量无效。`);
    }
    if (index > 0 && count > meta.counts[index - 1]) {
      throw new Error(`第 ${index} 层高斯点数量未保持单调递减。`);
    }
  }
  if (meta.count !== meta.counts.reduce((sum, count) => sum + count, 0)) {
    throw new Error('切片高斯点总数与分层统计不一致。');
  }
  if (!Array.isArray(meta.filenames) || meta.filenames.length === 0) {
    throw new Error('切片未生成空间数据块。');
  }

  for (const filename of meta.filenames) {
    const chunkMetaPath = assertInside(outputDirectory, filename);
    const chunkMeta = JSON.parse(await readFile(chunkMetaPath, 'utf8'));
    if (!Number.isInteger(chunkMeta.count) || chunkMeta.count <= 0) {
      throw new Error(`数据块数量无效：${filename}`);
    }
    const chunkDirectory = dirname(chunkMetaPath);
    for (const payload of collectPayloadFiles(chunkMeta)) {
      const payloadPath = assertInside(chunkDirectory, payload);
      const payloadStats = await stat(payloadPath);
      if (!payloadStats.isFile() || payloadStats.size === 0) {
        throw new Error(`数据块文件为空：${payload}`);
      }
    }
  }

  const disk = await directorySize(outputDirectory);
  return {
    meta,
    counts: meta.counts,
    gaussianEntries: meta.count,
    chunkCount: meta.filenames.length,
    bytes: disk.bytes,
    files: disk.files
  };
};
