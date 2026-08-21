import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CollisionRepository, VoxelCollisionWorld } from "./collision.js";

const metadata = {
  version: "1.1", gridBounds: { min: [0, 0, 0], max: [4, 4, 4] }, sceneBounds: { min: [0, 0, 0], max: [4, 4, 4] },
  voxelResolution: 1, leafSize: 4, treeDepth: 1, nodeCount: 1, leafDataCount: 0
};

describe("voxel collision reader", () => {
  it("reads a collapsed solid leaf", () => {
    const world = VoxelCollisionWorld.fromArrays(metadata, [0xff000000]);
    expect(world.isOccupied({ x: 1, y: 1, z: 1 })).toBe(true);
    expect(world.isOccupied({ x: 5, y: 1, z: 1 })).toBe(false);
    expect(world.sphereIsFree({ x: 1, y: 1, z: 1 }, 0)).toBe(false);
  });
  it("treats empty tree as free", () => {
    const world = VoxelCollisionWorld.fromArrays({ ...metadata, nodeCount: 0 }, []);
    expect(world.isOccupied({ x: 1, y: 1, z: 1 })).toBe(false);
    expect(world.sphereIsFree({ x: 1, y: 1, z: 1 }, 0)).toBe(true);
    expect(world.sphereIsFree({ x: 5, y: 1, z: 1 }, 0)).toBe(false);
  });
  it("samples swept segments at half-voxel spacing so midpoint collisions cannot hide between phases", () => {
    const world = VoxelCollisionWorld.fromArrays({ ...metadata, nodeCount: 0 }, []);
    world.sphereIsFree = point => Math.abs(point.x - 0.5) > 1e-9;

    expect(world.segmentIsFree({ x: 0, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, 0)).toBe(false);
  });
  it("reads mixed leaf voxel masks", () => {
    const world = VoxelCollisionWorld.fromArrays({ ...metadata, nodeCount: 2, leafDataCount: 2 }, [0x01000001, 0], [1, 0]);
    expect(world.isOccupied({ x: 0.1, y: 0.1, z: 0.1 })).toBe(true);
    expect(world.isOccupied({ x: 1.1, y: 0.1, z: 0.1 })).toBe(false);
  });
  it("raycasts the first occupied surface from outside the grid", () => {
    const world = VoxelCollisionWorld.fromArrays(metadata, [0xff000000]);
    const hit = world.raycast({ x: -1, y: 2, z: 2 }, { x: 1, y: 0, z: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.position.x).toBeGreaterThanOrEqual(0);
    expect(hit!.position.x).toBeLessThan(0.1);
    expect(hit!.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(world.raycast({ x: -1, y: 5, z: 2 }, { x: 1, y: 0, z: 0 })).toBeNull();
    expect(world.raycast({ x: -1, y: 2, z: 2 }, { x: 1, y: 0, z: 0 }, 0.5)).toBeNull();
  });

  it("does not create a false hit at a camera inside filled collision", () => {
    const world = VoxelCollisionWorld.fromArrays({ ...metadata, nodeCount: 2, leafDataCount: 2 }, [0x01000001, 0], [0b0101, 0]);
    const hit = world.raycast({ x: 0.1, y: 0.1, z: 0.1 }, { x: 1, y: 0, z: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.position.x).toBeGreaterThanOrEqual(2);
    expect(hit!.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(world.validateSurfaceNormal(hit!.position, hit!.normal)).not.toBeNull();
  });

  it("does not invent a surface normal for an interior occupied point", () => {
    const world = VoxelCollisionWorld.fromArrays(metadata, [0xff000000]);
    expect(world.snapSurface({ x: 2, y: 2, z: 2 }, 0)).toBeNull();
  });

  it("deduplicates concurrent loads and evicts least-recently-used worlds by byte budget", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "spikive-collision-cache-"));
    const prepare = async (id: string) => {
      await mkdir(path.join(directory, id, "tiles"), { recursive: true });
      await mkdir(path.join(directory, id, "collision"), { recursive: true });
      await writeFile(path.join(directory, id, "tiles", "build_summary.json"), JSON.stringify({ source_coordinate_system: "z_up" }));
      await writeFile(path.join(directory, id, "collision", "scene.voxel.json"), JSON.stringify({ ...metadata, coordinateFrame: "tile_local_z_up" }));
      await writeFile(path.join(directory, id, "collision", "scene.voxel.bin"), Buffer.from(new Uint32Array([0xff000000]).buffer));
    };
    try {
      await prepare("first"); await prepare("second");
      const repository = new CollisionRepository(directory, 4);
      const [firstA, firstB] = await Promise.all([repository.get("first"), repository.get("first")]);
      expect(firstA).toBe(firstB);
      expect(repository.stats).toEqual({ entries: 1, bytes: 4, maximumBytes: 4 });
      await repository.get("second");
      expect(repository.stats).toEqual({ entries: 1, bytes: 4, maximumBytes: 4 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
