import { describe, expect, it } from "vitest";
import { calculateHostCpuPercent, calculateProcessCpuPercent } from "./telemetry.js";

describe("runtime telemetry calculations", () => {
  it("calculates host CPU from cumulative idle and total ticks", () => {
    expect(calculateHostCpuPercent(
      { total: 1_000, idle: 400 },
      { total: 1_200, idle: 450 }
    )).toBe(75);
  });

  it("normalizes process CPU to the whole host", () => {
    expect(calculateProcessCpuPercent(500_000, 1_000, 4)).toBe(12.5);
    expect(calculateProcessCpuPercent(1, 0, 4)).toBeNull();
  });
});
