import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { availableParallelism } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOL_VERSION,
  resourceProfile,
  hashFile,
  atomicJson,
  readJson,
  checkDisk,
  checkCancelled,
  classifyBuildFailure
} from './build-support.mjs';

export const MIN_LOD_LEVELS = 1;
export const MAX_LOD_LEVELS = 20;
export const MAX_SOG_WORKERS = 4;

export const getSogWorkerCount = (profile = 'low-memory') =>
  resourceProfile(profile) === 'low-memory'
    ? 0
    : Math.max(1, Math.min(MAX_SOG_WORKERS, availableParallelism() - 1));

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

export const runSplatTransform = async (
  args,
  { cwd = projectRoot, onLog, onChild, signal, logPath } = {}
) => {
  checkCancelled(signal);
  await access(cliPath);
  if (logPath) await mkdir(dirname(logPath), { recursive: true });
  return new Promise((resolveRun, rejectRun) => {
    const logTail = [];
    const log = logPath ? createWriteStream(logPath, { flags: 'a' }) : null;
    let firstError = '';
    let logError;
    log?.on('error', (error) => {
      logError = error;
      child.stdout.resume();
      child.stderr.resume();
      abort();
    });
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    log?.write(`\n[${new Date().toISOString()}] splat-transform ${TOOL_VERSION} ${JSON.stringify(args)}\n`);
    onChild?.(child);
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const pending = ['', ''];
    const lineReceived = (line) => {
      line = line.trim();
      if (line) {
        if (!firstError && /error|failed|exceed|safety limit/i.test(line)) firstError = line;
        logTail.push(line);
        if (logTail.length > 100) {
          logTail.shift();
        }
        onLog?.(line);
      }
    };
    const capture = (chunk, index) => {
      const stream = index === 0 ? child.stdout : child.stderr;
      if (log && !logError && !log.destroyed && !log.write(chunk)) {
        stream.pause();
        log.once('drain', () => stream.resume());
      }
      pending[index] += decoders[index].write(chunk);
      const lines = pending[index].split(/[\r\n]/);
      pending[index] = lines.pop().slice(-65536);
      lines.forEach(lineReceived);
    };
    child.stdout.on('data', (chunk) => capture(chunk, 0));
    child.stderr.on('data', (chunk) => capture(chunk, 1));
    let killTimer;
    const abort = () => {
      clearTimeout(killTimer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => {
      firstError = error.message;
    });
    child.once('close', (code, exitSignal) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      decoders.forEach((decoder, i) => lineReceived(pending[i] + decoder.end()));
      onChild?.(undefined);
      const finish = () => {
        if (code === 0 && !signal?.aborted && !logError) {
          resolveRun();
          return;
        }
        const details = signal?.aborted
          ? 'CANCELLED'
          : `${logError?.message || ''}\n${firstError}\n${logTail.join('\n')}`;
        const diagnosis = classifyBuildFailure(details);
        const failure = Object.assign(
          new Error(`${diagnosis.message}（退出码 ${code ?? '未知'}，终止信号 ${exitSignal ?? '无'}）`),
          { code: diagnosis.code, logPath }
        );
        failure.cause = new Error(details);
        rejectRun(failure);
      };
      if (log && !log.destroyed) log.end(finish);
      else finish();
    });
  });
};

export const buildOfficialSog = async ({
  source,
  output,
  workDirectory,
  levelCount = 5,
  resourceProfile: profile = 'low-memory',
  sourceSha256,
  signal,
  logPath,
  onProgress,
  onLog,
  onChild
}) => {
  const ratios = createLodRatios(levelCount);
  const workerCount = getSogWorkerCount(profile);
  await access(source);
  await mkdir(workDirectory, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const digest = sourceSha256 ?? (await hashFile(source));
  const checkpointPath = resolve(workDirectory, 'checkpoint.json');
  const key = JSON.stringify({ digest, ratios, profile, tool: TOOL_VERSION });
  let checkpoint = await readJson(checkpointPath);
  if (checkpoint?.key !== key) checkpoint = { key, completed: {} };
  const options = { onLog, onChild, signal, logPath };
  const execution = profile === 'low-memory' ? ['--gpu', 'cpu'] : [];

  const generatedLevels = [];
  for (let index = 1; index < ratios.length; index += 1) {
    const ratio = ratios[index];
    const levelPath = resolve(workDirectory, `lod-${index}-${ratio}.ply`);
    checkCancelled(signal);
    onProgress?.({
      progress: Math.floor((index / ratios.length) * 80),
      stage: `正在生成第 ${index} 层（${ratio}%）`
    });
    let reusable = false;
    if (checkpoint.completed[index]) {
      try {
        reusable = (await hashFile(levelPath)) === checkpoint.completed[index];
      } catch {
        /* rebuild incomplete stage */
      }
    }
    if (!reusable) {
      await checkDisk(workDirectory, (await stat(source)).size * 2);
      const temporary = resolve(workDirectory, `lod-${index}.pending.ply`);
      await runSplatTransform(
        [
          '--overwrite',
          '--memory',
          ...execution,
          '--scratch-dir',
          workDirectory,
          source,
          '--decimate',
          `${ratio}%`,
          temporary
        ],
        options
      );
      checkCancelled(signal);
      await rename(temporary, levelPath);
      checkpoint.completed[index] = await hashFile(levelPath);
      await atomicJson(checkpointPath, checkpoint);
    } else onLog?.(`复用已校验第 ${index} 层中间文件。`);
    generatedLevels.push({ lod: index, ratio, path: levelPath });
  }

  onProgress?.({ progress: 85, stage: '正在生成官方流式切片' });
  checkCancelled(signal);
  await checkDisk(workDirectory, (await stat(source)).size);
  const tagArguments = [
    '--overwrite',
    '--memory',
    ...execution,
    '--scratch-dir',
    workDirectory,
    '--max-workers',
    String(workerCount),
    source,
    '--tag-lod',
    '0'
  ];
  for (const level of generatedLevels) {
    tagArguments.push(level.path, '--tag-lod', String(level.lod));
  }
  tagArguments.push(output);
  await runSplatTransform(tagArguments, options);
  onProgress?.({ progress: 100, stage: '切片构建完成' });

  return { ratios, workerCount, sourceSha256: digest, resourceProfile: profile };
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
