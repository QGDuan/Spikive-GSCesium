import {
  AppBase,
  AppOptions,
  Asset,
  AssetListLoader,
  BLEND_NORMAL,
  CanvasFont,
  CameraComponentSystem,
  Color,
  ContainerHandler,
  ContainerResource,
  CULLFACE_NONE,
  DEVICETYPE_WEBGPU,
  ELEMENTTYPE_TEXT,
  ElementComponentSystem,
  Entity,
  FILLMODE_FILL_WINDOW,
  GSplatComponentSystem,
  GSplatHandler,
  GraphicsDevice,
  LightComponentSystem,
  Picker,
  Quat,
  RESOLUTION_AUTO,
  RenderComponent,
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
import { InspectionCameraNavigation } from './camera-navigation';
import { INSPECTION_FOCUS_DISTANCE_METERS, type CameraMode } from './camera-mode';
import {
  SURFACE_DEPTH_SAMPLE_OFFSETS,
  createGaussianSurfaceSelection,
  type GaussianSurfaceSelection
} from './gaussian-surface-selector';

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
  root: Entity;
  entity: Entity;
  asset: Asset;
  url: string;
  markerSize: number;
  markers: InspectionMarker[];
  route?: RouteOverlay;
  voxelDebug?: VoxelDebugOverlay;
}

interface RouteOverlay {
  root: Entity;
}

