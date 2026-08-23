import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAYCANVAS_OFFICIAL_LOD_RATIOS, PLAYCANVAS_POLICY_VERSION, PLAYCANVAS_SOG_POLICY, publishPlayCanvasRevision,
  resolvePlayCanvasRevision, validatePlayCanvasRevision, writePlayCanvasReport
} from "./playcanvas-artifacts.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("PlayCanvas visual artifacts", () => {
  it("records unmodified upstream Streamed SOG defaults", () => {
    expect(PLAYCANVAS_POLICY_VERSION).toBe("playcanvas-upstream-streamed-sog-v1");
    expect(PLAYCANVAS_OFFICIAL_LOD_RATIOS).toEqual([1, 0.5, 0.25, 0.1]);
    expect(PLAYCANVAS_SOG_POLICY).toMatchObject({
      fineLodFormat: "sog",
      coarseLodFormat: "sog",
      lodChunkCount: 512,
      lodChunkExtent: 16
    });
  });

  it("validates and atomically publishes a native Streamed SOG revision", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "spikive-playcanvas-artifacts-"));
    directories.push(root);
    const datasetRoot = path.join(root, "published");
    const stagedRoot = path.join(root, "staged");
    const sog = path.join(stagedRoot, "sog");
    const collision = path.join(root, "collision");
    mkdirSync(sog, { recursive: true });
    mkdirSync(collision, { recursive: true });
    const source = path.join(root, "scene.ply");
    const sourceHeader = "ply\nformat binary_little_endian 1.0\nelement vertex 20\nproperty float x\nproperty float y\nproperty float z\nend_header\n";
    writeFileSync(source, sourceHeader);
    for (const name of ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"]) writeFileSync(path.join(collision, name), name);
    const counts = [20, 10, 5, 2];
    const filenames = counts.map((_, level) => `${level}_0/meta.json`);
    for (const filename of filenames) {
      mkdirSync(path.dirname(path.join(sog, filename)), { recursive: true });
      writeFileSync(path.join(sog, filename), JSON.stringify({ version: 2 }));
    }
    writeFileSync(path.join(sog, "lod-meta.json"), JSON.stringify({
      version: 1,
      count: counts.reduce((sum, count) => sum + count, 0),
      counts,
      lodLevels: counts.length,
      filenames,
      tree: {
        bound: { min: [-1, -2, -3], max: [4, 5, 6] },
        lods: Object.fromEntries(counts.map((count, level) => [level, { file: level, offset: 0, count }]))
      }
    }));

    const report = await validatePlayCanvasRevision({
      datasetId: "dataset", revision: "revision-a", sourcePath: source,
      collisionDirectory: collision, stagedRoot, toolVersion: "3.3.0"
    });
    expect(report.source.splatCount).toBe(20);
    expect(report.levels.map(level => level.splatCount)).toEqual(counts);
    expect(report.policy.ratios).toEqual([1, 0.5, 0.25, 0.1]);
    expect(report.policy.spatialTreeDepth).toBe(0);
    await writePlayCanvasReport(stagedRoot, report);
    await publishPlayCanvasRevision({ datasetRoot, stagedRoot, report });
    const resolved = await resolvePlayCanvasRevision(datasetRoot);
    expect(resolved?.record.revision).toBe("revision-a");
    expect(resolved?.record.backend).toBe("playcanvas-sog");
  });
});
