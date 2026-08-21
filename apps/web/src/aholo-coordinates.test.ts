import { describe, expect, it } from "vitest";
import { aholoToLocal, localToAholo, normalizeVec3 } from "./aholo-coordinates";

describe("AHoLo fixed coordinate contract", () => {
  it("maps local Z-up through Rx(-90 degrees) and back exactly", () => {
    const local = { x: 3.25, y: -7.5, z: 12 };
    expect(localToAholo(local)).toEqual({ x: 3.25, y: 12, z: 7.5 });
    expect(aholoToLocal(localToAholo(local))).toEqual(local);
  });

  it("preserves ray direction length under the orthonormal transform", () => {
    const direction = normalizeVec3({ x: 2, y: -3, z: 6 })!;
    const renderDirection = localToAholo(direction);
    expect(Math.hypot(renderDirection.x, renderDirection.y, renderDirection.z)).toBeCloseTo(1, 12);
    expect(aholoToLocal(renderDirection)).toEqual(direction);
  });
});
