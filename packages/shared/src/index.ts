import { z } from "zod";

export const idSchema = z.string().uuid();
export const vec3Schema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
export const geoPointSchema = z.object({ longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90), height: z.number().finite() });
export const placementSchema = geoPointSchema.extend({
  heading: z.number().finite().default(0),
  pitch: z.number().finite().default(0),
  roll: z.number().finite().default(0),
  scale: z.number().positive().max(10000).default(1)
});

export const datasetStatusSchema = z.enum(["created", "uploading", "queued", "tiling", "collision_processing", "rebuilding", "ready", "failed"]);
export const collisionStatusSchema = z.enum(["pending", "processing", "ready", "failed"]);
export const sceneTypeSchema = z.enum(["outdoor", "indoor"]);
// Collision generation currently consumes GraphDECO's log-scale/logit-opacity PLY convention.
export const inputConventionSchema = z.literal("graphdeco");
export const sourceCoordinateSystemSchema = z.literal("z_up");

export const createDatasetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sourceFileName: z.string().trim().min(1).max(255).regex(/\.ply$/i, "只支持 PLY 文件"),
  sourceSize: z.number().int().positive().max(5 * 1024 ** 3),
  sceneType: sceneTypeSchema.default("outdoor"),
  inputConvention: inputConventionSchema.default("graphdeco"),
  sourceCoordinateSystem: sourceCoordinateSystemSchema,
  voxelSize: z.number().min(0.02).max(2).default(0.1),
  voxelOpacity: z.number().min(0.001).max(1).default(0.1),
  indoorSeed: vec3Schema.nullable().optional(),
  placement: placementSchema
});

export const patchDatasetSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  placement: placementSchema.optional(),
  voxelSize: z.number().min(0.02).max(2).optional(),
  voxelOpacity: z.number().min(0.001).max(1).optional(),
  indoorSeed: vec3Schema.nullable().optional()
});

export const labelResolutionSchema = z.enum(["pending", "resolved", "unresolved"]);
export const createLabelSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  category: z.string().trim().max(80).default("巡检点"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffb020"),
  positionLocal: vec3Schema,
  surfaceNormalLocal: vec3Schema.nullable().optional()
});
export const patchLabelSchema = createLabelSchema.partial().extend({ flipNormal: z.boolean().optional() });
export const raycastSchema = z.object({
  originLocal: vec3Schema,
  directionLocal: vec3Schema,
  maxDistance: z.number().positive().max(100000).optional()
});

export const flightProfileSchema = z.object({
  droneRadius: z.number().positive().max(20),
  safetyMargin: z.number().nonnegative().max(100),
  observationDistance: z.number().positive().max(500),
  speed: z.number().positive().max(100),
  minimumWaypointSpacing: z.number().positive().max(100),
  maximumSegmentLength: z.number().positive().max(500).default(5)
}).refine(value => value.maximumSegmentLength >= value.minimumWaypointSpacing, {
  message: "最大航段长度不能小于最小航点间距",
  path: ["maximumSegmentLength"]
});
const missionInputSchema = z.object({
  datasetId: idSchema,
  name: z.string().trim().min(1).max(120),
  homeLocal: vec3Schema,
  startLabelId: idSchema.nullable().default(null),
  labelIds: z.array(idSchema).min(1).refine(values => new Set(values).size === values.length, "巡检标签不能重复"),
  flightProfile: flightProfileSchema
});
export const createMissionSchema = missionInputSchema.refine(value => !value.startLabelId || !value.labelIds.includes(value.startLabelId), {
  message: "起点标签不能在巡检顺序中重复出现",
  path: ["startLabelId"]
});
export const patchMissionSchema = missionInputSchema
  .omit({ datasetId: true, startLabelId: true })
  .partial()
  .extend({ startLabelId: idSchema.nullable().optional() });

