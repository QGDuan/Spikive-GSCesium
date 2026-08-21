import { describe, expect, it } from "vitest";
import { GS_STABLE_TILE_POLICY, resolutionScaleForDevice } from "./gs-tiles-policy";

describe("fixed Cesium GS quality policy", () => {
  it("keeps native REPLACE traversal at fixed SSE without dynamic degradation", () => {
    expect(GS_STABLE_TILE_POLICY).toMatchObject({
      maximumScreenSpaceError: 16,
      dynamicScreenSpaceError: false,
      skipLevelOfDetail: false,
      cullRequestsWhileMoving: false
    });
  });

  it("caps effective high-DPI rendering at 1.5 device pixels", () => {
    expect(resolutionScaleForDevice(1)).toBe(1);
    expect(resolutionScaleForDevice(1.25)).toBe(1);
    expect(resolutionScaleForDevice(2)).toBe(0.75);
    expect(resolutionScaleForDevice(3)).toBe(0.5);
  });
});
