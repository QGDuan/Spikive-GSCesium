import { randomUUID } from "node:crypto";
import type { FlightProfile, InspectionLabel, Vec3, Waypoint } from "@spikive/shared";
import { add, distance, mul, normalize, sub } from "@spikive/shared";

export interface CollisionQuery {
  readonly resolution: number;
  sphereIsFree(point: Vec3, radius: number): boolean;
  segmentIsFree(from: Vec3, to: Vec3, radius: number): boolean;
  estimateClearance(point: Vec3, maximum: number): number;
}

interface Node { point: Vec3; key: string; g: number; f: number; parent: string | null }
interface QueueEntry { key: string; g: number; f: number }
const MAX_GENERATED_WAYPOINTS = 5_000;

class MinPriorityQueue {
  private readonly entries: QueueEntry[] = [];

  get size() { return this.entries.length; }

  push(entry: QueueEntry) {
    this.entries.push(entry);
    let index = this.entries.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.entries[parent]!.f <= entry.f) break;
      this.entries[index] = this.entries[parent]!;
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop(): QueueEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (!first || !last || this.entries.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.entries.length) break;
      const child = right < this.entries.length && this.entries[right]!.f < this.entries[left]!.f ? right : left;
      if (this.entries[child]!.f >= last.f) break;
      this.entries[index] = this.entries[child]!;
      index = child;
    }
    this.entries[index] = last;
    return first;
  }
}

export interface PlanResult { valid: boolean; waypoints: Waypoint[]; error: string | null }

interface FinalRouteFailure {
  error: string;
  safeWaypointCount: number;
}

export function planMission(home: Vec3, labels: InspectionLabel[], profile: FlightProfile, collision: CollisionQuery, startLabel: InspectionLabel | null = null): PlanResult {
  const routeLabels = startLabel ? [startLabel, ...labels] : labels;
  const unresolved = routeLabels.find(label => label.resolutionStatus !== "resolved" || !label.surfaceNormalLocal);
  if (unresolved) return { valid: false, waypoints: [], error: `标签“${unresolved.title}”缺少可靠表面法向` };
  const radius = profile.droneRadius + profile.safetyMargin;
  const maximumSegmentLength = profile.maximumSegmentLength ?? 5;
  if (maximumSegmentLength < profile.minimumWaypointSpacing) {
    return { valid: false, waypoints: [], error: "最大航段长度不能小于最小航点间距" };
  }
  let routeStart = home;
  if (startLabel) {
    const derivedStart = chooseInspectionPoint(startLabel, startLabel.positionLocal, profile.observationDistance, radius, collision);
    if (!derivedStart) return { valid: false, waypoints: [], error: `起点标签“${startLabel.title}”附近找不到满足视线和净空的起点` };
    routeStart = derivedStart;
  } else if (!collision.sphereIsFree(home, radius)) {
    return { valid: false, waypoints: [], error: "Home 点与碰撞体或安全边界冲突" };
  }

  const targets: Array<{ point: Vec3; label: InspectionLabel }> = [];
  let previous = routeStart;
  for (const label of labels) {
    const point = chooseInspectionPoint(label, previous, profile.observationDistance, radius, collision);
    if (!point) return { valid: false, waypoints: [], error: `标签“${label.title}”附近找不到满足视线和净空的观察点` };
    targets.push({ point, label }); previous = point;
  }

  const startTargetLabelId = startLabel?.id ?? null;
  const all: Waypoint[] = [makeWaypoint(0, "home", routeStart, startTargetLabelId, profile.speed, true, collision, radius)];
  const stops = [...targets.map(value => value.point), routeStart];
  let from = routeStart;
  for (let index = 0; index < stops.length; index++) {
    const to = stops[index]!;
    const segment = findCollisionAwarePath(from, to, radius, collision);
    if (!segment) {
      return buildInvalidPreview(
        all,
        `第 ${index + 1} 个航段无法绕开碰撞体或未知空间`,
        profile.minimumWaypointSpacing,
        maximumSegmentLength,
        radius,
        collision,
        routeLabels
      );
    }
    for (let i = 1; i < segment.length - 1; i++) all.push(makeWaypoint(all.length, "transit", segment[i]!, null, profile.speed, true, collision, radius));
    const target = targets[index];
    if (target) {
      const attitude = lookAt(to, target.label.positionLocal);
      const waypoint = makeWaypoint(all.length, "inspection", to, target.label.id, profile.speed, true, collision, radius);
      waypoint.yaw = attitude.yaw; waypoint.pitch = attitude.pitch; all.push(waypoint);
    } else {
      all.push(makeWaypoint(all.length, "home", to, startTargetLabelId, profile.speed, true, collision, radius));
    }
    from = to;
  }
  const simplified = enforceMinimumWaypointSpacing(all, profile.minimumWaypointSpacing, radius, collision);
  const detailed = subdivideRoute(simplified, maximumSegmentLength, radius, collision);
  if (!detailed) {
    return { valid: false, waypoints: [], error: `航迹细分超过 ${MAX_GENERATED_WAYPOINTS} 点或存在不可通行航段，请增大最大航段长度或调整标签/Home` };
  }
  const finalFailure = validateFinalRoute(detailed, radius, collision);
  if (finalFailure) {
    return invalidPreviewResult(detailed.slice(0, finalFailure.safeWaypointCount), finalFailure.error, routeLabels);
  }
  applyWaypointAttitudes(detailed, new Map(routeLabels.map(label => [label.id, label])));
  return { valid: true, waypoints: detailed.map((point, sequence) => ({ ...point, sequence })), error: null };
}

