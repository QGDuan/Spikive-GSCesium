import {
  AppBase,
  AppOptions,
  Asset,
  AssetListLoader,
  CameraComponentSystem,
  Color,
  ContainerHandler,
  DEVICETYPE_WEBGPU,
  Entity,
  FILLMODE_FILL_WINDOW,
  GSplatComponentSystem,
  GSplatHandler,
  LightComponentSystem,
  RESOLUTION_AUTO,
  RenderComponentSystem,
  ScriptComponentSystem,
  TextureHandler,
  Vec3,
  createGraphicsDevice
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';

import './styles.css';

const POINT_CLOUD_URL = '/data/point_cloud-lod/lod-meta.json';
const POINT_COUNT = 14_224_203;

const canvas = document.querySelector<HTMLCanvasElement>('#application-canvas');
const status = document.querySelector<HTMLDivElement>('#status');
const statusText = document.querySelector<HTMLSpanElement>('#status-text');

if (!canvas || !status || !statusText) {
  throw new Error('页面初始化失败：缺少必要的 DOM 节点。');
}

const setStatus = (message: string, state: 'loading' | 'ready' | 'error' = 'loading') => {
  statusText.textContent = message;
  status.classList.toggle('is-ready', state === 'ready');
  status.classList.toggle('is-error', state === 'error');
};

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const loadAssets = (assets: Asset[], app: AppBase) => {
  const loader = new AssetListLoader(assets, app.assets);
  let settled = false;
  let resolveLoad!: () => void;

  const promise = new Promise<void>((resolve, reject) => {
    resolveLoad = resolve;
    loader.load((error: unknown, failed: Asset[]) => {
      if (settled) {
        return;
      }
      settled = true;
      loader.destroy();
      if (error) {
        const names = failed?.map((asset) => asset.name).join(', ') || '未知资源';
        reject(new Error(`资源加载失败：${names}`));
        return;
      }
      resolve();
    });
  });

  return {
    promise,
    cancel: () => {
      if (settled) {
        return;
      }
      settled = true;
      loader.destroy();
      resolveLoad();
    }
  };
};

let disposeCurrent: (() => void) | undefined;
import.meta.hot?.dispose(() => disposeCurrent?.());

const start = async () => {
  setStatus('正在创建 PlayCanvas 图形设备…');

  // Request WebGPU first. PlayCanvas automatically appends WebGL2 as the official fallback.
  const device = await createGraphicsDevice(canvas, {
    deviceTypes: [DEVICETYPE_WEBGPU],
    antialias: false,
    powerPreference: 'high-performance'
  });
  device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

  const options = new AppOptions();
  options.graphicsDevice = device;
  options.componentSystems = [
    RenderComponentSystem,
    CameraComponentSystem,
    LightComponentSystem,
    ScriptComponentSystem,
    GSplatComponentSystem
  ];
  options.resourceHandlers = [TextureHandler, ContainerHandler, GSplatHandler];

  const app = new AppBase(canvas);
  app.init(options);
  app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(RESOLUTION_AUTO);

  let disposed = false;
  let pendingLoad: ReturnType<typeof loadAssets> | undefined;
  const resize = () => app.resizeCanvas();
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    pendingLoad?.cancel();
    pendingLoad = undefined;
    window.removeEventListener('resize', resize);
    window.removeEventListener('pagehide', dispose);
    app.destroy();
  };

  disposeCurrent = dispose;
  window.addEventListener('resize', resize);
  window.addEventListener('pagehide', dispose, { once: true });

  const pointCloud = new Asset('point_cloud', 'gsplat', { url: POINT_CLOUD_URL });

  setStatus('正在加载官方 Streamed SOG（LOD0–6，按需流式请求）…');
  pendingLoad = loadAssets([pointCloud], app);
  await pendingLoad.promise;
  pendingLoad = undefined;

  if (disposed) {
    return;
  }

  app.start();

  const splat = new Entity('point_cloud');
  splat.addComponent('gsplat', { asset: pointCloud });

  // The source is a local engineering coordinate system with Z up. PlayCanvas uses Y up.
  splat.setLocalEulerAngles(-90, 0, 0);
  app.root.addChild(splat);

  await nextFrame();

  const bounds = splat.gsplat?.customAabb;
  if (!bounds) {
    throw new Error('PLY 已加载，但 PlayCanvas 未生成 Gaussian 包围盒。');
  }

  // Recenter only the scene node; the PLY data itself remains untouched.
  const worldCenter = splat.getWorldTransform().transformPoint(bounds.center, new Vec3());
  splat.setLocalPosition(-worldCenter.x, -worldCenter.y, -worldCenter.z);

  const diagonal = Math.max(bounds.halfExtents.length() * 2, 1);
  const initialDistance = diagonal * 0.9;

  const camera = new Entity('camera');
  camera.addComponent('camera', {
    clearColor: new Color(0.065, 0.065, 0.065),
    fov: 60,
    nearClip: Math.max(diagonal / 10_000, 0.01),
    farClip: diagonal * 20
  });
  camera.setLocalPosition(0, diagonal * 0.15, initialDistance);
  camera.lookAt(0, 0, 0);
  app.root.addChild(camera);

  camera.addComponent('script');
  const controls = camera.script?.create(CameraControls, {
    properties: {
      enableFly: false,
      enableOrbit: true,
      focusPoint: new Vec3(0, 0, 0)
    }
  });

  if (!controls) {
    throw new Error('PlayCanvas CameraControls 初始化失败。');
  }

  setStatus(`Streamed SOG 已加载：LOD0 ${POINT_COUNT.toLocaleString('zh-CN')} 个 Gaussian`, 'ready');
};

start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  setStatus(message, 'error');
});
