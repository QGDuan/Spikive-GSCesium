import { Cartesian3, Ellipsoid, HeadingPitchRoll, Math as CesiumMath, Matrix4, Transforms } from "cesium";
import type { Placement } from "@spikive/shared";

export function placementMatrix(placement: Placement): number[] {
  const origin = Cartesian3.fromDegrees(placement.longitude, placement.latitude, placement.height, Ellipsoid.WGS84);
  const hpr = new HeadingPitchRoll(CesiumMath.toRadians(placement.heading), CesiumMath.toRadians(placement.pitch), CesiumMath.toRadians(placement.roll));
  const matrix = Transforms.headingPitchRollToFixedFrame(origin, hpr, Ellipsoid.WGS84, Transforms.eastNorthUpToFixedFrame);
  Matrix4.multiplyByUniformScale(matrix, placement.scale, matrix);
  return Matrix4.toArray(matrix);
}

export function transformTileset(tileset: Record<string, unknown>, placement: Placement, contentRevision?: string) {
  const clone = structuredClone(tileset);
  const root = clone.root as Record<string, unknown> | undefined;
  if (!root) throw new Error("无效 tileset：缺少 root");
  root.transform = placementMatrix(placement);
  scaleGeometricError(clone, placement.scale);
  if (contentRevision) versionContentUris(root, contentRevision);
  return clone;
}

function versionContentUris(value: unknown, revision: string) {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  for (const key of ["content", "contents"] as const) {
    const entries = Array.isArray(object[key]) ? object[key] : object[key] ? [object[key]] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const content = entry as Record<string, unknown>;
      for (const uriKey of ["uri", "url"] as const) {
        if (typeof content[uriKey] !== "string" || content[uriKey].startsWith("data:")) continue;
        const separator = content[uriKey].includes("?") ? "&" : "?";
        content[uriKey] = `${content[uriKey]}${separator}revision=${encodeURIComponent(revision)}`;
      }
    }
  }
  if (Array.isArray(object.children)) for (const child of object.children) versionContentUris(child, revision);
}

function scaleGeometricError(value: unknown, scale: number) {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.geometricError === "number") object.geometricError *= scale;
  if (Array.isArray(object.children)) for (const child of object.children) scaleGeometricError(child, scale);
  if (object.root) scaleGeometricError(object.root, scale);
}
