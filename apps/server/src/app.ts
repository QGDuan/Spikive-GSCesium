import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { FileStore } from "@tus/file-store";
import { Server as TusServer } from "@tus/server";
import { ZodError } from "zod";
import {
  createDatasetSchema, patchDatasetSchema, createLabelSchema, patchLabelSchema, raycastSchema,
  createMissionSchema, patchMissionSchema, type Dataset, type InspectionLabel, type Mission,
  normalize, mul
} from "@spikive/shared";
import { config } from "./config.js";
import { Database } from "./db.js";
import { CollisionRepository } from "./collision.js";
import { ProcessingWorker } from "./worker.js";
import { planMission } from "./planner.js";
import { transformTileset } from "./coordinates.js";

export interface AppContext { app: FastifyInstance; db: Database; worker: ProcessingWorker; collisions: CollisionRepository }

export async function buildApp(): Promise<AppContext> {
  for (const directory of [config.dataDir, config.uploadsDir, config.sourcesDir, config.workDir, config.publishedDir]) await mkdir(directory, { recursive: true });
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 2 * 1024 * 1024,
    // Release idle keep-alive sockets during watch-mode shutdown so the next
    // development process can bind port 3000 without interrupting active work.
    forceCloseConnections: "idle"
  });
  await app.register(cors, {
    origin: true,
    // TUS creates an upload with POST, resumes it with HEAD and sends every
    // chunk with PATCH. @fastify/cors otherwise defaults to GET/HEAD/POST.
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization", "Content-Type", "Tus-Resumable", "Upload-Length",
      "Upload-Metadata", "Upload-Offset", "Upload-Defer-Length",
      "Upload-Concat", "X-HTTP-Method-Override"
    ],
    exposedHeaders: [
      "Location", "Tus-Resumable", "Tus-Version", "Tus-Extension",
      "Tus-Max-Size", "Upload-Offset", "Upload-Length", "Upload-Metadata",
      "Upload-Defer-Length", "Upload-Concat", "Upload-Expires"
    ],
    maxAge: 86400
  });
  const db = new Database(config.dbPath);
  const collisions = new CollisionRepository(config.publishedDir, config.collisionCacheBytes);
  const worker = new ProcessingWorker(db, collisions, app.log);
  app.addHook("onClose", async () => { await worker.stop(); db.close(); });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "请求参数无效", details: error.issues });
    }
    const status = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) app.log.error(error);
    reply.code(status).send({ error: message });
  });
  app.get("/healthz", async () => ({ status: "ok", conversionEnabled: config.conversionEnabled, collisionCache: collisions.stats }));

  app.get("/api/datasets", async () => db.listDatasets());
  app.post("/api/datasets", async (request, reply) => {
    const input = createDatasetSchema.parse(request.body); const now = new Date().toISOString();
    const dataset: Dataset = { ...input, indoorSeed: input.indoorSeed ?? null, id: randomUUID(), status: "created", collisionStatus: "pending", progress: 0, stage: "等待上传", error: null, uploadId: null, createdAt: now, updatedAt: now };
    db.insertDataset(dataset); return reply.code(201).send(dataset);
  });
  app.get<{ Params: { id: string } }>("/api/datasets/:id", async request => requireResource(db.getDataset(request.params.id)));
  app.patch<{ Params: { id: string } }>("/api/datasets/:id", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id)); const input = patchDatasetSchema.parse(request.body);
    const changesProcessingParameters = ["voxelSize", "voxelOpacity", "indoorSeed"].some(key => Object.hasOwn(input, key));
    if (changesProcessingParameters && dataset.status !== "created" && dataset.status !== "failed") {
      return reply.code(409).send({ error: "上传开始后不能修改碰撞处理参数；请新建数据集或在失败状态下修改后重试" });
    }
    return db.updateDataset(request.params.id, input as Partial<Dataset>);
  });
  app.delete<{ Params: { id: string } }>("/api/datasets/:id", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id));
    await worker.cancelDataset(request.params.id); db.deleteDataset(request.params.id); worker.forgetDataset(request.params.id);
    const uploadFiles = dataset.uploadId
      ? [rm(path.join(config.uploadsDir, dataset.uploadId), { force: true }), rm(path.join(config.uploadsDir, `${dataset.uploadId}.json`), { force: true })]
      : [];
    await Promise.all([...uploadFiles, rm(path.join(config.publishedDir, request.params.id), { recursive: true, force: true }), rm(path.join(config.workDir, request.params.id), { recursive: true, force: true }), rm(path.join(config.sourcesDir, `${request.params.id}.ply`), { force: true })]);
    collisions.invalidate(request.params.id); return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/datasets/:id/retry", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id)); if (dataset.status !== "failed") return reply.code(409).send({ error: "只有失败任务可以重试" });
    const next = db.updateDataset(dataset.id, { status: "queued", collisionStatus: "pending", progress: 5, stage: "重新排队", error: null }); worker.wake(); return next;
  });
  app.post<{ Params: { id: string } }>("/api/datasets/:id/rebuild-tiles", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id));
    if (dataset.status !== "ready" || dataset.collisionStatus !== "ready") {
      return reply.code(409).send({ error: "只有已完整发布的数据集可以重建高清切片" });
    }
    try {
      await Promise.all([
        stat(path.join(config.sourcesDir, `${dataset.id}.ply`)),
        stat(path.join(config.publishedDir, dataset.id, "tiles", "tileset.json")),
        stat(path.join(config.publishedDir, dataset.id, "collision", "scene.voxel.json")),
        stat(path.join(config.publishedDir, dataset.id, "collision", "scene.voxel.bin")),
        stat(path.join(config.publishedDir, dataset.id, "collision", "scene.collision.glb"))
      ]);
    } catch {
      return reply.code(409).send({ error: "源文件或上一已发布产物不完整，不能执行在线高清重建" });
    }
    const next = db.updateDataset(dataset.id, {
      status: "rebuilding", progress: 5, stage: "高清 LOD 重建已排队；上一版本继续服务", error: null
    });
    worker.wake();
    return next;
  });

  registerTus(app, db, worker);

  app.get<{ Params: { id: string } }>("/api/datasets/:id/tiles/tileset.json", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id)); if (!["ready", "rebuilding"].includes(dataset.status)) return reply.code(409).send({ error: "数据尚未发布" });
    const json = JSON.parse(await readFile(path.join(config.publishedDir, dataset.id, "tiles", "tileset.json"), "utf8"));
    reply.header("Cache-Control", "no-cache"); return transformTileset(json, dataset.placement, dataset.updatedAt);
  });
  app.get<{ Params: { id: string; "*": string } }>("/api/datasets/:id/tiles/*", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id)); if (!["ready", "rebuilding"].includes(dataset.status)) return reply.code(409).send({ error: "数据尚未发布" });
    const relative = request.params["*"]; if (!isSafeRelativePath(relative)) return reply.code(400).send({ error: "无效资源路径" });
    return reply.sendFile(path.join(dataset.id, "tiles", relative), config.publishedDir, { immutable: true, maxAge: "1y" });
  });
  app.get<{ Params: { id: string; "*": string } }>("/api/datasets/:id/collision/*", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id));
    if (dataset.collisionStatus !== "ready") return reply.code(409).send({ error: "碰撞数据尚未发布" });
    const relative = request.params["*"]; if (!isSafeRelativePath(relative)) return reply.code(400).send({ error: "无效资源路径" });
    return reply.sendFile(path.join(request.params.id, "collision", relative), config.publishedDir, { immutable: true, maxAge: "1y" });
  });
  app.post<{ Params: { id: string } }>("/api/datasets/:id/raycast", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id));
    if (dataset.collisionStatus !== "ready") return reply.code(409).send({ error: "碰撞数据尚未就绪" });
    const input = raycastSchema.parse(request.body);
    return (await collisions.get(dataset.id)).raycast(input.originLocal, input.directionLocal, input.maxDistance);
  });

  registerLabelRoutes(app, db, collisions);
  registerMissionRoutes(app, db, collisions);

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  await app.register(fastifyStatic, { root: config.publishedDir, decorateReply: true, prefix: "/_assets/", serve: false });
  try {
    await readFile(path.join(webDist, "index.html"));
    await app.register(fastifyStatic, { root: path.join(webDist, "assets"), prefix: "/assets/", decorateReply: false });
    await app.register(fastifyStatic, { root: path.join(webDist, "cesium"), prefix: "/cesium/", decorateReply: false });
    app.get("/", (_request, reply) => reply.sendFile("index.html", webDist));
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "接口不存在" }) : reply.sendFile("index.html", webDist));
  } catch { app.log.info("web dist not found; API-only mode"); }
  return { app, db, worker, collisions };
}

