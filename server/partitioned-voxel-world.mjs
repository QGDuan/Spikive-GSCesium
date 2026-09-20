import { openSync, closeSync, readSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { safePath } from '../scripts/build-support.mjs';
import { VoxelWorld, PLY_SOURCE_TO_VOXEL_IDENTITY } from './voxel-world.mjs';

const PAGE_BYTES = 64 * 1024;
export class VoxelPageCache {
  constructor(maximumBytes = 256 * 1024 ** 2) {
    this.limit = maximumBytes;
    this.bytes = 0;
    this.pages = new Map();
    this.files = new Map();
  }
  file(path) {
    let fd = this.files.get(path);
    if (fd !== undefined) this.files.delete(path);
    else fd = openSync(path, 'r');
    this.files.set(path, fd);
    if (this.files.size > 64) {
      const [name, old] = this.files.entries().next().value;
      closeSync(old);
      this.files.delete(name);
    }
    return fd;
  }
  word(path, offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 4) throw new Error('体素分页偏移无效。');
    const pageOffset = Math.floor(offset / PAGE_BYTES) * PAGE_BYTES;
    const key = `${path}:${pageOffset}`;
    let data = this.pages.get(key);
    if (data) this.pages.delete(key);
    else {
      const size = Math.min(PAGE_BYTES, statSync(path).size - pageOffset);
      if (size <= 0) throw new Error('体素分页文件已截断。');
      data = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const n = readSync(this.file(path), data, read, size - read, pageOffset + read);
        if (!n) throw new Error('体素分页读取不完整。');
        read += n;
      }
      this.bytes += size;
    }
    this.pages.set(key, data);
    while (this.bytes > this.limit && this.pages.size > 1) {
      const [old, page] = this.pages.entries().next().value;
      this.bytes -= page.length;
      this.pages.delete(old);
    }
    if (offset - pageOffset + 4 > data.length) throw new Error('体素节点引用越界。');
    return data.readUInt32LE(offset - pageOffset);
  }
  close() {
    for (const fd of this.files.values()) closeSync(fd);
    this.files.clear();
    this.pages.clear();
    this.bytes = 0;
  }
}
const wordView = (cache, path, offset, length) =>
  new Proxy(
    { length },
    {
      get(target, key) {
        if (key === 'length') return length;
        if (typeof key !== 'string' || !/^\d+$/.test(key)) return target[key];
        const index = Number(key);
        if (index >= length) throw new Error('体素树引用越界，停止碰撞查询。');
        return cache.word(path, offset + index * 4);
      }
    }
  );
