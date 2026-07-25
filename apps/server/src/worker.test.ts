import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { calculateGsLodDepth, fixedGsTilerArguments, isCollisionMutableGridLimit, recommendedCollisionVoxelSize, sourceCoordinateRotations, validateFixedGsLodSummary, validatePly } from "./worker.js";

describe("collision coordinate normalization", () => {
  it("maps every tiler source basis into tile-local Z-up", () => {
    expect(sourceCoordinateRotations("camera_y_down_z_forward")).toEqual(["270,0,0", "0,180,0"]);
    expect(sourceCoordinateRotations("gltf_y_up")).toEqual(["90,0,0", "0,180,0"]);
    expect(sourceCoordinateRotations("z_up")).toEqual(["0,0,180"]);
  });

  it("rejects an unknown basis rather than publishing misaligned collision data", () => {
    expect(() => sourceCoordinateRotations("unknown")).toThrow(/未知源坐标系/);
  });

  it("uses a fixed leaf budget with count-adaptive LOD depth", () => {
    expect(calculateGsLodDepth(25_000)).toBe(0);
    expect(calculateGsLodDepth(25_001)).toBe(1);
    expect(calculateGsLodDepth(50_001)).toBe(2);
    expect(calculateGsLodDepth(2_468_428)).toBe(7);
    expect(calculateGsLodDepth(13_518_212)).toBe(10);
    expect(fixedGsTilerArguments()).toContain("--max-leaf-limit");
  });

  it("rejects converter output that drifts from the fixed LOD policy", () => {
    const summary = { converted_splats: 2_468_428, max_depth: 7, max_depth_source: "auto", max_leaf_limit: 25_000, min_leaf_limit: 2_500, sampling_rate_per_level: 0.5, lod_multiplier_preset: "max", coverage_boost_scale: 0.8, opacity_filter: 0.05, bounds_mode: "aabb" };
    expect(() => validateFixedGsLodSummary(summary)).not.toThrow();
    expect(() => validateFixedGsLodSummary({ ...summary, max_depth: 8 })).toThrow(/固定策略/);
    expect(() => validateFixedGsLodSummary({ ...summary, converted_splats: undefined })).toThrow(/converted_splats/);
  });

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
