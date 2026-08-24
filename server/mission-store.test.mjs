import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { LabelStore } from './label-store.mjs';
import { MissionStore } from './mission-store.mjs';

const labelInput = (type, title) => ({
  id: crypto.randomUUID(), datasetId: 'dataset-a', visualRevision: 'visual-1', sourceSha256: 'sha',
  title, description: '', type, position: { x: 1, y: 2, z: 3 }, normal: { x: 1, y: 0, z: 0 },
  selectionMethod: 'playcanvas-picker-depth-pca-v2', selectionRadiusPixels: 5, neighborCount: 10,
  normalPlanarity: 0.9, normalEigenvalues: [0.1, 1, 2], residentLodLevels: [], residentFileCount: 0,
  pickBackend: 'playcanvas-native-depth-picker', selectionDataSource: 'rendered-alpha-front-surface', resolved: true
});

test('航线、顺序标签、航点和引用在同一 SQLite 闭环', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'spikive-missions-'));
  const labels = new LabelStore(resolve(directory, 'labels.sqlite'));
  const missions = new MissionStore(labels.database);
  try {
    const start = labels.create(labelInput('起点', '起点'));
    const first = labels.create(labelInput('关键巡检点', '电机 A'));
    const second = labels.create(labelInput('一般巡检点', '电机 B'));
    const mission = missions.create({
      id: crypto.randomUUID(), datasetId: 'dataset-a', name: '巡检航线', startLabelId: start.id,
      labelIds: [second.id, first.id],
      profile: { speed: 3, inflationRadius: 0.5, observationDistance: 3, minimumSpacing: 0.5, maximumSpacing: 5 }
    });
    assert.deepEqual(mission.labelIds, [second.id, first.id]);
    assert.equal(labels.get(start.id).inUse, true);
    assert.equal(labels.get(first.id).inUse, true);
    assert.throws(() => labels.delete(first.id), /正在被/);
    assert.throws(() => labels.updateMetadata(start.id, { type: '一般巡检点' }), /正在被航线使用/);

    const planned = missions.savePlan(mission.id, {
      valid: true, collisionRevision: 'collision-1', error: null,
      waypoints: [{
        id: crypto.randomUUID(), sequence: 0, type: 'start', position: { x: 4, y: 2, z: 3 },
        yaw: 0, pitch: 0, speed: 3, targetLabelId: start.id, clearance: 2, valid: true
      }]
    });
    assert.equal(planned.status, 'valid');
    assert.equal(planned.waypoints.length, 1);
    missions.invalidateDatasetCollision('dataset-a', 'collision-2');
    assert.equal(missions.get(mission.id).status, 'draft');
    assert.equal(missions.get(mission.id).waypoints.length, 0);

    missions.savePlan(mission.id, { valid: true, collisionRevision: 'collision-2', error: null, waypoints: [] });
    missions.invalidateDatasetVisual('dataset-a');
    assert.equal(missions.get(mission.id).status, 'draft');
    assert.match(missions.get(mission.id).error, /视觉版本/);

    missions.delete(mission.id);
    assert.equal(labels.get(first.id).inUse, false);
    assert.equal(labels.updateMetadata(start.id, { type: '一般巡检点' }).type, '一般巡检点');
  } finally {
    labels.close();
    await rm(directory, { recursive: true, force: true });
  }
});
