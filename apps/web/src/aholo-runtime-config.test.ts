import { describe, expect, it } from "vitest";
import { DEFAULT_AHOLO_RUNTIME_CONFIG, normalizeAholoRuntimeConfig, toAholoLodConfig } from "./aholo-runtime-config";

describe("AHoLo runtime LOD tuning", () => {
  it("keeps the fixed production defaults until the operator explicitly changes them", () => {
    expect(toAholoLodConfig({ ...DEFAULT_AHOLO_RUNTIME_CONFIG })).toMatchObject({
      minLevel: 0,
      maxBudget: 6_000_000,
      backgroundPenalty: 0.5,
      distanceStep: [{ distance: 10, step: 2 }],
      schedulerParallelCounts: 4,
      schedulerExistingTaskLimit: 64,
      schedulerMinDuration: 160
    });
  });

  it("clamps UI input to the loaded artifact and public LodConfig limits", () => {
    const value = normalizeAholoRuntimeConfig({
      ...DEFAULT_AHOLO_RUNTIME_CONFIG,
      minLevel: 99,
      maxBudget: 99_000_000,
      backgroundPenalty: -1,
      schedulerParallelCounts: 99,
      schedulerExistingTaskLimit: 1,
      schedulerMinDuration: 0
    }, 4, 14_224_203);
    expect(value).toMatchObject({
      minLevel: 4,
      maxBudget: 14_224_203,
      backgroundPenalty: 0,
      schedulerParallelCounts: 8,
      schedulerExistingTaskLimit: 4,
      schedulerMinDuration: 16
    });
  });
});
