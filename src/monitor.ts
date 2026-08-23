import type { GsViewer } from './viewer';

interface SystemMetrics {
  cpu: {
    logicalCores: number;
    systemPercent: number | null;
    serverProcessPercent: number | null;
  };
  memory: {
    systemTotalBytes: number;
    systemUsedBytes: number;
    serverRssBytes: number;
    serverHeapUsedBytes: number;
  };
}

interface ChromiumMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

const formatBytes = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '不可用';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
};

const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? '采样中' : `${value.toFixed(1)}%`;

export const startMonitor = (viewer: GsViewer) => {
  let systemMetrics: SystemMetrics | undefined;
  let disposed = false;
  let requestController: AbortController | undefined;

  const set = (name: string, value: string) => {
    document.querySelectorAll<HTMLElement>(`[data-metric="${name}"]`).forEach((element) => {
      element.textContent = value;
    });
  };

  const updateRenderer = () => {
    const metrics = viewer.getMetrics();
    set('backend', metrics.backend);
    set('fps', `${metrics.fps.toFixed(0)} FPS`);
    set('frame', `${metrics.frameMs.toFixed(1)} ms`);
    set('app-cpu', metrics.applicationCpuMs === null ? '当前构建不可用' : `${metrics.applicationCpuMs.toFixed(2)} ms/帧`);
    set('gpu-time', metrics.gpuFrameMs === null ? '设备不支持时间戳' : `${metrics.gpuFrameMs.toFixed(2)} ms/帧`);
    set('engine-vram', `${formatBytes(metrics.engineGpuBytes)}（引擎估算）`);
    set('gaussians', metrics.visibleGaussians.toLocaleString('zh-CN'));
    set('draw-calls', String(metrics.drawCalls));
    set('system-cpu', systemMetrics ? formatPercent(systemMetrics.cpu.systemPercent) : '采样中');
    set('server-cpu', systemMetrics ? formatPercent(systemMetrics.cpu.serverProcessPercent) : '采样中');
    set(
      'system-memory',
      systemMetrics
        ? `${formatBytes(systemMetrics.memory.systemUsedBytes)} / ${formatBytes(systemMetrics.memory.systemTotalBytes)}`
        : '采样中'
    );
    set('server-memory', systemMetrics ? formatBytes(systemMetrics.memory.serverRssBytes) : '采样中');

    const browserMemory = (performance as Performance & { memory?: ChromiumMemory }).memory;
    set(
      'browser-memory',
      browserMemory
        ? `${formatBytes(browserMemory.usedJSHeapSize)} / ${formatBytes(browserMemory.jsHeapSizeLimit)}`
        : '浏览器未开放'
    );
  };

  const fetchSystem = async () => {
    requestController?.abort();
    requestController = new AbortController();
    try {
      const response = await fetch('/api/system-metrics', {
        cache: 'no-store',
        signal: requestController.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      systemMetrics = (await response.json()) as SystemMetrics;
      updateRenderer();
    } catch (error) {
      if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) {
        set('system-cpu', '服务不可用');
        set('system-memory', '服务不可用');
      }
    }
  };

  updateRenderer();
  void fetchSystem();
  const rendererTimer = window.setInterval(updateRenderer, 1_000);
  const systemTimer = window.setInterval(fetchSystem, 2_000);

  return () => {
    disposed = true;
    window.clearInterval(rendererTimer);
    window.clearInterval(systemTimer);
    requestController?.abort();
  };
};
