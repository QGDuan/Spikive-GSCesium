import { math, Pose, Quat, Vec3 } from 'playcanvas';

const levelForward = new Vec3();
const levelTarget = new Vec3();
const fallbackRotation = new Quat();
const firstPersonRotation = new Quat();
const firstPersonForward = new Vec3();
const firstPersonRight = new Vec3();
const firstPersonLookDelta = new Vec3();

export const OFFICIAL_FIRST_PERSON_LOOK_SENSITIVITY = 0.08;

export const createLevelFirstPersonPose = (
  position: Vec3,
  forward: Vec3,
  fallbackYaw: number,
  out = new Pose()
) => {
  levelForward.copy(forward);
  levelForward.y = 0;
  if (levelForward.lengthSq() <= 1e-8) {
    fallbackRotation.setFromEulerAngles(0, fallbackYaw, 0);
    fallbackRotation.transformVector(Vec3.FORWARD, levelForward);
  }
  levelForward.normalize();
  levelTarget.copy(position).add(levelForward);
  return out.look(position, levelTarget);
};

/** Apply the public PlayCanvas FirstPersonController mouse-look formula to camera Euler angles. */
export const updateFirstPersonLook = (
  angles: Vec3,
  mouseX: number,
  mouseY: number,
  deltaTime: number
) => {
  const rotateMultiplier = OFFICIAL_FIRST_PERSON_LOOK_SENSITIVITY * 60 * deltaTime;
  angles.add(firstPersonLookDelta.set(
    -mouseY * rotateMultiplier,
    -mouseX * rotateMultiplier,
    0
  ));
  angles.x = math.clamp(angles.x, -90, 90);
  angles.z = 0;
  return angles;
};

/**
 * Resolve D-A / W-S against a yaw-only basis exactly as FirstPersonController does. The Y axis is
 * a product extension for Q/E and deliberately remains world vertical.
 */
export const resolveFirstPersonMovement = (
  axis: Vec3,
  yawDegrees: number,
  distance: number,
  out = new Vec3()
) => {
  firstPersonRotation.setFromEulerAngles(0, yawDegrees, 0);
  firstPersonRotation.transformVector(Vec3.FORWARD, firstPersonForward);
  firstPersonRotation.transformVector(Vec3.RIGHT, firstPersonRight);
  out.set(0, 0, 0)
    .add(firstPersonForward.mulScalar(axis.z))
    .add(firstPersonRight.mulScalar(axis.x));
  out.y += axis.y;
  if (out.lengthSq() > 1) out.normalize();
  return out.mulScalar(distance);
};
