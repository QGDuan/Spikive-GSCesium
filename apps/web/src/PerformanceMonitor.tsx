import { useEffect, useState } from "react";
import type { RuntimeTelemetry } from "@spikive/shared";
import { api } from "./api";
import { describeRendererBackend } from "./renderer-backend";

interface PerformanceDiagnostics {
  fps: number; averageFrameTimeMs: number; p95FrameTimeMs: number; maxFrameTimeMs: number;
  averageAppCpuTimeMs: number; maxAppCpuTimeMs: number; rendererCpuTimeMs: number;
  rendererBackend: string; sortMode?: string; gpuResourceBytes: number; engineAllocatedBytes: number;
  drawCalls: number; vertices: number; geometries: number; textures: number; chunks: number;
  loadedChunks?: number; loadedLevelChunks?: number[]; activeChunkLoads: number; completedChunkLoads: number; failedChunkLoads: number;
  averageChunkLoadMs: number; recentMaxChunkLoadMs: number; visibleSplats?: number;
  sourceSplats: number; budget: number; effectiveBudget?: number; minLevel: number; maxLevel?: number; levels: number;
  revision: string; format: string; workBufferFormat?: string; fallbackReason?: string | null;
  cameraDistance?: number;
}

interface BrowserHeap {
  used: number;
  total: number;
  limit: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

export function PerformanceMonitor({
  diagnostics,
  engineLabel = "PLAYCANVAS",
  defaultStatus = "WebGPU 优先，单 GraphicsDevice",
  textureMetricIsBytes = true
}: {
  diagnostics: PerformanceDiagnostics | null;
  engineLabel?: string;
  defaultStatus?: string;
  textureMetricIsBytes?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [telemetry, setTelemetry] = useState<RuntimeTelemetry | null>(null);
  const [telemetryUnavailable, setTelemetryUnavailable] = useState(false);
  const [browserHeap, setBrowserHeap] = useState<BrowserHeap | null>(() => readBrowserHeap());

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    const sample = async () => {
      setBrowserHeap(readBrowserHeap());
      controller = new AbortController();
      try {
        const next = await api.runtimeTelemetry(controller.signal);
        if (!disposed) {
          setTelemetry(next);
          setTelemetryUnavailable(false);
        }
      } catch {
        if (!disposed && !controller.signal.aborted) setTelemetryUnavailable(true);
      } finally {
        if (!disposed) timer = window.setTimeout(() => void sample(), 2_000);
      }
    };
    void sample();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const fps = diagnostics?.fps ?? 0;
  const health = !diagnostics ? "waiting" : fps >= 30 ? "good" : fps >= 18 ? "warn" : "bad";
  const rendererBackend = describeRendererBackend(diagnostics?.rendererBackend);
  const hostMemoryPercent = telemetry && telemetry.host.memoryTotalBytes > 0
    ? telemetry.host.memoryUsedBytes / telemetry.host.memoryTotalBytes * 100
    : null;
  const browserHeapPercent = browserHeap && browserHeap.limit > 0 ? browserHeap.used / browserHeap.limit * 100 : null;

  return <aside className={`performance-monitor ${collapsed ? "collapsed" : ""}`} aria-label="运行性能监控" aria-live="off">
    <button type="button" className="performance-monitor-toggle" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>
      <span><i className={`performance-health ${health}`} />PERF / {engineLabel}</span>
      <em className={`renderer-backend-badge ${rendererBackend.kind}`}>{rendererBackend.label}</em>
      <strong>{diagnostics ? `${fps} FPS` : "采样中"}</strong>
      <small>{collapsed ? "+" : "−"}</small>
    </button>
    {!collapsed && <div className="performance-monitor-body">
      <div className={`renderer-backend-status ${rendererBackend.kind}`} role="status">
        <i aria-hidden="true" />
        <div>
          <strong>{rendererBackend.activeText}</strong>
          <small>{diagnostics?.fallbackReason ?? (rendererBackend.kind === "webgpu" ? "PlayCanvas GraphicsDevice 已启用 WebGPU" : rendererBackend.kind === "webgl2" ? "PlayCanvas GraphicsDevice 已启用 WebGL2" : "等待 GraphicsDevice 初始化")}</small>
        </div>
      </div>
      <section>
        <h3>帧与主线程</h3>
        <Metric label="帧耗时 AVG / P95 / MAX" value={diagnostics ? `${formatMs(diagnostics.averageFrameTimeMs)} / ${formatMs(diagnostics.p95FrameTimeMs)} / ${formatMs(diagnostics.maxFrameTimeMs)}` : "—"} />
        <Metric label="主循环 CPU AVG / MAX" value={diagnostics ? `${formatMs(diagnostics.averageAppCpuTimeMs)} / ${formatMs(diagnostics.maxAppCpuTimeMs)}` : "—"} />
        <Metric label="PlayCanvas Render CPU" value={diagnostics ? formatMs(diagnostics.rendererCpuTimeMs) : "—"} />
      </section>

      <section>
        <h3>GPU 与绘制</h3>
        <Metric label="GPU 资源估算" value={diagnostics ? formatBytes(diagnostics.gpuResourceBytes) : "—"} />
        <Metric label={textureMetricIsBytes ? "Draw / Geometry / Texture VRAM" : "Draw / Geometry / Texture"} value={diagnostics ? `${formatCount(diagnostics.drawCalls)} / ${formatCount(diagnostics.geometries)} / ${textureMetricIsBytes ? formatBytes(diagnostics.textures) : formatCount(diagnostics.textures)}` : "—"} />
        <Metric label="Vertices" value={diagnostics ? formatCount(diagnostics.vertices) : "—"} />
        <Metric label="Renderer / Sort" value={diagnostics ? `${diagnostics.rendererBackend} / ${diagnostics.sortMode ?? "—"}` : "—"} />
        <Metric label="GS Work Buffer" value={diagnostics?.workBufferFormat ?? "—"} />
      </section>

      <section>
        <h3>CPU 与内存</h3>
        <Metric label="宿主 CPU / 服务进程" value={telemetry ? `${formatPercent(telemetry.host.cpuPercent)} / ${formatPercent(telemetry.process.cpuPercent)}` : telemetryUnavailable ? "不可用" : "采样中"} />
        <Metric label="宿主 RAM" value={telemetry ? `${formatBytes(telemetry.host.memoryUsedBytes)} / ${formatBytes(telemetry.host.memoryTotalBytes)}` : "—"} percent={hostMemoryPercent} />
        <Metric label="Node 服务 RSS" value={telemetry ? formatBytes(telemetry.process.rssBytes) : "—"} />
        <Metric label="浏览器 JS Heap" value={browserHeap ? `${formatBytes(browserHeap.used)} / ${formatBytes(browserHeap.limit)}` : "当前浏览器不提供"} percent={browserHeapPercent} />
      </section>

      <section>
        <h3>Chunk LOD 流式状态</h3>
        <Metric label="Chunk 已加载 / 总数 / FAIL" value={diagnostics ? `${diagnostics.loadedChunks ?? diagnostics.completedChunkLoads} / ${diagnostics.chunks} / ${diagnostics.failedChunkLoads}` : "—"} />
        <Metric label="加载中 / 平均 / 近期峰值" value={diagnostics ? `${diagnostics.activeChunkLoads} / ${formatMs(diagnostics.averageChunkLoadMs)} / ${formatMs(diagnostics.recentMaxChunkLoadMs)}` : "—"} />
        <Metric label="各级驻留 Chunk" value={diagnostics?.loadedLevelChunks?.map((count, level) => `L${level}:${count}`).join(" · ") ?? "—"} />
        <Metric label="可见 GS / 当前预算 / 上限" value={diagnostics ? `${formatCount(diagnostics.visibleSplats ?? 0)} / ${formatCount(diagnostics.effectiveBudget ?? diagnostics.budget)} / ${formatCount(diagnostics.budget)}` : "—"} />
        <Metric label="LOD 范围 / 总层级" value={diagnostics ? `${diagnostics.minLevel}…${diagnostics.maxLevel ?? diagnostics.levels - 1} / ${diagnostics.levels}` : "—"} />
        <Metric label="相机距离" value={diagnostics?.cameraDistance !== undefined ? `${diagnostics.cameraDistance.toFixed(diagnostics.cameraDistance >= 100 ? 0 : 1)} m` : "—"} />
        <Metric label="Source Gaussian" value={diagnostics ? formatCount(diagnostics.sourceSplats) : "—"} />
      </section>

      <footer>
        <span>{diagnostics ? `${diagnostics.rendererBackend} · ${diagnostics.format} · rev ${diagnostics.revision.slice(0, 8)}` : "等待 Renderer 首次采样"}</span>
        <span>{diagnostics?.fallbackReason ?? defaultStatus}</span>
        <span title="浏览器不公开可靠的系统 GPU 利用率或物理显存容量；这里只统计 PlayCanvas 可见的资源字节。">GPU 利用率/物理显存：浏览器不可可靠读取</span>
      </footer>
    </div>}
  </aside>;
}

function Metric({ label, value, percent }: { label: string; value: string; percent?: number | null }) {
  return <div className="performance-metric">
    <div><span>{label}</span><output>{value}</output></div>
    {percent !== undefined && percent !== null && <div className="performance-meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>}
  </div>;
}

function readBrowserHeap(): BrowserHeap | null {
  const memory = (performance as PerformanceWithMemory).memory;
  if (!memory || !Number.isFinite(memory.usedJSHeapSize) || !Number.isFinite(memory.jsHeapSizeLimit)) return null;
  return { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit };
}

const formatMs = (value: number) => value > 0 ? `${value.toFixed(value >= 100 ? 0 : 1)} ms` : "0 ms";
const formatPercent = (value: number | null) => value === null ? "采样中" : `${value.toFixed(1)}%`;
const formatCount = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1, notation: "compact" }).format(value);

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}
