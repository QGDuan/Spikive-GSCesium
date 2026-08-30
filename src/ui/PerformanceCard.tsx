import { useState } from 'react';
import { CollapseButton, UiContainer } from './primitives';

export const PerformanceCard = () => {
  const [collapsed, setCollapsed] = useState(false);
  return <UiContainer as="aside" variant="floating" className={`performance-card${collapsed ? ' is-collapsed' : ''}`} aria-label="性能监控">
  <header><span><i className="live-dot"/>性能</span><CollapseButton collapsed={collapsed} controls="performance-metrics" label="性能卡片" onToggle={() => setCollapsed((value) => !value)}/></header>
  <div id="performance-metrics" className="metric-grid">
    <div><span>帧率</span><strong data-metric="fps">0 帧/秒</strong></div><div><span>可见高斯点</span><strong data-metric="gaussians">0</strong></div>
    <div><span>系统处理器</span><strong data-metric="system-cpu">采样中</strong></div><div className="metric-wide"><span>系统内存</span><strong data-metric="system-memory">采样中</strong></div>
    <div className="metric-wide"><span>图形资源估算</span><strong data-metric="engine-vram">0 字节</strong></div>
  </div>
</UiContainer>;
};
