import assert from 'node:assert/strict';
import test from 'node:test';

import { findCollisionAwarePath, planMission } from './route-planner.mjs';

const collision = {
  resolution: 0.2,
  sphereIsFree: () => true,
  segmentIsFree: () => true,
  estimateClearance: (_point, maximum) => maximum
};

test('起点沿自身法向固定起飞 1.5m，巡检节点才使用观察距离', () => {
  const startLabel = {
    id: 'start', title: '起点', resolved: true,
    position: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }
  };
  const target = {
    id: 'target', title: '电机', resolved: true,
    position: { x: 10, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }
  };
  const result = planMission({
    startLabel, labels: [target], collision,
    profile: { speed: 4, inflationRadius: 0.5, observationDistance: 3, minimumSpacing: 0.5, maximumSpacing: 100 }
  });
  assert.equal(result.valid, true);
  assert.equal(result.waypoints.length, 3);
  assert.deepEqual(result.waypoints[0].position, { x: 1.5, y: 0, z: 0 });
  assert.equal(result.waypoints[0].targetLabelId, null);
  assert.deepEqual(result.waypoints[1].position, { x: 10, y: 3, z: 0 });
  assert.deepEqual(result.waypoints[2].position, result.waypoints[0].position);
  assert.equal(result.waypoints[2].targetLabelId, null);
  assert.equal(result.waypoints[1].targetLabelId, target.id);
  assert.equal(result.waypoints[1].yaw, 180);
});

test('起点法向通道被占用时不会退化成观察点搜索', () => {
  const startLabel = {
    id: 'start', title: '起点', resolved: true,
    position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }
  };
  const target = {
    id: 'target', title: '电机', resolved: true,
    position: { x: 10, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }
  };
  const blocked = {
    ...collision,
    sphereIsFree: (point) => point.z !== 1.5
  };
  const result = planMission({
    startLabel, labels: [target], collision: blocked,
    profile: { speed: 4, inflationRadius: 0.5, observationDistance: 8, minimumSpacing: 0.5, maximumSpacing: 100 }
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /沿法向 1.5 米/);
  assert.equal(result.waypoints.length, 0);
});

test('观察视线只豁免法向外侧四个体素内的表面厚度', () => {
  const startLabel = {
    id: 'start', title: '起点', resolved: true,
    position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }
  };
  const target = {
    id: 'target', title: '电机', resolved: true,
    position: { x: 10, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }
  };
  const surfaceAware = {
    ...collision,
    sphereIsFree: (point, radius) => radius > 0 || point.x !== 10 || point.y >= 0.4
  };
  const result = planMission({
    startLabel, labels: [target], collision: surfaceAware,
    profile: { speed: 4, inflationRadius: 0.5, observationDistance: 3, minimumSpacing: 0.5, maximumSpacing: 100 }
  });
  assert.equal(result.valid, true);

  const tooThick = {
    ...collision,
    sphereIsFree: (point, radius) => radius > 0 || point.x !== 10 || point.y > 0.8
  };
  const rejected = planMission({
    startLabel, labels: [target], collision: tooThick,
    profile: { speed: 4, inflationRadius: 0.5, observationDistance: 3, minimumSpacing: 0.5, maximumSpacing: 100 }
  });
  assert.equal(rejected.valid, false);
  assert.match(rejected.error, /找不到满足观察距离/);
});

test('A* 预算耗尽与自由空间不连通使用不同诊断状态', () => {
  const boundedCollision = {
    ...collision,
    segmentIsFree: (from, to) => Math.hypot(
      to.x - from.x,
      to.y - from.y,
      to.z - from.z
    ) <= 0.5
  };
  const result = findCollisionAwarePath(
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    0.5,
    boundedCollision,
    { maximumExpansions: 1 }
  );
  assert.equal(result.status, 'expansion-limit');
  assert.equal(result.path, null);
  assert.equal(result.expansions, 1);
  assert.equal(result.expansionLimit, 1);
});