export const waypointTypeSchema = z.enum(["home", "transit", "inspection", "manual"]);
export const missionStatusSchema = z.enum(["draft", "planning", "valid", "invalid"]);
export const waypointSchema = z.object({
  id: idSchema,
  sequence: z.number().int().nonnegative(),
  type: waypointTypeSchema,
  positionLocal: vec3Schema,
  yaw: z.number().finite(),
  pitch: z.number().finite(),
  speed: z.number().positive(),
  targetLabelId: idSchema.nullable(),
  generated: z.boolean(),
  clearance: z.number().nonnegative().nullable(),
  valid: z.boolean()
});

export type Vec3 = z.infer<typeof vec3Schema>;
export type GeoPoint = z.infer<typeof geoPointSchema>;
export type Placement = z.infer<typeof placementSchema>;
export type CreateDataset = z.infer<typeof createDatasetSchema>;
export type CreateLabel = z.infer<typeof createLabelSchema>;
export type RaycastRequest = z.infer<typeof raycastSchema>;
export type FlightProfile = z.infer<typeof flightProfileSchema>;
export type CreateMission = z.infer<typeof createMissionSchema>;
export type Waypoint = z.infer<typeof waypointSchema>;

export interface Dataset extends Omit<CreateDataset, "sourceCoordinateSystem"> {
  id: string;
  /** Null only for legacy records whose source basis has not yet been audited. */
  sourceCoordinateSystem: z.infer<typeof sourceCoordinateSystemSchema> | null;
  aholoVisualRevision: string | null;
  aholoPolicyVersion: string | null;
  status: z.infer<typeof datasetStatusSchema>;
  collisionStatus: z.infer<typeof collisionStatusSchema>;
  progress: number;
  stage: string;
  error: string | null;
  uploadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AholoLodLevelReport {
  level: number;
  precision: number;
  scaleBoost: number;
  permanent: boolean;
  merged: boolean;
  splatCount: number;
}

export interface AholoVisualReport {
  schemaVersion: 1;
  datasetId: string;
  visualRevision: string;
  policyVersion: string;
  source: {
    sha256: string;
    bytes: number;
    splatCount: number;
    shDegree: number;
    coordinateSystem: "tile_local_z_up";
  };
  transform: {
    localToRender: "render=(x,z,-y)";
    renderToLocal: "local=(x,-z,y)";
  };
  artifact: {
    eszBytes: number;
    eszPayloadSha256: string;
    referencePlyBytes: number;
    referencePlyPayloadSha256: string;
    chunkCount: number;
    referenceChunkCount: number;
  };
  collisionRevision: string;
  tool: { name: "@manycore/aholo-splat-transform"; version: string };
  levels: AholoLodLevelReport[];
  builtAt: string;
}

export interface RenderManifest {
  schemaVersion: 1;
  datasetId: string;
  activeVisualRevision: string;
  source: { sha256: string; splatCount: number; shDegree: number };
  coordinateFrame: "tile_local_z_up";
  collisionRevision: string;
  placement: Placement;
  aholo: {
    lodMetaUrl: string;
    referenceLodMetaUrl: string;
    reportUrl: string;
    policyVersion: string;
    maxBudget: 6000000;
    levels: AholoLodLevelReport[];
    transform: { localToRender: "render=(x,z,-y)"; renderToLocal: "local=(x,-z,y)" };
  };
}

export interface InspectionLabel extends CreateLabel {
  id: string;
  datasetId: string;
  surfaceNormalLocal: Vec3 | null;
  snapDistance: number | null;
  resolutionStatus: z.infer<typeof labelResolutionSchema>;
  createdAt: string;
  updatedAt: string;
}

export interface SurfaceHit {
  position: Vec3;
  normal: Vec3;
  distance: number;
}

export interface Mission extends CreateMission {
  id: string;
  status: z.infer<typeof missionStatusSchema>;
  error: string | null;
  waypoints: Waypoint[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiError { error: string; details?: unknown }

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul = (a: Vec3, scalar: number): Vec3 => ({ x: a.x * scalar, y: a.y * scalar, z: a.z * scalar });
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const normalize = (a: Vec3): Vec3 | null => {
  const value = length(a);
  return value > 1e-9 ? mul(a, 1 / value) : null;
};
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
