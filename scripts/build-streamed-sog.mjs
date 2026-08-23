import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(projectRoot, 'public/data/point_cloud.ply');
const output = resolve(projectRoot, 'public/data/point_cloud-lod/lod-meta.json');
const outputDirectory = dirname(output);
const workRoot = resolve(projectRoot, 'var/lod-build');
const lodLevels = [
  { lod: 1, ratio: '90%' },
  { lod: 2, ratio: '75%' },
  { lod: 3, ratio: '60%' },
  { lod: 4, ratio: '40%' },
  { lod: 5, ratio: '20%' },
  { lod: 6, ratio: '10%' }
];
const executable = resolve(
  projectRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'splat-transform.cmd' : 'splat-transform'
);

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
const lodSources = lodLevels.map(({ lod, ratio }) => ({
  lod,
  ratio,
  path: join(workDirectory, `lod${lod}.ply`)
}));

const run = (args) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      shell: false,
      stdio: 'inherit'
    });

    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`splat-transform 失败：code=${code ?? 'null'}, signal=${signal ?? 'null'}`));
    });
  });

let completed = false;

try {
  for (const level of lodSources) {
    await run([source, '--decimate', level.ratio, level.path]);
  }
  await mkdir(outputDirectory, { recursive: false });
  const tagArguments = [source, '--tag-lod', '0'];
  for (const level of lodSources) {
    tagArguments.push(level.path, '--tag-lod', String(level.lod));
  }
  tagArguments.push(output);
  await run(tagArguments);
  completed = true;
} finally {
  if (completed) {
    await rm(workDirectory, { recursive: true, force: true });
  } else {
    console.error(`中间文件保留在：${workDirectory}`);
  }
}