function registerTus(app: FastifyInstance, db: Database, worker: ProcessingWorker) {
  const tus = new TusServer({
    path: "/api/uploads", datastore: new FileStore({ directory: config.uploadsDir }), maxSize: config.maxUploadBytes,
    async onUploadCreate(_request, upload) {
      const datasetId = upload.metadata?.datasetId; const dataset = datasetId ? db.getDataset(datasetId) : null;
      if (!dataset) throw { status_code: 400, body: "Upload-Metadata 缺少有效 datasetId" };
      if (dataset.status !== "created") throw { status_code: 409, body: "该数据集已经开始上传或处理，不能创建重复上传" };
      if (upload.size !== dataset.sourceSize) throw { status_code: 400, body: "Upload-Length 与数据集 sourceSize 不一致" };
      db.updateDataset(dataset.id, { status: "uploading", stage: "上传 PLY", uploadId: upload.id ?? null });
      return { metadata: { ...upload.metadata, datasetId: dataset.id } };
    },
    async onUploadFinish(_request, upload) {
      const datasetId = upload.metadata?.datasetId; const dataset = datasetId ? db.getDataset(datasetId) : null;
      if (!dataset || !upload.id) throw { status_code: 400, body: "上传缺少数据集关联" };
      await rename(path.join(config.uploadsDir, upload.id), path.join(config.sourcesDir, `${dataset.id}.ply`));
      db.updateDataset(dataset.id, { status: "queued", progress: 5, stage: "上传完成，等待处理", uploadId: upload.id }); worker.wake(); return {};
    }
  });
  app.addContentTypeParser("application/offset+octet-stream", (_request, _payload, done) => done(null));
  const handler = (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    void tus.handle(request.raw, reply.raw).catch(error => {
      app.log.error({ err: error }, "TUS request failed");
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { "Content-Type": "application/json" });
      if (!reply.raw.writableEnded) reply.raw.end(JSON.stringify({ error: "上传服务处理失败" }));
    });
  };
  app.all("/api/uploads", handler); app.all("/api/uploads/*", handler);
}

