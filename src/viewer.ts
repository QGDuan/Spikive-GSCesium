import {
  AppBase,
  AppOptions,
  Asset,
  AssetListLoader,
  CanvasFont,
  CameraComponentSystem,
  Color,
  ContainerHandler,
  DEVICETYPE_WEBGPU,
  ELEMENTTYPE_TEXT,
  ElementComponentSystem,
  Entity,
  FILLMODE_FILL_WINDOW,
  GSplatComponentSystem,
  GSplatHandler,
  GraphicsDevice,
  LightComponentSystem,
  Mat4,
  Picker,
  Quat,
  RESOLUTION_AUTO,
  RenderComponentSystem,
  ScreenComponentSystem,
  ScriptComponentSystem,
  StandardMaterial,
  TextureHandler,
  Vec2,
  Vec3,
  Vec4,
  createGraphicsDevice
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import {
  GaussianCircleSelector,
  type GaussianCircleSelection
} from './gaussian-circle-selector';

export interface RendererMetrics {
  backend: 'WebGPU' | 'WebGL2' | string;
  fps: number;
  frameMs: number;
  applicationCpuMs: number | null;
  gpuFrameMs: number | null;
  engineGpuBytes: number;
  visibleGaussians: number;
  drawCalls: number;
}

interface LoadedScene {
  entity: Entity;
  asset: Asset;
  url: string;
  markerSize: number;
  markers: InspectionMarker[];
}

interface InspectionMarker {
  id: string;
  mesh: Entity;
  normalLine?: Entity;
  textScreen: Entity;
  text: Entity;
}

export interface InspectionPoint {
  id: string;
  title?: string;
  position: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number } | null;
}

export interface LocalRay {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  maxDistance: number;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const NORMAL_SEGMENT_METERS = 1;
const TEXT_NORMAL_CLEARANCE_METERS = 0.12;
const MARKER_SCALE = 0.62;
const SELECTED_MARKER_SCALE = 0.9;
const LOCAL_UP = new Vec3(0, 1, 0);

const loadAsset = (asset: Asset, app: AppBase) => {
  const loader = new AssetListLoader([asset], app.assets);
  let settled = false;

  const promise = new Promise<void>((resolve, reject) => {
    loader.load((error: unknown, failed: Asset[]) => {
      if (settled) {
        return;
      }
      settled = true;
      loader.destroy();
      if (error) {
        reject(new Error(`GS 资源加载失败：${failed?.map((item) => item.name).join(', ') || asset.name}`));
        return;
      }
      resolve();
    });
  });

  return promise;
};

export class GsViewer {
  private app?: AppBase;
  private device?: GraphicsDevice;
  private camera?: Entity;
  private controls?: { reset: (focus: Vec3, position: Vec3) => void };
  private picker?: Picker;
  private circleSelector?: GaussianCircleSelector;
  private inspectionFont?: CanvasFont;
  private inspectionMaterial?: StandardMaterial;
  private inspectionSelectedMaterial?: StandardMaterial;
  private inspectionNormalMaterial?: StandardMaterial;
  private current?: LoadedScene;
  private selectedInspectionPointId = '';
  private activeLoads = 0;
  private generation = 0;
  private disposed = false;
  private pickerBusy = false;
  private circleTrimFrame = 0;
  private readonly inspectionMeshIds = new Map<object, string>();
  private readonly resize = () => this.app?.resizeCanvas();
  private readonly updateInspectionLabels = () => {
    this.circleTrimFrame += 1;
    if (this.circleTrimFrame >= 60) {
      this.circleTrimFrame = 0;
      const component = this.current?.entity.gsplat;
      if (component) this.circleSelector?.trimResidentResources(component);
    }
    const camera = this.camera;
    const markers = this.current?.markers;
    if (!camera || !markers?.length) return;
    const cameraPosition = camera.getPosition();
    for (const marker of markers) {
      // A world-space Screen faces +Z; lookAt points -Z at the target, so rotate it back once.
      marker.textScreen.lookAt(cameraPosition);
      marker.textScreen.rotateLocal(0, 180, 0);
    }
  };

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async initialize() {
    const device = await createGraphicsDevice(this.canvas, {
      // PlayCanvas tries WebGPU first and appends its WebGL2 fallback when WebGPU is unavailable.
      deviceTypes: [DEVICETYPE_WEBGPU],
      antialias: false,
      powerPreference: 'high-performance'
    });
    this.device = device;
    device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);
    try {
      device.gpuProfiler.enabled = true;
    } catch {
      // GPU timestamp queries are optional. The monitor reports them as unavailable when absent.
    }

