import { readFile } from 'node:fs/promises';

const popcount = (input) => {
  let value = input >>> 0;
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

const normalize = (value) => {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(length) || length < 1e-12) return null;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
};

const intersectRayBounds = (origin, direction, bounds) => {
  let start = Number.NEGATIVE_INFINITY;
  let end = Number.POSITIVE_INFINITY;
  for (const axis of ['x', 'y', 'z']) {
    const component = direction[axis];
    if (Math.abs(component) < 1e-12) {
      if (origin[axis] < bounds.min[axis] || origin[axis] >= bounds.max[axis]) return null;
      continue;
    }
    let first = (bounds.min[axis] - origin[axis]) / component;
    let second = (bounds.max[axis] - origin[axis]) / component;
    if (first > second) [first, second] = [second, first];
    start = Math.max(start, first);
    end = Math.min(end, second);
    if (end < start) return null;
  }
  return { start, end };
};

const arrayVector = (value) => ({ x: value[0], y: value[1], z: value[2] });

/** Read-only runtime query for splat-transform voxel format v1.1. */
export class VoxelWorld {
  constructor(metadata, binary) {
    if (metadata.version !== '1.1' || metadata.leafSize !== 4) {
      throw new Error(`不支持的体素格式：${metadata.version ?? '未知'}`);
    }
    const words = new Uint32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4);
    if (words.length !== metadata.nodeCount + metadata.leafDataCount) {
      throw new Error('体素二进制长度与元数据不一致。');
    }
    this.metadata = metadata;
    this.nodes = words.slice(0, metadata.nodeCount);
    this.leafData = words.slice(metadata.nodeCount);
    this.bounds = {
      min: arrayVector(metadata.gridBounds.min),
      max: arrayVector(metadata.gridBounds.max)
    };
  }

  static async load(jsonPath) {
    const metadata = JSON.parse(await readFile(jsonPath, 'utf8'));
    const binaryPath = jsonPath.replace(/\.voxel\.json$/i, '.voxel.bin');
    return new VoxelWorld(metadata, await readFile(binaryPath));
  }

  get byteLength() {
    return this.nodes.byteLength + this.leafData.byteLength;
  }

  contains(point) {
    const { min, max } = this.bounds;
    return point.x >= min.x && point.y >= min.y && point.z >= min.z &&
      point.x < max.x && point.y < max.y && point.z < max.z;
  }

  isOccupied(point) {
    if (!this.contains(point) || this.nodes.length === 0) return false;
    const { min } = this.bounds;
    const resolution = this.metadata.voxelResolution;
    const vx = Math.floor((point.x - min.x) / resolution);
    const vy = Math.floor((point.y - min.y) / resolution);
    const vz = Math.floor((point.z - min.z) / resolution);
    const bx = vx >> 2;
    const by = vy >> 2;
    const bz = vz >> 2;
    let nodeIndex = 0;

    for (let level = this.metadata.treeDepth; level > 0; level -= 1) {
      const word = this.nodes[nodeIndex];
      if (word === undefined) return false;
      if (word === 0xff000000) return true;
      const mask = word >>> 24;
      const base = word & 0x00ffffff;
      const bit = level - 1;
      const octant = ((bx >> bit) & 1) | (((by >> bit) & 1) << 1) | (((bz >> bit) & 1) << 2);
      if ((mask & (1 << octant)) === 0) return false;
      nodeIndex = base + popcount(mask & ((1 << octant) - 1));
    }

    const leaf = this.nodes[nodeIndex];
    if (leaf === undefined) return false;
    if (leaf === 0xff000000) return true;
    const leafIndex = leaf & 0x00ffffff;
    const voxelBit = (vx & 3) | ((vy & 3) << 2) | ((vz & 3) << 4);
    const word = this.leafData[leafIndex * 2 + (voxelBit >= 32 ? 1 : 0)] ?? 0;
    return ((word >>> (voxelBit & 31)) & 1) === 1;
  }

  /** First free-to-occupied hit. Normal calculation is intentionally deferred. */
  raycast(origin, direction, maxDistance = 100_000) {
    const unitDirection = normalize(direction);
    if (!unitDirection) return null;
    const interval = intersectRayBounds(origin, unitDirection, this.bounds);
    if (!interval) return null;
    const start = Math.max(0, interval.start);
    const end = Math.min(interval.end, maxDistance);
    if (end < start) return null;

    const step = this.metadata.voxelResolution * 0.5;
    let waitingToExitInitialSolid = this.contains(origin) && this.isOccupied(origin);
    for (let distance = start + step * 0.05; distance <= end; distance += step) {
      const point = {
        x: origin.x + unitDirection.x * distance,
        y: origin.y + unitDirection.y * distance,
        z: origin.z + unitDirection.z * distance
      };
      const occupied = this.isOccupied(point);
      if (waitingToExitInitialSolid) {
        if (!occupied) waitingToExitInitialSolid = false;
        continue;
      }
      if (occupied) return { position: point, distance };
    }
    return null;
  }
}

export class VoxelWorldRepository {
  constructor(maximumBytes = 512 * 1024 ** 2) {
    this.maximumBytes = maximumBytes;
    this.cache = new Map();
    this.inFlight = new Map();
    this.bytes = 0;
  }

  async get(key, jsonPath) {
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.cache.set(key, existing);
      return existing;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const load = VoxelWorld.load(jsonPath).then((world) => {
      this.cache.set(key, world);
      this.bytes += world.byteLength;
      this.trim();
      return world;
    });
    this.inFlight.set(key, load);
    try {
      return await load;
    } finally {
      if (this.inFlight.get(key) === load) this.inFlight.delete(key);
    }
  }

  invalidateDataset(datasetId) {
    for (const [key, world] of this.cache) {
      if (!key.startsWith(`${datasetId}:`)) continue;
      this.cache.delete(key);
      this.bytes -= world.byteLength;
    }
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(`${datasetId}:`)) this.inFlight.delete(key);
    }
  }

  trim() {
    while (this.bytes > this.maximumBytes && this.cache.size > 1) {
      const oldestKey = this.cache.keys().next().value;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      this.bytes -= oldest.byteLength;
    }
  }
}
