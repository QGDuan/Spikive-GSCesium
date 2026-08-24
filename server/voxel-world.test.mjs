import assert from 'node:assert/strict';
import test from 'node:test';

import { PLY_SOURCE_TO_VOXEL_IDENTITY, VoxelWorld } from './voxel-world.mjs';

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

test('膨胀球和航段扫掠把占用体素当作实体立方体', () => {
  const mixedMetadata = { ...metadata, nodeCount: 2, leafDataCount: 2 };
  const world = new VoxelWorld(mixedMetadata, binary([0x01000001, 0, 1, 0]));
  assert.equal(world.sphereIsFree({ x: 1.2, y: 0.5, z: 0.5 }, 0.1), true);
  assert.equal(world.sphereIsFree({ x: 1.05, y: 0.5, z: 0.5 }, 0.1), false);
  assert.equal(world.segmentIsFree({ x: 1.2, y: 0.5, z: 0.5 }, { x: 3, y: 0.5, z: 0.5 }, 0.1), true);
  assert.equal(world.segmentIsFree({ x: 1.2, y: 0.5, z: 0.5 }, { x: 0.5, y: 0.5, z: 0.5 }, 0.1), false);
});

test('PLY 源坐标通过 Rz(180°) 适配官方 identity 体素坐标', () => {
  const mixedMetadata = {
    ...metadata,
    gridBounds: { min: [0, 0, 0], max: [4, 8, 4] },
    sceneBounds: { min: [0, 0, 0], max: [4, 8, 4] },
    nodeCount: 2,
    leafDataCount: 2
  };
  const world = new VoxelWorld(mixedMetadata, binary([0x01000001, 0, 1, 0]), {
    coordinateTransform: PLY_SOURCE_TO_VOXEL_IDENTITY
  });
  assert.deepEqual(world.bounds, {
    min: { x: -4, y: -8, z: 0 },
    max: { x: 0, y: 0, z: 4 }
  });
  assert.equal(world.isOccupied({ x: -0.1, y: -0.1, z: 0.1 }), true);
  assert.equal(world.isOccupied({ x: -1.1, y: -0.1, z: 0.1 }), false);
  assert.equal(world.sphereIsFree({ x: -1.2, y: -0.5, z: 0.5 }, 0.1), true);
  assert.equal(world.segmentIsFree(
    { x: -1.2, y: -0.5, z: 0.5 },
    { x: -0.5, y: -0.5, z: 0.5 },
    0.1
  ), false);
  const hit = world.raycast({ x: 1, y: -0.1, z: 0.1 }, { x: -1, y: 0, z: 0 });
  assert.ok(hit);
  assert.ok(hit.position.x <= 0 && hit.position.x > -0.1);
});