    const options = new AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [
      RenderComponentSystem,
      CameraComponentSystem,
      LightComponentSystem,
      ScreenComponentSystem,
      ElementComponentSystem,
      ScriptComponentSystem,
      GSplatComponentSystem
    ];
    options.resourceHandlers = [TextureHandler, ContainerHandler, GSplatHandler];

    this.app = new AppBase(this.canvas);
    this.app.init(options);
    this.app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    this.app.setCanvasResolution(RESOLUTION_AUTO);
    // Unified GS picking only maps placement IDs back to GS components when this public flag is on.
    this.app.scene.gsplat.enableIds = true;

    this.picker = new Picker(this.app, 1, 1, true);
    this.circleSelector = new GaussianCircleSelector(device);
    this.inspectionFont = new CanvasFont(this.app, {
      fontName: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontWeight: 'bold',
      fontSize: 64,
      // CanvasFont temporarily changes alpha while rasterizing, so this must not use readonly Color.WHITE.
      color: new Color(1, 1, 1, 1),
      width: 1024,
      height: 1024,
      padding: 4
    });
    this.inspectionFont.createTextures('巡检点_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ- ');
    this.inspectionMaterial = this.createInspectionMaterial('inspection-point-red', new Color(1, 0.025, 0.015));
    this.inspectionSelectedMaterial = this.createInspectionMaterial('inspection-point-selected', new Color(0.02, 0.34, 1));
    this.inspectionNormalMaterial = this.createInspectionMaterial('inspection-normal-orange', new Color(1, 0.32, 0.025));

    this.camera = new Entity('camera');
    this.camera.addComponent('camera', {
      clearColor: new Color(0.055, 0.06, 0.065),
      fov: 60,
      nearClip: 0.01,
      farClip: 100_000
    });
    this.camera.setLocalPosition(0, 1, 5);
    this.camera.lookAt(0, 0, 0);
    this.app.root.addChild(this.camera);
    this.camera.addComponent('script');
    const controls = this.camera.script?.create(CameraControls, {
      properties: {
        enableFly: false,
        enableOrbit: true,
        focusPoint: new Vec3(0, 0, 0)
      }
    });
    if (!controls) {
      throw new Error('PlayCanvas CameraControls 初始化失败。');
    }
    this.controls = controls as unknown as { reset: (focus: Vec3, position: Vec3) => void };

    window.addEventListener('resize', this.resize);
    this.app.on('update', this.updateInspectionLabels);
    this.app.start();
  }

  get backend() {
    const type = this.device?.deviceType?.toLowerCase();
    if (type === 'webgpu') {
      return 'WebGPU';
    }
    if (type === 'webgl2') {
      return 'WebGL2';
    }
    return this.device?.deviceType || '未知';
  }

  async load(url: string, name: string) {
    const app = this.app;
    if (!app || this.disposed) {
      throw new Error('PlayCanvas 尚未初始化或已经销毁。');
    }
    if (this.current?.url === url) {
      return;
    }

    const generation = ++this.generation;
    const asset = new Asset(name, 'gsplat', { url });
    let entity: Entity | undefined;
    this.activeLoads += 1;
    try {
      await loadAsset(asset, app);
      if (this.disposed || generation !== this.generation) {
        asset.unload();
        app.assets.remove(asset);
        return;
      }

      entity = new Entity(`gs-${name}`);
      entity.addComponent('gsplat', { asset });
      // All source data remains in its local Z-up metric engineering coordinate system.
      entity.setLocalEulerAngles(-90, 0, 0);
      app.root.addChild(entity);
      await nextFrame();

      if (this.disposed || generation !== this.generation) {
        entity.destroy();
        entity = undefined;
        asset.unload();
        app.assets.remove(asset);
        return;
      }
      const bounds = entity.gsplat?.customAabb;
      if (!bounds) {
        throw new Error('SOG 已加载，但 PlayCanvas 未生成 Gaussian 包围盒。');
      }

      const worldCenter = entity.getWorldTransform().transformPoint(bounds.center, new Vec3());
      entity.setLocalPosition(-worldCenter.x, -worldCenter.y, -worldCenter.z);
      const diagonal = Math.max(bounds.halfExtents.length() * 2, 1);
      const position = new Vec3(0, diagonal * 0.15, diagonal * 0.9);
      this.camera!.camera!.nearClip = Math.max(diagonal / 10_000, 0.01);
      this.camera!.camera!.farClip = diagonal * 20;
      this.controls?.reset(new Vec3(0, 0, 0), position);

      const previous = this.current;
      this.circleSelector?.clearResidentResources();
      this.current = {
        entity,
        asset,
        url,
        markerSize: Math.max(0.25, Math.min(1.2, diagonal * 0.001)),
        markers: []
      };
      entity = undefined;
      if (previous) {
        this.clearInspectionMarkers(previous);
        previous.entity.destroy();
        previous.asset.unload();
        app.assets.remove(previous.asset);
      }
    } catch (error) {
      entity?.destroy();
      asset.unload();
      app.assets.remove(asset);
      throw error;
    } finally {
      this.activeLoads -= 1;
      if (this.disposed && this.activeLoads === 0 && !this.pickerBusy) {
        this.destroyApplication();
      }
    }
  }

