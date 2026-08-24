import { UiContainer } from './primitives';

export const PerformanceCard = () => <UiContainer as="aside" variant="floating" className="performance-card" aria-label="性能监控">
  <header><span><i className="live-dot"/>性能</span></header>
  <div className="metric-grid">
    <div><span>FPS</span><strong data-metric="fps">0 FPS</strong></div><div><span>可见 GS</span><strong data-metric="gaussians">0</strong></div>
    <div><span>系统 CPU</span><strong data-metric="system-cpu">采样中</strong></div><div className="metric-wide"><span>系统内存</span><strong data-metric="system-memory">采样中</strong></div>
    <div className="metric-wide"><span>GPU 资源估算</span><strong data-metric="engine-vram">0 B</strong></div>
  </div>
</UiContainer>;
