import { randomUUID } from 'node:crypto';

const MAX_WAYPOINTS = 5_000;
const MAX_ASTAR_EXPANSIONS = 150_000;
export const TAKEOFF_HEIGHT_METERS = 1.5;
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a, value) => ({ x: a.x * value, y: a.y * value, z: a.z * value });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const normalize = (value) => {
  const length = Math.hypot(value.x, value.y, value.z);
  return length > 1e-12 ? mul(value, 1 / length) : null;
};
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});

class MinQueue {
  constructor() { this.values = []; }
  get size() { return this.values.length; }
  push(value) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].f <= value.f) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }
  pop() {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right].f < this.values[left].f ? right : left;
      if (this.values[child].f >= last.f) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

const lookAt = (from, to) => {
  const delta = sub(to, from);
  return {
    yaw: Math.atan2(delta.x, delta.y) * 180 / Math.PI,
    pitch: Math.atan2(delta.z, Math.hypot(delta.x, delta.y)) * 180 / Math.PI
  };
};

const observationDirections = (normal) => {
  const reference = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const tangent = normalize(cross(reference, normal));
  if (!tangent) return [normal];
  const bitangent = cross(normal, tangent);
  const result = [normal];
  for (const tiltDegrees of [12, 24, 36]) {
    const tilt = tiltDegrees * Math.PI / 180;
    for (let index = 0; index < 12; index += 1) {
      const azimuth = index * Math.PI * 2 / 12;
      const radial = add(mul(tangent, Math.cos(azimuth)), mul(bitangent, Math.sin(azimuth)));
      const direction = normalize(add(mul(normal, Math.cos(tilt)), mul(radial, Math.sin(tilt))));
      if (direction) result.push(direction);
    }
  }
  return result;
};

const findOutsideSurface = (position, normal, collision) => {
  const step = collision.resolution * 0.5;
  const maximum = collision.resolution * 4;
  for (let distanceFromSurface = step; distanceFromSurface <= maximum + 1e-12; distanceFromSurface += step) {
    const point = add(position, mul(normal, distanceFromSurface));
    if (collision.sphereIsFree(point, 0)) return point;
  }
  return null;
};

