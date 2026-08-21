import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCollisionMutableGridLimit, recommendedCollisionVoxelSize, validatePly } from "./worker.js";

describe("AHoLo-only processing", () => {
  it("only suggests a coarser collision voxel for explicit mutable-grid safety failures", () => {
    const memoryError = new Error("Voxel mutation would require approximately 1.51K MiB of mutable-grid storage, exceeding the 1024 MiB safety limit.");
    expect(recommendedCollisionVoxelSize(memoryError, 0.1)).toBe(0.14);
    expect(isCollisionMutableGridLimit(memoryError)).toBe(true);
    expect(recommendedCollisionVoxelSize(new Error("invalid PLY"), 0.1)).toBeNull();
    expect(isCollisionMutableGridLimit(new Error("invalid PLY"))).toBe(false);
    expect(recommendedCollisionVoxelSize(new Error("Voxel mutation requires 5G blocks, exceeding the 32-bit mutable-grid limit."), 0.1)).toBe(0.2);
    expect(recommendedCollisionVoxelSize(memoryError, 2)).toBeNull();
  });

  it("requires every GraphDECO scale and rotation property", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spikive-ply-test-"));
    const filename = path.join(directory, "scene.ply");
    const properties = ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
    const header = (values: string[]) => `ply\nformat ascii 1.0\nelement vertex 0\n${values.map(value => `property float ${value}`).join("\n")}\nend_header\n`;
    try {
      await writeFile(filename, header(properties));
      await expect(validatePly(filename)).resolves.toBeUndefined();
      await writeFile(filename, header(properties.filter(value => value !== "rot_3")));
      await expect(validatePly(filename)).rejects.toThrow(/rot_3/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
