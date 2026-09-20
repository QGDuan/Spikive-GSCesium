import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hashFile } from '../scripts/build-support.mjs';

test(
  '构建 API：设备失败分区重试、取消续算、网格失败隔离、旧版和标签航线保留',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'spikive-api-test-'));
    let child;
    try {
      const id = randomUUID(),
        dir = resolve(root, 'data/local-datasets', id);
      await mkdir(dir, { recursive: true });
      await mkdir(resolve(root, 'dist'));
      await writeFile(resolve(root, 'dist/index.html'), 'ok');
      const fields = [
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
      const header = Buffer.from(
        `ply\nformat binary_little_endian 1.0\nelement vertex 1\n${fields.map((n) => `property float ${n}`).join('\n')}\nend_header\n`
      );
      const data = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0]).buffer);
      await writeFile(resolve(dir, 'source.ply'), Buffer.concat([header, data]));
      const digest = await hashFile(resolve(dir, 'source.ply'));
      await writeFile(
        resolve(dir, 'dataset.json'),
        JSON.stringify({
          id,
          name: '验收场景',
          status: 'ready',
          lodLevels: 5,
          source: { sha256: digest, bytes: header.length + data.length },
          activeVisualRevision: 'visual-stable',
          visual: { revision: 'visual-stable', renderUrl: '/not-loaded', counts: [1] },
          collision: { status: 'not-built', voxelSize: 0.5, voxelOpacity: 0.1 }
        })
      );
      const flag = resolve(root, 'mode'),
        cli = resolve(root, 'converter.mjs');
      await writeFile(flag, 'lost-once');
      await writeFile(
        cli,
        `import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{dirname,resolve}from'node:path';
const mode=readFileSync(${JSON.stringify(flag)},'utf8');
if(mode==='lost-once'){writeFileSync(${JSON.stringify(flag)},'ok');console.error('Error: DXGI_ERROR_DEVICE_HUNG');process.exit(1);}
if(mode==='disk'){console.error('Error: ENOSPC');process.exit(1);}
if(mode==='grid'){console.error('Error: mutable-grid safety limit');process.exit(1);}
if(mode==='wait'){console.log('Voxelizing');setInterval(()=>{},1000);}else{
const args=process.argv.slice(2),out=args.at(-1),dir=dirname(out);mkdirSync(dir,{recursive:true});
if(out.endsWith('lod-meta.json')){mkdirSync(resolve(dir,'chunk'));writeFileSync(out,JSON.stringify({lodLevels:1,counts:[1],count:1,filenames:['chunk/meta.json']}));writeFileSync(resolve(dir,'chunk/meta.json'),JSON.stringify({count:1,means:{files:['data.webp']}}));writeFileSync(resolve(dir,'chunk/data.webp'),'test payload');process.exit(0);}
writeFileSync(out,JSON.stringify({version:'1.1',voxelResolution:Number(args[args.indexOf('--voxel-size')+1]),leafSize:4,treeDepth:1,numInteriorNodes:0,numMixedLeaves:0,nodeCount:1,leafDataCount:0,gridBounds:{min:[-4,-4,-4],max:[4,4,4]},sceneBounds:{min:[-3,-3,-3],max:[3,3,3]}}));
writeFileSync(out.replace('.json','.bin'),Buffer.alloc(4));
if(args.includes('--collision-mesh')){const json=Buffer.from('{"asset":{"version":"2.0"}}  '),b=Buffer.alloc(20+json.length);b.write('glTF');b.writeUInt32LE(2,4);b.writeUInt32LE(b.length,8);b.writeUInt32LE(json.length,12);b.write('JSON',16);json.copy(b,20);writeFileSync(resolve(dir,'scene.collision.glb'),b);}
console.log('done');}`
      );
      child = spawn(process.execPath, [process.env.SPIKIVE_TEST_SERVER || 'server.mjs', '--production'], {
        env: {
          ...process.env,
          SPIKIVE_DATA_ROOT: resolve(root, 'data'),
          SPIKIVE_DIST_ROOT: resolve(root, 'dist'),
          SPIKIVE_PUBLIC_ROOT: resolve(root, 'public'),
          SPIKIVE_PORT: '0',
          SPIKIVE_HOST: '127.0.0.1',
          SPIKIVE_SPLAT_CLI: cli
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stderr.on('data', (c) => {
        output += c;
      });
      const base = await new Promise((res, rej) => {
        const timeout = setTimeout(() => rej(new Error(output)), 5000);
        child.stdout.on('data', (c) => {
          output += c;
          const match = /http:\/\/127.0.0.1:\d+/.exec(output);
          if (match) {
            clearTimeout(timeout);
            res(match[0]);
          }
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          rej(new Error(output));
        });
      });
      const request = async (path, body, method = body ? 'POST' : 'GET') => {
        const response = await fetch(base + path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined
        });
        const result = await response.json();
        assert.ok(response.ok, JSON.stringify(result));
        return result;
      };
      const get = () => request(`/api/datasets/${id}`);
      const idle = async () => {
        for (let i = 0; i < 150; i++) {
          const list = await request('/api/datasets');
          if (!list.activeTask) return get();
          await delay(30);
        }
        throw new Error('task not idle ' + output);
      };
      const build = (options = { voxelSize: 0.5, voxelOpacity: 0.1 }) =>
        request(`/api/datasets/${id}/collision/build`, options);
      await build();
      let dataset = await idle();
      assert.equal(dataset.collision.status, 'ready', JSON.stringify(dataset));
      assert.ok(dataset.collision.partitionCount >= 2);
      const original = dataset.activeCollisionRevision;
      const label = async (type, x) =>
        request(`/api/datasets/${id}/labels/select`, {
          title: type,
          type,
          position: { x, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
          visualRevision: 'visual-stable',
          selectionRadiusPixels: 5,
          neighborCount: 3,
          normalEigenvalues: [0, 1, 1],
          normalPlanarity: 1,
          pickBackend: 'playcanvas-native-depth-picker',
          selectionDataSource: 'rendered-alpha-front-surface'
        });
      const start = await label('起点', -1),
        target = await label('一般巡检点', 1);
      const mission = await request(`/api/datasets/${id}/missions`, {
        name: '验收航线',
        startLabelId: start.id,
        labelIds: [target.id],
        profile: {
          speed: 1,
          inflationRadius: 0.1,
          observationDistance: 1,
          minimumSpacing: 0.1,
          maximumSpacing: 3
        }
      });
      const planned = await request(`/api/missions/${mission.id}/plan`, {});
      assert.equal(planned.status, 'valid', JSON.stringify(planned));
      await writeFile(flag, 'wait');
      await build();
      await delay(100);
      await request(`/api/datasets/${id}/tasks/cancel`, {});
      dataset = await idle();
      assert.equal(dataset.activeCollisionRevision, original);
      assert.equal(dataset.collision.status, 'ready');
      assert.equal(dataset.collision.errorCode, 'CANCELLED');
      const pending = dataset.pendingCollisionRevision;
      assert.ok(pending);
      assert.equal((await request(`/api/missions/${mission.id}`)).status, 'valid');
      await writeFile(flag, 'grid');
      await request(`/api/datasets/${id}/collision/debug-mesh/build`, { partitionIndex: 0 });
      dataset = await idle();
      assert.equal(dataset.activeCollisionRevision, original);
      assert.equal(dataset.collision.debugMeshStatus, 'failed');
      assert.equal((await request(`/api/missions/${mission.id}`)).status, 'valid');
      await writeFile(flag, 'disk');
      await build();
      dataset = await idle();
      assert.equal(dataset.collision.errorCode, 'DISK_FULL');
      assert.equal(dataset.activeCollisionRevision, original);
      const log = await fetch(base + dataset.collisionLogUrl);
      assert.match(await log.text(), /ENOSPC/);
      await writeFile(flag, 'ok');
      await build();
      dataset = await idle();
      assert.equal(dataset.activeCollisionRevision, pending);
      assert.equal((await request(`/api/datasets/${id}/labels`)).labels.length, 2);
      assert.equal(dataset.activeVisualRevision, 'visual-stable');
      assert.notEqual((await request(`/api/missions/${mission.id}`)).status, 'valid');
      await request(`/api/datasets/${id}/collision/debug-mesh/build`, { partitionIndex: 0 });
      dataset = await idle();
      assert.equal(dataset.collision.debugMeshStatus, 'ready');
      assert.equal(dataset.activeCollisionRevision, pending);
      assert.equal((await fetch(base + dataset.collision.debugMeshUrl)).status, 200);
      const persisted = JSON.parse(await readFile(resolve(dir, 'dataset.json'), 'utf8'));
      assert.equal(persisted.pendingCollisionRevision, null);
      const uploaded = await request('/api/datasets', {
        name: '新数据.ply',
        size: header.length + data.length,
        lodLevels: 1
      });
      assert.equal(uploaded.resourceProfile, 'low-memory');
      const put = await fetch(`${base}/api/datasets/${uploaded.id}/source`, {
        method: 'PUT',
        body: Buffer.concat([header, data])
      });
      assert.equal(put.status, 200);
      const invalid = await fetch(`${base}/api/datasets/${uploaded.id}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceProfile: 'unknown' })
      });
      assert.equal(invalid.status, 400);
      await request(`/api/datasets/${uploaded.id}/build`, { lodLevels: 1 });
      await idle();
      const visual = await request(`/api/datasets/${uploaded.id}`);
      assert.equal(visual.status, 'ready', JSON.stringify(visual));
      assert.equal(visual.visual.counts[0], 1);
      const rebuild = await fetch(`${base}/api/datasets/${uploaded.id}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      assert.equal(rebuild.status, 409);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(root, { recursive: true, force: true });
    }
  }
);
