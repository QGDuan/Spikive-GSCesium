import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildOfficialSog, validateSogArtifact, directorySize } from './sog-build-lib.mjs';
import { buildPartitionedCollision, validatePartitionManifest } from './partitioned-collision.mjs';
import { sourceInfo } from './native-file-system.mjs';
import { hashFile, atomicJson, readJson } from './build-support.mjs';

const source = process.argv[2];
if (!source)
  throw new Error('用法：node scripts/verify-low-resource.mjs /绝对路径/source.ply [独立验收目录]');
const directory = resolve(process.argv[3] || 'var/acceptance/low-resource');
await mkdir(directory, { recursive: true });
const sourceSha256 = await hashFile(source),
  info = await sourceInfo(source);
const reportPath = resolve(directory, 'result.json');
const previous = await readJson(reportPath);
const report =
  previous?.sourceSha256 === sourceSha256
    ? previous
    : { sourceSha256, gaussianCount: info.numGaussians, stages: {} };
report.startedAt ??= new Date().toISOString();
report.validatedAt = new Date().toISOString();
report.platform = process.platform;
report.node = process.version;
report.peakProcessTreeRssBytes ??= 0;
report.converterGpuBytes ??= 0;
const run = promisify(execFile);
let sampling = false;
let successfulSamples = 0;
const sample = async () => {
  if (sampling || process.platform === 'win32') return;
  sampling = true;
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=']);
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const ids = new Set([process.pid]);
    let added;
    do {
      added = false;
      for (const [pid, parent] of rows)
        if (ids.has(parent) && !ids.has(pid)) {
          ids.add(pid);
          added = true;
        }
    } while (added);
    const bytes = rows.filter(([pid]) => ids.has(pid)).reduce((sum, [, , rss]) => sum + rss * 1024, 0);
    report.peakProcessTreeRssBytes = Math.max(report.peakProcessTreeRssBytes, bytes);
    successfulSamples++;
  } finally {
    sampling = false;
  }
};
const timer = setInterval(() => void sample().catch(() => {}), 1000);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const onLog = (line) => {
  const gpu = /gpu=([\d.]+)(KB|MB|GB)/.exec(line);
  if (gpu)
    report.converterGpuBytes = Math.max(
      report.converterGpuBytes,
      Number(gpu[1]) * 1024 ** { KB: 1, MB: 2, GB: 3 }[gpu[2]]
    );
  if (/peak|failed|Error|复用/.test(line)) console.log(line);
};
try {
  if (!report.stages.visual?.pass) {
    console.log('开始 5 层官方 CPU 低资源切片');
    await buildOfficialSog({
      source,
      sourceSha256,
      output: resolve(directory, 'sog/lod-meta.json'),
      workDirectory: resolve(directory, 'levels'),
      resourceProfile: 'low-memory',
      levelCount: 5,
      signal: controller.signal,
      logPath: resolve(directory, 'visual.log'),
      onLog,
      onProgress: (p) => console.log(p.stage)
    });
  }
  const visual = await validateSogArtifact(resolve(directory, 'sog'), 5);
  if (visual.counts[0] !== info.numGaussians) throw new Error('LOD0 点数不等于源点数。');
  report.stages.visual = { pass: true, counts: visual.counts, bytes: visual.bytes };
  await atomicJson(reportPath, report);
  const collisionDir = resolve(directory, 'collision');
  if (!report.stages.collision?.pass) {
    console.log('开始 0.2 米 / 0.1 阈值分区体素');
    const result = await buildPartitionedCollision({
      source,
      sourceSha256,
      outputDirectory: collisionDir,
      workDirectory: resolve(directory, 'collision-work'),
      voxelSize: 0.2,
      voxelOpacity: 0.1,
      signal: controller.signal,
      logPath: resolve(directory, 'collision.log'),
      onLog,
      onProgress: (p) => console.log(p.stage)
    });
    report.stages.collision = {
      pass: true,
      partitions: result.manifest.partitions.length,
      bytes: result.bytes
    };
  }
  const manifest = await readJson(resolve(collisionDir, 'collision-manifest.json'));
  await validatePartitionManifest(manifest, collisionDir);
  report.stages.collision.bytes = (await directorySize(collisionDir)).bytes;
  report.stages.collision.occupiedPartitions = manifest.partitions.filter(p => !p.empty && !p.occupancyEmpty).length;
  report.stages.collision.maximumContributors = Math.max(...manifest.partitions.map(p => p.count));
  report.stages.collision.manifestSha256 = await hashFile(resolve(collisionDir, 'collision-manifest.json'));
  report.completedAt ??= new Date().toISOString();
  report.error = null;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  clearInterval(timer);
  await sample().catch(() => {});
  report.resourceMeasurement = process.platform === 'win32' || !successfulSamples
    ? '未获得本次进程树 RSS 采样，必须在目标机器补测'
    : '每秒采样进程树 RSS；GPU 为转换器资源估算；峰值包含本目录先前执行阶段';
  report.resourceGate = report.error || process.platform === 'win32' || !successfulSamples
    ? null
    : report.peakProcessTreeRssBytes <= 8 * 1024 ** 3 && report.converterGpuBytes <= 2 * 1024 ** 3;
  await atomicJson(reportPath, report);
  console.log(report);
}
