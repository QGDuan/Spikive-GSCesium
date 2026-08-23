import assert from 'node:assert/strict';
import test from 'node:test';

import { VoxelWorld } from './voxel-world.mjs';

const metadata = {
  version: '1.1',
  gridBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  sceneBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  voxelResolution: 1,
  leafSize: 4,
  treeDepth: 1,
  nodeCount: 1,
  leafDataCount: 0
};

const binary = (words) => Buffer.from(new Uint32Array(words).buffer);

test('读取完整占用叶并从网格外命中首个表面', () => {
  const world = new VoxelWorld(metadata, binary([0xff000000]));
  assert.equal(world.isOccupied({ x: 1, y: 1, z: 1 }), true);
  assert.equal(world.isOccupied({ x: 5, y: 1, z: 1 }), false);
  const hit = world.raycast({ x: -1, y: 2, z: 2 }, { x: 1, y: 0, z: 0 });
  assert.ok(hit);
  assert.ok(hit.position.x >= 0 && hit.position.x < 0.1);
  assert.deepEqual(Object.keys(hit).sort(), ['distance', 'position']);
});

test('读取 mixed leaf 位掩码', () => {
  const mixedMetadata = { ...metadata, nodeCount: 2, leafDataCount: 2 };
  const world = new VoxelWorld(mixedMetadata, binary([0x01000001, 0, 1, 0]));
  assert.equal(world.isOccupied({ x: 0.1, y: 0.1, z: 0.1 }), true);
  assert.equal(world.isOccupied({ x: 1.1, y: 0.1, z: 0.1 }), false);
});

test('相机位于初始占用区域时不会把相机位置当成巡检点', () => {
  const mixedMetadata = { ...metadata, nodeCount: 2, leafDataCount: 2 };
  const world = new VoxelWorld(mixedMetadata, binary([0x01000001, 0, 0b0101, 0]));
  const hit = world.raycast({ x: 0.1, y: 0.1, z: 0.1 }, { x: 1, y: 0, z: 0 });
  assert.ok(hit);
  assert.ok(hit.position.x >= 2);
});