const chooseObservationPoint = (label, previous, profile, collision) => {
  const normal = normalize(label.normal);
  if (!normal) return null;
  // A Picker point lies on the rendered front surface, while conservative SVO
  // voxelization can occupy several samples around that surface. End LOS at the
  // first free sample on the persisted outward-normal side, within four voxels;
  // never skip through an arbitrarily thick solid.
  const outsideSurface = findOutsideSurface(label.position, normal, collision);
  if (!outsideSurface) return null;
  const candidates = [];
  const directions = observationDirections(normal);
  for (const factor of [1, 1.15, 1.3, 1.5]) {
    for (const direction of directions) {
      const point = add(label.position, mul(direction, profile.observationDistance * factor));
      if (!collision.sphereIsFree(point, profile.inflationRadius)) continue;
      if (!collision.segmentIsFree(point, outsideSurface, 0)) continue;
      const alignment = direction.x * normal.x + direction.y * normal.y + direction.z * normal.z;
      candidates.push({
        point,
        score: alignment * 100 - distance(previous, point) - (factor - 1) * profile.observationDistance
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.point ?? null;
};

const chooseTakeoffPoint = (label, profile, collision) => {
  const direction = normalize(label.normal);
  if (!direction) return null;
  const point = add(label.position, mul(direction, TAKEOFF_HEIGHT_METERS));
  if (!collision.sphereIsFree(point, profile.inflationRadius)) return null;
  // Ignore only the launch surface itself. Above that small allowance, the
  // complete vertical climb must pass the same inflated sweep as every leg.
  const surfaceAllowance = Math.min(
    TAKEOFF_HEIGHT_METERS,
    profile.inflationRadius + collision.resolution * 1.5
  );
  const corridorStart = add(label.position, mul(direction, surfaceAllowance));
  return collision.segmentIsFree(corridorStart, point, profile.inflationRadius) ? point : null;
};

const smoothPath = (points, radius, collision) => {
  const result = [points[0]];
  let index = 0;
  while (index < points.length - 1) {
    let next = points.length - 1;
    while (next > index + 1 && !collision.segmentIsFree(points[index], points[next], radius)) next -= 1;
    result.push(points[next]);
    index = next;
  }
  return result;
};

export const findCollisionAwarePath = (
  start,
  goal,
  radius,
  collision,
  { maximumExpansions = MAX_ASTAR_EXPANSIONS } = {}
) => {
  const expansionLimit = Number.isInteger(maximumExpansions) && maximumExpansions > 0
    ? maximumExpansions
    : MAX_ASTAR_EXPANSIONS;
  if (!collision.sphereIsFree(start, radius) || !collision.sphereIsFree(goal, radius)) {
    return { status: 'blocked-endpoint', path: null, expansions: 0, expansionLimit };
  }
  if (collision.segmentIsFree(start, goal, radius)) {
    return { status: 'found', path: [start, goal], expansions: 0, expansionLimit };
  }
  const step = Math.max(collision.resolution, radius / 2, 0.25);
  const padding = Math.max(radius * 6, distance(start, goal) * 0.5, 2);
  const origin = {
    x: Math.min(start.x, goal.x) - padding,
    y: Math.min(start.y, goal.y) - padding,
    z: Math.min(start.z, goal.z) - padding
  };
  const toGrid = (point) => ({
    x: Math.round((point.x - origin.x) / step),
    y: Math.round((point.y - origin.y) / step),
    z: Math.round((point.z - origin.z) / step)
  });
  const toWorld = (point) => ({ x: origin.x + point.x * step, y: origin.y + point.y * step, z: origin.z + point.z * step });
  const maximum = toGrid({
    x: Math.max(start.x, goal.x) + padding,
    y: Math.max(start.y, goal.y) + padding,
    z: Math.max(start.z, goal.z) + padding
  });
  const startGrid = toGrid(start);
  const goalGrid = toGrid(goal);
  const keyOf = (point) => `${point.x},${point.y},${point.z}`;
  const startKey = keyOf(startGrid);
  const open = new Map();
  const closed = new Map();
  const queue = new MinQueue();
  const startNode = { point: startGrid, key: startKey, g: 0, f: distance(startGrid, goalGrid), parent: null };
  open.set(startKey, startNode);
  queue.push(startNode);
  let expansions = 0;
  while (queue.size && expansions < expansionLimit) {
    let current;
    while (queue.size) {
      const entry = queue.pop();
      const candidate = open.get(entry.key);
      if (candidate && candidate.g === entry.g && candidate.f === entry.f) { current = candidate; break; }
    }
    if (!current) break;
    expansions += 1;
    open.delete(current.key);
    closed.set(current.key, current);
    const currentWorld = current.key === startKey ? start : toWorld(current.point);
    if (distance(currentWorld, goal) <= step * 1.75 && collision.segmentIsFree(currentWorld, goal, radius)) {
      const raw = [];
      let node = current;
      while (node) {
        raw.push(node.key === startKey ? start : toWorld(node.point));
        node = node.parent ? closed.get(node.parent) : undefined;
      }
      raw.reverse();
      raw.push(goal);
      return {
        status: 'found',
        path: smoothPath(raw, radius, collision),
        expansions,
        expansionLimit
      };
    }
    for (let dz = -1; dz <= 1; dz += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const point = { x: current.point.x + dx, y: current.point.y + dy, z: current.point.z + dz };
      if (point.x < 0 || point.y < 0 || point.z < 0 || point.x > maximum.x || point.y > maximum.y || point.z > maximum.z) continue;
      const key = keyOf(point);
      if (closed.has(key)) continue;
      const world = toWorld(point);
      if (!collision.sphereIsFree(world, radius) || !collision.segmentIsFree(currentWorld, world, radius)) continue;
      const g = current.g + Math.hypot(dx, dy, dz);
      const existing = open.get(key);
      if (!existing || g < existing.g) {
        const next = { point, key, g, f: g + distance(point, goalGrid), parent: current.key };
        open.set(key, next);
        queue.push(next);
      }
    }
  }
  return {
    status: expansions >= expansionLimit && open.size > 0 ? 'expansion-limit' : 'unreachable',
    path: null,
    expansions,
    expansionLimit
  };
};

const makeWaypoint = (type, position, targetLabelId, profile, collision) => ({
  id: randomUUID(),
  sequence: 0,
  type,
  position,
  yaw: 0,
  pitch: 0,
  speed: profile.speed,
  targetLabelId,
  clearance: collision.estimateClearance(position, Math.max(profile.inflationRadius * 4, 1)),
  valid: collision.sphereIsFree(position, profile.inflationRadius)
});

const removeCloseTransitPoints = (points, minimum, radius, collision) => {
  if (minimum <= 0) return points;
  const result = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const previous = result[result.length - 1];
    const next = points[index + 1];
    if (point.type === 'transit' && next && distance(previous.position, point.position) < minimum &&
        collision.segmentIsFree(previous.position, next.position, radius)) continue;
    result.push(point);
  }
  return result;
};

const subdivide = (points, maximum, profile, collision) => {
  const result = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const destination = points[index];
    const from = result[result.length - 1].position;
    if (!collision.segmentIsFree(from, destination.position, profile.inflationRadius)) return null;
    const parts = Math.max(1, Math.ceil(distance(from, destination.position) / maximum));
    if (result.length + parts > MAX_WAYPOINTS) return null;
    for (let part = 1; part < parts; part += 1) {
      const t = part / parts;
      result.push(makeWaypoint('transit', {
        x: from.x + (destination.position.x - from.x) * t,
        y: from.y + (destination.position.y - from.y) * t,
        z: from.z + (destination.position.z - from.z) * t
      }, null, profile, collision));
    }
    result.push({ ...destination });
  }
  return result;
};

const finalize = (points, labels, profile, collision) => {
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    point.sequence = index;
    point.valid = collision.sphereIsFree(point.position, profile.inflationRadius);
    if (!point.valid) return { valid: false, safeCount: index, error: `最终航迹点 ${index + 1} 未通过膨胀净空复检` };
    if (index > 0 && !collision.segmentIsFree(points[index - 1].position, point.position, profile.inflationRadius)) {
      return { valid: false, safeCount: index, error: `最终航迹第 ${index} 段未通过膨胀扫掠复检` };
    }
    const target = point.targetLabelId ? labels.get(point.targetLabelId) : undefined;
    const lookTarget = target?.position ?? points[index + 1]?.position ?? points[index - 1]?.position;
    if (lookTarget) Object.assign(point, target || points[index + 1] ? lookAt(point.position, lookTarget) : lookAt(lookTarget, point.position));
  }
  return { valid: true, safeCount: points.length, error: null };
};

export const planMission = ({ startLabel, labels, profile, collision }) => {
  const routeLabels = [startLabel, ...labels];
  const unresolved = labels.find((label) => !label.resolved || !label.normal);
  if (unresolved) return { valid: false, waypoints: [], error: `标签“${unresolved.title}”缺少可靠表面法向。` };
  if (!startLabel.resolved || !startLabel.normal) return { valid: false, waypoints: [], error: `起点“${startLabel.title}”缺少可靠起飞法向。` };
  const start = chooseTakeoffPoint(startLabel, profile, collision);
  if (!start) return { valid: false, waypoints: [], error: `起点“${startLabel.title}”沿法向 ${TAKEOFF_HEIGHT_METERS.toFixed(1)} 米的起飞位置或通道被占用。` };
  const targets = [];
  let previous = start;
  for (const label of labels) {
    const point = chooseObservationPoint(label, previous, profile, collision);
    if (!point) return { valid: false, waypoints: [], error: `标签“${label.title}”附近找不到满足观察距离、视线和净空的观察点。` };
    targets.push({ label, point });
    previous = point;
  }
  const waypoints = [makeWaypoint('start', start, null, profile, collision)];
  const stops = [...targets.map((target) => target.point), start];
  previous = start;
  for (let index = 0; index < stops.length; index += 1) {
    const search = findCollisionAwarePath(previous, stops[index], profile.inflationRadius, collision);
    if (!search.path) {
      const result = finalize(waypoints, new Map(routeLabels.map((label) => [label.id, label])), profile, collision);
      const reason = search.status === 'expansion-limit'
        ? `搜索达到 ${search.expansionLimit.toLocaleString('zh-CN')} 个节点上限，尚未完成自由空间连通性判定`
        : search.status === 'blocked-endpoint'
          ? '航段端点未通过膨胀净空检查'
          : '在当前离散搜索域内未找到连通路径';
      return {
        valid: false,
        waypoints: waypoints.slice(0, result.safeCount),
        error: `第 ${index + 1} 航段${reason}；仅保留安全前缀预览。`
      };
    }
    for (let part = 1; part < search.path.length - 1; part += 1) {
      waypoints.push(makeWaypoint('transit', search.path[part], null, profile, collision));
    }
    const target = targets[index];
    waypoints.push(makeWaypoint(target ? 'inspection' : 'start', stops[index], target?.label.id ?? null, profile, collision));
    previous = stops[index];
  }
  const spaced = removeCloseTransitPoints(waypoints, profile.minimumSpacing, profile.inflationRadius, collision);
  const detailed = subdivide(spaced, profile.maximumSpacing, profile, collision);
  if (!detailed) return { valid: false, waypoints: [], error: `航迹细分超过 ${MAX_WAYPOINTS} 点或存在不可通行航段。` };
  const labelsById = new Map(routeLabels.map((label) => [label.id, label]));
  const result = finalize(detailed, labelsById, profile, collision);
  if (!result.valid) return { valid: false, waypoints: detailed.slice(0, result.safeCount), error: `${result.error}；仅保留安全前缀预览。` };
  return { valid: true, waypoints: detailed, error: null };
};
