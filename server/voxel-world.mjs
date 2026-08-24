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
const distance = (from, to) => Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);

// splat-transform labels PLY inputs with its PLY coordinate convention: a
// 180-degree rotation around Z. Streamed SOG remains in that source PLY frame,
// while voxel output is baked into the tool's identity frame. The platform's
// persisted domain coordinates intentionally follow the displayed source PLY,
// so SVO queries need this rigid, self-inverse adapter at the storage boundary.
export const PLY_SOURCE_TO_VOXEL_IDENTITY = 'ply-source-to-voxel-identity-z180';

const rotateZ180 = (point) => ({ x: -point.x, y: -point.y, z: point.z });
const negateWithoutNegativeZero = (value) => value === 0 ? 0 : -value;
const transformBounds = (bounds, coordinateTransform) => {
  if (coordinateTransform !== PLY_SOURCE_TO_VOXEL_IDENTITY) return bounds;
  return {
    min: {
      x: negateWithoutNegativeZero(bounds.max.x),
      y: negateWithoutNegativeZero(bounds.max.y),
      z: bounds.min.z
    },
    max: {
      x: negateWithoutNegativeZero(bounds.min.x),
      y: negateWithoutNegativeZero(bounds.min.y),
      z: bounds.max.z
    }
  };
};

/** Read-only runtime query for splat-transform voxel format v1.1. */
export class VoxelWorld {
  constructor(metadata, binary, { coordinateTransform = 'identity' } = {}) {
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
    this.coordinateTransform = coordinateTransform;
    this.voxelBounds = {
      min: arrayVector(metadata.gridBounds.min),
      max: arrayVector(metadata.gridBounds.max)
    };
    this.bounds = transformBounds(this.voxelBounds, coordinateTransform);
  }

  static async load(jsonPath, options) {
    const metadata = JSON.parse(await readFile(jsonPath, 'utf8'));
    const binaryPath = jsonPath.replace(/\.voxel\.json$/i, '.voxel.bin');
    return new VoxelWorld(metadata, await readFile(binaryPath), options);
  }

  get byteLength() {
    return this.nodes.byteLength + this.leafData.byteLength;
  }

  get resolution() {
    return this.metadata.voxelResolution;
  }

  toVoxelPoint(point) {
    return this.coordinateTransform === PLY_SOURCE_TO_VOXEL_IDENTITY ? rotateZ180(point) : point;
  }

  containsVoxelPoint(point) {
    const { min, max } = this.voxelBounds;
    return point.x >= min.x && point.y >= min.y && point.z >= min.z &&
      point.x < max.x && point.y < max.y && point.z < max.z;
  }

  contains(point) {
    return this.containsVoxelPoint(this.toVoxelPoint(point));
  }

  isOccupied(point) {
    const voxelPoint = this.toVoxelPoint(point);
    if (!this.containsVoxelPoint(voxelPoint) || this.nodes.length === 0) return false;
    const { min } = this.voxelBounds;
    const resolution = this.resolution;
    const vx = Math.floor((voxelPoint.x - min.x) / resolution);
    const vy = Math.floor((voxelPoint.y - min.y) / resolution);
    const vz = Math.floor((voxelPoint.z - min.z) / resolution);
    return this.isOccupiedVoxel(vx, vy, vz);
  }

