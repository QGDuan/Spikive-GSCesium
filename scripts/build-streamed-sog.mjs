import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(projectRoot, 'public/data/point_cloud.ply');
const output = resolve(projectRoot, 'public/data/point_cloud-lod/lod-meta.json');
const outputDirectory = dirname(output);
const workRoot = resolve(projectRoot, 'var/lod-build');
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
const lod1 = join(workDirectory, 'lod1.ply');
const lod2 = join(workDirectory, 'lod2.ply');
const lod3 = join(workDirectory, 'lod3.ply');

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
  await run([source, '--decimate', '50%', lod1]);
  await run([source, '--decimate', '25%', lod2]);
  await run([source, '--decimate', '10%', lod3]);
  await mkdir(outputDirectory, { recursive: false });
  await run([
    source,
    '--tag-lod',
    '0',
    lod1,
    '--tag-lod',
    '1',
    lod2,
    '--tag-lod',
    '2',
    lod3,
    '--tag-lod',
    '3',
    output
  ]);
  completed = true;
} finally {
  if (completed) {
    await rm(workDirectory, { recursive: true, force: true });
  } else {
    console.error(`中间文件保留在：${workDirectory}`);
  }
}
