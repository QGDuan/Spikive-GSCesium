import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Dataset, InspectionLabel, Mission, Waypoint } from "@spikive/shared";
import { Database } from "./db.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function createDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "spikive-db-test-"));
  directories.push(directory);
  return new Database(path.join(directory, "test.sqlite"));
}

describe("database persistence", () => {
  it("reuses an existing WAL database from a second connection", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-db-concurrent-"));
    directories.push(directory);
    const filename = path.join(directory, "test.sqlite");
    const first = new Database(filename);
    const second = new Database(filename);
    try {
      const journal = second.sqlite.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const timeout = second.sqlite.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      expect(journal.journal_mode.toLowerCase()).toBe("wal");
      expect(timeout.timeout).toBe(5000);
    } finally {
      second.close();
      first.close();
    }
  });

  it("round-trips datasets, labels, missions and all waypoint fields", () => {
    const db = createDatabase(); const now = new Date().toISOString(); const datasetId = randomUUID();
    const dataset: Dataset = {
      id: datasetId, name: "test", sourceFileName: "test.ply", sourceSize: 1, sceneType: "outdoor",
      inputConvention: "graphdeco", voxelSize: 0.1, voxelOpacity: 0.1, indoorSeed: null,
      placement: { longitude: 0, latitude: 0, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1 },
      status: "ready", collisionStatus: "ready", progress: 100, stage: "ready", error: null,
      uploadId: null, visualBackend: "cesium-3dtiles", activeVisualRevision: null, lodPolicyVersion: null,
      aholoVisualRevision: null, aholoPolicyVersion: null, visualBuildTarget: null, createdAt: now, updatedAt: now
    };
    db.insertDataset(dataset);

    const label: InspectionLabel = {
      id: randomUUID(), datasetId, title: "breaker", description: "", category: "inspection", color: "#ffb020",
      positionLocal: { x: 1, y: 2, z: 3 }, surfaceNormalLocal: { x: 1, y: 0, z: 0 }, snapDistance: 0.1,
      resolutionStatus: "resolved", createdAt: now, updatedAt: now
    };
    db.insertLabel(label);

    const mission: Mission = {
      id: randomUUID(), datasetId, name: "route", homeLocal: { x: 0, y: 0, z: 1 }, startLabelId: null, labelIds: [label.id],
      flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5, maximumSegmentLength: 5 },
      status: "draft", error: null, waypoints: [], createdAt: now, updatedAt: now
    };
    db.insertMission(mission);
    const waypoint: Waypoint = {
      id: randomUUID(), sequence: 0, type: "inspection", positionLocal: { x: 4, y: 5, z: 6 }, yaw: 20,
      pitch: -5, speed: 2, targetLabelId: label.id, generated: true, clearance: 1.2, valid: true
    };
    db.replaceWaypoints(mission.id, [waypoint]);

    expect(db.getDataset(datasetId)?.name).toBe("test");
    expect(db.getLabel(label.id)?.positionLocal).toEqual(label.positionLocal);
    expect(db.getMission(mission.id)?.waypoints).toEqual([waypoint]);
    const invalidated = db.updateMissionAndWaypoints(mission.id, { status: "draft", error: "geometry changed" }, []);
    expect(invalidated?.status).toBe("draft");
    expect(db.getMission(mission.id)?.waypoints).toEqual([]);
    db.close();
  });

  it("permanently deletes missions and cascades dataset deletion to all related records", () => {
    const db = createDatabase(); const now = new Date().toISOString(); const datasetId = randomUUID();
    db.insertDataset({
      id: datasetId, name: "delete-me", sourceFileName: "delete-me.ply", sourceSize: 1, sceneType: "outdoor",
      inputConvention: "graphdeco", voxelSize: 0.1, voxelOpacity: 0.1, indoorSeed: null,
      placement: { longitude: 0, latitude: 0, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1 },
      status: "ready", collisionStatus: "ready", progress: 100, stage: "ready", error: null,
      uploadId: null, visualBackend: "cesium-3dtiles", activeVisualRevision: null, lodPolicyVersion: null,
      aholoVisualRevision: null, aholoPolicyVersion: null, visualBuildTarget: null, createdAt: now, updatedAt: now
    });
    const labelId = randomUUID();
    db.insertLabel({ id: labelId, datasetId, title: "label", description: "", category: "inspection", color: "#fff", positionLocal: { x: 0, y: 0, z: 0 }, surfaceNormalLocal: null, snapDistance: null, resolutionStatus: "pending", createdAt: now, updatedAt: now });
    const firstMissionId = randomUUID(); const secondMissionId = randomUUID();
    db.insertMission({ id: firstMissionId, datasetId, name: "route", homeLocal: { x: 0, y: 0, z: 1 }, startLabelId: null, labelIds: [labelId], flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5, maximumSegmentLength: 5 }, status: "draft", error: null, waypoints: [], createdAt: now, updatedAt: now });
    db.insertMission({ id: secondMissionId, datasetId, name: "label origin", homeLocal: { x: 0, y: 0, z: 1 }, startLabelId: labelId, labelIds: [], flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5, maximumSegmentLength: 5 }, status: "draft", error: null, waypoints: [], createdAt: now, updatedAt: now });

    expect(db.listMissionsUsingLabel(datasetId, labelId).map(mission => mission.id).sort()).toEqual([firstMissionId, secondMissionId].sort());

    db.deleteMission(firstMissionId);
    expect(db.getMission(firstMissionId)).toBeNull();
    expect(db.getMission(secondMissionId)).not.toBeNull();

    db.deleteDataset(datasetId);
    expect(db.getDataset(datasetId)).toBeNull();
    expect(db.getLabel(labelId)).toBeNull();
    expect(db.getMission(secondMissionId)).toBeNull();
    db.close();
  });

  it("migrates legacy mission profiles and invalidates their old waypoint plan", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spikive-db-planner-migration-"));
    directories.push(directory);
    const filename = path.join(directory, "test.sqlite");
    const db = new Database(filename); const now = new Date().toISOString(); const datasetId = randomUUID(); const missionId = randomUUID();
    db.insertDataset({
      id: datasetId, name: "legacy", sourceFileName: "legacy.ply", sourceSize: 1, sceneType: "outdoor",
      inputConvention: "graphdeco", voxelSize: 0.1, voxelOpacity: 0.1, indoorSeed: null,
      placement: { longitude: 0, latitude: 0, height: 0, heading: 0, pitch: 0, roll: 0, scale: 1 },
      status: "ready", collisionStatus: "ready", progress: 100, stage: "ready", error: null,
      uploadId: null, visualBackend: "cesium-3dtiles", activeVisualRevision: null, lodPolicyVersion: null,
      aholoVisualRevision: null, aholoPolicyVersion: null, visualBuildTarget: null, createdAt: now, updatedAt: now
    });
    db.insertMission({
      id: missionId, datasetId, name: "legacy route", homeLocal: { x: 0, y: 0, z: 1 }, startLabelId: null, labelIds: [],
      flightProfile: { droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5, maximumSegmentLength: 5 },
      status: "valid", error: null, waypoints: [], createdAt: now, updatedAt: now
    });
    db.replaceWaypoints(missionId, [{
      id: randomUUID(), sequence: 0, type: "home", positionLocal: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: 0,
      speed: 2, targetLabelId: null, generated: true, clearance: 2, valid: true
    }]);
    db.sqlite.prepare("UPDATE missions SET flight_profile=? WHERE id=?").run(JSON.stringify({ droneRadius: 0.4, safetyMargin: 0.6, observationDistance: 3, speed: 2, minimumWaypointSpacing: 0.5 }), missionId);
    db.sqlite.exec("DROP INDEX idx_missions_start_label; ALTER TABLE missions DROP COLUMN start_label_id;");
    db.close();

    const migrated = new Database(filename);
    try {
      expect(migrated.getMission(missionId)).toMatchObject({
        status: "draft", startLabelId: null, waypoints: [], flightProfile: { maximumSegmentLength: 5 }
      });
      expect(migrated.getMission(missionId)?.error).toContain("需要重新规划");
    } finally { migrated.close(); }
  });
});