  getMetrics(): RendererMetrics {
    if (!this.app || !this.device) {
      return {
        backend: '未初始化',
        fps: 0,
        frameMs: 0,
        applicationCpuMs: null,
        gpuFrameMs: null,
        engineGpuBytes: 0,
        visibleGaussians: 0,
        drawCalls: 0
      };
    }
    const { frame, vram, drawCalls } = this.app.stats;
    const applicationCpuMs = frame.updateTime + frame.renderTime;
    const gpuTimings = [...this.device.gpuProfiler.passTimings.values()].filter(Number.isFinite);
    const gpuFrameMs = gpuTimings.length > 0 ? gpuTimings.reduce((sum, value) => sum + value, 0) : null;
    return {
      backend: this.backend,
      fps: frame.fps,
      frameMs: frame.ms,
      applicationCpuMs: applicationCpuMs > 0 ? applicationCpuMs : null,
      gpuFrameMs,
      engineGpuBytes: vram.tex + vram.vb + vram.ib + vram.ub + vram.sb,
      visibleGaussians: frame.gsplats,
      drawCalls: drawCalls.total
    };
  }

  screenToLocalRay(clientX: number, clientY: number): LocalRay | null {
    const camera = this.camera;
    const current = this.current;
    if (!camera?.camera || !current) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const worldOrigin = camera.getPosition().clone();
    const maxDistance = camera.camera.farClip;
    const worldTarget = camera.camera.screenToWorld(x, y, maxDistance, new Vec3());
    const inverse = current.entity.getWorldTransform().clone().invert();
    const localOrigin = inverse.transformPoint(worldOrigin, new Vec3());
    const localTarget = inverse.transformPoint(worldTarget, new Vec3());
    const direction = localTarget.sub(localOrigin).normalize();
    return {
      origin: { x: localOrigin.x, y: localOrigin.y, z: localOrigin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      maxDistance
    };
  }

  setInspectionPoints(points: InspectionPoint[]) {
    const current = this.current;
    const app = this.app;
    const font = this.inspectionFont;
    const material = this.inspectionMaterial;
    const normalMaterial = this.inspectionNormalMaterial;
    if (!current || !app || !font || !material || !normalMaterial) return;
    this.clearInspectionMarkers(current);
    if (points.length === 0) return;
    font.updateTextures(points.map((point) => point.title ?? '').join(''));
    const worldLayerId = app.scene.layers.getLayerByName('World')?.id ?? 0;
    for (const point of points) {
      const { x, y, z } = point.position;
      const mesh = new Entity(`inspection-mesh:${point.id}`);
      mesh.addComponent('render', { type: 'sphere', material });
      mesh.setLocalPosition(x, y, z);
      mesh.setLocalScale(
        current.markerSize * MARKER_SCALE,
        current.markerSize * MARKER_SCALE,
        current.markerSize * MARKER_SCALE
      );
      current.entity.addChild(mesh);

      let normalLine: Entity | undefined;
      let normalDirection: Vec3 | undefined;
      if (point.normal) {
        const direction = new Vec3(point.normal.x, point.normal.y, point.normal.z);
        if (direction.lengthSq() > 1e-12) {
          direction.normalize();
          normalDirection = direction;
          const lineDiameter = Math.max(current.markerSize * 0.055, 0.012);
          normalLine = new Entity(`inspection-normal:${point.id}`);
          normalLine.addComponent('render', { type: 'cylinder', material: normalMaterial });
          normalLine.setLocalPosition(
            x + direction.x * NORMAL_SEGMENT_METERS * 0.5,
            y + direction.y * NORMAL_SEGMENT_METERS * 0.5,
            z + direction.z * NORMAL_SEGMENT_METERS * 0.5
          );
          normalLine.setLocalRotation(new Quat().setFromDirections(LOCAL_UP, direction));
          normalLine.setLocalScale(lineDiameter, NORMAL_SEGMENT_METERS, lineDiameter);
          current.entity.addChild(normalLine);
        }
      }

      const textScreen = new Entity(`inspection-text-screen:${point.id}`);
      const textScale = current.markerSize / 64;
      const textNormalOffset = normalDirection
        ? NORMAL_SEGMENT_METERS + TEXT_NORMAL_CLEARANCE_METERS
        : 0;
      textScreen.setLocalPosition(
        x + (normalDirection?.x ?? 0) * textNormalOffset,
        y + (normalDirection?.y ?? 0) * textNormalOffset,
        z + (normalDirection?.z ?? 0) * textNormalOffset
      );
      textScreen.setLocalScale(textScale, textScale, textScale);
      textScreen.addComponent('screen', {
        referenceResolution: new Vec2(1280, 720),
        screenSpace: false
      });
      current.entity.addChild(textScreen);

      const text = new Entity(`inspection-text:${point.id}`);
      text.setLocalPosition(0, 58, 0);
      text.addComponent('element', {
        type: ELEMENTTYPE_TEXT,
        text: point.title ?? '巡检点',
        font,
        fontSize: 32,
        lineHeight: 34,
        autoWidth: true,
        autoHeight: true,
        wrapLines: false,
        pivot: new Vec2(0.5, 0),
        anchor: new Vec4(0.5, 0.5, 0.5, 0.5),
        alignment: new Vec2(0.5, 0.5),
        color: new Color(1, 1, 1, 1),
        outlineColor: new Color(0, 0, 0, 0.9),
        outlineThickness: 0.38,
        shadowColor: new Color(0, 0, 0, 0.65),
        shadowOffset: new Vec2(0.08, -0.08),
        layers: [worldLayerId]
      });
      textScreen.addChild(text);

      const meshInstance = mesh.render?.meshInstances[0];
      if (meshInstance) this.inspectionMeshIds.set(meshInstance, point.id);
      const normalMeshInstance = normalLine?.render?.meshInstances[0];
      if (normalMeshInstance) this.inspectionMeshIds.set(normalMeshInstance, point.id);
      current.markers.push({ id: point.id, mesh, normalLine, textScreen, text });
    }
    this.setSelectedInspectionPoint(this.selectedInspectionPointId);
    this.updateInspectionLabels();
  }

  setSelectedInspectionPoint(id?: string | null) {
    this.selectedInspectionPointId = id ?? '';
    const current = this.current;
    if (!current || !this.inspectionMaterial || !this.inspectionSelectedMaterial) return;
    for (const marker of current.markers) {
      const selected = marker.id === this.selectedInspectionPointId;
      marker.mesh.render!.material = selected ? this.inspectionSelectedMaterial : this.inspectionMaterial;
      const scale = current.markerSize * (selected ? SELECTED_MARKER_SCALE : MARKER_SCALE);
      marker.mesh.setLocalScale(scale, scale, scale);
      if (marker.text.element) {
        marker.text.element.color = selected ? new Color(0.35, 0.66, 1) : new Color(1, 1, 1, 1);
        marker.text.element.outlineThickness = selected ? 0.52 : 0.38;
      }
    }
  }

  async pickInspectionPoint(clientX: number, clientY: number) {
    const app = this.app;
    const camera = this.camera?.camera;
    const picker = this.picker;
    const current = this.current;
    if (!app || !camera || !picker || !current || this.pickerBusy || current.markers.length === 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const generation = this.generation;
    this.pickerBusy = true;
    try {
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      picker.resize(width, height);
      picker.prepare(camera, app.scene);
      const radius = 4;
      const selection = await picker.getSelectionAsync(x - radius, y - radius, radius * 2 + 1, radius * 2 + 1);
      if (this.disposed || generation !== this.generation) return null;
      for (const selected of selection) {
        const id = this.inspectionMeshIds.get(selected as object);
        if (id) return id;
      }
      return null;
    } finally {
      this.finishPick();
    }
  }

  async pickGaussianCircle(
    clientX: number,
    clientY: number
  ): Promise<GaussianCircleSelection | null> {
    const app = this.app;
    const cameraEntity = this.camera;
    const camera = cameraEntity?.camera;
    const picker = this.picker;
    const circleSelector = this.circleSelector;
    const current = this.current;
    if (!app || !cameraEntity || !camera || !picker || !circleSelector || !current || this.pickerBusy) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const generation = this.generation;
    this.pickerBusy = true;
    try {
      picker.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
      for (const marker of current.markers) {
        marker.mesh.enabled = false;
        if (marker.normalLine) marker.normalLine.enabled = false;
        marker.textScreen.enabled = false;
      }
      try {
        picker.prepare(camera, app.scene);
      } finally {
        for (const marker of current.markers) {
          marker.mesh.enabled = true;
          if (marker.normalLine) marker.normalLine.enabled = true;
          marker.textScreen.enabled = true;
        }
      }
      const selection = await picker.getSelectionAsync(x, y, 1, 1);
      if (this.disposed || generation !== this.generation ||
          !selection.some((selected) => selected === current.entity.gsplat)) return null;
      const inverse = current.entity.getWorldTransform().clone().invert();
      const localCamera = inverse.transformPoint(cameraEntity.getPosition(), new Vec3());
      const modelViewProjection = new Mat4();
      modelViewProjection.mul2(camera.projectionMatrix, camera.viewMatrix);
      modelViewProjection.mul(current.entity.getWorldTransform());
      const selectionResult = await circleSelector.selectCircle(
        current.entity.gsplat!,
        modelViewProjection,
        { x: localCamera.x, y: localCamera.y, z: localCamera.z },
        x,
        y,
        rect.width,
        rect.height
      );
      if (this.disposed || generation !== this.generation) return null;
      return selectionResult;
    } finally {
      this.finishPick();
    }
  }

  clear() {
    this.generation += 1;
    if (!this.current || !this.app) {
      return;
    }
    this.clearInspectionMarkers(this.current);
    this.circleSelector?.clearResidentResources();
    this.current.entity.destroy();
    this.current.asset.unload();
    this.app.assets.remove(this.current.asset);
    this.current = undefined;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1;
    window.removeEventListener('resize', this.resize);
    if (this.current && this.app) {
      this.clearInspectionMarkers(this.current);
      this.circleSelector?.clearResidentResources();
      this.current.entity.destroy();
      this.current.asset.unload();
      this.app.assets.remove(this.current.asset);
      this.current = undefined;
    }
    if (this.activeLoads === 0 && !this.pickerBusy) {
      this.destroyApplication();
    }
  }

  private finishPick() {
    this.pickerBusy = false;
    if (this.disposed && this.activeLoads === 0) this.destroyApplication();
  }

  private destroyApplication() {
    this.app?.off('update', this.updateInspectionLabels);
    this.picker?.destroy();
    this.picker = undefined;
    this.circleSelector?.destroy();
    this.circleSelector = undefined;
    this.inspectionFont?.destroy();
    this.inspectionFont = undefined;
    this.inspectionMaterial?.destroy();
    this.inspectionMaterial = undefined;
    this.inspectionSelectedMaterial?.destroy();
    this.inspectionSelectedMaterial = undefined;
    this.inspectionNormalMaterial?.destroy();
    this.inspectionNormalMaterial = undefined;
    this.app?.destroy();
    this.app = undefined;
    this.device = undefined;
  }

  private clearInspectionMarkers(scene: LoadedScene) {
    for (const marker of scene.markers) {
      const meshInstance = marker.mesh.render?.meshInstances[0];
      if (meshInstance) this.inspectionMeshIds.delete(meshInstance);
      const normalMeshInstance = marker.normalLine?.render?.meshInstances[0];
      if (normalMeshInstance) this.inspectionMeshIds.delete(normalMeshInstance);
      marker.normalLine?.destroy();
      marker.textScreen.destroy();
      marker.mesh.destroy();
    }
    scene.markers = [];
  }

  private createInspectionMaterial(name: string, color: Color) {
    const material = new StandardMaterial();
    material.name = name;
    material.diffuse = color;
    material.emissive = color;
    material.useLighting = false;
    material.depthTest = true;
    material.depthWrite = true;
    material.update();
    return material;
  }
}
