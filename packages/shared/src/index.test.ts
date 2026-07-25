import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatasetSchema, createMissionSchema, distance, normalize, patchMissionSchema } from "./index.js";

describe("shared contracts", () => {
  it("normalizes vectors", () => {
    const value = normalize({ x: 3, y: 0, z: 4 });
    expect(value?.x).toBeCloseTo(0.6); expect(value?.y).toBe(0); expect(value?.z).toBeCloseTo(0.8);
  });
  it("computes distance", () => expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5));
  it("rejects oversized datasets", () => {
    const result = createDatasetSchema.safeParse({
      name: "x", sourceFileName: "x.ply", sourceSize: 6 * 1024 ** 3,
      placement: { longitude: 0, latitude: 0, height: 0 }
    });
    expect(result.success).toBe(false);
  });
  it("rejects duplicate labels in one mission", () => {
    const labelId = randomUUID();
    const result = createMissionSchema.safeParse({
      datasetId: randomUUID(), name: "route", homeLocal: { x: 0, y: 0, z: 1 }, labelIds: [labelId, labelId],
      flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5 }
    });
    expect(result.success).toBe(false);
  });
  it("defaults detailed route subdivision and rejects contradictory spacing", () => {
    const base = {
      datasetId: randomUUID(), name: "route", homeLocal: { x: 0, y: 0, z: 1 }, labelIds: [randomUUID()],
      flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5 }
    };
    const parsed = createMissionSchema.parse(base);
    expect(parsed.startLabelId).toBeNull();
    expect(parsed.flightProfile.maximumSegmentLength).toBe(5);
    expect(createMissionSchema.safeParse({ ...base, flightProfile: { ...base.flightProfile, minimumWaypointSpacing: 6, maximumSegmentLength: 5 } }).success).toBe(false);
  });

  it("allows a label origin but rejects repeating it in the inspection order", () => {
    const startLabelId = randomUUID();
    const base = {
      datasetId: randomUUID(), name: "label-start", homeLocal: { x: 0, y: 0, z: 0 }, startLabelId,
      labelIds: [randomUUID()],
      flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5 }
    };
    expect(createMissionSchema.parse(base).startLabelId).toBe(startLabelId);
    expect(createMissionSchema.safeParse({ ...base, labelIds: [startLabelId] }).success).toBe(false);
  });

  it("does not inject a null start label into an unrelated mission patch", () => {
    expect(patchMissionSchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
    expect(patchMissionSchema.parse({ startLabelId: null })).toEqual({ startLabelId: null });
  });
});
