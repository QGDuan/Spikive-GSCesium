import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploymentRoot = resolve(root, 'release', 'web');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (command, args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    cwd: root,
    shell: false,
    stdio: 'inherit'
  });
  child.once('error', rejectRun);
  child.once('exit', (code, signal) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`${command} ${args.join(' ')} 失败：code=${code}, signal=${signal}`));
  });
});

const assertNoDeploymentData = async () => {
  for (const name of ['data', 'var']) {
    const path = resolve(deploymentRoot, name);
    try {
      await access(path);
      throw new Error(
        `拒绝覆盖 ${relative(root, path)}：部署构建不得删除或携带业务数据。`
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
};

const copyConverterRuntime = async () => {
  const packageRoot = resolve(root, 'node_modules/@playcanvas/splat-transform');
  const targetRoot = resolve(deploymentRoot, 'node_modules/@playcanvas/splat-transform');
  await Promise.all([
    mkdir(resolve(targetRoot, 'bin'), { recursive: true }),
    mkdir(resolve(targetRoot, 'dist'), { recursive: true }),
    mkdir(resolve(targetRoot, 'lib'), { recursive: true })
  ]);
  await Promise.all([
    cp(resolve(packageRoot, 'bin/cli.mjs'), resolve(targetRoot, 'bin/cli.mjs')),
    cp(resolve(packageRoot, 'LICENSE'), resolve(targetRoot, 'LICENSE')),
    cp(resolve(packageRoot, 'package.json'), resolve(targetRoot, 'package.json')),
    cp(resolve(packageRoot, 'lib/webp.wasm'), resolve(targetRoot, 'lib/webp.wasm'))
  ]);
  const compiledFiles = await readdir(resolve(packageRoot, 'dist'));
  await Promise.all(compiledFiles
    .filter((file) => ['.mjs', '.js', '.cjs', '.wasm'].includes(extname(file)))
    .map((file) => cp(resolve(packageRoot, 'dist', file), resolve(targetRoot, 'dist', file))));

  const webGpuRoot = resolve(root, 'node_modules/webgpu');
  const webGpuTarget = resolve(deploymentRoot, 'node_modules/webgpu');
  await mkdir(resolve(webGpuTarget, 'dist'), { recursive: true });
  await Promise.all([
    cp(resolve(webGpuRoot, 'index.js'), resolve(webGpuTarget, 'index.js')),
    cp(resolve(webGpuRoot, 'LICENSE.md'), resolve(webGpuTarget, 'LICENSE.md')),
    cp(resolve(webGpuRoot, 'package.json'), resolve(webGpuTarget, 'package.json'))
  ]);
  const nativeFiles = (await readdir(resolve(webGpuRoot, 'dist')))
    .filter((file) => ['.node', '.dll'].includes(extname(file)));
  await Promise.all(nativeFiles.map((file) =>
    cp(resolve(webGpuRoot, 'dist', file), resolve(webGpuTarget, 'dist', file))
  ));
};

const auditDeployment = async () => {
  const forbiddenExtensions = new Set(['.ts', '.tsx', '.map', '.ply', '.sqlite', '.db']);
  const forbiddenNames = new Set(['.env', 'source.ply', 'labels.sqlite']);
  const problems = [];
  let bytes = 0;
  let files = 0;
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
        if (forbiddenExtensions.has(extname(entry.name)) || forbiddenNames.has(entry.name)) {
          problems.push(relative(deploymentRoot, path));
        }
      }
    }
  };
  await walk(deploymentRoot);
  if (problems.length > 0) {
    throw new Error(`Web 部署目录包含禁止文件：${problems.join(', ')}`);
  }
  return { bytes, files };
};

const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const collectFiles = async (directory) => {
  const result = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name !== 'SHA256SUMS.txt') result.push(path);
    }
  };
  await walk(directory);
  return result.sort((left, right) => left.localeCompare(right));
};

