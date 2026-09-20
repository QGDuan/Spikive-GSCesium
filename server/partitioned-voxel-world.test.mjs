import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { hashFile, atomicJson } from '../scripts/build-support.mjs';
import {
  validatePartitionManifest,
  splitCore,
  createExtentCalculator
} from '../scripts/partitioned-collision.mjs';
import { openCollisionWorld, PartitionedVoxelWorld, VoxelPageCache } from './partitioned-voxel-world.mjs';
import { VoxelWorld, PLY_SOURCE_TO_VOXEL_IDENTITY } from './voxel-world.mjs';
import { planMission } from './route-planner.mjs';
import { planInWorker } from './route-job.mjs';

const metadata = {
  version: '1.1',
  leafSize: 4,
  treeDepth: 1,
  voxelResolution: 1,
  nodeCount: 2,
  leafDataCount: 2,
  numInteriorNodes: 1,
  numMixedLeaves: 1,
  gridBounds: { min: [0, 0, 0], max: [8, 4, 4] },
  sceneBounds: { min: [0, 0, 0], max: [8, 4, 4] }
};
const binary = Buffer.from(new Uint32Array([0x01000001, 0, 1, 0]).buffer);
const fixture = async (directory) => {
  await mkdir(resolve(directory, 'parts/a'), { recursive: true });
  await atomicJson(resolve(directory, 'parts/a/scene.voxel.json'), metadata);
  await writeFile(resolve(directory, 'parts/a/scene.voxel.bin'), binary);
  const checksums = Object.fromEntries(
    await Promise.all(
      ['json', 'bin'].map(async (ext) => {
        const path = `parts/a/scene.voxel.${ext}`;
        return [path, await hashFile(resolve(directory, path))];
      })
    )
  );
  const manifest = {
    schemaVersion: 2,
    complete: true,
    options: { voxelSize: 1, voxelOpacity: 0.1 },
    root: { min: [0, 0, 0], max: [2, 1, 1] },
    gridBounds: metadata.gridBounds,
    partitions: [
      {
        id: 'a',
        core: { min: [0, 0, 0], max: [1, 1, 1] },
        empty: false,
        file: 'parts/a/scene.voxel.json',
        checksums,
        metadata
      },
      { id: 'b', core: { min: [1, 0, 0], max: [2, 1, 1] }, empty: true, count: 0 }
    ]
  };
  await atomicJson(resolve(directory, 'collision-manifest.json'), manifest);
  return manifest;
};
test('分区查询复用原碰撞数学、跨区扫掠一致且缺区不视为空', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'svo-part-test-'));
  let world;
  try {
    const manifest = await fixture(dir);
    await validatePartitionManifest(manifest, dir);
    world = openCollisionWorld(dir);
    const whole = new VoxelWorld(metadata, binary, { coordinateTransform: PLY_SOURCE_TO_VOXEL_IDENTITY });
    for (let x = 0.5; x < 8; x++)
      for (let y = 0.5; y < 4; y++)
        for (let z = 0.5; z < 4; z++) {
          const p = { x: -x, y: -y, z };
          assert.equal(world.isOccupied(p), whole.isOccupied(p));
          for (const r of [0, 0.1, 0.3]) assert.equal(world.sphereIsFree(p, r), whole.sphereIsFree(p, r));
        }
    for (const to of [
      { x: -7, y: -2, z: 2 },
      { x: -0.5, y: -0.5, z: 0.5 }
    ]) {
      assert.equal(
        world.segmentIsFree({ x: -3, y: -2, z: 2 }, to, 0.2),
        whole.segmentIsFree({ x: -3, y: -2, z: 2 }, to, 0.2)
      );
    }
    const input = {
      startLabel: {
        id: 'start',
        title: '起点',
        resolved: true,
        position: { x: -6, y: -2, z: 0.5 },
        normal: { x: 0, y: 0, z: 1 }
      },
      labels: [
        {
          id: 'target',
          title: '目标',
          resolved: true,
          position: { x: -2, y: -2, z: 1 },
          normal: { x: 0, y: 0, z: 1 }
        }
      ],
      profile: {
        speed: 4,
        inflationRadius: 0.1,
        observationDistance: 1,
        minimumSpacing: 0.5,
        maximumSpacing: 2
      }
    };
    const legacyPlan = planMission({ ...input, collision: whole });
    const partitionPlan = await planInWorker(
      dir,
      input,
      await hashFile(resolve(dir, 'collision-manifest.json'))
    );
    const stable = (plan) => ({ ...plan, waypoints: plan.waypoints.map(({ id, ...point }) => point) });
    assert.equal(legacyPlan.valid, true);
    assert.deepEqual(stable(partitionPlan), stable(legacyPlan));
    const broken = { ...manifest, partitions: [manifest.partitions[0]] };
    await assert.rejects(validatePartitionManifest(broken, dir), /覆盖/);
    const missing = new PartitionedVoxelWorld(broken, dir);
    try {
      assert.throws(() => missing.isOccupied({ x: -5, y: -1, z: 1 }), /缺失/);
    } finally {
      missing.close();
    }
    const overlap = structuredClone(manifest);
    overlap.partitions[1].core = overlap.partitions[0].core;
    await assert.rejects(validatePartitionManifest(overlap, dir), /重叠/);
  } finally {
    world?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('损坏分区和清单摘要变化均拒绝规划', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'svo-corrupt-test-'));
  try {
    await fixture(dir);
    const digest = await hashFile(resolve(dir, 'collision-manifest.json'));
    await writeFile(resolve(dir, 'parts/a/scene.voxel.bin'), Buffer.alloc(binary.length));
    const world = openCollisionWorld(dir, { manifestSha256: digest });
    try {
      assert.throws(() => world.isOccupied({ x: -1, y: -1, z: 1 }), /损坏/);
    } finally {
      world.close();
    }
    await writeFile(resolve(dir, 'collision-manifest.json'), '{}');
    assert.throws(() => openCollisionWorld(dir, { manifestSha256: digest }), /损坏/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('分页缓存固定上限并释放文件句柄', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'svo-cache-test-'));
  const cache = new VoxelPageCache(128 * 1024);
  try {
    const file = resolve(dir, 'data.bin');
    await writeFile(file, Buffer.alloc(512 * 1024, 1));
    for (let i = 0; i < 512 * 1024; i += 65536) assert.equal(cache.word(file, i), 0x01010101);
    assert.ok(cache.bytes <= 128 * 1024);
    assert.throws(() => cache.word(file, 999999), /偏移/);
    cache.close();
    assert.equal(cache.bytes, 0);
    assert.equal(cache.files.size, 0);
  } finally {
    cache.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('分区只分块不改精度，旋转椭球贡献范围含中心外区域', () => {
  assert.deepEqual(splitCore({ min: [0, 0, 0], max: [3, 1, 1] }), [
    { min: [0, 0, 0], max: [1, 1, 1] },
    { min: [1, 0, 0], max: [3, 1, 1] }
  ]);
  assert.throws(() => splitCore({ min: [0, 0, 0], max: [1, 1, 1] }), /最小/);
  const b = createExtentCalculator()(
    [10, 20, 3],
    [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    [Math.log(2), Math.log(0.1), Math.log(0.1)]
  );
  assert.ok(b.min[1] < -25 && b.max[1] > -15);
  assert.ok(b.min[0] > -11 && b.max[0] < -9);
});
