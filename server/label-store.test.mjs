import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { LabelStore, LABEL_TYPES, START_LABEL_TYPE } from './label-store.mjs';

const makeLabel = (overrides = {}) => ({
  id: crypto.randomUUID(),
  datasetId: 'dataset-a',
  visualRevision: 'visual-1',
  sourceSha256: 'abc',
  title: '电机 A',
  description: '侧面巡检',
  type: '关键巡检点',
  position: { x: 1, y: 2, z: 3 },
  normal: { x: 0, y: 1, z: 0 },
  selectionMethod: 'playcanvas-picker-depth-pca-v2',
  selectionRadiusPixels: 5,
  neighborCount: 20,
  normalPlanarity: 0.9,
  normalEigenvalues: [0.1, 1, 2],
  residentLodLevels: [],
  residentFileCount: 0,
  pickBackend: 'playcanvas-native-depth-picker',
  selectionDataSource: 'rendered-alpha-front-surface',
  resolved: true,
  ...overrides
});

const withStore = async (callback) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'spikive-labels-'));
  const store = new LabelStore(resolve(directory, 'labels.sqlite'));
  try {
    await callback(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test('标签 CRUD、类型与场景隔离', async () => withStore((store) => {
  const first = store.create(makeLabel());
  const second = store.create(makeLabel({
    id: crypto.randomUUID(), datasetId: 'dataset-b', title: '柱子 B', type: '缺陷点'
  }));
  assert.equal(first.type, '关键巡检点');
  assert.equal(store.count('dataset-a'), 1);
  assert.deepEqual(store.list('dataset-a').labels.map((label) => label.id), [first.id]);
  assert.deepEqual(store.list('dataset-b', { type: '缺陷点' }).labels.map((label) => label.id), [second.id]);

  const updated = store.updateMetadata(first.id, {
    title: '电机 A-1', description: '已复核', type: '常态化巡检点'
  });
  assert.equal(updated.title, '电机 A-1');
  assert.equal(updated.position.x, 1);
  assert.equal(store.list('dataset-a', { query: '复核' }).total, 1);
  assert.equal(store.delete(first.id).id, first.id);
  assert.equal(store.get(first.id), undefined);
}));

test('五种标签类型之外的值被拒绝', async () => withStore((store) => {
  assert.equal(LABEL_TYPES.length, 5);
  assert.equal(LABEL_TYPES[0], START_LABEL_TYPE);
  assert.throws(() => store.create(makeLabel({ type: '其他' })), /标签类型/);
  assert.throws(() => store.create(makeLabel({ type: undefined })), /标签类型/);
}));

test('起点允许缺省但同一场景最多一个', async () => withStore((store) => {
  assert.equal(store.getStart('dataset-a'), undefined);
  const startA = store.create(makeLabel({ id: crypto.randomUUID(), type: START_LABEL_TYPE, title: '起点 A' }));
  const startB = store.create(makeLabel({ id: crypto.randomUUID(), datasetId: 'dataset-b', type: START_LABEL_TYPE, title: '起点 B' }));
  assert.equal(store.getStart('dataset-a').id, startA.id);
  assert.equal(store.getStart('dataset-b').id, startB.id);

  assert.throws(
    () => store.create(makeLabel({ id: crypto.randomUUID(), type: START_LABEL_TYPE, title: '重复起点' })),
    (error) => error.statusCode === 409 && /最多只能有一个起点/.test(error.message)
  );

  const ordinary = store.create(makeLabel({ id: crypto.randomUUID(), title: '待转换标签' }));
  assert.throws(
    () => store.updateMetadata(ordinary.id, { type: START_LABEL_TYPE }),
    (error) => error.statusCode === 409 && /最多只能有一个起点/.test(error.message)
  );
  store.updateMetadata(startA.id, { type: '一般巡检点' });
  assert.equal(store.getStart('dataset-a'), undefined);
  assert.equal(store.updateMetadata(ordinary.id, { type: START_LABEL_TYPE }).type, START_LABEL_TYPE);
}));

test('空间查询使用场景边界并按距离排序', async () => withStore((store) => {
  const near = store.create(makeLabel({ id: crypto.randomUUID(), position: { x: 0.2, y: 0, z: 0 } }));
  const far = store.create(makeLabel({ id: crypto.randomUUID(), position: { x: 0.8, y: 0, z: 0 } }));
  store.create(makeLabel({ id: crypto.randomUUID(), position: { x: 2, y: 0, z: 0 } }));
  store.create(makeLabel({ id: crypto.randomUUID(), datasetId: 'dataset-b', position: { x: 0, y: 0, z: 0 } }));
  const result = store.spatial('dataset-a', { x: 0, y: 0, z: 0, radius: 1 });
  assert.deepEqual(result.map((label) => label.id), [near.id, far.id]);
  assert.ok(result[0].distance < result[1].distance);
}));

test('被任务引用的标签与场景不可删除', async () => withStore((store) => {
  const label = store.create(makeLabel());
  store.addReference(label.id, { ownerType: 'mission', ownerId: 'mission-1', ownerName: '巡检任务' });
  assert.equal(store.get(label.id).usageCount, 1);
  assert.throws(() => store.delete(label.id), /正在被/);
  assert.throws(() => store.deleteDataset('dataset-a'), /不能删除场景/);
  store.removeReference(label.id, 'mission', 'mission-1');
  assert.equal(store.delete(label.id).id, label.id);
}));

test('旧 labels.json 数据幂等迁移且保留空间信息', async () => withStore((store) => {
  const legacy = makeLabel({
    type: undefined,
    description: undefined,
    selectionMethod: undefined,
    residentLodLevels: undefined,
    residentFileCount: undefined,
    pickBackend: undefined,
    selectionDataSource: undefined
  });
  assert.equal(store.migrateLegacy('dataset-a', [legacy]), 1);
  assert.equal(store.migrateLegacy('dataset-a', [legacy]), 0);
  const migrated = store.get(legacy.id);
  assert.equal(migrated.type, '一般巡检点');
  assert.equal(migrated.selectionMethod, 'loaded-lod-gpu-circle-pca-v1');
  assert.equal(migrated.pickBackend, 'supersplat-centers-gpu-circle');
  assert.deepEqual(migrated.position, legacy.position);
  assert.deepEqual(migrated.normal, legacy.normal);
}));

test('四类型 SQLite 旧库自动迁移且保留标签和引用', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'spikive-label-schema-'));
  const path = resolve(directory, 'labels.sqlite');
  const old = new DatabaseSync(path);
  const label = makeLabel({ id: crypto.randomUUID() });
  try {
    old.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE labels (
        id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, visual_revision TEXT NOT NULL,
        source_sha256 TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK (type IN ('缺陷点', '常态化巡检点', '关键巡检点', '一般巡检点')),
        position_x REAL NOT NULL, position_y REAL NOT NULL, position_z REAL NOT NULL,
        normal_x REAL, normal_y REAL, normal_z REAL, selection_method TEXT NOT NULL,
        selection_radius_pixels INTEGER NOT NULL, neighbor_count INTEGER NOT NULL,
        normal_planarity REAL NOT NULL, normal_eigenvalues TEXT NOT NULL,
        resident_lod_levels TEXT NOT NULL, resident_file_count INTEGER NOT NULL,
        pick_backend TEXT NOT NULL, selection_data_source TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE label_references (
        label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE RESTRICT,
        owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, PRIMARY KEY(label_id, owner_type, owner_id)
      );
    `);
    const now = new Date().toISOString();
    old.prepare(`
      INSERT INTO labels VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      label.id, label.datasetId, label.visualRevision, label.sourceSha256, label.title, label.description,
      label.type, label.position.x, label.position.y, label.position.z, label.normal.x, label.normal.y,
      label.normal.z, label.selectionMethod, label.selectionRadiusPixels, label.neighborCount,
      label.normalPlanarity, JSON.stringify(label.normalEigenvalues), JSON.stringify(label.residentLodLevels),
      label.residentFileCount, label.pickBackend, label.selectionDataSource, 1, now, now
    );
    old.prepare('INSERT INTO label_references VALUES (?, ?, ?, ?, ?)')
      .run(label.id, 'mission', 'mission-old', '旧任务', now);
  } finally {
    old.close();
  }

  const store = new LabelStore(path);
  try {
    assert.equal(store.database.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(store.get(label.id).usageCount, 1);
    assert.equal(store.get(label.id).type, label.type);
    assert.throws(() => store.delete(label.id), /正在被/);
    const start = store.create(makeLabel({ id: crypto.randomUUID(), type: START_LABEL_TYPE, title: '迁移后起点' }));
    assert.equal(store.getStart('dataset-a').id, start.id);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