function registerLabelRoutes(app: FastifyInstance, db: Database, collisions: CollisionRepository) {
  app.get<{ Params: { id: string } }>("/api/datasets/:id/labels", async request => {
    requireResource(db.getDataset(request.params.id));
    return db.listLabels(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/datasets/:id/labels", async (request, reply) => {
    const dataset = requireResource(db.getDataset(request.params.id)); const input = createLabelSchema.parse(request.body); const now = new Date().toISOString();
    let normal = input.surfaceNormalLocal ? normalize(input.surfaceNormalLocal) : null;
    let snapDistance: number | null = null;
    let status: InspectionLabel["resolutionStatus"] = normal ? "resolved" : "pending";
    if (dataset.collisionStatus === "ready") {
      try { const hit = (await collisions.get(dataset.id)).snapSurface(input.positionLocal); if (hit) { normal = hit.normal; snapDistance = hit.distance; status = "resolved"; } else status = "unresolved"; } catch { status = "unresolved"; }
    }
    const label: InspectionLabel = { ...input, surfaceNormalLocal: normal, id: randomUUID(), datasetId: dataset.id, snapDistance, resolutionStatus: status, createdAt: now, updatedAt: now };
    db.insertLabel(label); return reply.code(201).send(label);
  });
  app.patch<{ Params: { id: string } }>("/api/labels/:id", async request => {
    const current = requireResource(db.getLabel(request.params.id)); const input = patchLabelSchema.parse(request.body);
    const { flipNormal, ...values } = input;
    const hasExplicitNormal = Object.hasOwn(input, "surfaceNormalLocal");
    let normal = hasExplicitNormal ? normalize(input.surfaceNormalLocal ?? { x: 0, y: 0, z: 0 }) : current.surfaceNormalLocal;
    let snapDistance = hasExplicitNormal ? null : current.snapDistance;
    let resolutionStatus: InspectionLabel["resolutionStatus"] = hasExplicitNormal
      ? (normal ? "resolved" : "unresolved")
      : current.resolutionStatus;
    if (input.positionLocal) {
      const dataset = requireResource(db.getDataset(current.datasetId));
      if (dataset.collisionStatus === "ready") {
        try {
          const hit = (await collisions.get(dataset.id)).snapSurface(input.positionLocal);
          normal = hit?.normal ?? null;
          snapDistance = hit?.distance ?? null;
          resolutionStatus = hit ? "resolved" : "unresolved";
        } catch {
          normal = null; snapDistance = null; resolutionStatus = "unresolved";
        }
      } else {
        normal = null; snapDistance = null; resolutionStatus = "pending";
      }
    }
    if (flipNormal && normal) normal = mul(normal, -1);
    const updated = db.updateLabel(current.id, { ...values, surfaceNormalLocal: normal, snapDistance, resolutionStatus });
    if (input.positionLocal || hasExplicitNormal || flipNormal) invalidateMissionsUsingLabel(db, current.datasetId, current.id);
    return updated;
  });
  app.post<{ Params: { id: string } }>("/api/labels/:id/resolve", async (request, reply) => {
    const label = requireResource(db.getLabel(request.params.id));
    const dataset = requireResource(db.getDataset(label.datasetId));
    if (dataset.collisionStatus !== "ready") return reply.code(409).send({ error: "碰撞数据尚未就绪" });
    const world = await collisions.get(label.datasetId); const hit = world.snapSurface(label.positionLocal);
    const updated = hit
      ? db.updateLabel(label.id, { resolutionStatus: "resolved", surfaceNormalLocal: hit.normal, snapDistance: hit.distance })
      : db.updateLabel(label.id, { resolutionStatus: "unresolved", surfaceNormalLocal: null, snapDistance: null });
    invalidateMissionsUsingLabel(db, label.datasetId, label.id);
    return updated;
  });
  app.delete<{ Params: { id: string } }>("/api/labels/:id", async (request, reply) => {
    const label = requireResource(db.getLabel(request.params.id));
    const usingMissions = db.listMissionsUsingLabel(label.datasetId, label.id);
    if (usingMissions.length) {
      const names = usingMissions.slice(0, 3).map(mission => `“${mission.name}”`).join("、");
      const more = usingMissions.length > 3 ? `等 ${usingMissions.length} 个任务` : "";
      return reply.code(409).send({ error: `标签“${label.title}”正在被航迹任务 ${names}${more} 使用，请先永久删除这些任务` });
    }
    db.deleteLabel(request.params.id); return reply.code(204).send();
  });
}

function registerMissionRoutes(app: FastifyInstance, db: Database, collisions: CollisionRepository) {
  app.get<{ Querystring: { datasetId?: string } }>("/api/missions", async request => {
    if (request.query.datasetId) requireResource(db.getDataset(request.query.datasetId));
    return db.listMissions(request.query.datasetId);
  });
  app.post("/api/missions", async (request, reply) => {
    const input = createMissionSchema.parse(request.body); requireResource(db.getDataset(input.datasetId));
    getMissionLabels(db, input.datasetId, input.labelIds);
    getMissionStartLabel(db, input.datasetId, input.startLabelId, input.labelIds);
    const now = new Date().toISOString(); const mission: Mission = { ...input, id: randomUUID(), status: "draft", error: null, waypoints: [], createdAt: now, updatedAt: now };
    db.insertMission(mission); return reply.code(201).send(mission);
  });
  app.get<{ Params: { id: string } }>("/api/missions/:id", async request => requireResource(db.getMission(request.params.id)));
  app.patch<{ Params: { id: string } }>("/api/missions/:id", async request => {
    const mission = requireResource(db.getMission(request.params.id)); const input = patchMissionSchema.parse(request.body);
    // Create-contract defaults from a stale/shared build must never turn an
    // omitted nullable PATCH field into an explicit clear.
    const explicitlyPatchesStartLabel = typeof request.body === "object" && request.body !== null && Object.hasOwn(request.body, "startLabelId");
    const { startLabelId: _parsedStartLabelId, ...inputWithoutStartLabel } = input;
    const patch = explicitlyPatchesStartLabel ? input : inputWithoutStartLabel;
    const nextLabelIds = patch.labelIds ?? mission.labelIds;
    const nextStartLabelId = explicitlyPatchesStartLabel ? input.startLabelId ?? null : mission.startLabelId;
    getMissionLabels(db, mission.datasetId, nextLabelIds);
    getMissionStartLabel(db, mission.datasetId, nextStartLabelId, nextLabelIds);
    const affectsPlan = ["homeLocal", "startLabelId", "labelIds", "flightProfile"].some(key => Object.hasOwn(patch, key));
    if (affectsPlan) {
      return db.updateMissionAndWaypoints(request.params.id, { ...patch, status: "draft", error: null }, []);
    }
    return db.updateMission(request.params.id, patch);
  });
  app.post<{ Params: { id: string } }>("/api/missions/:id/plan", async (request, reply) => {
    const mission = requireResource(db.getMission(request.params.id)); const dataset = requireResource(db.getDataset(mission.datasetId));
    if (dataset.collisionStatus !== "ready") return reply.code(409).send({ error: "碰撞数据尚未就绪" });
    const labels = getMissionLabels(db, dataset.id, mission.labelIds);
    const startLabel = getMissionStartLabel(db, dataset.id, mission.startLabelId, mission.labelIds);
    db.updateMission(mission.id, { status: "planning", error: null });
    try {
      const result = planMission(mission.homeLocal, labels, mission.flightProfile, await collisions.get(dataset.id), startLabel);
      return db.updateMissionAndWaypoints(mission.id, { status: result.valid ? "valid" : "invalid", error: result.error }, result.waypoints);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.updateMissionAndWaypoints(mission.id, { status: "invalid", error: message.slice(0, 4000) }, []);
      throw error;
    }
  });
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/missions/:id/export", async (request, reply) => {
    const mission = requireResource(db.getMission(request.params.id)); if (mission.status !== "valid") return reply.code(409).send({ error: "只有校验通过的任务可以导出" });
    if (request.query.format === "geojson") return { type: "FeatureCollection", features: [{ type: "Feature", properties: { id: mission.id, name: mission.name, coordinateFrame: "model-local" }, geometry: { type: "LineString", coordinates: mission.waypoints.map(p => [p.positionLocal.x, p.positionLocal.y, p.positionLocal.z]) } }] };
    return { schemaVersion: "1.0", warning: "规划结果不能替代真实飞控与现场安全校验", mission };
  });
  app.delete<{ Params: { id: string } }>("/api/missions/:id", async (request, reply) => { requireResource(db.getMission(request.params.id)); db.deleteMission(request.params.id); return reply.code(204).send(); });
}