function buildInvalidPreview(
  completedPoints: Waypoint[],
  error: string,
  minimumWaypointSpacing: number,
  maximumSegmentLength: number,
  radius: number,
  collision: CollisionQuery,
  routeLabels: InspectionLabel[]
): PlanResult {
  const simplified = enforceMinimumWaypointSpacing(completedPoints, minimumWaypointSpacing, radius, collision);
  const detailed = subdivideRoute(simplified, maximumSegmentLength, radius, collision);
  if (!detailed) return { valid: false, waypoints: [], error };
  const finalFailure = validateFinalRoute(detailed, radius, collision);
  const safePrefix = finalFailure ? detailed.slice(0, finalFailure.safeWaypointCount) : detailed;
  return invalidPreviewResult(safePrefix, error, routeLabels);
}

function invalidPreviewResult(safePrefix: Waypoint[], error: string, routeLabels: InspectionLabel[]): PlanResult {
  applyWaypointAttitudes(safePrefix, new Map(routeLabels.map(label => [label.id, label])));
  return {
    valid: false,
    waypoints: safePrefix.map((point, sequence) => ({ ...point, sequence })),
    error: `${error}；仅保留失败位置之前已通过复检的 ${safePrefix.length} 个预览航点，禁止导出或执行`
  };
}

