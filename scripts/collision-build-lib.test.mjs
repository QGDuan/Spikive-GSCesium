import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_VOXEL_OPACITY,
  DEFAULT_VOXEL_SIZE,
  recommendedWorkerCount,
  validateCollisionArtifact,
  validateCollisionOptions
} from './collision-build-lib.mjs';

test('体素参数固定默认值且不自动调节', () => {
  assert.deepEqual(validateCollisionOptions(), {
    voxelSize: DEFAULT_VOXEL_SIZE,
    voxelOpacity: DEFAULT_VOXEL_OPACITY
  });
  assert.deepEqual(validateCollisionOptions({ voxelSize: 0.35, voxelOpacity: 0.2 }), {
    voxelSize: 0.35,
    voxelOpacity: 0.2
  });
  assert.throws(() => validateCollisionOptions({ voxelSize: 0.001 }), /体素边长/);
});

test('官方 worker 数保持在安全的多核范围', () => {
  assert.ok(recommendedWorkerCount() >= 1);
  assert.ok(recommendedWorkerCount() <= 4);
});

test('校验官方 sparse voxel octree 文件闭环', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'spikive-voxel-test-'));
  try {
    const metadata = {
      version: '1.1',
      asset: { generator: 'splat-transform test' },
      gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
      sceneBounds: { min: [0.1, 0.1, 0.1], max: [3.9, 3.9, 3.9] },
      voxelResolution: 0.2,
      leafSize: 4,
      treeDepth: 2,
      numInteriorNodes: 1,
      numMixedLeaves: 1,
      nodeCount: 3,
      leafDataCount: 2
    };
    await writeFile(resolve(directory, 'scene.voxel.json'), JSON.stringify(metadata));
    await writeFile(resolve(directory, 'scene.voxel.bin'), Buffer.alloc(20));
    const report = await validateCollisionArtifact(directory, {
      voxelSize: 0.2,
      voxelOpacity: 0.1
    });
    assert.equal(report.binaryBytes, 20);
    assert.equal(report.metadata.treeDepth, 2);
    assert.match(report.checksums['scene.voxel.bin'], /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