  isOccupiedVoxel(vx, vy, vz) {
    if (vx < 0 || vy < 0 || vz < 0 || this.nodes.length === 0) return false;
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

  /** Conservative sphere-vs-occupied-voxel-cube query in local Z-up meters. */
  sphereIsFree(point, radius) {
    const voxelPoint = this.toVoxelPoint(point);
    if (!Number.isFinite(radius) || radius < 0 || !this.containsVoxelPoint(voxelPoint)) return false;
    const { min, max } = this.voxelBounds;
    if (voxelPoint.x - radius < min.x || voxelPoint.y - radius < min.y || voxelPoint.z - radius < min.z ||
        voxelPoint.x + radius >= max.x || voxelPoint.y + radius >= max.y || voxelPoint.z + radius >= max.z) return false;
    if (radius === 0) {
      const vx = Math.floor((voxelPoint.x - min.x) / this.resolution);
      const vy = Math.floor((voxelPoint.y - min.y) / this.resolution);
      const vz = Math.floor((voxelPoint.z - min.z) / this.resolution);
      return !this.isOccupiedVoxel(vx, vy, vz);
    }
    const step = this.resolution;
    const firstX = Math.floor((voxelPoint.x - radius - min.x) / step);
    const firstY = Math.floor((voxelPoint.y - radius - min.y) / step);
    const firstZ = Math.floor((voxelPoint.z - radius - min.z) / step);
    const lastX = Math.floor((voxelPoint.x + radius - min.x) / step);
    const lastY = Math.floor((voxelPoint.y + radius - min.y) / step);
    const lastZ = Math.floor((voxelPoint.z + radius - min.z) / step);
    const radiusSquared = radius * radius;
    for (let vz = firstZ; vz <= lastZ; vz += 1) {
      for (let vy = firstY; vy <= lastY; vy += 1) {
        for (let vx = firstX; vx <= lastX; vx += 1) {
          if (!this.isOccupiedVoxel(vx, vy, vz)) continue;
          const cellMinX = min.x + vx * step;
          const cellMinY = min.y + vy * step;
          const cellMinZ = min.z + vz * step;
          const nearestX = Math.max(cellMinX, Math.min(voxelPoint.x, cellMinX + step));
          const nearestY = Math.max(cellMinY, Math.min(voxelPoint.y, cellMinY + step));
          const nearestZ = Math.max(cellMinZ, Math.min(voxelPoint.z, cellMinZ + step));
          const dx = voxelPoint.x - nearestX;
          const dy = voxelPoint.y - nearestY;
          const dz = voxelPoint.z - nearestZ;
          if (dx * dx + dy * dy + dz * dz <= radiusSquared) return false;
        }
      }
    }
    return true;
  }

  /** Phase-stable swept sphere; endpoints and every half-voxel interval use the same rule. */
  segmentIsFree(from, to, radius) {
    const count = Math.max(1, Math.ceil(distance(from, to) / (this.resolution * 0.5)));
    for (let index = 0; index <= count; index += 1) {
      const t = index / count;
      if (!this.sphereIsFree({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t
      }, radius)) return false;
    }
    return true;
  }

  estimateClearance(point, maximum) {
    if (!this.contains(point) || this.isOccupied(point)) return 0;
    for (let radius = this.resolution; radius <= maximum; radius += this.resolution) {
      for (let index = 0; index < 24; index += 1) {
        const phi = Math.acos(1 - 2 * (index + 0.5) / 24);
        const theta = Math.PI * (1 + Math.sqrt(5)) * index;
        const sample = {
          x: point.x + radius * Math.sin(phi) * Math.cos(theta),
          y: point.y + radius * Math.sin(phi) * Math.sin(theta),
          z: point.z + radius * Math.cos(phi)
        };
        if (!this.contains(sample) || this.isOccupied(sample)) return radius;
      }
    }
    return maximum;
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
  constructor(maximumBytes = 512 * 1024 ** 2, worldOptions = {}) {
    this.maximumBytes = maximumBytes;
    this.worldOptions = worldOptions;
    this.cache = new Map();
    this.inFlight = new Map();
    this.datasetEpoch = new Map();
    this.bytes = 0;
  }

  async get(key, jsonPath) {
    const datasetId = key.split(':', 1)[0];
    const epoch = this.datasetEpoch.get(datasetId) ?? 0;
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.cache.set(key, existing);
      return existing;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const load = VoxelWorld.load(jsonPath, this.worldOptions).then((world) => {
      if ((this.datasetEpoch.get(datasetId) ?? 0) !== epoch) return world;
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
    this.datasetEpoch.set(datasetId, (this.datasetEpoch.get(datasetId) ?? 0) + 1);
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