function requireResource<T>(value: T | null): T {
  if (!value) { const error = new Error("资源不存在") as Error & { statusCode: number }; error.statusCode = 404; throw error; }
  return value;
}

function isSafeRelativePath(value: string | undefined): value is string {
  if (!value || value.includes("\0") || path.isAbsolute(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

function invalidateMissionsUsingLabel(db: Database, datasetId: string, labelId: string) {
  for (const mission of db.listMissionsUsingLabel(datasetId, labelId)) {
    db.updateMissionAndWaypoints(mission.id, { status: "draft", error: "巡检标签几何信息已变更，需要重新规划" }, []);
  }
}

function getMissionLabels(db: Database, datasetId: string, labelIds: string[]): InspectionLabel[] {
  const labels = labelIds.map(id => db.getLabel(id));
  if (labels.some(label => !label)) throwHttpError(409, "任务包含不存在或已删除的标签");
  if (labels.some(label => label!.datasetId !== datasetId)) throwHttpError(409, "任务标签与 GS 数据集不属于同一场景");
  return labels as InspectionLabel[];
}

function getMissionStartLabel(db: Database, datasetId: string, startLabelId: string | null, labelIds: string[]): InspectionLabel | null {
  if (!startLabelId) return null;
  if (labelIds.includes(startLabelId)) throwHttpError(409, "起点标签不能在巡检顺序中重复出现");
  const label = db.getLabel(startLabelId);
  if (!label) throwHttpError(409, "任务起点标签不存在或已删除");
  if (label.datasetId !== datasetId) throwHttpError(409, "任务起点标签与 GS 数据集不属于同一场景");
  return label;
}

function throwHttpError(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode: number }; error.statusCode = statusCode; throw error;
}