const startShell = `#!/usr/bin/env sh
set -eu

SPIKIVE_DEPLOY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SPIKIVE_USER_ROOT="${'${HOME:-$SPIKIVE_DEPLOY_ROOT}'}"
export SPIKIVE_HOST="${'${SPIKIVE_HOST:-0.0.0.0}'}"
export SPIKIVE_PORT="${'${SPIKIVE_PORT:-5173}'}"
export SPIKIVE_DATA_ROOT="${'${SPIKIVE_DATA_ROOT:-$SPIKIVE_USER_ROOT/.spikive-gs/data}'}"
export SPIKIVE_DIST_ROOT="$SPIKIVE_DEPLOY_ROOT/dist"
export SPIKIVE_PUBLIC_ROOT="$SPIKIVE_DEPLOY_ROOT/public"
export SPIKIVE_SPLAT_CLI="$SPIKIVE_DEPLOY_ROOT/node_modules/@playcanvas/splat-transform/bin/cli.mjs"

exec node "$SPIKIVE_DEPLOY_ROOT/server.mjs" --production
`;

const startWindows = `@echo off\r
setlocal\r
set "SPIKIVE_DEPLOY_ROOT=%~dp0"\r
if not defined SPIKIVE_HOST set "SPIKIVE_HOST=0.0.0.0"\r
if not defined SPIKIVE_PORT set "SPIKIVE_PORT=5173"\r
if not defined SPIKIVE_DATA_ROOT (\r
  if defined LOCALAPPDATA (\r
    set "SPIKIVE_DATA_ROOT=%LOCALAPPDATA%\\Spikive GS\\data"\r
  ) else (\r
    set "SPIKIVE_DATA_ROOT=%USERPROFILE%\\.spikive-gs\\data"\r
  )\r
)\r
set "SPIKIVE_DIST_ROOT=%SPIKIVE_DEPLOY_ROOT%dist"\r
set "SPIKIVE_PUBLIC_ROOT=%SPIKIVE_DEPLOY_ROOT%public"\r
set "SPIKIVE_SPLAT_CLI=%SPIKIVE_DEPLOY_ROOT%node_modules\\@playcanvas\\splat-transform\\bin\\cli.mjs"\r
node "%SPIKIVE_DEPLOY_ROOT%server.mjs" --production\r
endlocal\r
`;

await run(npmCommand, ['run', 'build']);
await assertNoDeploymentData();
await rm(deploymentRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(resolve(deploymentRoot, 'dist'), { recursive: true }),
  mkdir(resolve(deploymentRoot, 'public'), { recursive: true }),
  mkdir(resolve(deploymentRoot, 'docs'), { recursive: true })
]);

await build({
  entryPoints: [resolve(root, 'server.mjs')],
  outfile: resolve(deploymentRoot, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['vite'],
  minify: true,
  sourcemap: false,
  legalComments: 'none'
});

await Promise.all([
  cp(resolve(root, 'dist'), resolve(deploymentRoot, 'dist'), { recursive: true }),
  cp(resolve(root, 'docs/WEB_DEPLOYMENT.md'), resolve(deploymentRoot, 'README.md')),
  cp(resolve(root, 'docs/WEB_DEPLOYMENT.md'), resolve(deploymentRoot, 'docs/WEB_DEPLOYMENT.md')),
  cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(deploymentRoot, 'THIRD_PARTY_NOTICES.md')),
  writeFile(resolve(deploymentRoot, 'start.sh'), startShell),
  writeFile(resolve(deploymentRoot, 'start.cmd'), startWindows),
  copyConverterRuntime()
]);
await chmod(resolve(deploymentRoot, 'start.sh'), 0o755);

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const deploymentStats = await auditDeployment();
await writeFile(resolve(deploymentRoot, 'release.json'), `${JSON.stringify({
  product: '实景三维底座',
  version: packageJson.version,
  createdAt: new Date().toISOString(),
  node: '>=22.22.1',
  frontendAndApiSameOrigin: true,
  supportedLaunchers: ['macOS/Linux start.sh', 'Windows start.cmd'],
  sourceIncluded: false,
  sourceMapsIncluded: false,
  businessDataIncluded: false,
  runtimeBytesBeforeManifest: deploymentStats.bytes,
  runtimeFilesBeforeManifest: deploymentStats.files,
  defaultDataLocations: {
    posix: '~/.spikive-gs/data',
    windows: '%LOCALAPPDATA%\\Spikive GS\\data'
  }
}, null, 2)}\n`);

const files = await collectFiles(deploymentRoot);
const checksums = [];
for (const path of files) {
  const name = relative(deploymentRoot, path).split(sep).join('/');
  checksums.push(`${await hashFile(path)}  ${name}`);
}
await writeFile(resolve(deploymentRoot, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
await auditDeployment();

console.log(`Web 前后端部署目录已生成：${relative(root, deploymentRoot).split(sep).join('/')}`);
