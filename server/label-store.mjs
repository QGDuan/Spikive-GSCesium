import { DatabaseSync } from 'node:sqlite';

export const LABEL_TYPES = Object.freeze([
  '起点',
  '缺陷点',
  '常态化巡检点',
  '关键巡检点',
  '一般巡检点'
]);

export const START_LABEL_TYPE = '起点';
const LABEL_SCHEMA_VERSION = 2;
const DEFAULT_LABEL_TYPE = '一般巡检点';
const json = (value) => JSON.stringify(value ?? null);
const parseJson = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const toBoolean = (value) => Boolean(Number(value));

const mapLabel = (row) => {
  if (!row) return undefined;
  return {
    id: row.id,
    datasetId: row.dataset_id,
    title: row.title,
    description: row.description,
    type: row.type,
    position: { x: row.position_x, y: row.position_y, z: row.position_z },
    normal: row.normal_x === null
      ? null
      : { x: row.normal_x, y: row.normal_y, z: row.normal_z },
    selectionMethod: row.selection_method,
    selectionRadiusPixels: row.selection_radius_pixels,
    neighborCount: row.neighbor_count,
    normalPlanarity: row.normal_planarity,
    normalEigenvalues: parseJson(row.normal_eigenvalues, []),
    residentLodLevels: parseJson(row.resident_lod_levels, []),
    residentFileCount: row.resident_file_count,
    pickBackend: row.pick_backend,
    selectionDataSource: row.selection_data_source,
    visualRevision: row.visual_revision,
    sourceSha256: row.source_sha256,
    resolved: toBoolean(row.resolved),
    usageCount: Number(row.usage_count ?? 0),
    inUse: Number(row.usage_count ?? 0) > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

const assertLabelType = (type) => {
  if (!LABEL_TYPES.includes(type)) {
    const error = new Error(`标签类型必须是：${LABEL_TYPES.join('、')}。`);
    error.statusCode = 400;
    throw error;
  }
  return type;
};

const normalizeText = (value, field, maxLength, { required = false } = {}) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (required && !normalized) {
    const error = new Error(`${field}不能为空。`);
    error.statusCode = 400;
    throw error;
  }
  if (normalized.length > maxLength) {
    const error = new Error(`${field}不能超过 ${maxLength} 个字符。`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
};

const labelsTableSql = (name) => `
  CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    visual_revision TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('起点', '缺陷点', '常态化巡检点', '关键巡检点', '一般巡检点')),
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    position_z REAL NOT NULL,
    normal_x REAL,
    normal_y REAL,
    normal_z REAL,
    selection_method TEXT NOT NULL,
    selection_radius_pixels INTEGER NOT NULL,
    neighbor_count INTEGER NOT NULL,
    normal_planarity REAL NOT NULL,
    normal_eigenvalues TEXT NOT NULL,
    resident_lod_levels TEXT NOT NULL,
    resident_file_count INTEGER NOT NULL,
    pick_backend TEXT NOT NULL,
    selection_data_source TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const labelReferencesTableSql = (name, labelsTable) => `
  CREATE TABLE ${name} (
    label_id TEXT NOT NULL REFERENCES ${labelsTable}(id) ON DELETE RESTRICT,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    owner_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY(label_id, owner_type, owner_id)
  );
`;

const createIndexes = (database) => database.exec(`
  CREATE INDEX IF NOT EXISTS labels_dataset_created
    ON labels(dataset_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS labels_dataset_type_created
    ON labels(dataset_id, type, created_at DESC);
  CREATE INDEX IF NOT EXISTS labels_dataset_x
    ON labels(dataset_id, position_x);
  CREATE INDEX IF NOT EXISTS labels_dataset_y
    ON labels(dataset_id, position_y);
  CREATE INDEX IF NOT EXISTS labels_dataset_z
    ON labels(dataset_id, position_z);
  CREATE UNIQUE INDEX IF NOT EXISTS labels_one_start_per_dataset
    ON labels(dataset_id) WHERE type = '起点';
  CREATE INDEX IF NOT EXISTS label_references_owner
    ON label_references(owner_type, owner_id);
`);

const tableExists = (database, name) => Boolean(database.prepare(`
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
`).get(name));

const migrateFourTypeSchema = (database) => {
  const hasReferences = tableExists(database, 'label_references');
  database.exec('PRAGMA foreign_keys = OFF;');
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      ${labelsTableSql('labels_v2')}
      INSERT INTO labels_v2 SELECT * FROM labels;
      ${labelReferencesTableSql('label_references_v2', 'labels_v2')}
      ${hasReferences ? 'INSERT INTO label_references_v2 SELECT * FROM label_references;' : ''}
      ${hasReferences ? 'DROP TABLE label_references;' : ''}
      DROP TABLE labels;
      ALTER TABLE labels_v2 RENAME TO labels;
      ALTER TABLE label_references_v2 RENAME TO label_references;
      PRAGMA user_version = ${LABEL_SCHEMA_VERSION};
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // The original migration error is more useful than a second rollback error.
    }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
};

const initializeSchema = (database) => {
  const labelsSchema = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'labels'
  `).get()?.sql;
  if (!labelsSchema) {
    database.exec(`
      ${labelsTableSql('labels')}
      ${labelReferencesTableSql('label_references', 'labels')}
      PRAGMA user_version = ${LABEL_SCHEMA_VERSION};
    `);
  } else if (!labelsSchema.includes(`'起点'`)) {
    migrateFourTypeSchema(database);
  } else if (!tableExists(database, 'label_references')) {
    database.exec(labelReferencesTableSql('label_references', 'labels'));
  }
  createIndexes(database);
  database.exec(`PRAGMA user_version = ${LABEL_SCHEMA_VERSION};`);
  const violations = database.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new Error(`标签数据库外键校验失败：${violations.length} 个异常。`);
  }
};

const throwStartConflict = (error, type) => {
  if (type === START_LABEL_TYPE && String(error?.message).includes('UNIQUE constraint failed: labels.dataset_id')) {
    const conflict = new Error('同一场景最多只能有一个起点；请先删除原起点或将其改为其他类型。');
    conflict.statusCode = 409;
    throw conflict;
  }
  throw error;
};

export class LabelStore {
  constructor(path) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
      `);
      initializeSchema(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
    this.selectById = this.database.prepare(`
      SELECT labels.*, COUNT(label_references.label_id) AS usage_count
      FROM labels
      LEFT JOIN label_references ON label_references.label_id = labels.id
      WHERE labels.id = ?
      GROUP BY labels.id
    `);
  }

  close() {
    this.database.close();
  }

  count(datasetId) {
    return Number(this.database.prepare('SELECT COUNT(*) AS count FROM labels WHERE dataset_id = ?').get(datasetId).count);
  }

  getStart(datasetId) {
    return mapLabel(this.database.prepare(`
      SELECT labels.*, COUNT(label_references.label_id) AS usage_count
      FROM labels
      LEFT JOIN label_references ON label_references.label_id = labels.id
      WHERE labels.dataset_id = ? AND labels.type = ?
      GROUP BY labels.id
    `).get(datasetId, START_LABEL_TYPE));
  }

  get(labelId) {
    return mapLabel(this.selectById.get(labelId));
  }

  list(datasetId, { type, query = '', limit = 200, offset = 0 } = {}) {
    const clauses = ['labels.dataset_id = ?'];
    const parameters = [datasetId];
    if (type) {
      clauses.push('labels.type = ?');
      parameters.push(assertLabelType(type));
    }
    const normalizedQuery = normalizeText(query, '搜索条件', 100);
    if (normalizedQuery) {
      clauses.push("(labels.title LIKE ? ESCAPE '\\' OR labels.description LIKE ? ESCAPE '\\')");
      const escaped = normalizedQuery.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
      parameters.push(`%${escaped}%`, `%${escaped}%`);
    }
    const safeLimit = Math.min(500, Math.max(1, Number.isInteger(limit) ? limit : 200));
    const safeOffset = Math.max(0, Number.isInteger(offset) ? offset : 0);
    const where = clauses.join(' AND ');
    const rows = this.database.prepare(`
      SELECT labels.*, COUNT(label_references.label_id) AS usage_count
      FROM labels
      LEFT JOIN label_references ON label_references.label_id = labels.id
      WHERE ${where}
      GROUP BY labels.id
      ORDER BY labels.created_at DESC, labels.id
      LIMIT ? OFFSET ?
    `).all(...parameters, safeLimit, safeOffset);
    const total = Number(this.database.prepare(`SELECT COUNT(*) AS count FROM labels WHERE ${where}`).get(...parameters).count);
    return { labels: rows.map(mapLabel), total, limit: safeLimit, offset: safeOffset };
  }

  spatial(datasetId, { x, y, z, radius, type, limit = 200 }) {
    const values = [x, y, z, radius].map(Number);
    if (!values.every(Number.isFinite) || radius <= 0) {
      const error = new Error('空间查询坐标和半径必须是有限数，且半径大于 0。');
      error.statusCode = 400;
      throw error;
    }
    const clauses = [
      'labels.dataset_id = ?',
      'labels.position_x BETWEEN ? AND ?',
      'labels.position_y BETWEEN ? AND ?',
      'labels.position_z BETWEEN ? AND ?'
    ];
    const parameters = [datasetId, x - radius, x + radius, y - radius, y + radius, z - radius, z + radius];
    if (type) {
      clauses.push('labels.type = ?');
      parameters.push(assertLabelType(type));
    }
    const safeLimit = Math.min(500, Math.max(1, Number.isInteger(limit) ? limit : 200));
    const radiusSquared = radius * radius;
    const rows = this.database.prepare(`
      SELECT labels.*, COUNT(label_references.label_id) AS usage_count,
        ((position_x - ?) * (position_x - ?) +
         (position_y - ?) * (position_y - ?) +
         (position_z - ?) * (position_z - ?)) AS distance_squared
      FROM labels
      LEFT JOIN label_references ON label_references.label_id = labels.id
      WHERE ${clauses.join(' AND ')}
      GROUP BY labels.id
      HAVING distance_squared <= ?
      ORDER BY distance_squared ASC, labels.id
      LIMIT ?
    `).all(x, x, y, y, z, z, ...parameters, radiusSquared, safeLimit);
    return rows.map((row) => ({ ...mapLabel(row), distance: Math.sqrt(row.distance_squared) }));
  }

  create(input) {
    const now = input.createdAt || new Date().toISOString();
    const label = {
      ...input,
      title: normalizeText(input.title, '标签名称', 80, { required: true }),
      description: normalizeText(input.description, '标签说明', 500),
      type: assertLabelType(input.type),
      createdAt: now,
      updatedAt: input.updatedAt || now
    };
    try {
      this.database.prepare(`
        INSERT INTO labels (
          id, dataset_id, visual_revision, source_sha256, title, description, type,
          position_x, position_y, position_z, normal_x, normal_y, normal_z,
          selection_method, selection_radius_pixels, neighbor_count, normal_planarity,
          normal_eigenvalues, resident_lod_levels, resident_file_count,
          pick_backend, selection_data_source, resolved, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        label.id, label.datasetId, label.visualRevision, label.sourceSha256,
        label.title, label.description, label.type,
        label.position.x, label.position.y, label.position.z,
        label.normal?.x ?? null, label.normal?.y ?? null, label.normal?.z ?? null,
        label.selectionMethod, label.selectionRadiusPixels, label.neighborCount,
        label.normalPlanarity, json(label.normalEigenvalues), json(label.residentLodLevels),
        label.residentFileCount, label.pickBackend, label.selectionDataSource,
        label.resolved === false ? 0 : 1, label.createdAt, label.updatedAt
      );
    } catch (error) {
      throwStartConflict(error, label.type);
    }
    return this.get(label.id);
  }

  updateMetadata(labelId, patch) {
    const current = this.get(labelId);
    if (!current) return undefined;
    const title = patch.title === undefined
      ? current.title
      : normalizeText(patch.title, '标签名称', 80, { required: true });
    const description = patch.description === undefined
      ? current.description
      : normalizeText(patch.description, '标签说明', 500);
    const type = patch.type === undefined ? current.type : assertLabelType(patch.type);
    try {
      this.database.prepare(`
        UPDATE labels SET title = ?, description = ?, type = ?, updated_at = ? WHERE id = ?
      `).run(title, description, type, new Date().toISOString(), labelId);
    } catch (error) {
      throwStartConflict(error, type);
    }
    return this.get(labelId);
  }

  delete(labelId) {
    const current = this.get(labelId);
    if (!current) return undefined;
    if (current.inUse) {
      const owners = this.database.prepare(`
        SELECT owner_type AS ownerType, owner_id AS ownerId, owner_name AS ownerName
        FROM label_references WHERE label_id = ? ORDER BY owner_type, owner_id
      `).all(labelId);
      const error = new Error('标签正在被任务或航线使用，请先删除引用后再删除标签。');
      error.statusCode = 409;
      error.references = owners;
      throw error;
    }
    this.database.prepare('DELETE FROM labels WHERE id = ?').run(labelId);
    return current;
  }

  deleteDataset(datasetId) {
    const transaction = this.database.prepare('DELETE FROM labels WHERE dataset_id = ?');
    try {
      transaction.run(datasetId);
    } catch (error) {
      if (String(error?.message).includes('FOREIGN KEY')) {
        const conflict = new Error('该场景的标签正在被任务或航线使用，不能删除场景。');
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    }
  }

  addReference(labelId, { ownerType, ownerId, ownerName = '' }) {
    this.database.prepare(`
      INSERT OR IGNORE INTO label_references(label_id, owner_type, owner_id, owner_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(labelId, ownerType, ownerId, ownerName, new Date().toISOString());
  }

  removeReference(labelId, ownerType, ownerId) {
    this.database.prepare(`
      DELETE FROM label_references WHERE label_id = ? AND owner_type = ? AND owner_id = ?
    `).run(labelId, ownerType, ownerId);
  }

  migrateLegacy(datasetId, labels) {
    let inserted = 0;
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO labels (
        id, dataset_id, visual_revision, source_sha256, title, description, type,
        position_x, position_y, position_z, normal_x, normal_y, normal_z,
        selection_method, selection_radius_pixels, neighbor_count, normal_planarity,
        normal_eigenvalues, resident_lod_levels, resident_file_count,
        pick_backend, selection_data_source, resolved, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const legacy of labels) {
        if (!legacy?.id || legacy.datasetId !== datasetId || !legacy.position) continue;
        const createdAt = legacy.createdAt || new Date().toISOString();
        const result = insert.run(
          legacy.id, datasetId, legacy.visualRevision || 'legacy', legacy.sourceSha256 || 'legacy',
          normalizeText(legacy.title || '巡检点', '标签名称', 80, { required: true }),
          normalizeText(legacy.description, '标签说明', 500),
          LABEL_TYPES.includes(legacy.type) ? legacy.type : DEFAULT_LABEL_TYPE,
          Number(legacy.position.x), Number(legacy.position.y), Number(legacy.position.z),
          legacy.normal?.x ?? null, legacy.normal?.y ?? null, legacy.normal?.z ?? null,
          legacy.selectionMethod || 'loaded-lod-gpu-circle-pca-v1',
          legacy.selectionRadiusPixels ?? 5, legacy.neighborCount ?? 3,
          legacy.normalPlanarity ?? 0, json(legacy.normalEigenvalues || []),
          json(legacy.residentLodLevels || [0]), legacy.residentFileCount ?? 1,
          legacy.pickBackend || 'supersplat-centers-gpu-circle',
          legacy.selectionDataSource || 'resident-streamed-sog-lod',
          legacy.resolved === false ? 0 : 1, createdAt, legacy.updatedAt || createdAt
        );
        inserted += Number(result.changes);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return inserted;
  }
}
