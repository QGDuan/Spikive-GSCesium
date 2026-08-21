import type { Vec3 } from "@spikive/shared";

/** Fixed Rx(-90°): dataset-local Z-up -> AHoLo render Y-up. */
export function localToAholo(value: Vec3): Vec3 {
  return { x: value.x, y: value.z, z: -value.y };
}

/** Exact inverse of localToAholo. */
export function aholoToLocal(value: Vec3): Vec3 {
  return { x: value.x, y: -value.z, z: value.y };
}

export function normalizeVec3(value: Vec3): Vec3 | null {
  const length = Math.hypot(value.x, value.y, value.z);
  return length > 1e-12 ? { x: value.x / length, y: value.y / length, z: value.z / length } : null;
}