function chooseInspectionPoint(label: InspectionLabel, previous: Vec3, standoff: number, radius: number, collision: CollisionQuery) {
  const normal = normalize(label.surfaceNormalLocal!); if (!normal) return null;
  const directions = observationDirections(normal);
  const candidates: Array<{ point: Vec3; score: number }> = [];
  for (const factor of [1, 1.25, 1.5]) for (const direction of directions) {
    const point = add(label.positionLocal, mul(direction, standoff * factor));
    if (!collision.sphereIsFree(point, radius)) continue;
    const towardTarget = normalize(sub(label.positionLocal, point));
    if (!towardTarget) continue;
    const visibleEnd = add(label.positionLocal, mul(towardTarget, -collision.resolution * 1.5));
    if (!collision.segmentIsFree(point, visibleEnd, 0)) continue;
    const alignment = Math.abs(direction.x * normal.x + direction.y * normal.y + direction.z * normal.z);
    candidates.push({ point, score: alignment * 100 - distance(previous, point) - (factor - 1) * standoff });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.point ?? null;
}

export function findCollisionAwarePath(start: Vec3, goal: Vec3, radius: number, collision: CollisionQuery): Vec3[] | null {
  if (!collision.sphereIsFree(start, radius) || !collision.sphereIsFree(goal, radius)) return null;
  if (collision.segmentIsFree(start, goal, radius)) return [start, goal];
  // Do not multiply collision resolution by two unconditionally. Radius and
  // the 0.25 m CPU floor may still select a coarser safe search lattice, while
  // continuous edge sweeps remain authoritative.
  const step = Math.max(collision.resolution, radius / 2, 0.25);
  const padding = Math.max(radius * 6, distance(start, goal) * 0.5, 2);
  const origin = { x: Math.min(start.x, goal.x) - padding, y: Math.min(start.y, goal.y) - padding, z: Math.min(start.z, goal.z) - padding };
  const toGrid = (p: Vec3): Vec3 => ({ x: Math.round((p.x - origin.x) / step), y: Math.round((p.y - origin.y) / step), z: Math.round((p.z - origin.z) / step) });
  const toWorld = (p: Vec3): Vec3 => ({ x: origin.x + p.x * step, y: origin.y + p.y * step, z: origin.z + p.z * step });
  const gridMax = toGrid({ x: Math.max(start.x, goal.x) + padding, y: Math.max(start.y, goal.y) + padding, z: Math.max(start.z, goal.z) + padding });
  const s = toGrid(start), g = toGrid(goal); const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  const open = new Map<string, Node>(); const closed = new Map<string, Node>(); const queue = new MinPriorityQueue();
  const startKey = key(s);
  const startNode = { point: s, key: startKey, g: 0, f: distance(s, g), parent: null };
  open.set(startKey, startNode); queue.push(startNode);
  const maxExpansions = 150000;
  let expansions = 0;
  while (open.size && queue.size && expansions < maxExpansions) {
    let current: Node | undefined;
    while (queue.size) {
      const entry = queue.pop()!;
      const candidate = open.get(entry.key);
      if (candidate && candidate.g === entry.g && candidate.f === entry.f) { current = candidate; break; }
    }
    if (!current) break;
    expansions++;
    open.delete(current.key); closed.set(current.key, current);
    const currentWorld = current.key === startKey ? start : toWorld(current.point);
    if (distance(currentWorld, goal) <= step * 1.75 && collision.segmentIsFree(currentWorld, goal, radius)) {
      const raw = reconstruct(current, closed).map(toWorld);
      raw[0] = start;
      raw.push(goal);
      return smoothPath(raw, radius, collision, start, goal);
    }
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const point = { x: current.point.x + dx, y: current.point.y + dy, z: current.point.z + dz };
      if (point.x < 0 || point.y < 0 || point.z < 0 || point.x > gridMax.x || point.y > gridMax.y || point.z > gridMax.z) continue;
      const pointKey = key(point);
      const pointWorld = toWorld(point);
      if (closed.has(pointKey) || !collision.sphereIsFree(pointWorld, radius)) continue;
      // A free endpoint does not prove that the diagonal/corner-cutting edge is
      // free. Every A* edge is a continuous swept-sphere query.
      if (!collision.segmentIsFree(currentWorld, pointWorld, radius)) continue;
      const tentative = current.g + Math.hypot(dx, dy, dz); const existing = open.get(pointKey);
      if (!existing || tentative < existing.g) {
        const next = { point, key: pointKey, g: tentative, f: tentative + distance(point, g), parent: current.key };
        open.set(pointKey, next); queue.push(next);
      }
    }
  }
  return null;
}

export function enforceMinimumWaypointSpacing(points: Waypoint[], minimumSpacing: number, radius: number, collision: CollisionQuery) {
  if (points.length <= 2 || minimumSpacing <= 0) return points.map((point, sequence) => ({ ...point, sequence }));
  const result: Waypoint[] = [points[0]!];
  for (let index = 1; index < points.length; index++) {
    const point = points[index]!;
    const previous = result[result.length - 1]!;
    const next = points[index + 1];
    const canSkip = point.type === "transit"
      && distance(previous.positionLocal, point.positionLocal) < minimumSpacing
      && next !== undefined
      && collision.segmentIsFree(previous.positionLocal, next.positionLocal, radius);
    if (!canSkip) result.push(point);
  }
  return result.map((point, sequence) => ({ ...point, sequence }));
}

function reconstruct(last: Node, closed: Map<string, Node>) {
  const result: Vec3[] = []; let node: Node | undefined = last;
  while (node) { result.push(node.point); node = node.parent ? closed.get(node.parent) : undefined; }
  return result.reverse();
}
function smoothPath(points: Vec3[], radius: number, collision: CollisionQuery, start: Vec3, goal: Vec3) {
  points[0] = start; points[points.length - 1] = goal;
  const result: Vec3[] = [points[0]!]; let index = 0;
  while (index < points.length - 1) {
    let next = points.length - 1;
    while (next > index + 1 && !collision.segmentIsFree(points[index]!, points[next]!, radius)) next--;
    result.push(points[next]!); index = next;
  }
  return result.every((point, pointIndex) => pointIndex === 0 || collision.segmentIsFree(result[pointIndex - 1]!, point, radius))
    ? result
    : null;
}
function makeWaypoint(sequence: number, type: Waypoint["type"], positionLocal: Vec3, targetLabelId: string | null, speed: number, generated: boolean, collision: CollisionQuery, radius: number): Waypoint {
  const clearance = collision.estimateClearance(positionLocal, Math.max(radius * 4, 1));
  return { id: randomUUID(), sequence, type, positionLocal, yaw: 0, pitch: 0, speed, targetLabelId, generated, clearance, valid: collision.sphereIsFree(positionLocal, radius) };
}

