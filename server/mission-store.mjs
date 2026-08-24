const parseBoolean = (value) => Boolean(Number(value));

const mapWaypoint = (row) => ({
  id: row.id,
  sequence: row.sequence,
  type: row.type,
  position: { x: row.position_x, y: row.position_y, z: row.position_z },
  yaw: row.yaw,
  pitch: row.pitch,
  speed: row.speed,
  targetLabelId: row.target_label_id,
  clearance: row.clearance,
  valid: parseBoolean(row.valid)
});

const normalizeName = (value) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw Object.assign(new Error('航线名称不能为空。'), { statusCode: 400 });
  if (name.length > 80) throw Object.assign(new Error('航线名称不能超过 80 个字符。'), { statusCode: 400 });
  return name;
};

export class MissionStore {
  constructor(database) {
    this.database = database;
  }

  count(datasetId) {
    return Number(this.database.prepare('SELECT COUNT(*) AS count FROM missions WHERE dataset_id = ?').get(datasetId).count);
  }

  get(id) {
    const row = this.database.prepare('SELECT * FROM missions WHERE id = ?').get(id);
    if (!row) return undefined;
    const labelRows = this.database.prepare(`
      SELECT label_id FROM mission_labels WHERE mission_id = ? ORDER BY sequence
    `).all(id);
    const waypointRows = this.database.prepare(`
      SELECT * FROM waypoints WHERE mission_id = ? ORDER BY sequence
    `).all(id);
    return {
      id: row.id,
      datasetId: row.dataset_id,
      name: row.name,
      startLabelId: row.start_label_id,
      labelIds: labelRows.map((item) => item.label_id),
      profile: {
        speed: row.speed,
        inflationRadius: row.inflation_radius,
        observationDistance: row.observation_distance,
        minimumSpacing: row.minimum_spacing,
        maximumSpacing: row.maximum_spacing
      },
      collisionRevision: row.collision_revision,
      status: row.status,
      error: row.error,
      waypoints: waypointRows.map(mapWaypoint),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  list(datasetId) {
    return this.database.prepare(`
      SELECT id FROM missions WHERE dataset_id = ? ORDER BY updated_at DESC, id
    `).all(datasetId).map(({ id }) => this.get(id));
  }

  create(input) {
    const now = new Date().toISOString();
    const mission = {
      ...input,
      name: normalizeName(input.name),
      status: 'draft',
      error: null,
      collisionRevision: null,
      createdAt: now,
      updatedAt: now
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO missions (
          id, dataset_id, name, start_label_id, speed, inflation_radius,
          observation_distance, minimum_spacing, maximum_spacing,
          collision_revision, status, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mission.id, mission.datasetId, mission.name, mission.startLabelId,
        mission.profile.speed, mission.profile.inflationRadius,
        mission.profile.observationDistance, mission.profile.minimumSpacing,
        mission.profile.maximumSpacing, null, mission.status, null, now, now
      );
      this.replaceLabels(mission.id, mission.name, mission.startLabelId, mission.labelIds);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(mission.id);
  }

  update(id, input) {
    const current = this.get(id);
    if (!current) return undefined;
    const next = {
      ...current,
      name: input.name === undefined ? current.name : normalizeName(input.name),
      startLabelId: input.startLabelId ?? current.startLabelId,
      labelIds: input.labelIds ?? current.labelIds,
      profile: input.profile ?? current.profile,
      updatedAt: new Date().toISOString()
    };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE missions SET name = ?, start_label_id = ?, speed = ?, inflation_radius = ?,
          observation_distance = ?, minimum_spacing = ?, maximum_spacing = ?,
          collision_revision = NULL, status = 'draft', error = NULL, updated_at = ?
        WHERE id = ?
      `).run(
        next.name, next.startLabelId, next.profile.speed, next.profile.inflationRadius,
        next.profile.observationDistance, next.profile.minimumSpacing,
        next.profile.maximumSpacing, next.updatedAt, id
      );
      this.database.prepare('DELETE FROM waypoints WHERE mission_id = ?').run(id);
      this.replaceLabels(id, next.name, next.startLabelId, next.labelIds);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(id);
  }

  savePlan(id, { valid, waypoints, error, collisionRevision }) {
    const current = this.get(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM waypoints WHERE mission_id = ?').run(id);
      const insert = this.database.prepare(`
        INSERT INTO waypoints (
          id, mission_id, sequence, type, position_x, position_y, position_z,
          yaw, pitch, speed, target_label_id, clearance, valid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const point of waypoints) {
        insert.run(
          point.id, id, point.sequence, point.type,
          point.position.x, point.position.y, point.position.z,
          point.yaw, point.pitch, point.speed, point.targetLabelId,
          point.clearance, point.valid ? 1 : 0
        );
      }
      this.database.prepare(`
        UPDATE missions SET status = ?, error = ?, collision_revision = ?, updated_at = ? WHERE id = ?
      `).run(valid ? 'valid' : 'invalid', error ?? null, collisionRevision, now, id);
      this.database.exec('COMMIT');
    } catch (saveError) {
      this.database.exec('ROLLBACK');
      throw saveError;
    }
    return this.get(id);
  }

  delete(id) {
    const current = this.get(id);
    if (!current) return undefined;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`DELETE FROM label_references WHERE owner_id = ? AND owner_type IN ('mission-start', 'mission-target')`).run(id);
      this.database.prepare('DELETE FROM missions WHERE id = ?').run(id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return current;
  }

  deleteDataset(datasetId) {
    const ids = this.database.prepare('SELECT id FROM missions WHERE dataset_id = ?').all(datasetId).map(({ id }) => id);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const deleteReferences = this.database.prepare(`DELETE FROM label_references WHERE owner_id = ? AND owner_type IN ('mission-start', 'mission-target')`);
      for (const id of ids) deleteReferences.run(id);
      this.database.prepare('DELETE FROM missions WHERE dataset_id = ?').run(datasetId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return ids.length;
  }

  invalidateDatasetCollision(datasetId, activeRevision) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        DELETE FROM waypoints WHERE mission_id IN (
          SELECT id FROM missions WHERE dataset_id = ? AND collision_revision IS NOT NULL AND collision_revision <> ?
        )
      `).run(datasetId, activeRevision);
      this.database.prepare(`
        UPDATE missions SET status = 'draft', error = '体素版本已更新，请重新规划。',
          collision_revision = NULL, updated_at = ?
        WHERE dataset_id = ? AND collision_revision IS NOT NULL AND collision_revision <> ?
      `).run(new Date().toISOString(), datasetId, activeRevision);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  invalidateDatasetVisual(datasetId) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        DELETE FROM waypoints WHERE mission_id IN (SELECT id FROM missions WHERE dataset_id = ?)
      `).run(datasetId);
      this.database.prepare(`
        UPDATE missions SET status = 'draft', error = '视觉版本已更新，标签需重新选择后再规划。',
          collision_revision = NULL, updated_at = ? WHERE dataset_id = ?
      `).run(new Date().toISOString(), datasetId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  replaceLabels(missionId, missionName, startLabelId, labelIds) {
    this.database.prepare(`DELETE FROM label_references WHERE owner_id = ? AND owner_type IN ('mission-start', 'mission-target')`).run(missionId);
    this.database.prepare('DELETE FROM mission_labels WHERE mission_id = ?').run(missionId);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO label_references(label_id, owner_type, owner_id, owner_name, created_at)
      VALUES (?, 'mission-start', ?, ?, ?)
    `).run(startLabelId, missionId, missionName, now);
    const labelInsert = this.database.prepare(`
      INSERT INTO mission_labels(mission_id, label_id, sequence) VALUES (?, ?, ?)
    `);
    const referenceInsert = this.database.prepare(`
      INSERT INTO label_references(label_id, owner_type, owner_id, owner_name, created_at)
      VALUES (?, 'mission-target', ?, ?, ?)
    `);
    labelIds.forEach((labelId, sequence) => {
      labelInsert.run(missionId, labelId, sequence);
      referenceInsert.run(labelId, missionId, missionName, now);
    });
  }
}
