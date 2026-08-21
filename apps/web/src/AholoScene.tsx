import { useEffect, useRef, useState } from "react";
import {
  BackgroundMode, BufferAttribute, BufferGeometry, Color, DrawableRenderMode, FatLineBufferGeometry, FatLineMaterial,
  FatLineSegments, PerspectiveCamera, Raycaster, SplatLoader, SplatUtils, Sprite, SpriteMaterial, Vector2, Vector3,
  createViewer, createViewerContext, setViewerConfig, type Object3D, type Viewer
} from "@manycore/aholo-viewer";
import type { Dataset, InspectionLabel, Mission, RenderManifest, SurfaceHit, Vec3 } from "@spikive/shared";
import { api } from "./api";
import { aholoToLocal, localToAholo, normalizeVec3 } from "./aholo-coordinates";
import { applyAholoSceneState, type AholoSceneState } from "./aholo-scene-state";
import { routeWaypointVisual } from "./route-visuals";
import { AholoTuningPanel } from "./AholoTuningPanel";
import {
  DEFAULT_AHOLO_RUNTIME_CONFIG, normalizeAholoRuntimeConfig, toAholoLodConfig, type AholoRuntimeConfig
} from "./aholo-runtime-config";

interface FocusRequest { datasetId: string; sequence: number }
interface AholoSceneProps {
  dataset: Dataset | null;
  labels: InspectionLabel[];
  mission: Mission | null;
  labelMode: boolean;
  pendingPick: SurfaceHit | null;
  selectedLabelId: string | null;
  focusRequest?: FocusRequest | null;
  referenceFormat?: boolean;
  showDiagnostics?: boolean;
  onPickLabel: (hit: SurfaceHit) => void;
  onSelectLabel: (labelId: string) => void;
  onMessage: (message: string) => void;
  onFatal?: (message: string) => void;
}

interface LodMeta {
  magicCode: 2500660;
  type: "lod-splat";
  version: string;
  counts: number;
  shDegree: number;
  levels: number;
  files: string[];
  forwardBox: { min: [number, number, number]; max: [number, number, number] };
  permanentFiles: number[];
  tree: Array<{ bound: { min: [number, number, number]; max: [number, number, number] }; lods: Array<{ file: number; offset: number; count: number }> }>;
}

interface Diagnostics {
  fps: number;
  chunks: number;
  sourceSplats: number;
  budget: number;
  minLevel: number;
  levels: number;
  revision: string;
  format: string;
}
interface PickProbe { x: number; y: number }

class AholoChunkLoadCancelledError extends Error {
  constructor() {
    super("AHoLo chunk load cancelled");
    this.name = "AholoChunkLoadCancelledError";
  }
}

class CancellableChunkLoader {
  private readonly controller = new AbortController();
  private activeLoads = 0;
  private disposed = false;
  private cleanupTimer: number | null = null;

  constructor(
    private readonly fileType: SplatLoader.SplatFileType,
    private readonly parentSignal: AbortSignal
  ) {
    parentSignal.addEventListener("abort", this.dispose, { once: true });
    window.addEventListener("unhandledrejection", this.onUnhandledRejection);
  }

  readonly load = async (url: string) => {
    if (this.disposed) throw new AholoChunkLoadCancelledError();
    this.activeLoads += 1;
    try {
      const response = await fetch(url, { signal: this.controller.signal, cache: "force-cache" });
      if (!response.ok) throw new Error(`AHoLo chunk HTTP ${response.status}: ${url}`);
      if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return await SplatLoader.parseSplatData(
          this.fileType,
          bytes,
          SplatLoader.SplatPackType.SuperCompressed
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return await SplatLoader.parseSplatData(
          this.fileType,
          bytes,
          SplatLoader.SplatPackType.SuperCompressed
        );
      }
      return await SplatLoader.parseSplatData(
        this.fileType,
        { stream: response.body, contentLength },
        SplatLoader.SplatPackType.SuperCompressed
      );
    } catch (error) {
      if (this.controller.signal.aborted) throw new AholoChunkLoadCancelledError();
      throw error;
    } finally {
      this.activeLoads -= 1;
      this.scheduleListenerCleanupIfIdle();
    }
  };

