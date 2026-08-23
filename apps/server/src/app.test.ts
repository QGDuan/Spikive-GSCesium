import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { config } from "./config.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const datasetInput = (name: string) => ({
  name, sourceFileName: `${name}.ply`, sourceSize: 1, sceneType: "outdoor", inputConvention: "graphdeco",
  sourceCoordinateSystem: "z_up",
  voxelSize: 0.1, voxelOpacity: 0.1,
  placement: { longitude: 0, latitude: 0, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1 }
});

describe("scene-bound label and mission API", () => {
  it("reports coarse runtime telemetry without exposing machine identity", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-app-telemetry-")); directories.push(directory);
    Object.assign(config, {
      dataDir: directory, dbPath: path.join(directory, "platform.sqlite"), uploadsDir: path.join(directory, "uploads"),
      sourcesDir: path.join(directory, "sources"), workDir: path.join(directory, "work"), publishedDir: path.join(directory, "published"),
      conversionEnabled: false
    });
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/runtime-telemetry" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        host: { logicalCores: expect.any(Number), memoryUsedBytes: expect.any(Number), memoryTotalBytes: expect.any(Number) },
        process: { rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number), heapTotalBytes: expect.any(Number) }
      });
      expect(response.body).not.toContain("hostname");
      expect(response.body).not.toContain("pid");
    } finally { await app.close(); }
  });

  it("returns 400 for invalid request contracts instead of reporting a server error", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-app-validation-")); directories.push(directory);
    Object.assign(config, {
      dataDir: directory, dbPath: path.join(directory, "platform.sqlite"), uploadsDir: path.join(directory, "uploads"),
      sourcesDir: path.join(directory, "sources"), workDir: path.join(directory, "work"), publishedDir: path.join(directory, "published"),
      conversionEnabled: false
    });
    const { app } = await buildApp();
    try {
      const response = await app.inject({ method: "POST", url: "/api/datasets", payload: { ...datasetInput("invalid"), sourceFileName: "invalid.txt" } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("请求参数无效");
    } finally { await app.close(); }
  });

  it("blocks deleting an in-use label and rejects cross-scene mission labels", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-app-test-")); directories.push(directory);
    Object.assign(config, {
      dataDir: directory, dbPath: path.join(directory, "platform.sqlite"), uploadsDir: path.join(directory, "uploads"),
      sourcesDir: path.join(directory, "sources"), workDir: path.join(directory, "work"), publishedDir: path.join(directory, "published"),
      conversionEnabled: false
    });
    const { app } = await buildApp();
    try {
      const firstDataset = (await app.inject({ method: "POST", url: "/api/datasets", payload: datasetInput("first") })).json();
      const secondDataset = (await app.inject({ method: "POST", url: "/api/datasets", payload: datasetInput("second") })).json();
      const labelResponse = await app.inject({ method: "POST", url: `/api/datasets/${firstDataset.id}/labels`, payload: { title: "绝缘子 A", description: "", category: "巡检点", color: "#ffb020", positionLocal: { x: 1, y: 2, z: 3 } } });
      expect(labelResponse.statusCode).toBe(201); const label = labelResponse.json();
      const nextLabelResponse = await app.inject({ method: "POST", url: `/api/datasets/${firstDataset.id}/labels`, payload: { title: "绝缘子 B", description: "", category: "巡检点", color: "#ffb020", positionLocal: { x: 4, y: 2, z: 3 } } });
      expect(nextLabelResponse.statusCode).toBe(201); const nextLabel = nextLabelResponse.json();

      const missionPayload = {
        name: "巡检路线", homeLocal: { x: 0, y: 0, z: 1 }, startLabelId: label.id, labelIds: [nextLabel.id],
        flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5 }
      };
      const missionResponse = await app.inject({ method: "POST", url: "/api/missions", payload: { ...missionPayload, datasetId: firstDataset.id } });
      expect(missionResponse.statusCode).toBe(201); const mission = missionResponse.json();

      const renamedMissionResponse = await app.inject({ method: "PATCH", url: `/api/missions/${mission.id}`, payload: { name: "重命名路线" } });
      expect(renamedMissionResponse.statusCode).toBe(200);
      expect(renamedMissionResponse.json()).toMatchObject({ name: "重命名路线", startLabelId: label.id });

      const inUseDelete = await app.inject({ method: "DELETE", url: `/api/labels/${label.id}` });
      expect(inUseDelete.statusCode).toBe(409);
      expect(inUseDelete.json().error).toContain("正在被航迹任务");

      const crossSceneMission = await app.inject({ method: "POST", url: "/api/missions", payload: { ...missionPayload, datasetId: secondDataset.id } });
      expect(crossSceneMission.statusCode).toBe(409);
      expect(crossSceneMission.json().error).toContain("不属于同一场景");

      expect((await app.inject({ method: "DELETE", url: `/api/missions/${mission.id}` })).statusCode).toBe(204);
      expect((await app.inject({ method: "DELETE", url: `/api/labels/${label.id}` })).statusCode).toBe(204);
      expect((await app.inject({ method: "DELETE", url: `/api/labels/${nextLabel.id}` })).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it("requires an operator PATCH before retrying a failed collision resolution", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-app-retry-")); directories.push(directory);
    Object.assign(config, {
      dataDir: directory, dbPath: path.join(directory, "platform.sqlite"), uploadsDir: path.join(directory, "uploads"),
      sourcesDir: path.join(directory, "sources"), workDir: path.join(directory, "work"), publishedDir: path.join(directory, "published"),
      conversionEnabled: false
    });
    const { app, db } = await buildApp();
    try {
      const dataset = (await app.inject({ method: "POST", url: "/api/datasets", payload: datasetInput("memory-limit") })).json();
      db.updateDataset(dataset.id, { status: "failed", collisionStatus: "failed", progress: 60, stage: "处理失败", error: "建议人工确认后改为不小于 0.14 m" });

      const patchResponse = await app.inject({ method: "PATCH", url: `/api/datasets/${dataset.id}`, payload: { voxelSize: 0.14 } });
      expect(patchResponse.statusCode).toBe(200);
      expect(patchResponse.json().voxelSize).toBe(0.14);

      const retryResponse = await app.inject({ method: "POST", url: `/api/datasets/${dataset.id}/retry` });
      expect(retryResponse.statusCode).toBe(200);
      expect(retryResponse.json()).toMatchObject({ status: "queued", collisionStatus: "pending", voxelSize: 0.14 });
    } finally { await app.close(); }
  });

  it("queues a PlayCanvas visual rebuild while keeping published collision serviceable", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-app-rebuild-")); directories.push(directory);
    Object.assign(config, {
      dataDir: directory, dbPath: path.join(directory, "platform.sqlite"), uploadsDir: path.join(directory, "uploads"),
      sourcesDir: path.join(directory, "sources"), workDir: path.join(directory, "work"), publishedDir: path.join(directory, "published"),
      conversionEnabled: false
    });
    const { app, db } = await buildApp();
    try {
      const dataset = (await app.inject({ method: "POST", url: "/api/datasets", payload: datasetInput("rebuild") })).json();
      const published = path.join(directory, "published", dataset.id);
      mkdirSync(path.join(directory, "sources"), { recursive: true });
      mkdirSync(path.join(published, "collision"), { recursive: true });
      writeFileSync(path.join(directory, "sources", `${dataset.id}.ply`), "source");
      for (const name of ["scene.voxel.json", "scene.voxel.bin", "scene.collision.glb"]) writeFileSync(path.join(published, "collision", name), "artifact");
      db.updateDataset(dataset.id, { status: "ready", collisionStatus: "ready", progress: 100, stage: "已发布" });

      const rebuild = await app.inject({ method: "POST", url: `/api/datasets/${dataset.id}/rebuild-visuals` });
      expect(rebuild.statusCode).toBe(200);
      expect(rebuild.json()).toMatchObject({ status: "rebuilding", collisionStatus: "ready" });

      const collision = await app.inject({ method: "GET", url: `/api/datasets/${dataset.id}/collision/scene.voxel.bin` });
      expect(collision.statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/datasets/${dataset.id}/rebuild-tiles` })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("serves a no-store PlayCanvas manifest and immutable nested SOG resources", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-app-playcanvas-manifest-")); directories.push(directory);
    Object.assign(config, {
      dataDir: directory, dbPath: path.join(directory, "platform.sqlite"), uploadsDir: path.join(directory, "uploads"),
      sourcesDir: path.join(directory, "sources"), workDir: path.join(directory, "work"), publishedDir: path.join(directory, "published"),
      conversionEnabled: false
    });
    const { app, db } = await buildApp();
    try {
      const dataset = (await app.inject({ method: "POST", url: "/api/datasets", payload: datasetInput("manifest") })).json();
      const revision = "11111111-1111-4111-8111-111111111111";
      const datasetRoot = path.join(directory, "published", dataset.id);
      const revisionRoot = path.join(datasetRoot, "visual-revisions", revision);
      mkdirSync(path.join(revisionRoot, "sog", "0_0"), { recursive: true });
      writeFileSync(path.join(revisionRoot, "sog", "lod-meta.json"), "{}");
      writeFileSync(path.join(revisionRoot, "sog", "0_0", "meta.json"), "{\"version\":2}");
      writeFileSync(path.join(revisionRoot, "visual-report.json"), JSON.stringify({
        schemaVersion: 2, datasetId: dataset.id, visualBackend: "playcanvas-sog", visualRevision: revision,
        policyVersion: "playcanvas-upstream-streamed-sog-v1",
        source: { sha256: "source", bytes: 100, splatCount: 16, shDegree: 0, coordinateSystem: "tile_local_z_up" },
        transform: { localToRender: "render=(x,z,-y)", renderToLocal: "local=(x,-z,y)" },
        artifact: { bytes: 10, sha256: "artifact", chunkCount: 1, lodMetaSha256: "meta" },
        collisionRevision: "collision", tool: { name: "@playcanvas/splat-transform", version: "3.3.0" },
        policy: { lodChunkCount: 512, lodChunkExtent: 16, fineLodFormat: "sog", coarseLodFormat: "sog", ratios: [1, 0.5, 0.25, 0.1] },
        levels: [1, 0.5, 0.25, 0.1].map((ratio, level) => ({ level, ratio, splatCount: Math.max(1, Math.round(16 * ratio)), chunkCount: 1, bytes: 2 })),
        builtAt: "2026-08-23T00:00:00.000Z"
      }));
      writeFileSync(path.join(datasetRoot, "visual-artifact-manifest.json"), JSON.stringify({
        schemaVersion: 2, datasetId: dataset.id, activeRevision: revision, previousRevision: null,
        revisions: [{
          revision, backend: "playcanvas-sog", policyVersion: "playcanvas-upstream-streamed-sog-v1",
          sourceSha256: "source", collisionRevision: "collision",
          relativeRootPath: `visual-revisions/${revision}`,
          reportPath: `visual-revisions/${revision}/visual-report.json`,
          createdAt: "2026-08-23T00:00:00.000Z", retainUntil: null
        }],
        updatedAt: "2026-08-23T00:00:00.000Z"
      }));
      db.updateDataset(dataset.id, {
        status: "ready", collisionStatus: "ready", progress: 100,
        visualBackend: "playcanvas-sog", activeVisualRevision: revision,
        visualPolicyVersion: "playcanvas-upstream-streamed-sog-v1"
      });

      const manifest = await app.inject({ method: "GET", url: `/api/datasets/${dataset.id}/render-manifest` });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["cache-control"]).toBe("no-store");
      expect(manifest.json()).toMatchObject({
        renderer: "playcanvas", visualBackend: "playcanvas-sog", activeVisualRevision: revision,
        collisionRevision: "collision", playcanvas: { policyVersion: "playcanvas-upstream-streamed-sog-v1" }
      });

      const meta = await app.inject({ method: "GET", url: `/api/datasets/${dataset.id}/visual-revisions/${revision}/sog/lod-meta.json` });
      expect(meta.statusCode).toBe(200);
      expect(meta.headers["cache-control"]).toBe("no-store");
      const chunk = await app.inject({ method: "GET", url: `/api/datasets/${dataset.id}/visual-revisions/${revision}/sog/0_0/meta.json` });
      expect(chunk.statusCode).toBe(200);
      expect(chunk.headers["cache-control"]).toContain("immutable");
      expect(chunk.headers["content-type"]).toContain("application/json");
    } finally { await app.close(); }
  });
});
