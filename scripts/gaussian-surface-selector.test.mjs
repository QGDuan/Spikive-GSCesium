import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FIXED_CIRCLE_RADIUS_PIXELS,
  GAUSSIAN_SURFACE_PICK_BACKEND,
  SURFACE_DEPTH_SAMPLE_OFFSETS,
  createGaussianSurfaceSelection
} from '../src/gaussian-surface-selector.ts';

test('深度 Picker 前表面样本拟合平面法向并朝向相机', () => {
  const points = [
    { x: -1, y: -1, z: 2 },
    { x: 1, y: -1, z: 2 },
    { x: -1, y: 1, z: 2 },
    { x: 1, y: 1, z: 2 },
    { x: 0, y: 0, z: 2 }
  ];
  const result = createGaussianSurfaceSelection(points[4], points, { x: 0, y: 0, z: 10 });
  assert.deepEqual(result.position, points[4]);
  assert.ok(Math.abs(result.normal.x) < 1e-9);
  assert.ok(Math.abs(result.normal.y) < 1e-9);
  assert.ok(result.normal.z > 0.999999);
  assert.equal(result.neighborCount, points.length);
  assert.equal(result.pickBackend, GAUSSIAN_SURFACE_PICK_BACKEND);
  assert.deepEqual(result.residentLodLevels, []);
  assert.equal(result.residentFileCount, 0);
});

test('法向符号随选择时相机侧翻转', () => {
  const points = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 }
  ];
  const result = createGaussianSurfaceSelection(points[0], points, { x: 0, y: 0, z: -2 });
  assert.ok(result.normal.z < -0.999999);
});

test('固定采样模板完全位于 5px 圆内且退化线样本被拒绝', () => {
  assert.equal(FIXED_CIRCLE_RADIUS_PIXELS, 5);
  assert.ok(SURFACE_DEPTH_SAMPLE_OFFSETS.length >= 9);
  assert.ok(SURFACE_DEPTH_SAMPLE_OFFSETS.every(({ x, y }) =>
    x * x + y * y <= FIXED_CIRCLE_RADIUS_PIXELS ** 2
  ));
  assert.throws(() => createGaussianSurfaceSelection(
    { x: 0, y: 0, z: 0 },
    [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }],
    { x: 0, y: 0, z: 1 }
  ), /无法可靠计算平面法向/);
});

test('标签选择只复用官方 Picker 深度，不再维护自定义 GS 选择 Shader', async () => {
  const [viewer, selector] = await Promise.all([
    readFile(new URL('../src/viewer.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/gaussian-surface-selector.ts', import.meta.url), 'utf8')
  ]);
  assert.match(viewer, /new Picker\(this\.app, 1, 1, true\)/);
  assert.match(viewer, /picker\.getWorldPointAsync/);
  assert.doesNotMatch(selector, /GraphicsDevice|ShaderUtils|drawQuadWithShader|activePlacements|RGBA32F/);
});