function subdivideRoute(points: Waypoint[], maximumSegmentLength: number, radius: number, collision: CollisionQuery): Waypoint[] | null {
  if (!points.length) return [];
  const result: Waypoint[] = [{ ...points[0]!, sequence: 0 }];
  for (let index = 1; index < points.length; index++) {
    const destination = points[index]!;
    const from = result[result.length - 1]!.positionLocal;
    const length = distance(from, destination.positionLocal);
    if (!collision.segmentIsFree(from, destination.positionLocal, radius)) return null;
    const partCount = Math.max(1, Math.ceil(length / maximumSegmentLength));
    if (result.length + partCount > MAX_GENERATED_WAYPOINTS) return null;
    for (let part = 1; part < partCount; part++) {
      const t = part / partCount;
      const position = {
        x: from.x + (destination.positionLocal.x - from.x) * t,
        y: from.y + (destination.positionLocal.y - from.y) * t,
        z: from.z + (destination.positionLocal.z - from.z) * t
      };
      result.push(makeWaypoint(result.length, "transit", position, null, destination.speed, true, collision, radius));
    }
    result.push({ ...destination, sequence: result.length });
  }
  return result;
}

function validateFinalRoute(points: Waypoint[], radius: number, collision: CollisionQuery): FinalRouteFailure | null {
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    point.valid = collision.sphereIsFree(point.positionLocal, radius);
    if (!point.valid) {
      return { error: `最终航迹点 ${index + 1} 未通过机体膨胀净空复检`, safeWaypointCount: index };
    }
    if (index > 0 && !collision.segmentIsFree(points[index - 1]!.positionLocal, point.positionLocal, radius)) {
      return { error: `最终航迹第 ${index} 段未通过机体膨胀扫掠复检`, safeWaypointCount: index };
    }
  }
  return null;
}

function applyWaypointAttitudes(points: Waypoint[], labels: Map<string, InspectionLabel>) {
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const targetLabel = point.targetLabelId ? labels.get(point.targetLabelId) : undefined;
    const lookTarget = targetLabel?.positionLocal ?? points[index + 1]?.positionLocal ?? points[index - 1]?.positionLocal;
    if (!lookTarget) continue;
    const attitude = targetLabel || points[index + 1]
      ? lookAt(point.positionLocal, lookTarget)
      : lookAt(lookTarget, point.positionLocal);
    point.yaw = attitude.yaw;
    point.pitch = attitude.pitch;
  }
}
function lookAt(from: Vec3, to: Vec3) {
  const delta = sub(to, from); const horizontal = Math.hypot(delta.x, delta.y);
  return { yaw: Math.atan2(delta.x, delta.y) * 180 / Math.PI, pitch: Math.atan2(delta.z, horizontal) * 180 / Math.PI };
}

/** Full azimuth cone around the surface normal, including vertical normals. */
function observationDirections(normal: Vec3): Vec3[] {
  const result: Vec3[] = [];
  for (const sign of [1, -1]) {
    const axis = mul(normal, sign);
    const reference = Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const tangent = normalize(cross(reference, axis));
    if (!tangent) continue;
    const bitangent = cross(axis, tangent);
    for (const tiltDegrees of [0, 15, 30, 45]) {
      const tilt = tiltDegrees * Math.PI / 180;
      const azimuthCount = tiltDegrees === 0 ? 1 : 12;
      for (let index = 0; index < azimuthCount; index++) {
        const azimuth = index * Math.PI * 2 / azimuthCount;
        const radial = add(mul(tangent, Math.cos(azimuth)), mul(bitangent, Math.sin(azimuth)));
        const direction = normalize(add(mul(axis, Math.cos(tilt)), mul(radial, Math.sin(tilt))));
        if (direction) result.push(direction);
      }
    }
  }
  return result;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
