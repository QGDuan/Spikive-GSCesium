import { describe, expect, it } from "vitest";
import { localToRender, normalizeVec3, renderToLocal } from "./gaussian-coordinates";

describe("PlayCanvas coordinate adapter", () => {
  it("round-trips local Z-up through the fixed Rx(-90) render basis", () => {
    const local = { x: 3.25, y: -7.5, z: 12 };
    expect(localToRender(local)).toEqual({ x: 3.25, y: 12, z: 7.5 });
    expect(renderToLocal(localToRender(local))).toEqual(local);
  });

  it("normalizes transformed ray directions", () => {
    const value = normalizeVec3(renderToLocal({ x: 0, y: 1, z: 0 }));
    expect(value?.x).toBe(0);
    expect(value?.y).toBeCloseTo(0);
    expect(value?.z).toBe(1);
  });
});
