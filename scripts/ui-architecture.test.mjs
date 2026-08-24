import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const walk = (relativeDirectory) => readdirSync(join(root, relativeDirectory), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? walk(`${relativeDirectory}/${entry.name}`)
    : [`${relativeDirectory}/${entry.name}`]);
const sourceFiles = walk('src');
const componentFiles = sourceFiles.filter((name) => name.endsWith('.tsx')).map((name) => [name, read(name)]);
const applicationStyles = sourceFiles.filter((name) => name.endsWith('.css') && name !== 'src/ui/theme.css');

test('主题令牌是应用颜色与字体的唯一来源', () => {
  assert.match(read('src/styles.css'), /^@import ['"]\.\/ui\/theme\.css['"];\n/);
  for (const name of applicationStyles) {
    const source = read(name);
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b|rgba?\(/i, `${name} 不得硬编码颜色`);
    assert.doesNotMatch(source, /font-weight:\s*\d|font:\s*\d{3}\b/i, `${name} 不得绕过字重令牌`);
  }
  for (const [name, source] of componentFiles) {
    assert.doesNotMatch(source, /style\s*=\s*\{\{/i, `${name} 不得内联视觉样式`);
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b|rgba?\(/i, `${name} 不得硬编码颜色`);
  }
});

test('业务界面按场景、标签、航线、性能和壳层拆分', () => {
  const shell = read('src/ui/AppShell.tsx');
  const contracts = read('src/ui/contracts.ts');
  assert.match(contracts, /WorkspaceTab = 'scenes' \| 'labels' \| 'missions'/);
  assert.doesNotMatch(shell, /activeTab === 'data'|onTab\('data'\)/);
  assert.doesNotMatch(read('src/main.tsx'), /数据卡片/);
  for (const component of ['ScenePanel', 'LabelPanel', 'MissionPanel', 'InspectionCard', 'PerformanceCard']) {
    assert.match(shell, new RegExp(`<${component}\\b`));
  }
  assert.ok(shell.split('\n').length <= 60, 'AppShell 只负责布局组合，不应重新承载业务实现');
});

test('卡片统一使用容器原语且标签页不改变场景归属', () => {
  const scenes = read('src/ui/ScenePanel.tsx');
  const labels = read('src/ui/LabelPanel.tsx');
  const missions = read('src/ui/MissionPanel.tsx');
  const performance = read('src/ui/PerformanceCard.tsx');
  assert.match(scenes, /<UiContainer[^>]+variant="panel"/);
  assert.match(scenes, /<UiContainer[^>]+variant="card"/);
  assert.match(labels, /<UiContainer[^>]+variant="panel"/);
  assert.match(labels, /<UiContainer[^>]+variant="floating"/);
  assert.match(missions, /<UiContainer[^>]+variant="panel"/);
  assert.match(missions, /<UiContainer[^>]+variant="card"/);
  assert.match(performance, /<UiContainer[^>]+variant="floating"/);
  assert.doesNotMatch(labels, /<select\b|onLabelSpatial|onDatasetAction/);
  assert.doesNotMatch(missions, /onDatasetAction|onUpload|onCardSettings/);
});

test('性能卡片只公开五项只读指标', () => {
  const source = read('src/ui/PerformanceCard.tsx');
  const metrics = [...source.matchAll(/data-metric="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(metrics, ['fps', 'gaussians', 'system-cpu', 'system-memory', 'engine-vram']);
});
