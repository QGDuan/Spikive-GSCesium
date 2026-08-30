import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = resolve(root, 'release');
const deploymentRoot = resolve(releaseRoot, 'web');
const packageRoot = resolve(releaseRoot, 'packages');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const product = '面向建运一体化转型的实景三维多场景孪生应用底座系统';
const archiveName = `${product}-${packageJson.version}.zip`;
const archivePath = resolve(packageRoot, archiveName);
const checksumPath = resolve(packageRoot, 'SHA256SUMS.txt');
const manifestPath = resolve(packageRoot, 'release-manifest.json');

const run = (command, args, options = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    shell: false,
    stdio: options.stdio ?? 'inherit'
  });
  let stdout = '';
  if (options.stdio === 'pipe') child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.once('error', rejectRun);
  child.once('exit', (code, signal) => {
    if (code === 0) resolveRun(stdout);
    else rejectRun(new Error(`${command} ${args.join(' ')} 失败：code=${code}, signal=${signal}`));
  });
});

const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const auditDeployment = async () => {
  const forbiddenExtensions = new Set(['.ts', '.tsx', '.map', '.ply', '.sqlite', '.db']);
  const forbiddenNames = new Set(['.env', 'source.ply', 'labels.sqlite']);
  const problems = [];
  let files = 0;
  let bytes = 0;
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const name = relative(deploymentRoot, path).split(sep).join('/');
      if (entry.isDirectory()) {
        if (name === 'data' || name === 'var') problems.push(`${name}/`);
        else await walk(path);
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
        if (forbiddenExtensions.has(extname(entry.name)) || forbiddenNames.has(entry.name)) {
          problems.push(name);
        }
      }
    }
  };
  await walk(deploymentRoot);
  if (problems.length > 0) throw new Error(`拒绝打包以下文件：${problems.join(', ')}`);
  return { files, bytes };
};

await access(resolve(deploymentRoot, 'server.mjs'));
await access(resolve(deploymentRoot, 'start.sh'));
await access(resolve(deploymentRoot, 'start.cmd'));
const deploymentStats = await auditDeployment();

await mkdir(packageRoot, { recursive: true });
await Promise.all([
  rm(archivePath, { force: true }),
  rm(checksumPath, { force: true }),
  rm(manifestPath, { force: true })
]);

if (process.platform === 'win32') {
  const escapedSource = deploymentRoot.replaceAll("'", "''");
  const escapedTarget = archivePath.replaceAll("'", "''");
  await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -LiteralPath '${escapedSource}' -DestinationPath '${escapedTarget}' -CompressionLevel Optimal -Force`
  ]);
} else {
  await run('zip', ['-q', '-r', archivePath, basename(deploymentRoot)], { cwd: releaseRoot });
}

const archiveHash = await hashFile(archivePath);
const archiveBytes = (await stat(archivePath)).size;
const manifest = {
  product,
  version: packageJson.version,
  createdAt: new Date().toISOString(),
  archive: archiveName,
  sha256: archiveHash,
  archiveBytes,
  deploymentFiles: deploymentStats.files,
  deploymentBytes: deploymentStats.bytes,
  supportedSystems: ['macOS', 'Windows 10/11 x64', 'Linux x64/arm64'],
  sourceIncluded: false,
  businessDataIncluded: false,
  launchers: {
    posix: 'web/start.sh',
    windows: 'web/start.cmd'
  }
};

await Promise.all([
  writeFile(checksumPath, `${archiveHash}  ${archiveName}\n`),
  writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
]);

console.log(`Web 安装包已生成：${relative(root, archivePath).split(sep).join('/')}`);
console.log(`SHA-256：${archiveHash}`);
