import { describe, expect, it } from "vitest";
import { inspectionLabelIdFromPick } from "./inspection-label-selection";

describe("Cesium inspection annotation selection", () => {
  it("accepts both the label and its highlight halo entity", () => {
    expect(inspectionLabelIdFromPick({ id: { id: "app:label:motor-1" } })).toBe("motor-1");
    expect(inspectionLabelIdFromPick({ id: { id: "app:label-highlight:motor-1" } })).toBe("motor-1");
  });

  it("ignores route, waypoint, and non-entity picks", () => {
    expect(inspectionLabelIdFromPick({ id: { id: "app:waypoint:1" } })).toBeNull();
    expect(inspectionLabelIdFromPick({ primitive: {} })).toBeNull();
  });
});
