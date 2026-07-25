import { describe, expect, it } from "vitest";
import type { Cesium3DTileset } from "cesium";
import { createGsRevealController } from "./gs-reveal-controller";

interface FakeRevealTileset {
  isDestroyed(): boolean;
  spikiveGaussianSplatRevealSupported?: number;
  spikiveGaussianSplatRevealPatchVersion?: number;
  spikiveGaussianSplatRevealShaderActive?: boolean;
  spikiveGaussianSplatReveal?: {
    enabled: boolean;
    globalAlpha: number;
    seedAlpha: number;
    scaleProgress: number;
    revealRadius: number;
  };
}

describe("GS reveal controller lifecycle", () => {
  it("publishes one stable state object and restores the baseline path on finish", () => {
    const fake: FakeRevealTileset = { isDestroyed: () => false };
    const controller = createGsRevealController(fake as unknown as Cesium3DTileset, 100);
    const state = fake.spikiveGaussianSplatReveal!;

    fake.spikiveGaussianSplatRevealSupported = 1;
    fake.spikiveGaussianSplatRevealPatchVersion = 6;
    expect(controller.supported).toBe(true);
    expect(controller.shaderActive).toBe(false);
    fake.spikiveGaussianSplatRevealShaderActive = true;
    expect(controller.shaderActive).toBe(true);
    controller.update(10_000);
    expect(fake.spikiveGaussianSplatReveal).toBe(state);
    expect(state.globalAlpha).toBeCloseTo(0.9);
    expect(state.seedAlpha).toBeCloseTo(0.8);
    expect(state.scaleProgress).toBeCloseTo(0.5);
    expect(state.revealRadius).toBeGreaterThan(0);

    controller.finish();
    expect(state.enabled).toBe(false);
    expect(state.globalAlpha).toBe(1);
    expect(state.scaleProgress).toBe(1);
    expect(state.revealRadius).toBeCloseTo(110);
  });

  it("does not mutate Cesium-owned state after the tileset is destroyed", () => {
    let destroyed = false;
    const fake: FakeRevealTileset = { isDestroyed: () => destroyed };
    const controller = createGsRevealController(fake as unknown as Cesium3DTileset, 50);
    const state = fake.spikiveGaussianSplatReveal!;
    const initialRadius = state.revealRadius;

    destroyed = true;
    controller.update(10_000);
    controller.finish();
    expect(state.revealRadius).toBe(initialRadius);
    expect(state.enabled).toBe(false);
  });
});
