import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  classifyBuildFailure,
  resourceProfile,
  safePath,
  checkCancelled,
  checkDisk
} from './build-support.mjs';
import { getSogWorkerCount } from './sog-build-lib.mjs';

test('低资源默认 CPU 单进程，错误分类不自动改精度', async () => {
  assert.equal(resourceProfile(), 'low-memory');
  assert.equal(getSogWorkerCount(), 0);
  assert.throws(() => resourceProfile('auto'), /无效/);
  assert.throws(() => safePath('/tmp/test', '../outside'), /越界/);
  for (const [message, code] of [
    ['CANCELLED', 'CANCELLED'],
    ['ENOSPC', 'DISK_FULL'],
    ['mutable-grid safety limit', 'GRID_LIMIT'],
    ['DXGI_ERROR_DEVICE_HUNG', 'GPU_LOST'],
    ['StorageBuffer binding size limit', 'GPU_MEMORY'],
    ['heap out of memory', 'RAM']
  ])
    assert.equal(classifyBuildFailure(message).code, code);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => checkCancelled(controller.signal), /取消/);
  await assert.rejects(checkDisk(tmpdir(), Number.MAX_SAFE_INTEGER), /磁盘空间不足/);
});

test('子进程取消、完整日志、失败续算校验复用和损坏层重建', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'build-resume-test-'));
  const original = process.env.SPIKIVE_SPLAT_CLI;
  try {
    const cli = resolve(dir, 'fake-cli.mjs');
    await writeFile(
      cli,
      `import{appendFileSync,writeFileSync}from'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(resolve(dir, 'calls.jsonl'))},JSON.stringify(args)+'\\n');if(args.includes('--wait')){console.error('before-cancel');setInterval(()=>{},1000);}else{writeFileSync(args.at(-1),'generated');console.log('done');}`
    );
    process.env.SPIKIVE_SPLAT_CLI = cli;
    const { buildOfficialSog, runSplatTransform } = await import(`./sog-build-lib.mjs?test=${Date.now()}`);
    const source = resolve(dir, 'source.ply');
    await writeFile(source, 'test-source');
    const config = {
      source,
      output: resolve(dir, 'out/lod-meta.json'),
      workDirectory: resolve(dir, 'levels'),
      levelCount: 3
    };
    await buildOfficialSog(config);
    await buildOfficialSog(config);
    let calls = (await readFile(resolve(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((a) => a.includes('--decimate')).length, 2);
    assert.ok(calls.every((a) => a.includes('--gpu') && a.includes('cpu')));
    assert.equal(calls.at(-1)[calls.at(-1).indexOf('--max-workers') + 1], '0');
    await writeFile(resolve(dir, 'levels/lod-1-67.ply'), 'corrupt');
    await buildOfficialSog(config);
    calls = (await readFile(resolve(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 6);
    const controller = new AbortController();
    const cancelled = runSplatTransform(['--wait'], {
      signal: controller.signal,
      logPath: resolve(dir, 'task.log'),
      onLog: () => controller.abort()
    });
    await assert.rejects(cancelled, (error) => error.code === 'CANCELLED');
    assert.match(await readFile(resolve(dir, 'task.log'), 'utf8'), /before-cancel/);
  } finally {
    if (original === undefined) delete process.env.SPIKIVE_SPLAT_CLI;
    else process.env.SPIKIVE_SPLAT_CLI = original;
    await rm(dir, { recursive: true, force: true });
  }
});
