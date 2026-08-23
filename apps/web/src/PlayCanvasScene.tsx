import { useEffect, useRef, useState } from "react";
import {
  Application, Asset, Color, DEVICETYPE_WEBGPU, Entity, GSPLAT_RENDERER_RASTER_GPU_SORT, LINECAP_ROUND, LINEJOIN_ROUND,
  Vec3 as PcVec3, WideLine, WideLineRenderer, createGraphicsDevice
} from "playcanvas";
import type { Dataset, InspectionLabel, Mission, RenderManifest, SurfaceHit, Vec3 } from "@spikive/shared";
import { api } from "./api";
import { localToRender, normalizeVec3, renderToLocal } from "./gaussian-coordinates";
import { applyInspectionSceneState, type InspectionSceneState } from "./scene-state";
import { routeWaypointVisual } from "./route-visuals";
import { PerformanceMonitor } from "./PerformanceMonitor";

interface FocusRequest { datasetId: string; sequence: number }
interface PlayCanvasSceneProps {
  dataset: Dataset | null;
  labels: InspectionLabel[];
  mission: Mission | null;
  labelMode: boolean;
  pendingPick: SurfaceHit | null;
  selectedLabelId: string | null;
  focusRequest?: FocusRequest | null;
  onPickLabel: (hit: SurfaceHit) => void;
  onSelectLabel: (labelId: string) => void;
  onMessage: (message: string) => void;
  onFatal?: (message: string) => void;
}

interface PlayCanvasLodMeta {
  version: 1;
  count: number;
  counts: number[];
  lodLevels: number;
  filenames: string[];
  tree: LodTreeNode;
}
interface LodTreeNode {
  bound?: { min: [number, number, number]; max: [number, number, number] };
  lods?: Record<string, { file: number; offset: number; count: number }>;
  children?: LodTreeNode[];
}

export interface PlayCanvasDiagnostics {
  fps: number;
  averageFrameTimeMs: number;
  p95FrameTimeMs: number;
  maxFrameTimeMs: number;
  averageAppCpuTimeMs: number;
  maxAppCpuTimeMs: number;
  rendererCpuTimeMs: number;
  rendererBackend: string;
  sortMode: string;
  gpuResourceBytes: number;
  engineAllocatedBytes: number;
  drawCalls: number;
  vertices: number;
  geometries: number;
  textures: number;
  chunks: number;
  loadedChunks: number;
  loadedLevelChunks: number[];
  activeChunkLoads: number;
  completedChunkLoads: number;
  failedChunkLoads: number;
  averageChunkLoadMs: number;
  recentMaxChunkLoadMs: number;
  visibleSplats: number;
  sourceSplats: number;
  budget: number;
  effectiveBudget: number;
  minLevel: number;
  maxLevel: number;
  levels: number;
  revision: string;
  format: string;
  workBufferFormat: string;
  cameraDistance: number;
  fallbackReason: string | null;
}

interface PickProbe { x: number; y: number }

