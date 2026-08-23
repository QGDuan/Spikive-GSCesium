import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOfficialSog, createLodRatios, validateSogArtifact } from './sog-build-lib.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(projectRoot, 'public/data/point_cloud.ply');
const output = resolve(projectRoot, 'public/data/point_cloud-lod/lod-meta.json');
const outputDirectory = dirname(output);
const workRoot = resolve(projectRoot, 'var/lod-build');
const levelArgumentIndex = process.argv.indexOf('--levels');
const levelCount = levelArgumentIndex >= 0 ? Number(process.argv[levelArgumentIndex + 1]) : 5;
const ratios = createLodRatios(levelCount);

await access(source);

try {
  await access(outputDirectory);
  throw new Error(`输出目录已存在，请先人工确认后移走或删除：${outputDirectory}`);
} catch (error) {
  if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) {
    throw error;
  }
}

await mkdir(workRoot, { recursive: true });
const workDirectory = await mkdtemp(join(workRoot, 'official-'));
const stagedOutputDirectory = resolve(workDirectory, 'sog');
const stagedOutput = resolve(stagedOutputDirectory, 'lod-meta.json');

let completed = false;

try {
  await mkdir(stagedOutputDirectory, { recursive: false });
  await buildOfficialSog({
    source,
    output: stagedOutput,
    workDirectory: resolve(workDirectory, 'levels'),
    levelCount,
    onProgress: ({ stage }) => console.log(stage),
    onLog: (line) => console.log(line)
  });
  await validateSogArtifact(stagedOutputDirectory, levelCount);
  await rename(stagedOutputDirectory, outputDirectory);
  completed = true;
  console.log(`已生成 ${levelCount} 层：${ratios.join('% / ')}%`);
} finally {
  if (completed) {
    await rm(workDirectory, { recursive: true, force: true });
  } else {
    console.error(`中间文件保留在：${workDirectory}`);
  }
}