  readonly dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.parentSignal.removeEventListener("abort", this.dispose);
    this.controller.abort();
    this.scheduleListenerCleanupIfIdle();
  };

  private readonly onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (event.reason instanceof AholoChunkLoadCancelledError) event.preventDefault();
  };

  private scheduleListenerCleanupIfIdle() {
    if (!this.disposed || this.activeLoads > 0 || this.cleanupTimer !== null) return;
    // LodSplat's internal async loop owns the load promise. Keep this exact-error
    // filter for one task so its cancellation rejection can reach the browser.
    this.cleanupTimer = window.setTimeout(() => {
      window.removeEventListener("unhandledrejection", this.onUnhandledRejection);
      this.cleanupTimer = null;
    }, 0);
  }
}

export function AholoScene(props: AholoSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const latestSceneStateRef = useRef<AholoSceneState>({
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
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [pickProbe, setPickProbe] = useState<PickProbe | null>(null);
  const [runtimeConfig, setRuntimeConfig] = useState<AholoRuntimeConfig>({ ...DEFAULT_AHOLO_RUNTIME_CONFIG });
  const datasetId = props.dataset?.id ?? null;
  const candidateRevision = props.dataset?.aholoVisualRevision ?? null;

  useEffect(() => {
    const container = containerRef.current;
    const labelLayer = labelLayerRef.current;
    if (!container || !labelLayer || !datasetId || !candidateRevision) return;
    const controller = new AbortController();
    let runtime: SceneRuntime | null = null;
    let disposed = false;
    void createSceneRuntime({
      container,
      labelLayer,
      datasetId,
      referenceFormat: Boolean(props.referenceFormat),
      runtimeConfig,
      signal: controller.signal,
      onDiagnostics: value => { if (!disposed) setDiagnostics(value); },
      onMessage: props.onMessage,
      onFatal: message => { if (!disposed) props.onFatal?.(message); },
      onPick: props.onPickLabel,
      onSelectLabel: props.onSelectLabel,
      onPickProbe: value => { if (!disposed) setPickProbe(value); }
    }).then(value => {
      if (disposed) { value.destroy(); return; }
      runtime = value;
      runtimeRef.current = value;
      setRuntimeConfig(value.getRuntimeConfig());
      applyAholoSceneState(value, latestSceneStateRef.current);
    }).catch(error => {
      if (disposed || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      props.onMessage(`AHoLo 初始化失败：${message}`);
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
    // The revision is immutable; overlay and interaction changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, candidateRevision, props.referenceFormat]);

  useEffect(() => runtimeRef.current?.setInteraction(props.labelMode), [props.labelMode]);
  useEffect(() => {
    const applied = runtimeRef.current?.setRuntimeConfig(runtimeConfig);
    if (applied && !sameRuntimeConfig(applied, runtimeConfig)) setRuntimeConfig(applied);
  }, [runtimeConfig]);
  useEffect(() => runtimeRef.current?.setOverlays(
    props.labels, props.mission, props.pendingPick, props.selectedLabelId
  ), [props.labels, props.mission, props.pendingPick, props.selectedLabelId]);
  useEffect(() => {
    if (props.focusRequest?.datasetId === datasetId) runtimeRef.current?.focus();
  }, [datasetId, props.focusRequest]);

  if (!props.dataset) return <div className="scene-empty">选择一个 GS 数据集</div>;
  if (!candidateRevision) return <div className="scene-empty">该场景尚未构建 AHoLo 候选视觉，请先执行“构建 AHoLo 候选”</div>;
  return <div className={`aholo-scene ${props.labelMode ? "picking" : ""}`}>
    <div ref={containerRef} className="aholo-canvas" />
    <div ref={labelLayerRef} className="aholo-label-layer" />
    {pickProbe && <div className="gs-pick-probe" style={{ left: pickProbe.x, top: pickProbe.y }} role="status" aria-label="正在解析点击位置"><i /></div>}
    <AholoTuningPanel
      value={runtimeConfig}
      maxLevel={Math.max(0, (diagnostics?.levels ?? 5) - 1)}
      sourceSplats={diagnostics?.sourceSplats ?? 16_000_000}
      onApply={value => setRuntimeConfig(value)}
      onMessage={props.onMessage}
    />
    {props.showDiagnostics && diagnostics && <div className="aholo-diagnostics">
      <span>AHoLo WebGL2</span>
      <span>{diagnostics.format}</span>
      <span>{diagnostics.fps} FPS</span>
      <span>minLevel {diagnostics.minLevel} / {diagnostics.levels - 1}</span>
      <span>{formatCount(diagnostics.budget)} / {formatCount(diagnostics.sourceSplats)} GS budget</span>
      <span>{diagnostics.chunks} chunks · rev {diagnostics.revision.slice(0, 8)}</span>
    </div>}
  </div>;
}

class SceneRuntime {
  private destroyed = false;
  private interaction = false;
  private labels: InspectionLabel[] = [];
  private mission: Mission | null = null;
  private pendingPick: SurfaceHit | null = null;
  private selectedLabelId: string | null = null;
  private overlayObjects: Object3D[] = [];
  private labelElements: Array<{ element: HTMLElement; position: Vec3; interactive: boolean }> = [];
  private renderFrame = 0;
  private frameCount = 0;
  private lastFpsTime = performance.now();
  private pointerStart: { id: number; x: number; y: number } | null = null;
  private yaw = Math.PI / 4;
  private pitch = 0.38;
  private distance: number;
  private readonly target: Vector3;
  private readonly sceneCenter: Vector3;
  private readonly localCamera: PerspectiveCamera;
  private readonly raycaster = new Raycaster();
  private pickController: AbortController | null = null;
  private readonly cleanupListeners: Array<() => void> = [];
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly viewer: Viewer,
    private readonly camera: PerspectiveCamera,
    private readonly lod: InstanceType<typeof SplatUtils.LodSplat>,
    private readonly chunkLoader: CancellableChunkLoader,
    private readonly container: HTMLDivElement,
    private readonly labelLayer: HTMLDivElement,
    private readonly manifest: RenderManifest,
    private readonly meta: LodMeta,
    private runtimeConfig: AholoRuntimeConfig,
    private readonly format: string,
    private readonly onPick: (hit: SurfaceHit) => void,
    private readonly onSelectLabel: (labelId: string) => void,
    private readonly onPickProbe: (value: PickProbe | null) => void,
    private readonly onMessage: (message: string) => void,
    private readonly onDiagnostics: (value: Diagnostics) => void,
    private readonly onFatal: (message: string) => void
  ) {
    const min = localToAholo({ x: meta.forwardBox.min[0], y: meta.forwardBox.min[1], z: meta.forwardBox.min[2] });
    const max = localToAholo({ x: meta.forwardBox.max[0], y: meta.forwardBox.max[1], z: meta.forwardBox.max[2] });
    const minRender = { x: Math.min(min.x, max.x), y: Math.min(min.y, max.y), z: Math.min(min.z, max.z) };
    const maxRender = { x: Math.max(min.x, max.x), y: Math.max(min.y, max.y), z: Math.max(min.z, max.z) };
    this.sceneCenter = new Vector3(
      (minRender.x + maxRender.x) / 2,
      (minRender.y + maxRender.y) / 2,
      (minRender.z + maxRender.z) / 2
    );
    this.target = this.sceneCenter.clone();
    const diagonal = Math.hypot(maxRender.x - minRender.x, maxRender.y - minRender.y, maxRender.z - minRender.z);
    this.distance = Math.max(2, diagonal * 0.85);
    this.localCamera = new PerspectiveCamera(camera.fov, camera.aspect, camera.near, camera.far);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindInput();
    this.focus();
    this.lod.start();
    this.renderFrame = requestAnimationFrame(() => this.render());
  }

  setInteraction(enabled: boolean) {
    this.interaction = enabled;
    for (const item of this.labelElements) {
      if (item.interactive && item.element instanceof HTMLButtonElement) item.element.disabled = enabled;
    }
    if (!enabled) {
      this.pickController?.abort();
      this.onPickProbe(null);
    }
  }

  getRuntimeConfig() { return { ...this.runtimeConfig }; }

  setRuntimeConfig(value: AholoRuntimeConfig) {
    const next = normalizeAholoRuntimeConfig(value, this.meta.levels - 1, this.meta.counts);
    this.runtimeConfig = next;
    this.lod.setConfig(toAholoLodConfig(next));
    return { ...next };
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
    cancelAnimationFrame(this.renderFrame);
    this.pickController?.abort();
    this.pickController = null;
    this.onPickProbe(null);
    this.resizeObserver.disconnect();
    for (const cleanup of this.cleanupListeners.splice(0)) cleanup();
    this.chunkLoader.dispose();
    this.clearOverlays();
    this.lod.destroy();
    this.viewer.destroy();
    this.labelLayer.replaceChildren();
  }

  private render = () => {
    if (this.destroyed) return;
    this.syncLocalLodCamera();
    this.lod.tick(this.localCamera);
    this.viewer.render();
    this.updateDomLabels();
    this.frameCount += 1;
    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      this.onDiagnostics({
        fps: Math.round(this.frameCount * 1000 / (now - this.lastFpsTime)),
        chunks: this.meta.files.length,
        sourceSplats: this.meta.counts,
        budget: this.runtimeConfig.maxBudget,
        minLevel: this.runtimeConfig.minLevel,
        levels: this.meta.levels,
        revision: this.manifest.activeVisualRevision,
        format: this.format
      });
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
    this.renderFrame = requestAnimationFrame(this.render);
  };

  private resize() {
    if (this.destroyed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewer.resize();
  }

  private applyCamera() {
    const cosPitch = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + this.distance * cosPitch * Math.sin(this.yaw),
      this.target.y + this.distance * Math.sin(this.pitch),
      this.target.z + this.distance * cosPitch * Math.cos(this.yaw)
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld(true);
  }

  private syncLocalLodCamera() {
    const position = aholoToLocal(this.camera.position);
    const directionRender = this.camera.getWorldDirection(new Vector3());
    const direction = aholoToLocal(directionRender);
    const up = aholoToLocal(this.camera.up);
    this.localCamera.fov = this.camera.fov;
    this.localCamera.aspect = this.camera.aspect;
    this.localCamera.near = this.camera.near;
    this.localCamera.far = this.camera.far;
    this.localCamera.updateProjectionMatrix();
    this.localCamera.position.set(position.x, position.y, position.z);
    this.localCamera.up.set(up.x, up.y, up.z);
    this.localCamera.lookAt(new Vector3(position.x + direction.x, position.y + direction.y, position.z + direction.z));
    this.localCamera.updateMatrixWorld(true);
  }

  private bindInput() {
    const onPointerDown = (event: PointerEvent) => {
      this.pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.container.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const start = this.pointerStart;
      if (!start || start.id !== event.pointerId || this.interaction) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy * 0.005));
      start.x = event.clientX;
      start.y = event.clientY;
      this.applyCamera();
    };
    const onPointerUp = (event: PointerEvent) => {
      const start = this.pointerStart;
      this.pointerStart = null;
      if (!start || start.id !== event.pointerId || !this.interaction || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      void this.pick(event);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      this.distance = Math.max(0.15, this.distance * Math.exp(event.deltaY * 0.001));
      this.applyCamera();
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      this.onFatal("AHoLo WebGL 上下文已丢失；候选 Renderer 已停止，请回滚 Cesium");
      this.destroy();
    };
    this.container.addEventListener("pointerdown", onPointerDown);
    this.container.addEventListener("pointermove", onPointerMove);
    this.container.addEventListener("pointerup", onPointerUp);
    this.container.addEventListener("pointercancel", onPointerUp);
    this.container.addEventListener("wheel", onWheel, { passive: false });
    const canvas = this.container.querySelector("canvas");
    canvas?.addEventListener("webglcontextlost", onContextLost);
    this.cleanupListeners.push(
      () => this.container.removeEventListener("pointerdown", onPointerDown),
      () => this.container.removeEventListener("pointermove", onPointerMove),
      () => this.container.removeEventListener("pointerup", onPointerUp),
      () => this.container.removeEventListener("pointercancel", onPointerUp),
      () => this.container.removeEventListener("wheel", onWheel),
      () => canvas?.removeEventListener("webglcontextlost", onContextLost)
    );
  }

  private async pick(event: PointerEvent) {
    if (this.destroyed) return;
    const rect = this.container.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 2 - 1;
    const y = 1 - (event.clientY - rect.top) / rect.height * 2;
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new Vector2(x, y), this.camera, rect.height);
    const origin = aholoToLocal(this.raycaster.ray.origin);
    const rawDirection = aholoToLocal(this.raycaster.ray.direction);
    const direction = normalizeVec3(rawDirection);
    if (!direction) return;
    const controller = new AbortController();
    this.pickController?.abort();
    this.pickController = controller;
    this.onPickProbe({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    this.onMessage("正在通过碰撞 SVO 解析 GS 表面与法向…");
    try {
      const hit = await api.raycastDataset(this.manifest.datasetId, { originLocal: origin, directionLocal: direction }, controller.signal);
      if (this.destroyed) return;
      if (!hit) { this.onMessage("该射线未命中碰撞 SVO，请换一个角度或确认碰撞数据覆盖"); return; }
      this.onPick(hit);
    } catch (error) {
      if (!this.destroyed && !controller.signal.aborted) this.onMessage(`标签拾取失败：${error instanceof Error ? error.message : String(error)}`);
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
      if (selected) this.addPoints([label.positionLocal], "#0b63f6", 24);
      this.addPoints([label.positionLocal], label.color, selected ? 16 : 12);
      this.addDomLabel(label.title, label.positionLocal, "inspection", label.id, selected);
    }
    if (this.pendingPick) {
      this.addPoints([this.pendingPick.position], "#ff7900", 14);
      this.addNormal(this.pendingPick.position, this.pendingPick.normal, "#ff7900");
      this.addDomLabel("待保存标签", this.pendingPick.position, "pending");
    }
    for (const label of this.labels) {
      if (label.surfaceNormalLocal) this.addNormal(label.positionLocal, label.surfaceNormalLocal, "#f97316");
    }
    if (!this.mission) return;

    const labelById = new Map(this.labels.map(label => [label.id, label]));
    this.mission.waypoints.forEach((point, index) => {
      const label = point.targetLabelId ? labelById.get(point.targetLabelId) : null;
      const visual = routeWaypointVisual(point, index, label?.title);
      this.addPoints([point.positionLocal], visual.color, visual.pixelSize);
    });
    const routeColor = this.mission.status === "valid" ? "#16a34a" : "#f97316";
    this.addRoute(this.mission.waypoints.map(point => point.positionLocal), routeColor);
  }

  private addPoints(points: Vec3[], color: string, size: number) {
    for (const point of points) {
      const value = localToAholo(point);
      const material = new SpriteMaterial({
        color, opacity: 1, sizeAttenuation: true,
        transparent: true, depthTest: false, depthWrite: false
      });
      const object = new Sprite(material);
      object.position.set(value.x, value.y, value.z);
      const screenScale = size / 1_400;
      object.scale.set(screenScale, screenScale, screenScale);
      object.renderMode = DrawableRenderMode.Overlay;
      object.overlayLayers = 10;
      object.renderOrder = 1_000;
      this.viewer.getScene().add(object);
      this.overlayObjects.push(object);
    }
  }

  private addRoute(points: Vec3[], color: string) {
    if (points.length < 2) return;
    const segments: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const a = localToAholo(points[index - 1]!);
      const b = localToAholo(points[index]!);
      segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const fallback = new BufferGeometry();
    fallback.setAttribute("position", new BufferAttribute(new Float32Array(segments), 3));
    const geometry = new FatLineBufferGeometry(fallback as never).setPositions(new Float32Array(segments));
    const material = new FatLineMaterial({
      color, opacity: 1, fatLineWidth: 5,
      transparent: true, depthTest: false, depthWrite: false
    });
    const object = new FatLineSegments(geometry, material);
    object.renderMode = DrawableRenderMode.Overlay;
    object.overlayLayers = 9;
    object.renderOrder = 900;
    this.viewer.getScene().add(object);
    this.overlayObjects.push(object);
  }

  private addNormal(position: Vec3, normal: Vec3, color: string) {
    this.addRoute([position, {
      x: position.x + normal.x,
      y: position.y + normal.y,
      z: position.z + normal.z
    }], color);
  }

  private addDomLabel(
    text: string,
    position: Vec3,
    kind: "inspection" | "pending",
    labelId?: string,
    selected = false
  ) {
    const interactive = kind === "inspection" && Boolean(labelId);
    const element = interactive ? document.createElement("button") : document.createElement("span");
    element.className = `aholo-space-label ${kind}`;
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
    this.labelElements.push({ element, position, interactive });
  }

  private updateDomLabels() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    for (const item of this.labelElements) {
      const value = localToAholo(item.position);
      const projected = new Vector3(value.x, value.y, value.z).project(this.camera);
      const visible = projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1.1 && Math.abs(projected.y) <= 1.1;
      item.element.hidden = !visible;
      if (visible) item.element.style.transform = `translate(${(projected.x * 0.5 + 0.5) * width}px, ${(-projected.y * 0.5 + 0.5) * height}px) translate(-50%, calc(-100% - 12px))`;
    }
  }

  private clearOverlays() {
    for (const object of this.overlayObjects.splice(0)) {
      object.removeFromParent();
      object.destroy();
    }
    this.labelElements = [];
    this.labelLayer.replaceChildren();
  }
}

async function createSceneRuntime(options: {
  container: HTMLDivElement;
  labelLayer: HTMLDivElement;
  datasetId: string;
  referenceFormat: boolean;
  runtimeConfig: AholoRuntimeConfig;
  signal: AbortSignal;
  onPick: (hit: SurfaceHit) => void;
  onSelectLabel: (labelId: string) => void;
  onPickProbe: (value: PickProbe | null) => void;
  onMessage: (message: string) => void;
  onDiagnostics: (value: Diagnostics) => void;
  onFatal: (message: string) => void;
}) {
  const manifest = await api.renderManifest(options.datasetId, "aholo-chunk-lod", options.signal);
  options.signal.throwIfAborted();
  if (!manifest.aholo) throw new Error("render-manifest 缺少 AHoLo 资源");
  const metaUrl = options.referenceFormat ? manifest.aholo.referenceLodMetaUrl : manifest.aholo.lodMetaUrl;
  const response = await fetch(metaUrl, { signal: options.signal, cache: "no-store" });
  if (!response.ok) throw new Error(`LOD meta HTTP ${response.status}`);
  const meta = await response.json() as LodMeta;
  options.signal.throwIfAborted();
  if (meta.magicCode !== 0x262834 || meta.type !== "lod-splat" || meta.levels !== 5) throw new Error("AHoLo LOD meta 未通过前端契约检查");
  const runtimeConfig = normalizeAholoRuntimeConfig(options.runtimeConfig, meta.levels - 1, meta.counts);

  const viewer = createViewer(`spikive-aholo-${options.datasetId}`, options.container, { antialiasing: true, alpha: false, preferWebGL1: false });
  const chunkLoader = new CancellableChunkLoader(
    options.referenceFormat ? SplatLoader.SplatFileType.PLY : SplatLoader.SplatFileType.ESZ,
    options.signal
  );
  try {
    const camera = new PerspectiveCamera(55, Math.max(1, options.container.clientWidth) / Math.max(1, options.container.clientHeight), 0.02, 100_000);
    viewer.setCamera(camera);
    setViewerConfig(viewer, {
      pixelRatio: Math.min(1, 1.5 / Math.max(1, window.devicePixelRatio)),
      pipeline: {
        Background: {
          enabled: true,
          up: new Vector3(0, 1, 0),
          background: { active: BackgroundMode.BasicBackground, basic: { color: new Color("#ffffff"), alpha: 1 } },
          ground: { enabled: false }
        },
        Splatting: {
          enabled: true,
          pack: { highPrecisionEnabled: true, precalculateEnabled: false, cameraRelativeEnabled: false },
          raster: { detailCullingThreshold: 0 },
          sort: { highPrecisionEnabled: true },
          composite: { enabled: true, highPrecisionEnabled: true },
          toneMapping: { enabled: false }
        },
        TAA: { enabled: false }
      }
    });
    const lod = new SplatUtils.LodSplat(meta as never, toAholoLodConfig(runtimeConfig), createViewerContext(viewer), chunkLoader.load);
    // Data stays dataset-local for LodSplat scheduling; its scene root applies the fixed Rx(-90°).
    lod.container.rotation.set(-Math.PI / 2, 0, 0);
    viewer.getScene().add(lod.container);
    viewer.resize();
    viewer.requestRenderHandler = () => undefined;
    return new SceneRuntime(
      viewer, camera, lod, chunkLoader, options.container, options.labelLayer, manifest, meta, runtimeConfig,
      options.referenceFormat ? "lossless PLY" : "high-precision ESZ",
      options.onPick, options.onSelectLabel, options.onPickProbe, options.onMessage, options.onDiagnostics, options.onFatal
    );
  } catch (error) {
    chunkLoader.dispose();
    viewer.destroy();
    throw error;
  }
}

const formatCount = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }).format(value);
const sameRuntimeConfig = (a: AholoRuntimeConfig, b: AholoRuntimeConfig) => JSON.stringify(a) === JSON.stringify(b);
