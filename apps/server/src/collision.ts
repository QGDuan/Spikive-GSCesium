import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SurfaceHit, Vec3 } from "@spikive/shared";
import { add, distance, mul, normalize } from "@spikive/shared";

interface VoxelMetadata {
  version: string;
  coordinateFrame?: "tile_local_z_up";
  gridBounds: { min: number[]; max: number[] };
  sceneBounds: { min: number[]; max: number[] };
  voxelResolution: number;
  leafSize: number;
  treeDepth: number;
  nodeCount: number;
  leafDataCount: number;
}

const popcount = (value: number) => {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Runtime reader for splat-transform voxel format v1.x (Laine-Karras SVO). */
export class VoxelCollisionWorld {
  readonly metadata: VoxelMetadata;
  private readonly nodes: Uint32Array;
  private readonly leafData: Uint32Array;
  private readonly tileToStorage: (point: Vec3) => Vec3;
  private readonly storageToTile: (point: Vec3) => Vec3;

  private constructor(metadata: VoxelMetadata, binary: Buffer, transforms = identityTransforms) {
    this.metadata = metadata;
    this.tileToStorage = transforms.tileToStorage;
    this.storageToTile = transforms.storageToTile;
    const words = new Uint32Array(binary.buffer, binary.byteOffset, Math.floor(binary.byteLength / 4));
    this.nodes = words.slice(0, metadata.nodeCount);
    this.leafData = words.slice(metadata.nodeCount, metadata.nodeCount + metadata.leafDataCount);
  }

  static async load(jsonPath: string, legacySourceCoordinateSystem?: string) {
    const metadata = JSON.parse(await readFile(jsonPath, "utf8")) as VoxelMetadata;
    if (!metadata.version.startsWith("1.") || metadata.leafSize !== 4) throw new Error(`Unsupported voxel format ${metadata.version}`);
    const binaryPath = jsonPath.replace(/\.voxel\.json$/i, ".voxel.bin");
    const transforms = metadata.coordinateFrame === "tile_local_z_up"
      ? identityTransforms
      : legacyCoordinateTransforms(legacySourceCoordinateSystem);
    return new VoxelCollisionWorld(metadata, await readFile(binaryPath), transforms);
  }

  static fromArrays(metadata: VoxelMetadata, nodes: number[], leafData: number[] = []) {
    const words = new Uint32Array([...nodes, ...leafData]);
    return new VoxelCollisionWorld(metadata, Buffer.from(words.buffer));
  }

  get resolution() { return this.metadata.voxelResolution; }
  get byteLength() { return this.nodes.byteLength + this.leafData.byteLength; }
  get bounds() {
    return transformBounds({ min: arrayVec(this.metadata.gridBounds.min), max: arrayVec(this.metadata.gridBounds.max) }, this.storageToTile);
  }

  contains(point: Vec3) {
    return this.containsStorage(this.tileToStorage(point));
  }

  private containsStorage(point: Vec3) {
    const min = arrayVec(this.metadata.gridBounds.min); const max = arrayVec(this.metadata.gridBounds.max);
    return point.x >= min.x && point.y >= min.y && point.z >= min.z && point.x < max.x && point.y < max.y && point.z < max.z;
  }

  isOccupied(point: Vec3): boolean {
    return this.isOccupiedStorage(this.tileToStorage(point));
  }

  private isOccupiedStorage(point: Vec3): boolean {
    if (!this.containsStorage(point) || this.nodes.length === 0) return false;
    const min = arrayVec(this.metadata.gridBounds.min);
    const vx = Math.floor((point.x - min.x) / this.resolution);
    const vy = Math.floor((point.y - min.y) / this.resolution);
    const vz = Math.floor((point.z - min.z) / this.resolution);
    let bx = vx >> 2, by = vy >> 2, bz = vz >> 2;
    let nodeIndex = 0;
    for (let level = this.metadata.treeDepth; level > 0; level--) {
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

  sphereIsFree(point: Vec3, radius: number) {
    if (!this.contains(point)) return false;
    const step = this.resolution;
    // Treat every occupied voxel as a solid cube, not a zero-size sample at its center.
    const effectiveRadius = radius + step * Math.sqrt(3) / 2;
    const cells = Math.ceil(effectiveRadius / step);
    for (let z = -cells; z <= cells; z++) for (let y = -cells; y <= cells; y++) for (let x = -cells; x <= cells; x++) {
      const offsetDistance = Math.hypot(x * step, y * step, z * step);
      if (offsetDistance > effectiveRadius) continue;
      const sample = { x: point.x + x * step, y: point.y + y * step, z: point.z + z * step };
      if (!this.contains(sample) || this.isOccupied(sample)) return false;
    }
    return true;
  }

  segmentIsFree(from: Vec3, to: Vec3, radius: number) {
    // A full-voxel interval can miss a short diagonal crossing depending on
    // the segment's sampling phase. Half-voxel spacing makes the sweep
    // conservative relative to the voxel cube expansion in sphereIsFree and
    // keeps planning, subdivision and final revalidation phase-consistent.
    const count = Math.max(1, Math.ceil(distance(from, to) / (this.resolution * 0.5)));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
      if (!this.sphereIsFree(point, radius)) return false;
    }
    return true;
  }

  estimateClearance(point: Vec3, maximum: number) {
    if (!this.contains(point) || this.isOccupied(point)) return 0;
    for (let radius = this.resolution; radius <= maximum; radius += this.resolution) {
      const samples = 16;
      for (let i = 0; i < samples; i++) {
        const phi = Math.acos(1 - 2 * (i + 0.5) / samples);
        const theta = Math.PI * (1 + Math.sqrt(5)) * i;
        const sample = { x: point.x + radius * Math.sin(phi) * Math.cos(theta), y: point.y + radius * Math.sin(phi) * Math.sin(theta), z: point.z + radius * Math.cos(phi) };
        if (this.isOccupied(sample)) return radius;
      }
    }
    return maximum;
  }

  /** Return the first occupied collision voxel intersected by a model-local ray. */
  raycast(origin: Vec3, direction: Vec3, maxDistance = Number.POSITIVE_INFINITY): SurfaceHit | null {
    const unitDirection = normalize(direction);
    if (!unitDirection) return null;
    const interval = intersectRayBounds(origin, unitDirection, this.bounds);
    if (!interval) return null;
    const start = Math.max(0, interval.start);
    const end = Math.min(interval.end, maxDistance);
    if (end < start) return null;

    // Half a voxel guarantees that an occupied cell cannot be skipped even
    // when the ray is diagonal to all three grid axes.
    const step = this.resolution * 0.5;
    // A filled collision volume may contain the camera. Returning that first
    // occupied sample would create a false label at the camera. In that case,
    // leave the initial solid first and only accept a later free-to-solid hit.
    let waitingToExitInitialSolid = this.contains(origin) && this.isOccupied(origin);
    for (let value = start + step * 0.05; value <= end; value += step) {
      const point = add(origin, mul(unitDirection, value));
      const occupied = this.isOccupied(point);
      if (waitingToExitInitialSolid) {
        if (!occupied) waitingToExitInitialSolid = false;
        continue;
      }
      if (!occupied) continue;
      const normal = this.occupancyGradient(point) ?? this.voxelEntryFaceNormal(point, unitDirection);
      // The fallback is the actual face through which this free-to-solid ray
      // entered the occupied voxel. It handles isolated thin features whose
      // symmetric central occupancy gradient legitimately cancels to zero.
      return { position: point, normal, distance: value };
    }
    return null;
  }

  snapSurface(point: Vec3, maxDistance = this.resolution * 3): SurfaceHit | null {
    const cells = Math.ceil(maxDistance / this.resolution);
    let best: Vec3 | null = null;
    let bestNormal: Vec3 | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let z = -cells; z <= cells; z++) for (let y = -cells; y <= cells; y++) for (let x = -cells; x <= cells; x++) {
      const candidate = { x: point.x + x * this.resolution, y: point.y + y * this.resolution, z: point.z + z * this.resolution };
      if (!this.isOccupied(candidate)) continue;
      const normal = this.occupancyGradient(candidate);
      if (!normal) continue;
      const d = distance(point, candidate);
      if (d < bestDistance) { best = candidate; bestNormal = normal; bestDistance = d; }
    }
    if (!best || !bestNormal) return null;
    return { position: best, normal: bestNormal, distance: bestDistance };
  }

  validateSurfaceNormal(point: Vec3, normal: Vec3): SurfaceHit | null {
    const unit = normalize(normal);
    if (!unit || !this.contains(point) || !this.isOccupied(point)) return null;
    const outside = add(point, mul(unit, this.resolution));
    if (!this.contains(outside) || this.isOccupied(outside)) return null;
    return { position: point, normal: unit, distance: 0 };
  }

  private occupancyGradient(point: Vec3) {
    const r = this.resolution;
    return normalize({
      x: Number(this.isOccupied(add(point, { x: -r, y: 0, z: 0 }))) - Number(this.isOccupied(add(point, { x: r, y: 0, z: 0 }))),
      y: Number(this.isOccupied(add(point, { x: 0, y: -r, z: 0 }))) - Number(this.isOccupied(add(point, { x: 0, y: r, z: 0 }))),
      z: Number(this.isOccupied(add(point, { x: 0, y: 0, z: -r }))) - Number(this.isOccupied(add(point, { x: 0, y: 0, z: r })))
    });
  }

  private voxelEntryFaceNormal(point: Vec3, direction: Vec3): Vec3 {
    const min = arrayVec(this.metadata.gridBounds.min);
    let bestDistance = Number.POSITIVE_INFINITY;
    let best: Vec3 = mul(direction, -1);
    for (const axis of ["x", "y", "z"] as const) {
      const component = direction[axis];
      if (Math.abs(component) < 1e-12) continue;
      const cell = Math.floor((point[axis] - min[axis]) / this.resolution);
      const lower = min[axis] + cell * this.resolution;
      const upper = lower + this.resolution;
      const backwards = component > 0
        ? (point[axis] - lower) / component
        : (upper - point[axis]) / -component;
      if (backwards >= bestDistance) continue;
      bestDistance = backwards;
      best = { x: 0, y: 0, z: 0 };
      best[axis] = component > 0 ? -1 : 1;
    }
    return best;
  }
}

export class CollisionRepository {
  private readonly cache = new Map<string, VoxelCollisionWorld>();
  private readonly inFlight = new Map<string, Promise<VoxelCollisionWorld>>();
  private readonly generations = new Map<string, number>();
  private cacheBytes = 0;
  constructor(private readonly publishedDir: string, private readonly maximumCacheBytes = 512 * 1024 ** 2) {}
  get stats() { return { entries: this.cache.size, bytes: this.cacheBytes, maximumBytes: this.maximumCacheBytes }; }
  async get(datasetId: string) {
    const existing = this.cache.get(datasetId);
    if (existing) {
      this.cache.delete(datasetId);
      this.cache.set(datasetId, existing);
      return existing;
    }
    const pending = this.inFlight.get(datasetId);
    if (pending) return pending;
    const generation = this.generations.get(datasetId) ?? 0;
    const load = this.load(datasetId).then(world => {
      if ((this.generations.get(datasetId) ?? 0) !== generation) return world;
      this.cache.set(datasetId, world);
      this.cacheBytes += world.byteLength;
      this.trim();
      return world;
    });
    this.inFlight.set(datasetId, load);
    try {
      return await load;
    } finally {
      if (this.inFlight.get(datasetId) === load) this.inFlight.delete(datasetId);
    }
  }
  invalidate(datasetId: string) {
    const existing = this.cache.get(datasetId);
    if (existing) this.cacheBytes -= existing.byteLength;
    this.cache.delete(datasetId);
    this.inFlight.delete(datasetId);
    this.generations.set(datasetId, (this.generations.get(datasetId) ?? 0) + 1);
  }
  private async load(datasetId: string) {
    const jsonPath = path.join(this.publishedDir, datasetId, "collision", "scene.voxel.json");
    const metadata = JSON.parse(await readFile(jsonPath, "utf8")) as Pick<VoxelMetadata, "coordinateFrame">;
    if (metadata.coordinateFrame === "tile_local_z_up") return VoxelCollisionWorld.load(jsonPath);

    // Frozen releases wrote collision data before coordinateFrame was embedded
    // in the voxel metadata. Keep that read-only compatibility path, but never
    // make a new AHoLo dataset depend on the retired visual artifact directory.
    const summary = JSON.parse(await readFile(path.join(this.publishedDir, datasetId, "tiles", "build_summary.json"), "utf8")) as { source_coordinate_system?: string };
    return VoxelCollisionWorld.load(jsonPath, summary.source_coordinate_system);
  }
  private trim() {
    while (this.cacheBytes > this.maximumCacheBytes && this.cache.size > 1) {
      const oldestId = this.cache.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.cache.get(oldestId)!;
      this.cache.delete(oldestId);
      this.cacheBytes -= oldest.byteLength;
    }
  }
}

const arrayVec = (value: number[]): Vec3 => ({ x: value[0] ?? 0, y: value[1] ?? 0, z: value[2] ?? 0 });

const identityTransforms = {
  tileToStorage: (point: Vec3): Vec3 => ({ ...point }),
  storageToTile: (point: Vec3): Vec3 => ({ ...point })
};

function legacyCoordinateTransforms(sourceCoordinateSystem?: string) {
  if (sourceCoordinateSystem === "camera_y_down_z_forward" || sourceCoordinateSystem === "gltf_y_up") {
    const transform = (point: Vec3): Vec3 => ({ x: -point.x, y: point.y, z: -point.z });
    return { tileToStorage: transform, storageToTile: transform };
  }
  if (sourceCoordinateSystem === "z_up") {
    const transform = (point: Vec3): Vec3 => ({ x: -point.x, y: -point.y, z: point.z });
    return { tileToStorage: transform, storageToTile: transform };
  }
  throw new Error(`旧碰撞体缺少可识别的源坐标系：${sourceCoordinateSystem ?? "未提供"}`);
}

function transformBounds(bounds: { min: Vec3; max: Vec3 }, transform: (point: Vec3) => Vec3) {
  const points: Vec3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) points.push(transform({ x, y, z }));
  return {
    min: { x: Math.min(...points.map(point => point.x)), y: Math.min(...points.map(point => point.y)), z: Math.min(...points.map(point => point.z)) },
    max: { x: Math.max(...points.map(point => point.x)), y: Math.max(...points.map(point => point.y)), z: Math.max(...points.map(point => point.z)) }
  };
}

function intersectRayBounds(origin: Vec3, direction: Vec3, bounds: { min: Vec3; max: Vec3 }) {
  let start = Number.NEGATIVE_INFINITY;
  let end = Number.POSITIVE_INFINITY;
  for (const axis of ["x", "y", "z"] as const) {
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
}