interface VoxelDebugOverlay {
  asset: Asset;
  entity: Entity;
  url: string;
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

export interface RouteWaypoint {
  id: string;
  type: 'start' | 'inspection' | 'transit';
  position: { x: number; y: number; z: number };
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
        reject(new Error(`资源加载失败：${failed?.map((item) => item.name).join(', ') || asset.name}`));
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
  private cameraNavigation?: InspectionCameraNavigation;
  private activeCameraMode: CameraMode = 'third-person';
  private picker?: Picker;
  private inspectionFont?: CanvasFont;
  private inspectionMaterial?: StandardMaterial;
  private inspectionSelectedMaterial?: StandardMaterial;
  private inspectionNormalMaterial?: StandardMaterial;
  private routeValidMaterial?: StandardMaterial;
  private routeInvalidMaterial?: StandardMaterial;
  private routeTransitMaterial?: StandardMaterial;
  private voxelDebugMaterial?: StandardMaterial;
  private current?: LoadedScene;
  private selectedInspectionPointId = '';
  private activeLoads = 0;
  private generation = 0;
  private voxelDebugGeneration = 0;
  private disposed = false;
  private pickerBusy = false;
  private readonly inspectionMeshIds = new Map<object, string>();
  private readonly resize = () => this.app?.resizeCanvas();
  private readonly updateCameraNavigation = (deltaTime: number) => {
    this.cameraNavigation?.update(deltaTime);
  };
  private readonly updateInspectionLabels = () => {
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
    this.routeValidMaterial = this.createInspectionMaterial('route-valid-green', new Color(0.08, 0.85, 0.28));
    this.routeInvalidMaterial = this.createInspectionMaterial('route-invalid-orange', new Color(1, 0.32, 0.025));
    this.routeTransitMaterial = this.createInspectionMaterial('route-transit-blue', new Color(0.03, 0.34, 1));
    this.voxelDebugMaterial = this.createVoxelDebugMaterial();

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
    this.cameraNavigation = new InspectionCameraNavigation(this.canvas, this.camera);

    window.addEventListener('resize', this.resize);
    this.app.on('update', this.updateCameraNavigation);
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

  get cameraMode() {
    return this.activeCameraMode;
  }

  setCameraMode(mode: CameraMode) {
    this.activeCameraMode = mode;
    this.cameraNavigation?.setCameraMode(mode);
  }

  releaseCameraPointerLock() {
    return this.cameraNavigation?.releasePointerLock() ?? false;
  }

  requestCameraPointerLock() {
    return this.cameraNavigation?.requestPointerLock() ?? false;
  }

  focusInspectionPoint(point: InspectionPoint) {
    const current = this.current;
    const cameraNavigation = this.cameraNavigation;
    if (!current || !cameraNavigation || !this.camera) {
      throw new Error('请先加载对应的高斯场景。');
    }
    if (!point.normal) {
      throw new Error(`巡检点“${point.title ?? point.id}”缺少有效法向量，无法建立第一人称观察方向。`);
    }

    const normal = new Vec3(point.normal.x, point.normal.y, point.normal.z);
    if (normal.lengthSq() <= 1e-12) {
      throw new Error(`巡检点“${point.title ?? point.id}”的法向量无效，无法建立第一人称观察方向。`);
    }
    normal.normalize();
    const localTarget = new Vec3(point.position.x, point.position.y, point.position.z);
    const localPosition = localTarget.clone().add(normal.mulScalar(INSPECTION_FOCUS_DISTANCE_METERS));
    const transform = current.root.getWorldTransform();
    const worldTarget = transform.transformPoint(localTarget, new Vec3());
    const worldPosition = transform.transformPoint(localPosition, new Vec3());

    this.setCameraMode('first-person');
    cameraNavigation.focusFirstPerson(worldTarget, worldPosition);
    cameraNavigation.requestPointerLock();
  }

  async load(url: string, name: string) {
    const app = this.app;
    if (!app || this.disposed) {
      throw new Error('三维引擎尚未初始化或已经销毁。');
    }
    if (this.current?.url === url) {
      return;
    }

    const generation = ++this.generation;
    const asset = new Asset(name, 'gsplat', { url });
    let root: Entity | undefined;
    let entity: Entity | undefined;
    this.activeLoads += 1;
    try {
      await loadAsset(asset, app);
      if (this.disposed || generation !== this.generation) {
        asset.unload();
        app.assets.remove(asset);
        return;
      }

      root = new Entity(`scene-root-${name}`);
      // The root owns the common source-local Z-up -> PlayCanvas Y-up transform.
      // GS, debug voxels and business annotations are independent children so their
      // visibility can be toggled without losing coordinate alignment.
      root.setLocalEulerAngles(-90, 0, 0);
      app.root.addChild(root);

      entity = new Entity(`gs-${name}`);
      entity.addComponent('gsplat', { asset });
      root.addChild(entity);
      await nextFrame();

      if (this.disposed || generation !== this.generation) {
        root.destroy();
        root = undefined;
        entity = undefined;
        asset.unload();
        app.assets.remove(asset);
        return;
      }
      const bounds = entity.gsplat?.customAabb;
      if (!bounds) {
        throw new Error('场景已加载，但未能取得高斯场景包围盒。');
      }

      const worldCenter = root.getWorldTransform().transformPoint(bounds.center, new Vec3());
      root.setLocalPosition(-worldCenter.x, -worldCenter.y, -worldCenter.z);
      const diagonal = Math.max(bounds.halfExtents.length() * 2, 1);
      this.camera!.camera!.nearClip = Math.max(diagonal / 10_000, 0.01);
      this.camera!.camera!.farClip = diagonal * 20;
      this.setCameraMode('third-person');
      this.cameraNavigation?.resetThirdPerson(Vec3.ZERO, diagonal * 20);

      const previous = this.current;
      this.current = {
        root,
        entity,
        asset,
        url,
        markerSize: Math.max(0.25, Math.min(1.2, diagonal * 0.001)),
        markers: []
      };
      root = undefined;
      entity = undefined;
      if (previous) {
        this.clearVoxelDebugForScene(previous);
        this.clearInspectionMarkers(previous);
        previous.root.destroy();
        previous.asset.unload();
        app.assets.remove(previous.asset);
      }
    } catch (error) {
      if (root) root.destroy();
      else entity?.destroy();
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

  get voxelDebugUrl() {
    return this.current?.voxelDebug?.url ?? '';
  }

  get gaussianVisible() {
    return Boolean(this.current?.entity.enabled);
  }

  setGaussianVisible(visible: boolean) {
    if (!this.current || this.disposed) {
      throw new Error('请先加载对应的高斯场景。');
    }
    this.current.entity.enabled = visible;
  }

  async toggleVoxelDebug(url: string, name: string) {
    const app = this.app;
    const scene = this.current;
    const material = this.voxelDebugMaterial;
    if (!app || !scene || !material || this.disposed) {
      throw new Error('请先加载对应的高斯场景。');
    }
    if (scene.voxelDebug?.url === url) {
      this.clearVoxelDebug();
      return false;
    }

    this.clearVoxelDebug();
    const voxelGeneration = ++this.voxelDebugGeneration;
    const sceneGeneration = this.generation;
    const asset = new Asset(`${name}-voxel-debug`, 'container', { url });
    let entity: Entity | undefined;
    let voxelFrame: Entity | undefined;
    this.activeLoads += 1;
    try {
      await loadAsset(asset, app);
      if (this.disposed || voxelGeneration !== this.voxelDebugGeneration ||
          sceneGeneration !== this.generation || this.current !== scene) {
        asset.unload();
        app.assets.remove(asset);
        return false;
      }

      const resource = asset.resource as ContainerResource | undefined;
      if (!resource?.instantiateRenderEntity) {
        throw new Error('体素调试网格不包含可渲染的网格数据。');
      }
      entity = resource.instantiateRenderEntity({
        castShadows: false,
        receiveShadows: false
      });
      entity.name = `voxel-debug-${name}`;
      let meshCount = 0;
      for (const render of entity.findComponents('render') as RenderComponent[]) {
        render.castShadows = false;
        render.receiveShadows = false;
        for (const meshInstance of render.meshInstances) {
          meshInstance.material = material;
          meshInstance.pick = false;
          meshCount += 1;
        }
      }
      if (meshCount === 0) {
        throw new Error('体素调试网格为空。');
      }

      // splat-transform bakes voxel/GLB output from PLY space into its identity
      // frame (Rz(180°)). Keep persisted annotations in source PLY coordinates
      // and adapt only this collision-storage boundary.
      voxelFrame = new Entity(`voxel-source-frame-${name}`);
      voxelFrame.setLocalEulerAngles(0, 0, 180);
      voxelFrame.addChild(entity);
      scene.root.addChild(voxelFrame);
      scene.voxelDebug = { asset, entity: voxelFrame, url };
      voxelFrame = undefined;
      entity = undefined;
      return true;
    } catch (error) {
      if (voxelFrame) voxelFrame.destroy();
      else entity?.destroy();
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

  clearVoxelDebug() {
    this.voxelDebugGeneration += 1;
    if (this.current) this.clearVoxelDebugForScene(this.current);
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
    const inverse = current.root.getWorldTransform().clone().invert();
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
      current.root.addChild(mesh);

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
          current.root.addChild(normalLine);
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
      current.root.addChild(textScreen);

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

  setRoute(waypoints: RouteWaypoint[], valid: boolean) {
    const current = this.current;
    const lineMaterial = valid ? this.routeValidMaterial : this.routeInvalidMaterial;
    const redMaterial = this.inspectionMaterial;
    const blueMaterial = this.routeTransitMaterial;
    if (!current || !lineMaterial || !redMaterial || !blueMaterial) return;
    this.clearRouteForScene(current);
    if (waypoints.length === 0) return;
    const root = new Entity('flight-route');
    current.root.addChild(root);
    const pointScale = Math.max(0.08, current.markerSize * 0.28);
    const lineDiameter = Math.max(0.025, current.markerSize * 0.045);
    for (let index = 0; index < waypoints.length; index += 1) {
      const point = waypoints[index];
      const node = new Entity(`route-point:${point.id}`);
      node.addComponent('render', {
        type: 'sphere',
        material: point.type === 'transit' ? blueMaterial : redMaterial
      });
      node.setLocalPosition(point.position.x, point.position.y, point.position.z);
      node.setLocalScale(pointScale, pointScale, pointScale);
      root.addChild(node);
      const next = waypoints[index + 1];
      if (!next) continue;
      const direction = new Vec3(
        next.position.x - point.position.x,
        next.position.y - point.position.y,
        next.position.z - point.position.z
      );
      const length = direction.length();
      if (length < 1e-6) continue;
      direction.mulScalar(1 / length);
      const segment = new Entity(`route-segment:${index}`);
      segment.addComponent('render', { type: 'cylinder', material: lineMaterial });
      segment.setLocalPosition(
        (point.position.x + next.position.x) * 0.5,
        (point.position.y + next.position.y) * 0.5,
        (point.position.z + next.position.z) * 0.5
      );
      segment.setLocalRotation(new Quat().setFromDirections(LOCAL_UP, direction));
      segment.setLocalScale(lineDiameter, length, lineDiameter);
      root.addChild(segment);
    }
    current.route = { root };
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
      const routeEnabled = current.route?.root.enabled;
      if (current.route) current.route.root.enabled = false;
      try {
        picker.prepare(camera, app.scene);
      } finally {
        if (current.route) current.route.root.enabled = routeEnabled ?? true;
      }
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

  async pickGaussianSurface(
    clientX: number,
    clientY: number
  ): Promise<GaussianSurfaceSelection | null> {
    const app = this.app;
    const cameraEntity = this.camera;
    const camera = cameraEntity?.camera;
    const picker = this.picker;
    const current = this.current;
    if (!app || !cameraEntity || !camera || !picker || !current || this.activeLoads > 0 ||
        !current.entity.enabled || this.pickerBusy) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;

    const generation = this.generation;
    this.pickerBusy = true;
    try {
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const pickX = Math.floor(x) + 0.5;
      const pickY = Math.floor(y) + 0.5;
      picker.resize(width, height);
      const markerStates = current.markers.map((marker) => ({
        marker,
        mesh: marker.mesh.enabled,
        normalLine: marker.normalLine?.enabled,
        textScreen: marker.textScreen.enabled
      }));
      const routeEnabled = current.route?.root.enabled;
      for (const { marker } of markerStates) {
        marker.mesh.enabled = false;
        if (marker.normalLine) marker.normalLine.enabled = false;
        marker.textScreen.enabled = false;
      }
      if (current.route) current.route.root.enabled = false;
      try {
        picker.prepare(camera, app.scene);
      } finally {
        for (const state of markerStates) {
          state.marker.mesh.enabled = state.mesh;
          if (state.marker.normalLine) state.marker.normalLine.enabled = state.normalLine ?? false;
          state.marker.textScreen.enabled = state.textScreen;
        }
        if (current.route) current.route.root.enabled = routeEnabled ?? true;
      }
      const [selection, centerWorld] = await Promise.all([
        picker.getSelectionAsync(pickX, pickY, 1, 1),
        picker.getWorldPointAsync(pickX, pickY)
      ]);
      if (this.disposed || generation !== this.generation ||
          !centerWorld || !selection.some((selected) => selected === current.entity.gsplat)) return null;

      const inverse = current.root.getWorldTransform().clone().invert();
      const localCamera = inverse.transformPoint(cameraEntity.getPosition(), new Vec3());
      const offsets = SURFACE_DEPTH_SAMPLE_OFFSETS.filter(({ x: offsetX, y: offsetY }) =>
        pickX + offsetX >= 0 && pickX + offsetX < width &&
        pickY + offsetY >= 0 && pickY + offsetY < height
      );
      const worldSamples = await Promise.all(offsets
        .filter(({ x: offsetX, y: offsetY }) => offsetX !== 0 || offsetY !== 0)
        .map(({ x: offsetX, y: offsetY }) => picker.getWorldPointAsync(pickX + offsetX, pickY + offsetY))
      );
      if (this.disposed || generation !== this.generation) return null;
      const centerLocal = inverse.transformPoint(centerWorld, new Vec3());
      const localSamples = [centerWorld, ...worldSamples]
        .filter((point): point is Vec3 => point !== null)
        .map((point) => inverse.transformPoint(point, new Vec3()))
        .map((point) => ({ x: point.x, y: point.y, z: point.z }));
      return createGaussianSurfaceSelection(
        { x: centerLocal.x, y: centerLocal.y, z: centerLocal.z },
        localSamples,
        { x: localCamera.x, y: localCamera.y, z: localCamera.z }
      );
    } finally {
      this.finishPick();
    }
  }

  clear() {
    this.generation += 1;
    this.voxelDebugGeneration += 1;
    // Clearing the scene also closes the camera-mode lifecycle. Do this before the early return
    // so a deleted/failed scene cannot leave Pointer Lock or first-person input active.
    this.setCameraMode('third-person');
    if (!this.current || !this.app) {
      return;
    }
    this.clearVoxelDebugForScene(this.current);
    this.clearInspectionMarkers(this.current);
    this.clearRouteForScene(this.current);
    this.current.root.destroy();
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
    this.voxelDebugGeneration += 1;
    window.removeEventListener('resize', this.resize);
    if (this.current && this.app) {
      this.clearVoxelDebugForScene(this.current);
      this.clearInspectionMarkers(this.current);
      this.clearRouteForScene(this.current);
      this.current.root.destroy();
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
    this.app?.off('update', this.updateCameraNavigation);
    this.app?.off('update', this.updateInspectionLabels);
    this.cameraNavigation?.dispose();
    this.cameraNavigation = undefined;
    this.picker?.destroy();
    this.picker = undefined;
    this.inspectionFont?.destroy();
    this.inspectionFont = undefined;
    this.inspectionMaterial?.destroy();
    this.inspectionMaterial = undefined;
    this.inspectionSelectedMaterial?.destroy();
    this.inspectionSelectedMaterial = undefined;
    this.inspectionNormalMaterial?.destroy();
    this.inspectionNormalMaterial = undefined;
    this.routeValidMaterial?.destroy();
    this.routeValidMaterial = undefined;
    this.routeInvalidMaterial?.destroy();
    this.routeInvalidMaterial = undefined;
    this.routeTransitMaterial?.destroy();
    this.routeTransitMaterial = undefined;
    this.voxelDebugMaterial?.destroy();
    this.voxelDebugMaterial = undefined;
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

  private clearRouteForScene(scene: LoadedScene) {
    scene.route?.root.destroy();
    scene.route = undefined;
  }

  private clearVoxelDebugForScene(scene: LoadedScene) {
    const overlay = scene.voxelDebug;
    const app = this.app;
    if (!overlay || !app) return;
    scene.voxelDebug = undefined;
    overlay.entity.destroy();
    overlay.asset.unload();
    app.assets.remove(overlay.asset);
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

  private createVoxelDebugMaterial() {
    const material = new StandardMaterial();
    const color = new Color(0.02, 0.82, 1);
    material.name = 'voxel-debug-cyan';
    material.diffuse = color;
    material.emissive = color;
    material.useLighting = false;
    material.opacity = 0.34;
    material.blendType = BLEND_NORMAL;
    material.cull = CULLFACE_NONE;
    material.depthTest = true;
    material.depthWrite = false;
    material.depthBias = -1;
    material.slopeDepthBias = -1;
    material.update();
    return material;
  }
}
