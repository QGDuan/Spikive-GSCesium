import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AHOLO_CHUNK_LOD_POLICY, AHOLO_POLICY_VERSION, createAholoPipeline, publishAholoRevision,
  createAholoEszConversionPipeline, readAholoManifest, readVersionedLodMeta, resolveAholoRevision,
  validateAholoRevision, writeAholoReport
} from "./aholo-artifacts.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map(value => rm(value, { recursive: true, force: true }))));

describe("AHoLo visual artifact contract", () => {
  it("builds one fixed lossless topology and derives exact ESZ v2 chunks", () => {
    const ply = createAholoPipeline("/source.ply", "/ply");
    expect(ply.tasks[1]!.config).toMatchObject({
      type: "ply", maxChunkCounts: 400_000, levels: AHOLO_CHUNK_LOD_POLICY.levels
    });
    expect(ply.tasks[2]!.config).not.toHaveProperty("highPrecision");
    const conversion = createAholoEszConversionPipeline("/ply", "/esz", ["chunk_0.ply", "chunk_1.ply"]);
    expect(conversion.tasks).toHaveLength(4);
    expect(conversion.tasks[1]).toMatchObject({
      type: "Write",
      config: { output: "/esz/chunk_0.esz", version: 2, highPrecision: true, parallelCounts: 1 },
      release: ["chunk-0"]
    });
  });

  it("validates matching five-level outputs and publishes an immutable revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spikive-aholo-test-"));
    temporary.push(root);
    const datasetId = "11111111-1111-4111-8111-111111111111";
    const revision = "22222222-2222-4222-8222-222222222222";
    const source = path.join(root, "source.ply");
    const collision = path.join(root, "collision");
    const staged = path.join(root, "staged");
    const published = path.join(root, datasetId);
    await mkdir(collision, { recursive: true });
    await Promise.all([
      writeFile(source, "ply\nformat ascii 1.0\nelement vertex 100\nproperty float x\nproperty float y\nproperty float z\nend_header\n"),
      ...["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"].map(name => writeFile(path.join(collision, name), name))
    ]);
    await createFakeLod(path.join(staged, "esz"), "esz");
    await createFakeLod(path.join(staged, "ply-reference"), "ply");

    const report = await validateAholoRevision({
      datasetId, revision, sourcePath: source, collisionDirectory: collision, stagedRoot: staged, toolVersion: "1.7.4"
    });
    expect(report.policyVersion).toBe(AHOLO_POLICY_VERSION);
    expect(report.levels.map(value => value.splatCount)).toEqual([100, 50, 25, 5, 1]);
    expect(report.source.coordinateSystem).toBe("tile_local_z_up");
    await writeAholoReport(staged, report);
    await publishAholoRevision({ datasetRoot: published, stagedRoot: staged, report });

    const manifest = await readAholoManifest(published);
    expect(manifest?.activeRevision).toBe(revision);
    const resolved = await resolveAholoRevision(published, revision);
    expect(resolved?.record.sourceSha256).toBe(report.source.sha256);
    const served = await readVersionedLodMeta({ datasetId, revision, format: "esz", root: resolved!.root });
    expect(served.files[0]).toBe(`/api/datasets/${datasetId}/aholo-visual-revisions/${revision}/esz/chunk_0.esz`);
    expect(JSON.parse(await readFile(path.join(resolved!.root, "aholo-report.json"), "utf8"))).toMatchObject({ visualRevision: revision });
  });
});

async function createFakeLod(directory: string, extension: "esz" | "ply") {
  await mkdir(directory, { recursive: true });
  const counts = [100, 50, 25, 5, 1];
  const files = counts.map((_, index) => `chunk_${index}.${extension}`);
  await Promise.all(files.map((file, index) => writeFile(path.join(directory, file), Buffer.alloc(index + 1, index + 1))));
  await writeFile(path.join(directory, "lod-meta.json"), JSON.stringify({
    magicCode: 0x262834,
    type: "lod-splat",
    version: "1.0",
    counts: 100,
    shDegree: 0,
    levels: 5,
    files,
    forwardBox: { min: [0, 0, 0], max: [10, 10, 10] },
    permanentFiles: [3, 4],
    tree: [{
      bound: { min: [0, 0, 0], max: [10, 10, 10] },
      lods: counts.map((count, file) => ({ file, offset: 0, count }))
    }]
  }));
}
