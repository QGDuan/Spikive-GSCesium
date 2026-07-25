import { describe, expect, it } from "vitest";
import type { InspectionLabel, Waypoint } from "@spikive/shared";
import { distance } from "@spikive/shared";
import { enforceMinimumWaypointSpacing, findCollisionAwarePath, planMission } from "./planner.js";

const freeWorld = {
  resolution: 0.2,
  sphereIsFree: () => true,
  segmentIsFree: () => true,
  estimateClearance: (_point: unknown, maximum: number) => maximum
};
const label: InspectionLabel = {
  id: "00000000-0000-4000-8000-000000000001", datasetId: "00000000-0000-4000-8000-000000000002",
  title: "绝缘子", description: "", category: "巡检点", color: "#ffb020",
  positionLocal: { x: 5, y: 0, z: 2 }, surfaceNormalLocal: { x: -1, y: 0, z: 0 },
  snapDistance: 0.05, resolutionStatus: "resolved", createdAt: "", updatedAt: ""
};
const profile = { droneRadius: 0.3, safetyMargin: 0.2, observationDistance: 2, speed: 2, minimumWaypointSpacing: 0.5, maximumSegmentLength: 10 };

describe("mission planner", () => {
  it("creates home-inspection-home route", () => {
    const result = planMission({ x: 0, y: 0, z: 2 }, [label], profile, freeWorld);
    expect(result.valid).toBe(true);
    expect(result.waypoints.map(point => point.type)).toEqual(["home", "inspection", "home"]);
    expect(result.waypoints[1]?.targetLabelId).toBe(label.id);
  });
  it("derives a collision-checked route origin from a label and returns to it", () => {
    const startLabel = { ...label, id: "00000000-0000-4000-8000-000000000003", title: "起点", positionLocal: { x: 0, y: 0, z: 2 }, surfaceNormalLocal: { x: 1, y: 0, z: 0 } };
    const result = planMission({ x: 999, y: 999, z: 999 }, [label], profile, freeWorld, startLabel);
    expect(result.valid).toBe(true);
    expect(result.waypoints[0]?.type).toBe("home");
    expect(result.waypoints[0]?.targetLabelId).toBe(startLabel.id);
    expect(result.waypoints.at(-1)?.positionLocal).toEqual(result.waypoints[0]?.positionLocal);
    expect(result.waypoints.at(-1)?.targetLabelId).toBe(startLabel.id);
    expect(result.waypoints.some(point => point.type === "inspection" && point.targetLabelId === label.id)).toBe(true);
  });
  it("rejects unresolved labels", () => {
    const result = planMission({ x: 0, y: 0, z: 2 }, [{ ...label, resolutionStatus: "unresolved", surfaceNormalLocal: null }], profile, freeWorld);
    expect(result.valid).toBe(false);
  });

  it("searches a full observation cone for vertical surface normals", () => {
    const verticalLabel = { ...label, positionLocal: { x: 0, y: 0, z: 5 }, surfaceNormalLocal: { x: 0, y: 0, z: 1 } };
    const world = {
      ...freeWorld,
      sphereIsFree: (point: { x: number; y: number }) => Math.hypot(point.x, point.y) > 0.25,
      segmentIsFree: () => true
    };
    const result = planMission({ x: 1, y: 0, z: 2 }, [verticalLabel], profile, world);
    expect(result.valid).toBe(true);
    const inspection = result.waypoints.find(point => point.type === "inspection");
    expect(inspection).toBeDefined();
    expect(Math.hypot(inspection!.positionLocal.x, inspection!.positionLocal.y)).toBeGreaterThan(0.25);
  });

  it("subdivides long collision-free legs and revalidates every final segment", () => {
    const checked: Array<{ radius: number; length: number }> = [];
    const world = {
      ...freeWorld,
      segmentIsFree: (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, radius: number) => {
        checked.push({ radius, length: distance(from, to) });
        return true;
      }
    };
    const result = planMission({ x: 0, y: 0, z: 2 }, [label], { ...profile, maximumSegmentLength: 1 }, world);
    expect(result.valid).toBe(true);
    expect(result.waypoints.filter(point => point.type === "transit").length).toBeGreaterThan(0);
    for (let index = 1; index < result.waypoints.length; index++) {
      expect(distance(result.waypoints[index - 1]!.positionLocal, result.waypoints[index]!.positionLocal)).toBeLessThanOrEqual(1.000001);
    }
    expect(checked.some(value => value.radius === profile.droneRadius + profile.safetyMargin && value.length <= 1.000001)).toBe(true);
  });

  it("returns only the revalidated safe prefix as a non-exportable preview", () => {
    const previewLabel = { ...label, positionLocal: { x: 6, y: 0, z: 2 } };
    const world = {
      ...freeWorld,
      sphereIsFree: (point: { x: number; y: number; z: number }) => Math.abs(point.x - 2) > 1e-9,
      // Reproduce a coarse long-segment pass whose later subdivision exposes
      // an occupied generated waypoint at x=2.
      segmentIsFree: () => true
    };
    const result = planMission({ x: 0, y: 0, z: 2 }, [previewLabel], { ...profile, maximumSegmentLength: 1 }, world);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("最终航迹点 3");
    expect(result.error).toContain("禁止导出或执行");
    expect(result.waypoints.map(point => point.positionLocal.x)).toEqual([0, 1]);
    expect(result.waypoints.every(point => point.valid)).toBe(true);
  });

  it("returns completed safe legs when a later label cannot be reached", () => {
    const first = { ...label, positionLocal: { x: 6, y: 0, z: 2 } };
    const second = { ...label, id: "00000000-0000-4000-8000-000000000004", positionLocal: { x: 12, y: 0, z: 2 } };
    const world = {
      ...freeWorld,
      segmentIsFree: (_from: { x: number }, to: { x: number }, radius: number) => radius === 0 || to.x <= 5
    };
    const result = planMission({ x: 0, y: 0, z: 2 }, [first, second], profile, world);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("第 2 个航段无法绕开");
    expect(result.error).toContain("禁止导出或执行");
    expect(result.waypoints.map(point => point.positionLocal.x)).toEqual([0, 4]);
    expect(result.waypoints[1]).toMatchObject({ type: "inspection", targetLabelId: first.id, valid: true });
  });

  it("checks continuous swept-sphere edges while A* routes around an obstacle", () => {
    const center = { x: 2, y: 0, z: 0 };
    const expandedObstacleRadius = 0.75;
    const sphereIsFree = (point: { x: number; y: number; z: number }) => distance(point, center) > expandedObstacleRadius;
    const segmentIsFree = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => {
      const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
      const lengthSquared = delta.x ** 2 + delta.y ** 2 + delta.z ** 2;
      const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
        ((center.x - from.x) * delta.x + (center.y - from.y) * delta.y + (center.z - from.z) * delta.z) / lengthSquared));
      return distance({ x: from.x + delta.x * projection, y: from.y + delta.y * projection, z: from.z + delta.z * projection }, center) > expandedObstacleRadius;
    };
    const world = { resolution: 0.5, sphereIsFree, segmentIsFree: (from: typeof center, to: typeof center, _radius: number) => segmentIsFree(from, to), estimateClearance: (_point: unknown, maximum: number) => maximum };
    const path = findCollisionAwarePath({ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 0.5, world);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(2);
    for (let index = 1; index < path!.length; index++) expect(segmentIsFree(path![index - 1]!, path![index]!)).toBe(true);
  });

  it("only removes close transit points when the shortcut remains collision-free", () => {
    const waypoint = (sequence: number, type: Waypoint["type"], x: number): Waypoint => ({
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      sequence, type, positionLocal: { x, y: 0, z: 2 }, yaw: 0, pitch: 0,
      speed: 2, targetLabelId: null, generated: true, clearance: 2, valid: true
    });
    const points = [waypoint(0, "home", 0), waypoint(1, "transit", 0.2), waypoint(2, "transit", 0.4), waypoint(3, "home", 1)];
    const blockedShortcut = {
      ...freeWorld,
      segmentIsFree: (from: { x: number }, to: { x: number }) => !(from.x === 0 && to.x === 0.4)
    };
    expect(enforceMinimumWaypointSpacing(points, 0.5, 0.5, blockedShortcut).map(point => point.positionLocal.x)).toEqual([0, 0.2, 1]);
    expect(enforceMinimumWaypointSpacing(points, 0.5, 0.5, freeWorld).map(point => point.positionLocal.x)).toEqual([0, 1]);
  });
});
