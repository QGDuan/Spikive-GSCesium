import { parentPort, workerData } from 'node:worker_threads';
import { openCollisionWorld } from './partitioned-voxel-world.mjs';
import { planMission } from './route-planner.mjs';

let collision;
try {
  collision = openCollisionWorld(workerData.directory, { manifestSha256: workerData.manifestSha256 });
  parentPort.postMessage({ result: planMission({ ...workerData.input, collision }) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  collision?.close();
}
