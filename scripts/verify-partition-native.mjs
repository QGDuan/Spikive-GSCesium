import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildOfficialCollision } from './collision-build-lib.mjs';
import { buildPartitionedCollision, buildCollisionDebugMesh } from './partitioned-collision.mjs';
import { openCollisionWorld } from '../server/partitioned-voxel-world.mjs';
import { hashFile, atomicJson } from './build-support.mjs';

// Explicit GPU acceptance fixture, not run by routine npm test (no reslicing).
const directory = resolve(process.argv[2] || 'var/acceptance/partition-native');
await mkdir(directory, { recursive: true });
const names = [
  'x',
  'y',
  'z',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
  'scale_0',
  'scale_1',
  'scale_2',
  'opacity',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2'
];
const rows = [];
const add = (x, y, z, sx, sy, sz, opacity, angle = 0) =>
  rows.push([
    x,
    y,
    z,
    Math.cos(angle / 2),
    0,
    0,
    Math.sin(angle / 2),
    Math.log(sx),
    Math.log(sy),
    Math.log(sz),
    Math.log(opacity / (1 - opacity)),
    0,
    0,
    0
  ]);
// Seam walls, several individually sub-threshold contributors, thin rods,
// anisotropic rotated Gaussian spanning the seam, and intentionally empty space.
for (let x = -5; x <= 5; x += 0.5) for (let z = 0; z <= 4; z += 0.5) add(x, 0, z, 0.22, 0.08, 0.22, 0.8);
for (let i = 0; i < 12; i++) add(0.05 + i * 0.01, 0.5, 2, 0.3, 0.3, 0.3, 0.02);
add(-2, 1, 2, 3, 0.08, 0.12, 0.7, Math.PI / 4);
add(-34, 0, 2, 0.3, 0.3, 0.3, 0.8);
add(34, 0, 2, 0.3, 0.3, 0.3, 0.8);
for (let z = 0; z < 4; z += 0.1) add(1, 2, z, 0.06, 0.06, 0.08, 0.8);
const header = Buffer.from(
  `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${names.map((n) => `property float ${n}`).join('\n')}\nend_header\n`
);
const data = Buffer.alloc(rows.length * names.length * 4);
rows.forEach((row, i) => row.forEach((value, k) => data.writeFloatLE(value, (i * names.length + k) * 4)));
const source = resolve(directory, 'fixture.ply');
await writeFile(source, Buffer.concat([header, data]));
const sourceSha256 = await hashFile(source);
const options = { voxelSize: 0.5, voxelOpacity: 0.1 };
const wholeDir = resolve(directory, 'whole'),
  partsDir = resolve(directory, 'partitioned');
const onLog = (line) => {
  if (/Error|peak|failed/.test(line)) console.log(line);
};
await buildOfficialCollision({
  source,
  outputDirectory: wholeDir,
  ...options,
  onLog,
  logPath: resolve(directory, 'whole.log')
});
await buildPartitionedCollision({
  source,
  sourceSha256,
  outputDirectory: partsDir,
  workDirectory: resolve(directory, 'work'),
  ...options,
  onLog,
  logPath: resolve(directory, 'parts.log'),
  onProgress: (p) => console.log(p.stage)
});
const whole = openCollisionWorld(wholeDir),
  parts = openCollisionWorld(partsDir);
let checked = 0,
  occupied = 0;
try {
  assert.deepEqual(parts.bounds, whole.bounds, 'unknown-space domain matches upstream cropped bounds');
  const b = parts.bounds,
    h = parts.resolution;
  for (let z = b.min.z + h / 2; z < b.max.z; z += h)
    for (let y = b.min.y + h / 2; y < b.max.y; y += h)
      for (let x = b.min.x + h / 2; x < b.max.x; x += h) {
        const p = { x, y, z };
        const a = whole.isOccupied(p),
          v = parts.isOccupied(p);
        assert.equal(v, a, `occupancy ${JSON.stringify(p)}`);
        checked++;
        if (v) occupied++;
      }
  for (let x = -4; x <= 4; x += 0.5)
    for (const r of [0, 0.1, 0.3, 0.6]) {
      const p = { x, y: 1, z: 2 };
      if (whole.contains(p))
        assert.equal(parts.sphereIsFree(p, r), whole.sphereIsFree(p, r), `sphere ${x}/${r}`);
    }
  const from = { x: -4, y: 1, z: 2 },
    to = { x: 4, y: 1, z: 2 };
  assert.equal(parts.segmentIsFree(from, to, 0.2), whole.segmentIsFree(from, to, 0.2));
} finally {
  whole.close();
  parts.close();
}
const debug = await buildCollisionDebugMesh({
  source,
  collisionDirectory: partsDir,
  indexDirectory: resolve(directory, 'work'),
  workDirectory: resolve(directory, 'debug'),
  partitionIndex: 0,
  onLog
});
const report = {
  date: new Date().toISOString(),
  sourceSha256,
  options,
  checked,
  occupied,
  debugBytes: debug.bytes,
  pass: true
};
await atomicJson(resolve(directory, 'result.json'), report);
console.log(report);