export function PlayCanvasScene(props: PlayCanvasSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const recoveryAttemptsRef = useRef(0);
  const [recoverySequence, setRecoverySequence] = useState(0);
  const latestSceneStateRef = useRef<InspectionSceneState>({
    labelMode: props.labelMode,
    labels: props.labels,
    mission: props.mission,
    pendingPick: props.pendingPick,
    selectedLabelId: props.selectedLabelId
  });
  latestSceneStateRef.current = {
    labelMode: props.labelMode,
    labels: props.labels,
    mission: props.mission,
    pendingPick: props.pendingPick,
    selectedLabelId: props.selectedLabelId
  };
  const [diagnostics, setDiagnostics] = useState<PlayCanvasDiagnostics | null>(null);
  const [pickProbe, setPickProbe] = useState<PickProbe | null>(null);
  const datasetId = props.dataset?.id ?? null;
  const visualRevision = props.dataset?.visualBackend === "playcanvas-sog" ? props.dataset.activeVisualRevision : null;

  useEffect(() => { recoveryAttemptsRef.current = 0; }, [datasetId, visualRevision]);
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const labelLayer = labelLayerRef.current;
    if (!container || !canvas || !labelLayer || !datasetId || !visualRevision) return;
    const controller = new AbortController();
    let runtime: SceneRuntime | null = null;
    let disposed = false;
    void createSceneRuntime({
      container,
      canvas,
      labelLayer,
      datasetId,
      signal: controller.signal,
      onDiagnostics: value => { if (!disposed) setDiagnostics(value); },
      onMessage: props.onMessage,
      onDeviceLost: message => {
        if (disposed) return;
        if (recoveryAttemptsRef.current < 1) {
          recoveryAttemptsRef.current += 1;
          props.onMessage(`${message}；正在执行一次有界重建`);
          setRecoverySequence(value => value + 1);
        } else {
          props.onFatal?.(`${message}；有界重建失败`);
        }
      },
      onPick: props.onPickLabel,
      onSelectLabel: props.onSelectLabel,
      onPickProbe: value => { if (!disposed) setPickProbe(value); }
    }).then(value => {
      if (disposed) { value.destroy(); return; }
      runtime = value;
      runtimeRef.current = value;
      applyInspectionSceneState(value, latestSceneStateRef.current);
    }).catch(error => {
      if (disposed || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      props.onMessage(`PlayCanvas 初始化失败：${message}`);
      props.onFatal?.(message);
    });
    return () => {
      disposed = true;
      controller.abort();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      runtime?.destroy();
      setDiagnostics(null);
      setPickProbe(null);
    };
    // Visual revisions are immutable; overlay and interaction changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, visualRevision, recoverySequence]);

  useEffect(() => runtimeRef.current?.setInteraction(props.labelMode), [props.labelMode]);
  useEffect(() => runtimeRef.current?.setOverlays(
    props.labels, props.mission, props.pendingPick, props.selectedLabelId
  ), [props.labels, props.mission, props.pendingPick, props.selectedLabelId]);
  useEffect(() => {
    if (props.focusRequest?.datasetId === datasetId) runtimeRef.current?.focus();
  }, [datasetId, props.focusRequest]);

  if (!props.dataset) return <div className="scene-empty">选择一个 GS 数据集</div>;
  if (props.dataset.visualBackend !== "playcanvas-sog" || !visualRevision) {
    return <div className="scene-empty">该场景尚未构建 PlayCanvas 流式 LOD，请先执行“构建 PlayCanvas 视觉”</div>;
  }
  return <div className={`playcanvas-scene ${props.labelMode ? "picking" : ""}`}>
    <div ref={containerRef} className="playcanvas-canvas"><canvas ref={canvasRef} /></div>
    <div ref={labelLayerRef} className="playcanvas-label-layer" />
    {pickProbe && <div className="gs-pick-probe" style={{ left: pickProbe.x, top: pickProbe.y }} role="status" aria-label="正在解析点击位置"><i /></div>}
    <PerformanceMonitor diagnostics={diagnostics} />
  </div>;
}

interface DomOverlay { element: HTMLElement; position: Vec3; interactive: boolean }
class SceneRuntime {
  private destroyed = false;
  private interaction = false;
  private labels: InspectionLabel[] = [];
  private mission: Mission | null = null;
  private pendingPick: SurfaceHit | null = null;
  private selectedLabelId: string | null = null;
  private domOverlays: DomOverlay[] = [];
  private readonly wideLineRenderer: WideLineRenderer;
  private frameCount = 0;
  private lastFpsTime = performance.now();
  private lastFrameTime = performance.now();
  private frameTimes: number[] = [];
  private appCpuTimeTotal = 0;
  private maxAppCpuTime = 0;
  private pointerStart: { id: number; x: number; y: number; button: number } | null = null;
  private yaw = Math.PI / 4;
  private pitch = 0.38;
  private distance: number;
  private readonly target: PcVec3;
  private readonly sceneCenter: PcVec3;
  private pickController: AbortController | null = null;
  private readonly cleanupListeners: Array<() => void> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly fileLevels: number[];

  constructor(
    private readonly app: Application,
    private readonly camera: Entity,
    private readonly gsplat: Entity,
    private readonly asset: Asset,
    private readonly container: HTMLDivElement,
    private readonly labelLayer: HTMLDivElement,
    private readonly manifest: RenderManifest,
    private readonly meta: PlayCanvasLodMeta,
    private readonly onPick: (hit: SurfaceHit) => void,
    private readonly onSelectLabel: (labelId: string) => void,
    private readonly onPickProbe: (value: PickProbe | null) => void,
    private readonly onMessage: (message: string) => void,
    private readonly onDiagnostics: (value: PlayCanvasDiagnostics) => void,
    private readonly onDeviceLost: (message: string) => void
  ) {
    const box = findTreeBound(meta.tree);
    const min = localToRender({ x: box.min[0], y: box.min[1], z: box.min[2] });
    const max = localToRender({ x: box.max[0], y: box.max[1], z: box.max[2] });
    const minRender = new PcVec3(Math.min(min.x, max.x), Math.min(min.y, max.y), Math.min(min.z, max.z));
    const maxRender = new PcVec3(Math.max(min.x, max.x), Math.max(min.y, max.y), Math.max(min.z, max.z));
    this.sceneCenter = minRender.clone().add(maxRender).mulScalar(0.5);
    this.target = this.sceneCenter.clone();
    this.distance = Math.max(2, maxRender.clone().sub(minRender).length() * 0.85);
    this.wideLineRenderer = new WideLineRenderer(app);
    this.fileLevels = mapFileLevels(meta.tree);
    this.wideLineRenderer.depthTest = false;
    this.wideLineRenderer.depthWrite = false;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindInput();
    const lostHandle = app.graphicsDevice.on("devicelost", () => {
      if (!this.destroyed) this.onDeviceLost(`PlayCanvas ${app.graphicsDevice.deviceType} 设备已丢失`);
    });
    this.cleanupListeners.push(() => lostHandle.off());
    app.on("update", this.updateFrame);
    this.cleanupListeners.push(() => app.off("update", this.updateFrame));
    this.focus();
    this.resize();
  }

  setInteraction(enabled: boolean) {
    this.interaction = enabled;
    for (const item of this.domOverlays) {
      if (item.interactive && item.element instanceof HTMLButtonElement) item.element.disabled = enabled;
    }
    if (!enabled) {
      this.pickController?.abort();
      this.onPickProbe(null);
    }
  }

  setOverlays(labels: InspectionLabel[], mission: Mission | null, pendingPick: SurfaceHit | null, selectedLabelId: string | null) {
    if (this.destroyed) return;
    this.labels = labels;
    this.mission = mission;
    this.pendingPick = pendingPick;
    this.selectedLabelId = selectedLabelId;
    this.rebuildOverlays();
  }

  focus() {
    this.target.copy(this.sceneCenter);
    this.yaw = Math.PI / 4;
    this.pitch = 0.38;
    this.applyCamera();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pickController?.abort();
    this.pickController = null;
    this.onPickProbe(null);
    this.resizeObserver.disconnect();
    for (const cleanup of this.cleanupListeners.splice(0)) cleanup();
    this.clearOverlays();
    this.wideLineRenderer.destroy();
    if (this.gsplat.gsplat) this.gsplat.removeComponent("gsplat");
    this.gsplat.destroy();
    this.asset.unload();
    this.app.assets.remove(this.asset);
    this.camera.destroy();
    this.labelLayer.replaceChildren();
    this.app.destroy();
  }

  private readonly updateFrame = () => {
    if (this.destroyed) return;
    const startedAt = performance.now();
    const frameTime = startedAt - this.lastFrameTime;
    this.lastFrameTime = startedAt;
    if (frameTime > 0 && frameTime < 10_000) this.frameTimes.push(frameTime);
    this.updateDomOverlays();
    const appCpuTime = performance.now() - startedAt;
    this.appCpuTimeTotal += appCpuTime;
    this.maxAppCpuTime = Math.max(this.maxAppCpuTime, appCpuTime);
    this.frameCount += 1;
    const now = performance.now();
    if (now - this.lastFpsTime < 1000) return;
    const stats = this.app.stats;
    const frameTimes = [...this.frameTimes].sort((a, b) => a - b);
    const resource = this.asset.resource as unknown as { octree?: { fileResources?: Map<number, unknown>; files?: unknown[] } };
    const loadedChunks = resource?.octree?.fileResources?.size ?? 0;
    const totalChunks = resource?.octree?.files?.length ?? this.meta.filenames.length;
    const loadedLevelChunks = new Array(this.meta.lodLevels).fill(0) as number[];
    for (const fileIndex of resource?.octree?.fileResources?.keys() ?? []) {
      const level = this.fileLevels[fileIndex];
      if (level !== undefined) loadedLevelChunks[level] = loadedLevelChunks[level]! + 1;
    }
    const renderer = this.app.scene.gsplat.currentRenderer;
    const gpuResourceBytes = Object.values(stats.vram).reduce((sum, value) => sum + finiteOrZero(value), 0);
    const budget = finiteOrZero(this.app.scene.gsplat.splatBudget);
    this.onDiagnostics({
      fps: Math.round(this.frameCount * 1000 / (now - this.lastFpsTime)),
      averageFrameTimeMs: average(frameTimes),
      p95FrameTimeMs: percentile(frameTimes, 0.95),
      maxFrameTimeMs: frameTimes.at(-1) ?? 0,
      averageAppCpuTimeMs: this.frameCount > 0 ? this.appCpuTimeTotal / this.frameCount : 0,
      maxAppCpuTimeMs: this.maxAppCpuTime,
      rendererCpuTimeMs: finiteOrZero(stats.frame.renderTime),
      rendererBackend: this.app.graphicsDevice.deviceType.toUpperCase(),
      sortMode: renderer === GSPLAT_RENDERER_RASTER_GPU_SORT ? "GPU SORT" : "CPU SORT",
      gpuResourceBytes,
      engineAllocatedBytes: 0,
      drawCalls: finiteOrZero(stats.drawCalls.total),
      vertices: finiteOrZero(stats.frame.triangles) * 3,
      geometries: finiteOrZero(stats.drawCalls.forward),
      textures: finiteOrZero(stats.vram.texAsset),
      chunks: totalChunks,
      loadedChunks,
      loadedLevelChunks,
      activeChunkLoads: 0,
      completedChunkLoads: loadedChunks,
      failedChunkLoads: 0,
      averageChunkLoadMs: 0,
      recentMaxChunkLoadMs: 0,
      visibleSplats: finiteOrZero(stats.frame.gsplats),
      sourceSplats: this.meta.counts[0]!,
      budget,
      effectiveBudget: budget,
      minLevel: this.gsplat.gsplat?.lodRangeMin ?? 0,
      maxLevel: Math.min(this.meta.lodLevels - 1, this.gsplat.gsplat?.lodRangeMax ?? this.meta.lodLevels - 1),
      levels: this.meta.lodLevels,
      revision: this.manifest.activeVisualRevision,
      format: "Official Streamed SOG",
      workBufferFormat: "PlayCanvas engine default",
      cameraDistance: this.distance,
      fallbackReason: this.app.graphicsDevice.deviceType === "webgpu" ? null : "WebGPU 不可用，已使用 WebGL2 基本巡检回退"
    });
    this.frameCount = 0;
    this.frameTimes = [];
    this.appCpuTimeTotal = 0;
    this.maxAppCpuTime = 0;
    this.lastFpsTime = now;
  };

  private resize() {
    if (this.destroyed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.app.resizeCanvas(width, height);
  }

  private applyCamera() {
    const cosPitch = Math.cos(this.pitch);
    this.camera.setPosition(
      this.target.x + this.distance * cosPitch * Math.sin(this.yaw),
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + this.distance * cosPitch * Math.cos(this.yaw)
    );
    this.camera.lookAt(this.target);
  }

  private bindInput() {
    const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement;
    const onPointerDown = (event: PointerEvent) => {
      this.pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, button: event.button };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const start = this.pointerStart;
      if (!start || start.id !== event.pointerId || this.interaction) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      if (start.button === 2 || event.shiftKey) {
        const scale = Math.max(0.001, this.distance * 0.0015);
        const right = this.camera.right.clone().mulScalar(-dx * scale);
        const up = this.camera.up.clone().mulScalar(dy * scale);
        this.target.add(right).add(up);
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.005));
      }
      start.x = event.clientX;
      start.y = event.clientY;
      this.applyCamera();
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = this.pointerStart;
      this.pointerStart = null;
      if (!start || start.id !== event.pointerId || !this.interaction || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      void this.pick(event, true);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      this.distance = Math.max(0.15, this.distance * Math.exp(event.deltaY * 0.001));
      this.applyCamera();
    };
    const onDoubleClick = (event: MouseEvent) => {
      if (this.interaction) return;
      event.preventDefault();
      void this.pick(event, false).then(hit => {
        if (!hit || this.destroyed) return;
        this.target.copy(toPc(localToRender(hit.position)));
        this.distance = Math.max(1, this.distance * 0.35);
        this.applyCamera();
        this.onMessage("已定位到碰撞 SVO 命中位置");
      });
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("contextmenu", onContextMenu);
    this.cleanupListeners.push(
      () => canvas.removeEventListener("pointerdown", onPointerDown),
      () => canvas.removeEventListener("pointermove", onPointerMove),
      () => canvas.removeEventListener("pointerup", onPointerUp),
      () => canvas.removeEventListener("pointercancel", onPointerUp),
      () => canvas.removeEventListener("wheel", onWheel),
      () => canvas.removeEventListener("dblclick", onDoubleClick),
      () => canvas.removeEventListener("contextmenu", onContextMenu)
    );
  }

  private async pick(event: MouseEvent | PointerEvent, emit: boolean) {
    if (this.destroyed || !this.camera.camera) return null;
    const rect = this.container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const originRender = this.camera.getPosition();
    const nearPoint = this.camera.camera.screenToWorld(x, y, this.camera.camera.nearClip, new PcVec3());
    const origin = renderToLocal(originRender);
    const direction = normalizeVec3(renderToLocal(nearPoint.sub(originRender).normalize()));
    if (!direction) return null;
    const controller = new AbortController();
    this.pickController?.abort();
    this.pickController = controller;
    this.onPickProbe({ x, y });
    this.onMessage(emit ? "正在通过碰撞 SVO 解析 GS 表面与法向…" : "正在定位碰撞 SVO 表面…");
    try {
      const hit = await api.raycastDataset(this.manifest.datasetId, { originLocal: origin, directionLocal: direction }, controller.signal);
      if (this.destroyed) return null;
      if (!hit) { this.onMessage("该射线未命中碰撞 SVO，请换一个角度或确认碰撞数据覆盖"); return null; }
      if (emit) this.onPick(hit);
      return hit;
    } catch (error) {
      if (!this.destroyed && !controller.signal.aborted) this.onMessage(`SVO 拾取失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      if (this.pickController === controller) {
        this.pickController = null;
        this.onPickProbe(null);
      }
    }
  }

  private rebuildOverlays() {
    this.clearOverlays();
    for (const label of this.labels) {
      const selected = label.id === this.selectedLabelId;
      this.addPoint(label.positionLocal, "#e32636", selected ? 16 : 12, selected);
      this.addDomLabel(label.title, label.positionLocal, "inspection", label.id, selected);
      if (label.surfaceNormalLocal) this.addNormal(label.positionLocal, label.surfaceNormalLocal, "#f97316");
    }
    if (this.pendingPick) {
      this.addPoint(this.pendingPick.position, "#ff7900", 14, false);
      this.addNormal(this.pendingPick.position, this.pendingPick.normal, "#ff7900");
      this.addDomLabel("待保存标签", this.pendingPick.position, "pending");
    }
    if (!this.mission) return;
    const labelById = new Map(this.labels.map(label => [label.id, label]));
    this.mission.waypoints.forEach((point, index) => {
      const label = point.targetLabelId ? labelById.get(point.targetLabelId) : null;
      const visual = routeWaypointVisual(point, index, label?.title);
      this.addPoint(point.positionLocal, visual.color, visual.pixelSize, false);
    });
    const routeColor = this.mission.status === "valid" ? "#16a34a" : "#f97316";
    this.addRoute(this.mission.waypoints.map(point => point.positionLocal), routeColor, 4);
  }

  private addPoint(position: Vec3, color: string, size: number, selected: boolean) {
    const element = document.createElement("i");
    element.className = `playcanvas-space-point${selected ? " selected" : ""}`;
    element.style.setProperty("--point-color", color);
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
    this.labelLayer.append(element);
    this.domOverlays.push({ element, position, interactive: false });
  }

  private addRoute(points: Vec3[], color: string, width = 2) {
    if (points.length < 2) return;
    const positions = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      const render = localToRender(point);
      positions[index * 3] = render.x;
      positions[index * 3 + 1] = render.y;
      positions[index * 3 + 2] = render.z;
    });
    const line = new WideLine();
    line.set(positions, colorFromHex(color), width);
    line.cap = LINECAP_ROUND;
    line.join = LINEJOIN_ROUND;
    this.wideLineRenderer.add(line);
  }

  private addNormal(position: Vec3, normal: Vec3, color: string) {
    this.addRoute([position, { x: position.x + normal.x, y: position.y + normal.y, z: position.z + normal.z }], color);
  }

  private addDomLabel(text: string, position: Vec3, kind: "inspection" | "pending", labelId?: string, selected = false) {
    const interactive = kind === "inspection" && Boolean(labelId);
    const element = interactive ? document.createElement("button") : document.createElement("span");
    element.className = `playcanvas-space-label ${kind}`;
    if (selected) element.classList.add("selected");
    element.textContent = text;
    if (element instanceof HTMLButtonElement && labelId) {
      element.type = "button";
      element.disabled = this.interaction;
      element.setAttribute("aria-label", `查看巡检对象 ${text}`);
      element.setAttribute("aria-pressed", String(selected));
      element.addEventListener("click", event => {
        event.stopPropagation();
        if (!this.interaction && !this.destroyed) this.onSelectLabel(labelId);
      });
    }
    this.labelLayer.append(element);
    this.domOverlays.push({ element, position, interactive });
  }

  private updateDomOverlays() {
    if (!this.camera.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const cameraPosition = this.camera.getPosition();
    const cameraForward = this.camera.forward;
    for (const item of this.domOverlays) {
      const renderPosition = toPc(localToRender(item.position));
      const screen = this.camera.camera.worldToScreen(renderPosition, new PcVec3());
      const inFront = renderPosition.clone().sub(cameraPosition).dot(cameraForward) > 0;
      const visible = inFront && screen.x >= -20 && screen.x <= width + 20 && screen.y >= -20 && screen.y <= height + 20;
      item.element.hidden = !visible;
      if (!visible) continue;
      const isPoint = item.element.classList.contains("playcanvas-space-point");
      item.element.style.transform = isPoint
        ? `translate(${screen.x}px, ${screen.y}px) translate(-50%, -50%)`
        : `translate(${screen.x}px, ${screen.y}px) translate(-50%, calc(-100% - 12px))`;
    }
  }

  private clearOverlays() {
    this.wideLineRenderer.clear();
    this.domOverlays = [];
    this.labelLayer.replaceChildren();
  }
}

async function createSceneRuntime(options: {
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  labelLayer: HTMLDivElement;
  datasetId: string;
  signal: AbortSignal;
  onPick: (hit: SurfaceHit) => void;
  onSelectLabel: (labelId: string) => void;
  onPickProbe: (value: PickProbe | null) => void;
  onMessage: (message: string) => void;
  onDiagnostics: (value: PlayCanvasDiagnostics) => void;
  onDeviceLost: (message: string) => void;
}) {
  const manifest = await api.renderManifest(options.datasetId, options.signal);
  options.signal.throwIfAborted();
  const response = await fetch(manifest.playcanvas.lodMetaUrl, { signal: options.signal, cache: "no-store" });
  if (!response.ok) throw new Error(`LOD meta HTTP ${response.status}`);
  const meta = await response.json() as PlayCanvasLodMeta;
  options.signal.throwIfAborted();
  const manifestCounts = manifest.playcanvas.levels.map(level => level.splatCount);
  if (
    meta.version !== 1 || meta.lodLevels < 1 || meta.counts.length !== meta.lodLevels ||
    meta.lodLevels !== manifestCounts.length || meta.counts.some((count, level) => count !== manifestCounts[level]) ||
    meta.counts[0] !== manifest.source.splatCount
  ) {
    throw new Error("PlayCanvas LOD meta 未通过前端契约检查");
  }
  const device = await createGraphicsDevice(options.canvas, {
    deviceTypes: [DEVICETYPE_WEBGPU]
  });
  if (options.signal.aborted) { device.destroy(); options.signal.throwIfAborted(); }
  const app = new Application(options.canvas, { graphicsDevice: device });
  const camera = new Entity("inspection-camera");
  const gsplat = new Entity("playcanvas-streamed-sog");
  const asset = new Asset(`sog-${options.datasetId}`, "gsplat", { url: manifest.playcanvas.lodMetaUrl, filename: "lod-meta.json" });
  try {
    camera.addComponent("camera", { clearColor: new Color(1, 1, 1), fov: 55, nearClip: 0.02, farClip: 100_000 });
    app.root.addChild(camera);
    gsplat.setLocalEulerAngles(-90, 0, 0);
    app.root.addChild(gsplat);
    app.assets.add(asset);
    app.start();
    const abortAsset = () => asset.unload();
    options.signal.addEventListener("abort", abortAsset, { once: true });
    try {
      await loadAsset(asset, app, options.signal);
    } finally {
      options.signal.removeEventListener("abort", abortAsset);
    }
    options.signal.throwIfAborted();
    gsplat.addComponent("gsplat", { asset });
    return new SceneRuntime(
      app, camera, gsplat, asset, options.container, options.labelLayer, manifest, meta,
      options.onPick, options.onSelectLabel, options.onPickProbe, options.onMessage, options.onDiagnostics, options.onDeviceLost
    );
  } catch (error) {
    asset.unload();
    app.assets.remove(asset);
    camera.destroy();
    gsplat.destroy();
    app.destroy();
    throw error;
  }
}

function loadAsset(asset: Asset, app: Application, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      asset.off("load", onLoad);
      asset.off("error", onError);
      callback();
    };
    const onLoad = () => finish(resolve);
    const onError = (error: unknown) => finish(() => reject(new Error(`PlayCanvas 流式 LOD 加载失败：${String(error)}`)));
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
    asset.on("load", onLoad);
    asset.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    app.assets.load(asset);
  });
}

type LodBound = { min: [number, number, number]; max: [number, number, number] };
function mapFileLevels(tree: LodTreeNode) {
  const result: number[] = [];
  const visit = (node: LodTreeNode) => {
    for (const [levelText, reference] of Object.entries(node.lods ?? {})) {
      const level = Number(levelText);
      if (Number.isInteger(level) && Number.isInteger(reference.file)) result[reference.file] = level;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return result;
}

function findTreeBound(tree: LodTreeNode): LodBound {
  if (tree.bound) return tree.bound;
  const bounds: LodBound[] = (tree.children ?? []).map(findTreeBound);
  if (!bounds.length) throw new Error("PlayCanvas LOD meta 缺少根包围体");
  return {
    min: [0, 1, 2].map(axis => Math.min(...bounds.map(box => box.min[axis]!))) as [number, number, number],
    max: [0, 1, 2].map(axis => Math.max(...bounds.map(box => box.max[axis]!))) as [number, number, number]
  };
}

const toPc = (value: Vec3) => new PcVec3(value.x, value.y, value.z);
const finiteOrZero = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const percentile = (sorted: number[], ratio: number) => sorted.length > 0 ? sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]! : 0;
function colorFromHex(value: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  const numeric = Number.parseInt(match?.[1] ?? "ffffff", 16);
  return new Color(((numeric >> 16) & 255) / 255, ((numeric >> 8) & 255) / 255, (numeric & 255) / 255);
}
