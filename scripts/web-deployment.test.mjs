import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('产品前端不显示底层三维引擎品牌', async () => {
  const files = await Promise.all([
    read('index.html'),
    read('src/main.tsx'),
    read('src/ui/AppShell.tsx'),
    read('src/ui/PerformanceCard.tsx'),
    read('src/ui/ScenePanel.tsx'),
    read('src/ui/LabelPanel.tsx'),
    read('src/ui/MissionPanel.tsx')
  ]);
  assert.equal(files.some((file) => /play\s*canvas/i.test(file)), false);
  assert.match(files[0], /面向建运一体化转型的实景三维多场景孪生应用底座系统/);
  assert.match(files[2], /data-metric="backend"/);
  const visibleCopy = files.join('\n');
  for (const term of ['SPIKIVE', 'LOCAL SCENES', 'INSPECTION LABELS', 'FLIGHT ROUTES', 'FPS', '可见 GS', '系统 CPU', 'GPU 资源估算']) {
    assert.equal(visibleCopy.includes(term), false, `不应显示英文文案：${term}`);
  }
});

test('Web 部署同源提供前后端并隔离业务数据', async () => {
  const [packageText, server, deployScript, packageScript, viteConfig] = await Promise.all([
    read('package.json'),
    read('server.mjs'),
    read('scripts/prepare-web-deployment.mjs'),
    read('scripts/package-web-release.mjs'),
    read('vite.config.ts')
  ]);
  const packageJson = JSON.parse(packageText);
  assert.equal(packageJson.scripts['deploy:web'], 'node scripts/prepare-web-deployment.mjs');
  assert.equal(packageJson.scripts['package:web'], 'npm run deploy:web && node scripts/package-web-release.mjs');
  assert.equal(packageJson.devDependencies.electron, undefined);
  assert.equal(packageJson.devDependencies['electron-builder'], undefined);
  assert.match(server, /process\.env\.SPIKIVE_DATA_ROOT/);
  assert.match(server, /process\.env\.SPIKIVE_HOST/);
  assert.match(server, /面向建运一体化转型的实景三维多场景孪生应用底座系统已启动/);
  assert.match(deployScript, /release', 'web'/);
  assert.match(deployScript, /\.spikive-gs\/data/);
  assert.match(deployScript, /LOCALAPPDATA/);
  assert.match(deployScript, /'\.ts', '\.tsx', '\.map', '\.ply', '\.sqlite', '\.db'/);
  assert.doesNotMatch(deployScript, /resolve\(root, 'var'/);
  assert.match(packageScript, /SHA256SUMS\.txt/);
  assert.match(packageScript, /businessDataIncluded: false/);
  assert.match(packageScript, /'\.ts', '\.tsx', '\.map', '\.ply', '\.sqlite', '\.db'/);
  assert.doesNotMatch(packageScript, /rm\(deploymentRoot/);
  assert.match(viteConfig, /publicDir: command === 'serve' \? 'public' : false/);
});
