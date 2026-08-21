import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GS_LOD_POLICY_VERSION, activateVisualRevision, buildLodReport, prepareInitialVisualLayout,
  publishVisualRevision, readArtifactManifest, visualRecordFromReport,
  writeArtifactManifestAtomic, writeLodReport
} from "./visual-artifacts.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("versioned GS visual artifacts", () => {
  it("audits terminal coverage and publishes an immutable initial revision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spikive-visual-artifact-")); directories.push(root);
    const output = path.join(root, "dataset-1");
    const tiles = path.join(output, "tiles");
    const collision = path.join(output, "collision");
    const source = path.join(root, "source.ply");
    await mkdir(tiles, { recursive: true });
    await mkdir(collision, { recursive: true });
    await writeFile(source, graphdecoPly());
    await writeFile(path.join(tiles, "tile.glb"), glbWithSplats(2));
    await writeFile(path.join(tiles, "tileset.json"), JSON.stringify({
      asset: { version: "1.1" },
      root: {
        boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
        geometricError: 1,
        refine: "REPLACE",
        content: { uri: "tile.glb" }
      }
    }));
    await writeFile(path.join(tiles, "build_summary.json"), JSON.stringify({
      input_splats: 2, converted_splats: 2, removed_invalid_splats: 0,
      removed_opacity_filtered_splats: 0, opacity_filter: 0.02, sh_degree: 0,
      source_coordinate_system: "z_up", max_depth: 0,
      max_leaf_limit: 25000, min_leaf_limit: 2500, sampling_rate_per_level: 0.65,
      lod_multiplier_preset: "max", coverage_boost_scale: 0.6,
      geometric_error_layer_multiplier: 1.35, geometric_error_scale: 2.5,
      bounds_mode: "aabb", diagnostics: { tree: { physical_levels: 1 } }
    }));
    for (const name of ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"]) {
      await writeFile(path.join(collision, name), name);
    }

    const report = await buildLodReport({
      datasetId: "dataset-1", visualRevision: "revision-1", sourcePath: source,
      tilesDirectory: tiles, collisionDirectory: collision, tilerVersion: "0.5.14"
    });
    expect(report).toMatchObject({
      policyVersion: GS_LOD_POLICY_VERSION,
      source: { inputSplats: 2, convertedSplats: 2, shDegree: 0 },
      coverage: { complete: true, terminalSplatCount: 2, terminalTileCount: 1 },
      artifact: { logicalLevels: 1, physicalLevels: 1 }
    });
    expect(report.levels[0]).toMatchObject({ depth: 0, tileCount: 1, splatCount: 2 });
    await writeLodReport(tiles, report);
    const manifest = await prepareInitialVisualLayout("dataset-1", output, tiles, visualRecordFromReport(report));
    await writeArtifactManifestAtomic(output, manifest);
    expect((await readArtifactManifest(output))?.activeVisualRevision).toBe("revision-1");
    expect(JSON.parse(await readFile(path.join(output, "visual-revisions", "revision-1", "tiles", "lod-report.json"), "utf8"))).toEqual(report);

    const nextTiles = path.join(root, "next-tiles");
    await cp(path.join(output, "visual-revisions", "revision-1", "tiles"), nextTiles, { recursive: true });
    const nextReport = await buildLodReport({
      datasetId: "dataset-1", visualRevision: "revision-2", sourcePath: source,
      tilesDirectory: nextTiles, collisionDirectory: collision, tilerVersion: "0.5.14"
    });
    await writeLodReport(nextTiles, nextReport);
    await publishVisualRevision({ datasetRoot: output, stagedTilesDirectory: nextTiles, record: visualRecordFromReport(nextReport) });
    expect((await readArtifactManifest(output))?.previousVisualRevision).toBe("revision-1");
    await activateVisualRevision({ datasetRoot: output, revision: "revision-1", sourcePath: source });
    expect((await readArtifactManifest(output))?.activeVisualRevision).toBe("revision-1");
  });
});

function graphdecoPly() {
  const names = [
    "x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
    "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"
  ];
  const header = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex 2\n${names.map(name => `property float ${name}`).join("\n")}\nend_header\n`);
  const vertices = Buffer.alloc(2 * names.length * 4);
  for (let vertex = 0; vertex < 2; vertex += 1) {
    for (let property = 0; property < names.length; property += 1) {
      const value = names[property]!.startsWith("scale_") ? Math.log(vertex === 0 ? 0.5 : 3) : 0;
      vertices.writeFloatLE(value, (vertex * names.length + property) * 4);
    }
  }
  return Buffer.concat([header, vertices]);
}

function glbWithSplats(count: number) {
  const value = {
    asset: { version: "2.0" },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ componentType: 5126, count, type: "VEC3" }]
  };
  const raw = Buffer.from(JSON.stringify(value));
  const paddedLength = Math.ceil(raw.length / 4) * 4;
  const json = Buffer.alloc(paddedLength, 0x20); raw.copy(json);
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "ascii"); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, json]);
}
