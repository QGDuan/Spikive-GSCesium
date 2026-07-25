import { describe, expect, it } from "vitest";
import {
  calculateGsRevealFrame, easeOutGsReveal, easeOutGsSolid, GS_REVEAL_BASE_ALPHA,
  GS_REVEAL_DURATION_MS, GS_REVEAL_SEED_SIZE_PIXELS
} from "./gs-reveal-policy";

describe("Luma-inspired GS reveal policy", () => {
  it("starts every loaded splat from one projected seed scale", () => {
    const frame = calculateGsRevealFrame(0, 100);
    expect(frame.globalAlpha).toBeCloseTo(GS_REVEAL_BASE_ALPHA);
    expect(frame.seedAlpha).toBeCloseTo(GS_REVEAL_BASE_ALPHA);
    expect(frame.scaleProgress).toBe(0);
    expect(frame.revealRadius).toBe(0);
    expect(frame.solidRadius).toBe(0);
    expect(frame.seedSizePixels).toBeCloseTo(GS_REVEAL_SEED_SIZE_PIXELS);
    expect(frame.seedSizePixels).toBeCloseTo(4.2);
  });

  it("keeps a visible all-scene alpha base while scale and target alpha grow", () => {
    for (const elapsed of [0, 3_000, 10_000, GS_REVEAL_DURATION_MS]) {
      expect(calculateGsRevealFrame(elapsed, 100).seedAlpha).toBeCloseTo(GS_REVEAL_BASE_ALPHA);
    }
    expect(calculateGsRevealFrame(3_000, 100).globalAlpha).toBeGreaterThan(GS_REVEAL_BASE_ALPHA);
    expect(calculateGsRevealFrame(10_000, 100).globalAlpha).toBeLessThan(1);
  });

  it("keeps the solid wave behind the reveal wave during growth", () => {
    for (const elapsed of [1_000, 7_000, 10_000, 15_000]) {
      const frame = calculateGsRevealFrame(elapsed, 100);
      expect(frame.solidRadius).toBeLessThan(frame.revealRadius);
    }
  });

  it("expands quickly at first and decelerates toward the scene edge", () => {
    const at0 = calculateGsRevealFrame(0, 100);
    const at2 = calculateGsRevealFrame(2_000, 100);
    const at18 = calculateGsRevealFrame(18_000, 100);
    const at20 = calculateGsRevealFrame(20_000, 100);
    expect(at2.revealRadius - at0.revealRadius).toBeGreaterThan(at20.revealRadius - at18.revealRadius);
    expect(at2.solidRadius - at0.solidRadius).toBeGreaterThan(at20.solidRadius - at18.solidRadius);
    expect(easeOutGsReveal(0.5)).toBeCloseTo(0.875);
    expect(easeOutGsSolid(0.5)).toBeCloseTo(0.75);
  });

  it("keeps scale and alpha growing through the full twenty seconds", () => {
    const milestones = [0, 3_000, 10_000, 19_000, GS_REVEAL_DURATION_MS]
      .map(elapsed => calculateGsRevealFrame(elapsed, 100));
    for (let index = 1; index < milestones.length; index += 1) {
      const previous = milestones[index - 1];
      const current = milestones[index];
      if (!previous || !current) throw new Error("测试时间线缺少采样帧");
      expect(current.scaleProgress).toBeGreaterThan(previous.scaleProgress);
      expect(current.globalAlpha).toBeGreaterThan(previous.globalAlpha);
    }
    const atTenSeconds = calculateGsRevealFrame(10_000, 100);
    expect(atTenSeconds.scaleProgress).toBeCloseTo(0.5);
    expect(atTenSeconds.globalAlpha).toBeCloseTo(0.9);
    const frame = calculateGsRevealFrame(GS_REVEAL_DURATION_MS, 100);
    expect(frame.globalAlpha).toBe(1);
    expect(frame.scaleProgress).toBe(1);
    expect(frame.revealRadius).toBeCloseTo(110);
    expect(frame.solidRadius).toBeCloseTo(110);
  });

  it("sanitizes invalid or tiny scene radii", () => {
    const frame = calculateGsRevealFrame(10_000, Number.NaN);
    expect(Object.values(frame).every(Number.isFinite)).toBe(true);
    expect(frame.revealFeather).toBeGreaterThan(0);
  });
});
