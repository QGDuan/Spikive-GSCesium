import { Cartesian3, Ellipsoid, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from "cesium";
import type { Placement, Vec3 } from "@spikive/shared";

export function placementMatrix(placement: Placement) {
  const origin = Cartesian3.fromDegrees(placement.longitude, placement.latitude, placement.height, Ellipsoid.WGS84);
  const hpr = new HeadingPitchRoll(CesiumMath.toRadians(placement.heading), CesiumMath.toRadians(placement.pitch), CesiumMath.toRadians(placement.roll));
  const matrix = Transforms.headingPitchRollToFixedFrame(origin, hpr, Ellipsoid.WGS84, Transforms.eastNorthUpToFixedFrame);
  return Matrix4.multiplyByUniformScale(matrix, placement.scale, matrix);
}
export const localToWorld = (local: Vec3, transform: Matrix4) => Matrix4.multiplyByPoint(transform, new Cartesian3(local.x, local.y, local.z), new Cartesian3());
