import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { LabelStore, LABEL_TYPES } from './label-store.mjs';

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
  selectionMethod: 'loaded-lod-gpu-circle-pca-v1',
  selectionRadiusPixels: 5,
  neighborCount: 20,
  normalPlanarity: 0.9,
  normalEigenvalues: [0.1, 1, 2],
  residentLodLevels: [0, 1],
  residentFileCount: 2,
  pickBackend: 'supersplat-centers-gpu-circle',
  selectionDataSource: 'resident-streamed-sog-lod',
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

test('四种标签类型之外的值被拒绝', async () => withStore((store) => {
  assert.equal(LABEL_TYPES.length, 4);
  assert.throws(() => store.create(makeLabel({ type: '其他' })), /标签类型/);
  assert.throws(() => store.create(makeLabel({ type: undefined })), /标签类型/);
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
  const legacy = makeLabel({ type: undefined, description: undefined });
  assert.equal(store.migrateLegacy('dataset-a', [legacy]), 1);
  assert.equal(store.migrateLegacy('dataset-a', [legacy]), 0);
  const migrated = store.get(legacy.id);
  assert.equal(migrated.type, '一般巡检点');
  assert.deepEqual(migrated.position, legacy.position);
  assert.deepEqual(migrated.normal, legacy.normal);
}));