const checkHash = (path, digest) => {
  if (!digest) throw new Error('体素分区缺少文件校验值。');
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(PAGE_BYTES);
  try {
    let n;
    while ((n = readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  if (hash.digest('hex') !== digest) throw new Error('体素分区文件损坏，请重新计算；禁止使用损坏数据规划。');
};
const setupFrame = (world, bounds, coordinateTransform) => {
  world.coordinateTransform = coordinateTransform;
  world.voxelBounds = {
    min: Object.fromEntries(['x', 'y', 'z'].map((a, i) => [a, bounds.min[i]])),
    max: Object.fromEntries(['x', 'y', 'z'].map((a, i) => [a, bounds.max[i]]))
  };
  const b = world.voxelBounds;
  world.bounds =
    coordinateTransform === PLY_SOURCE_TO_VOXEL_IDENTITY
      ? { min: { x: -b.max.x, y: -b.max.y, z: b.min.z }, max: { x: -b.min.x, y: -b.min.y, z: b.max.z } }
      : b;
};
const pagedWorld = (jsonPath, cache, coordinateTransform = 'identity') => {
  const m = JSON.parse(readFileSync(jsonPath, 'utf8'));
  if (
    m.version !== '1.1' ||
    m.leafSize !== 4 ||
    !Number.isSafeInteger(m.nodeCount) ||
    m.nodeCount < 0 ||
    (m.nodeCount === 0 && (m.leafDataCount !== 0 || m.numInteriorNodes !== 0 || m.numMixedLeaves !== 0)) ||
    !Number.isSafeInteger(m.leafDataCount) ||
    m.leafDataCount < 0 ||
    !Number.isInteger(m.treeDepth) ||
    m.treeDepth < 1 ||
    m.treeDepth > 17 ||
    !Number.isFinite(m.voxelResolution) ||
    m.voxelResolution <= 0 ||
    !m.gridBounds?.min?.every(
      (v, a) => Number.isFinite(v) && Number.isFinite(m.gridBounds.max[a]) && v < m.gridBounds.max[a]
    )
  )
    throw new Error('体素格式无效。');
  const binPath = jsonPath.replace(/\.voxel\.json$/, '.voxel.bin');
  if (statSync(binPath).size !== (m.nodeCount + m.leafDataCount) * 4) throw new Error('体素二进制长度无效。');
  const world = Object.create(VoxelWorld.prototype);
  world.metadata = m;
  world.nodes = wordView(cache, binPath, 0, m.nodeCount);
  world.leafData = wordView(cache, binPath, m.nodeCount * 4, m.leafDataCount);
  setupFrame(world, m.gridBounds, coordinateTransform);
  return world;
};

export class PartitionedVoxelWorld extends VoxelWorld {
  constructor(manifest, directory, { cacheBytes = 256 * 1024 ** 2 } = {}) {
    super(
      {
        version: '1.1',
        leafSize: 4,
        nodeCount: 1,
        leafDataCount: 0,
        treeDepth: 1,
        gridBounds: manifest.queryBounds ?? manifest.gridBounds,
        voxelResolution: manifest.options.voxelSize
      },
      Buffer.alloc(4)
    );
    if (manifest.schemaVersion !== 2 || !manifest.complete) throw new Error('碰撞分区未完整发布。');
    this.manifest = manifest;
    this.directory = directory;
    this.cache = new VoxelPageCache(cacheBytes);
    this.worlds = new Map();
    setupFrame(this, manifest.queryBounds ?? manifest.gridBounds, PLY_SOURCE_TO_VOXEL_IDENTITY);
    this.index = new DatabaseSync(':memory:');
    this.index.exec('CREATE VIRTUAL TABLE boxes USING rtree(id,a,b,c,d,e,f)');
    const add = this.index.prepare('INSERT INTO boxes VALUES(?,?,?,?,?,?,?)');
    this.index.exec('BEGIN');
    manifest.partitions.forEach((p, i) =>
      add.run(i, p.core.min[0], p.core.max[0], p.core.min[1], p.core.max[1], p.core.min[2], p.core.max[2])
    );
    this.index.exec('COMMIT');
    this.query = this.index.prepare(
      'SELECT id FROM boxes WHERE a<=? AND b>=? AND c<=? AND d>=? AND e<=? AND f>=?'
    );
  }
  owner(block) {
    const contains = (p) =>
      p && [0, 1, 2].every((a) => block[a] >= p.core.min[a] && block[a] < p.core.max[a]);
    if (contains(this.lastOwner)) return this.lastOwner;
    const hits = this.query.all(block[0], block[0], block[1], block[1], block[2], block[2]);
    const parts = hits.map(({ id }) => this.manifest.partitions[id]).filter(contains);
    if (parts.length !== 1) throw new Error('碰撞分区缺失或重叠，停止规划。');
    return (this.lastOwner = parts[0]);
  }
  isOccupiedVoxel(vx, vy, vz) {
    const min = this.voxelBounds.min;
    const h = this.resolution;
    const p = { x: min.x + (vx + 0.5) * h, y: min.y + (vy + 0.5) * h, z: min.z + (vz + 0.5) * h };
    if (!this.containsVoxelPoint(p)) return true;
    const owner = this.owner([p.x, p.y, p.z].map((v) => Math.floor(v / (4 * h))));
    if (owner.empty) return false;
    let world = this.worlds.get(owner.id);
    if (!world) {
      if (!owner.checksums?.[owner.file] || !owner.checksums?.[owner.file.replace('.json', '.bin')])
        throw new Error('体素分区缺少必要校验值，停止规划。');
      for (const [path, digest] of Object.entries(owner.checksums))
        checkHash(safePath(this.directory, path), digest);
      world = pagedWorld(safePath(this.directory, owner.file), this.cache);
      this.worlds.set(owner.id, world);
    }
    // Official output crops empty padding; the complete owner certifies that padding as empty.
    return world.isOccupied(p);
  }
  close() {
    this.cache.close();
    this.index.close();
    this.worlds.clear();
  }
}

export const openCollisionWorld = (directory, { manifestSha256 } = {}) => {
  const manifestPath = safePath(directory, 'collision-manifest.json');
  if (manifestSha256) checkHash(manifestPath, manifestSha256);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion === 2) return new PartitionedVoxelWorld(manifest, directory);
  const cache = new VoxelPageCache();
  for (const [path, digest] of Object.entries(manifest.checksums ?? {})) {
    if (path === 'scene.voxel.json' || path === 'scene.voxel.bin')
      checkHash(safePath(directory, path), digest);
  }
  const world = pagedWorld(safePath(directory, 'scene.voxel.json'), cache, PLY_SOURCE_TO_VOXEL_IDENTITY);
  world.close = () => cache.close();
  return world;
};
