import { describe, expect, it } from "vitest";
import type { Waypoint } from "@spikive/shared";
import { routeWaypointVisual } from "./route-visuals";

const waypoint = (type: Waypoint["type"], valid = true): Waypoint => ({
  id: "00000000-0000-4000-8000-000000000001",
  sequence: 0,
  type,
  positionLocal: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  speed: 2,
  targetLabelId: type === "inspection" ? "00000000-0000-4000-8000-000000000002" : null,
  generated: true,
  clearance: 2,
  valid
});

describe("route waypoint visuals", () => {
  it("renders label inspection points red with the durable hj name", () => {
    expect(routeWaypointVisual(waypoint("inspection"), 3, "配电箱")).toMatchObject({ name: "hj_配电箱", color: "#e32636", emphasized: true });
  });

  it("renders generated transit points blue and Home neutral", () => {
    expect(routeWaypointVisual(waypoint("transit"), 4)).toMatchObject({ name: "4 transit", color: "#1677ff" });
    expect(routeWaypointVisual(waypoint("home"), 0)).toMatchObject({ name: "0 home", color: "#111318" });
  });

  it("renders a label-derived route origin red", () => {
    const start = { ...waypoint("home"), targetLabelId: "00000000-0000-4000-8000-000000000002" };
    expect(routeWaypointVisual(start, 0, "入口")).toMatchObject({ name: "hj_入口", color: "#e32636", emphasized: true });
  });

  it("uses an explicit warning color for an invalid stored point", () => {
    expect(routeWaypointVisual(waypoint("transit", false), 1).color).toBe("#ff8a00");
  });
});
