import assert from 'node:assert/strict';
import test from 'node:test';
import { Vec3 } from 'playcanvas';
import {
  createLevelFirstPersonPose,
  resolveFirstPersonMovement,
  updateFirstPersonLook
} from '../src/camera-orientation.ts';

const almostEqual = (actual, expected, epsilon = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} 应接近 ${expected}`);

test('手动进入第一人称时移除第三人称俯角并保留水平航向', () => {
  const position = new Vec3(2, 8, -3);
  const pose = createLevelFirstPersonPose(position, new Vec3(0.45, -0.8, -0.45), 0);
  const focus = pose.getFocus(new Vec3());

  almostEqual(pose.position.x, position.x);
  almostEqual(pose.position.y, position.y);
  almostEqual(pose.position.z, position.z);
  almostEqual(pose.angles.x, 0);
  almostEqual(pose.angles.z, 0);
  almostEqual(focus.y, position.y);
  assert.ok(focus.x > position.x);
  assert.ok(focus.z < position.z);
});

test('垂直视角切换第一人称时使用当前航向恢复水平前向', () => {
  const position = new Vec3(-1, 12, 4);
  const pose = createLevelFirstPersonPose(position, Vec3.DOWN, 90);
  const focus = pose.getFocus(new Vec3());

  almostEqual(pose.angles.x, 0);
  almostEqual(focus.y, position.y);
  almostEqual(focus.distance(position), 1);
  assert.ok(Math.abs(focus.x - position.x) > 0.9);
});

test('第一人称 W 与 A 严格沿官方前向和左向移动', () => {
  for (const yaw of [0, 37, 90, -145]) {
    const expectedForward = new Vec3();
    const expectedRight = new Vec3();
    const pose = createLevelFirstPersonPose(Vec3.ZERO, new Vec3(0, 0, -1), yaw);
    pose.angles.y = yaw;

    // Use the camera Pose itself as the reference, rather than assuming a world-axis sign.
    const rotation = pose.getFocus(expectedForward).sub(pose.position).normalize();
    const aMove = resolveFirstPersonMovement(new Vec3(-1, 0, 0), yaw, 1);
    const wMove = resolveFirstPersonMovement(new Vec3(0, 0, 1), yaw, 1);
    expectedRight.cross(rotation, Vec3.UP).normalize();

    assert.ok(wMove.dot(rotation) > 0.999999, `航向 ${yaw}° 时 W 必须朝镜头前方`);
    assert.ok(aMove.dot(expectedRight) < -0.999999, `航向 ${yaw}° 时 A 必须朝镜头左方`);
  }
});

test('第一人称 Q/E 只扩展世界高度且鼠标公式与官方控制器一致', () => {
  const qMove = resolveFirstPersonMovement(new Vec3(0, 1, 0), 63, 2);
  const eMove = resolveFirstPersonMovement(new Vec3(0, -1, 0), 63, 2);
  assert.deepEqual(qMove.toArray(), [0, 2, 0]);
  assert.deepEqual(eMove.toArray(), [0, -2, 0]);

  const angles = new Vec3(0, 0, 9);
  updateFirstPersonLook(angles, 10, -5, 1 / 60);
  almostEqual(angles.x, 0.4);
  almostEqual(angles.y, -0.8);
  almostEqual(angles.z, 0);
});
