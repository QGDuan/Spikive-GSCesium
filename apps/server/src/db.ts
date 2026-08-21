import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Dataset, InspectionLabel, Mission, Waypoint } from "@spikive/shared";

type Row = Record<string, unknown>;

export class Database {
  readonly sqlite: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.sqlite = new DatabaseSync(filename);
    try {
      // A watch restart may overlap briefly with the previous connection.
      // Install the wait policy before any pragma that can acquire a lock and
      // avoid rewriting WAL mode when the database already uses it.
      this.sqlite.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const journal = this.sqlite.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
      if (journal?.journal_mode?.toLowerCase() !== "wal") this.sqlite.exec("PRAGMA journal_mode=WAL;");
      this.migrate();
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  private migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, source_file_name TEXT NOT NULL,
        source_size INTEGER NOT NULL, scene_type TEXT NOT NULL, input_convention TEXT NOT NULL,
        source_coordinate_system TEXT,
        voxel_size REAL NOT NULL, voxel_opacity REAL NOT NULL, indoor_seed TEXT,
        placement TEXT NOT NULL, status TEXT NOT NULL, collision_status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT '', error TEXT,
        upload_id TEXT, aholo_visual_revision TEXT, aholo_policy_version TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, color TEXT NOT NULL,
        position_local TEXT NOT NULL, surface_normal_local TEXT, snap_distance REAL,
        resolution_status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        name TEXT NOT NULL, home_local TEXT NOT NULL, start_label_id TEXT, label_ids TEXT NOT NULL,
        flight_profile TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS waypoints (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, type TEXT NOT NULL, position_local TEXT NOT NULL,
        yaw REAL NOT NULL, pitch REAL NOT NULL, speed REAL NOT NULL,
        target_label_id TEXT, generated INTEGER NOT NULL, clearance REAL, valid INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_labels_dataset ON labels(dataset_id);
      CREATE INDEX IF NOT EXISTS idx_missions_dataset ON missions(dataset_id);
      CREATE INDEX IF NOT EXISTS idx_waypoints_mission ON waypoints(mission_id, sequence);
    `);
    this.migrateDatasetVisualFields();
    this.migrateMissionStartLabels();
    this.migrateDetailedRouteProfiles();
  }

  private migrateDatasetVisualFields() {
    const columns = this.sqlite.prepare("PRAGMA table_info(datasets)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "source_coordinate_system")) this.sqlite.exec("ALTER TABLE datasets ADD COLUMN source_coordinate_system TEXT;");
    if (!columns.some(column => column.name === "aholo_visual_revision")) {
      this.sqlite.exec("ALTER TABLE datasets ADD COLUMN aholo_visual_revision TEXT;");
    }
    if (!columns.some(column => column.name === "aholo_policy_version")) {
      this.sqlite.exec("ALTER TABLE datasets ADD COLUMN aholo_policy_version TEXT;");
    }
  }

  private migrateMissionStartLabels() {
    const columns = this.sqlite.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "start_label_id")) this.sqlite.exec("ALTER TABLE missions ADD COLUMN start_label_id TEXT;");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS idx_missions_start_label ON missions(start_label_id);");
  }

  private migrateDetailedRouteProfiles() {
    const rows = this.sqlite.prepare("SELECT id, flight_profile FROM missions").all() as Row[];
    const legacy = rows.flatMap(row => {
      try {
        const profile = JSON.parse(String(row.flight_profile)) as Record<string, unknown>;
        return typeof profile.maximumSegmentLength === "number" ? [] : [{ id: String(row.id), profile }];
      } catch {
        return [];
      }
    });
    if (!legacy.length) return;
    const update = this.sqlite.prepare("UPDATE missions SET flight_profile=?,status='draft',error=?,updated_at=? WHERE id=?");
    const clear = this.sqlite.prepare("DELETE FROM waypoints WHERE mission_id=?");
    const updatedAt = new Date().toISOString();
    this.sqlite.exec("BEGIN");
    try {
      for (const mission of legacy) {
        clear.run(mission.id);
        update.run(
          JSON.stringify({ ...mission.profile, maximumSegmentLength: 5 }),
          "规划策略已升级为逐段扫掠与最大航段细分，需要重新规划",
          updatedAt,
          mission.id
        );
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.sqlite.close(); }

  listDatasets(): Dataset[] {
    return (this.sqlite.prepare("SELECT * FROM datasets ORDER BY created_at DESC").all() as Row[]).map(datasetFromRow);
  }
  getDataset(id: string): Dataset | null {
    const row = this.sqlite.prepare("SELECT * FROM datasets WHERE id=?").get(id) as Row | undefined;
    return row ? datasetFromRow(row) : null;
  }
  insertDataset(dataset: Dataset) {
    this.sqlite.prepare(`
      INSERT INTO datasets (
        id, name, source_file_name, source_size, scene_type, input_convention,
        source_coordinate_system, voxel_size, voxel_opacity, indoor_seed, placement, status, collision_status,
        progress, stage, error, upload_id, aholo_visual_revision, aholo_policy_version,
        created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      dataset.id, dataset.name, dataset.sourceFileName, dataset.sourceSize, dataset.sceneType,
      dataset.inputConvention, dataset.sourceCoordinateSystem, dataset.voxelSize, dataset.voxelOpacity,
      dataset.indoorSeed ? JSON.stringify(dataset.indoorSeed) : null, JSON.stringify(dataset.placement),
      dataset.status, dataset.collisionStatus, dataset.progress, dataset.stage, dataset.error,
      dataset.uploadId, dataset.aholoVisualRevision, dataset.aholoPolicyVersion,
      dataset.createdAt, dataset.updatedAt
    );
  }
  updateDataset(id: string, values: Partial<Dataset>) {
    const current = this.getDataset(id);
    if (!current) return null;
    const next = { ...current, ...values, updatedAt: new Date().toISOString() };
    this.sqlite.prepare(`UPDATE datasets SET name=?,source_coordinate_system=?,voxel_size=?,voxel_opacity=?,indoor_seed=?,placement=?,status=?,collision_status=?,progress=?,stage=?,error=?,upload_id=?,aholo_visual_revision=?,aholo_policy_version=?,updated_at=? WHERE id=?`).run(
      next.name, next.sourceCoordinateSystem, next.voxelSize, next.voxelOpacity, next.indoorSeed ? JSON.stringify(next.indoorSeed) : null,
      JSON.stringify(next.placement), next.status, next.collisionStatus, next.progress, next.stage,
      next.error, next.uploadId, next.aholoVisualRevision, next.aholoPolicyVersion, next.updatedAt, id
    );
    return next;
  }
  deleteDataset(id: string) { return this.sqlite.prepare("DELETE FROM datasets WHERE id=?").run(id); }

  listLabels(datasetId: string): InspectionLabel[] {
    return (this.sqlite.prepare("SELECT * FROM labels WHERE dataset_id=? ORDER BY created_at").all(datasetId) as Row[]).map(labelFromRow);
  }
  getLabel(id: string): InspectionLabel | null {
    const row = this.sqlite.prepare("SELECT * FROM labels WHERE id=?").get(id) as Row | undefined;
    return row ? labelFromRow(row) : null;
  }
  insertLabel(label: InspectionLabel) {
    this.sqlite.prepare(`
      INSERT INTO labels (
        id, dataset_id, title, description, category, color, position_local,
        surface_normal_local, snap_distance, resolution_status, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      label.id, label.datasetId, label.title, label.description, label.category, label.color,
      JSON.stringify(label.positionLocal), label.surfaceNormalLocal ? JSON.stringify(label.surfaceNormalLocal) : null,
      label.snapDistance, label.resolutionStatus, label.createdAt, label.updatedAt
    );
  }
  updateLabel(id: string, values: Partial<InspectionLabel>) {
    const current = this.getLabel(id); if (!current) return null;
    const next = { ...current, ...values, updatedAt: new Date().toISOString() };
    this.sqlite.prepare(`UPDATE labels SET title=?,description=?,category=?,color=?,position_local=?,surface_normal_local=?,snap_distance=?,resolution_status=?,updated_at=? WHERE id=?`).run(
      next.title, next.description, next.category, next.color, JSON.stringify(next.positionLocal),
      next.surfaceNormalLocal ? JSON.stringify(next.surfaceNormalLocal) : null, next.snapDistance,
      next.resolutionStatus, next.updatedAt, id
    ); return next;
  }
  deleteLabel(id: string) { return this.sqlite.prepare("DELETE FROM labels WHERE id=?").run(id); }

  listMissions(datasetId?: string): Mission[] {
    const rows = datasetId
      ? this.sqlite.prepare("SELECT * FROM missions WHERE dataset_id=? ORDER BY created_at DESC").all(datasetId)
      : this.sqlite.prepare("SELECT * FROM missions ORDER BY created_at DESC").all();
    return (rows as Row[]).map(row => this.missionFromRow(row));
  }
  listMissionsUsingLabel(datasetId: string, labelId: string): Mission[] {
    return this.listMissions(datasetId).filter(mission => mission.startLabelId === labelId || mission.labelIds.includes(labelId));
  }
  getMission(id: string): Mission | null {
    const row = this.sqlite.prepare("SELECT * FROM missions WHERE id=?").get(id) as Row | undefined;
    return row ? this.missionFromRow(row) : null;
  }
  insertMission(mission: Mission) {
    this.sqlite.prepare(`
      INSERT INTO missions (
        id, dataset_id, name, home_local, start_label_id, label_ids,
        flight_profile, status, error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      mission.id, mission.datasetId, mission.name, JSON.stringify(mission.homeLocal),
      mission.startLabelId ?? null, JSON.stringify(mission.labelIds), JSON.stringify(mission.flightProfile), mission.status,
      mission.error, mission.createdAt, mission.updatedAt
    );
  }
  updateMission(id: string, values: Partial<Mission>) {
    const current = this.getMission(id); if (!current) return null;
    const next = { ...current, ...values, updatedAt: new Date().toISOString() };
    this.sqlite.prepare(`UPDATE missions SET name=?,home_local=?,start_label_id=?,label_ids=?,flight_profile=?,status=?,error=?,updated_at=? WHERE id=?`).run(
      next.name, JSON.stringify(next.homeLocal), next.startLabelId ?? null, JSON.stringify(next.labelIds), JSON.stringify(next.flightProfile),
      next.status, next.error, next.updatedAt, id
    ); return next;
  }
  updateMissionAndWaypoints(id: string, values: Partial<Mission>, waypoints: Waypoint[]) {
    const current = this.getMission(id); if (!current) return null;
    const next = { ...current, ...values, waypoints, updatedAt: new Date().toISOString() };
    this.sqlite.exec("BEGIN");
    try {
      this.sqlite.prepare(`UPDATE missions SET name=?,home_local=?,start_label_id=?,label_ids=?,flight_profile=?,status=?,error=?,updated_at=? WHERE id=?`).run(
        next.name, JSON.stringify(next.homeLocal), next.startLabelId ?? null, JSON.stringify(next.labelIds), JSON.stringify(next.flightProfile),
        next.status, next.error, next.updatedAt, id
      );
      this.replaceWaypointsInTransaction(id, waypoints);
      this.sqlite.exec("COMMIT");
      return next;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  replaceWaypoints(missionId: string, waypoints: Waypoint[]) {
    this.sqlite.exec("BEGIN");
    try {
      this.replaceWaypointsInTransaction(missionId, waypoints);
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  deleteMission(id: string) { return this.sqlite.prepare("DELETE FROM missions WHERE id=?").run(id); }

  private missionFromRow(row: Row): Mission {
    const waypoints = (this.sqlite.prepare("SELECT * FROM waypoints WHERE mission_id=? ORDER BY sequence").all(String(row.id)) as Row[]).map(waypointFromRow);
    return {
      id: String(row.id), datasetId: String(row.dataset_id), name: String(row.name),
      homeLocal: JSON.parse(String(row.home_local)), startLabelId: row.start_label_id ? String(row.start_label_id) : null,
      labelIds: JSON.parse(String(row.label_ids)),
      flightProfile: JSON.parse(String(row.flight_profile)), status: row.status as Mission["status"],
      error: row.error ? String(row.error) : null, waypoints,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  private replaceWaypointsInTransaction(missionId: string, waypoints: Waypoint[]) {
    this.sqlite.prepare("DELETE FROM waypoints WHERE mission_id=?").run(missionId);
    const statement = this.sqlite.prepare(`
      INSERT INTO waypoints (
        id, mission_id, sequence, type, position_local, yaw, pitch, speed,
        target_label_id, generated, clearance, valid
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const point of waypoints) {
      statement.run(
        point.id, missionId, point.sequence, point.type, JSON.stringify(point.positionLocal),
        point.yaw, point.pitch, point.speed, point.targetLabelId, point.generated ? 1 : 0,
        point.clearance, point.valid ? 1 : 0
      );
    }
  }
}

const datasetFromRow = (row: Row): Dataset => ({
  id: String(row.id), name: String(row.name), sourceFileName: String(row.source_file_name),
  sourceSize: Number(row.source_size), sceneType: row.scene_type as Dataset["sceneType"],
  inputConvention: row.input_convention as Dataset["inputConvention"],
  sourceCoordinateSystem: row.source_coordinate_system === "z_up" ? "z_up" : null,
  voxelSize: Number(row.voxel_size),
  voxelOpacity: Number(row.voxel_opacity), indoorSeed: row.indoor_seed ? JSON.parse(String(row.indoor_seed)) : null,
  placement: JSON.parse(String(row.placement)), status: row.status as Dataset["status"],
  collisionStatus: row.collision_status as Dataset["collisionStatus"], progress: Number(row.progress),
  stage: String(row.stage), error: row.error ? String(row.error) : null,
  uploadId: row.upload_id ? String(row.upload_id) : null,
  aholoVisualRevision: row.aholo_visual_revision ? String(row.aholo_visual_revision) : null,
  aholoPolicyVersion: row.aholo_policy_version ? String(row.aholo_policy_version) : null,
  createdAt: String(row.created_at), updatedAt: String(row.updated_at)
});
const labelFromRow = (row: Row): InspectionLabel => ({
  id: String(row.id), datasetId: String(row.dataset_id), title: String(row.title), description: String(row.description),
  category: String(row.category), color: String(row.color), positionLocal: JSON.parse(String(row.position_local)),
  surfaceNormalLocal: row.surface_normal_local ? JSON.parse(String(row.surface_normal_local)) : null,
  snapDistance: row.snap_distance == null ? null : Number(row.snap_distance),
  resolutionStatus: row.resolution_status as InspectionLabel["resolutionStatus"], createdAt: String(row.created_at), updatedAt: String(row.updated_at)
});
const waypointFromRow = (row: Row): Waypoint => ({
  id: String(row.id), sequence: Number(row.sequence), type: row.type as Waypoint["type"],
  positionLocal: JSON.parse(String(row.position_local)), yaw: Number(row.yaw), pitch: Number(row.pitch),
  speed: Number(row.speed), targetLabelId: row.target_label_id ? String(row.target_label_id) : null,
  generated: Boolean(row.generated), clearance: row.clearance == null ? null : Number(row.clearance), valid: Boolean(row.valid)
});
