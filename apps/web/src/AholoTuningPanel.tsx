import { useEffect, useState } from "react";
import {
  DEFAULT_AHOLO_RUNTIME_CONFIG, normalizeAholoRuntimeConfig, type AholoRuntimeConfig
} from "./aholo-runtime-config";

interface Props {
  value: AholoRuntimeConfig;
  maxLevel: number;
  sourceSplats: number;
  onApply(value: AholoRuntimeConfig): void;
  onMessage(message: string): void;
}

export function AholoTuningPanel({ value, maxLevel, sourceSplats, onApply, onMessage }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const update = <K extends keyof AholoRuntimeConfig>(key: K, next: AholoRuntimeConfig[K]) => {
    setDraft(current => ({ ...current, [key]: next }));
  };
  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    const next = normalizeAholoRuntimeConfig(draft, maxLevel, sourceSplats);
    setDraft(next);
    onApply(next);
    onMessage(`已应用 AHoLo 会话参数：minLevel ${next.minLevel}，预算 ${(next.maxBudget / 1_000_000).toFixed(1)}M`);
  };
  const reset = () => {
    const next = normalizeAholoRuntimeConfig({ ...DEFAULT_AHOLO_RUNTIME_CONFIG }, maxLevel, sourceSplats);
    setDraft(next);
    onApply(next);
    onMessage("已恢复 AHoLo 固定默认参数；未修改视觉产物或碰撞数据");
  };

  return <div className={`aholo-tuning ${open ? "open" : ""}`}>
    <button type="button" className="aholo-tuning-toggle" onClick={() => setOpen(current => !current)}>
      LOD 调参 · L{value.minLevel} · {(value.maxBudget / 1_000_000).toFixed(1)}M
    </button>
    {open && <form onSubmit={apply}>
      <header><strong>AHoLo 运行时参数</strong><small>仅当前会话 · 显式应用</small></header>
      <label>最细允许层 minLevel
        <input type="number" min="0" max={maxLevel} step="1" value={draft.minLevel} onChange={event => update("minLevel", Number(event.target.value))} />
        <small>0 最清晰；数值越大越偏向粗层</small>
      </label>
      <label>Gaussian 预算
        <div className="aholo-budget-row">
          <input type="range" min="0.5" max={Math.max(0.5, sourceSplats / 1_000_000)} step="0.5" value={draft.maxBudget / 1_000_000} onChange={event => update("maxBudget", Number(event.target.value) * 1_000_000)} />
          <output>{(draft.maxBudget / 1_000_000).toFixed(1)}M</output>
        </div>
      </label>
      <label>背景权重 backgroundPenalty
        <input type="number" min="0" max="1" step="0.05" value={draft.backgroundPenalty} onChange={event => update("backgroundPenalty", Number(event.target.value))} />
      </label>
      <div className="row">
        <label>近距阈值 m<input type="number" min="0" max="100000" step="1" value={draft.nearDistance} onChange={event => update("nearDistance", Number(event.target.value))} /></label>
        <label>近距层步长<input type="number" min="1" max={maxLevel + 1} step="1" value={draft.nearLevelStep} onChange={event => update("nearLevelStep", Number(event.target.value))} /></label>
      </div>
      <details>
        <summary>调度与诊断</summary>
        <div className="row">
          <label>滞回 ticks<input type="number" min="0" max="30" step="1" value={draft.hysteresisTicks} onChange={event => update("hysteresisTicks", Number(event.target.value))} /></label>
          <label>并行任务<input type="number" min="1" max="8" step="1" value={draft.schedulerParallelCounts} onChange={event => update("schedulerParallelCounts", Number(event.target.value))} /></label>
        </div>
        <div className="row">
          <label>任务缓存<input type="number" min="4" max="256" step="4" value={draft.schedulerExistingTaskLimit} onChange={event => update("schedulerExistingTaskLimit", Number(event.target.value))} /></label>
          <label>调度间隔 ms<input type="number" min="16" max="2000" step="16" value={draft.schedulerMinDuration} onChange={event => update("schedulerMinDuration", Number(event.target.value))} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={draft.mergeNodeEnabled} onChange={event => update("mergeNodeEnabled", event.target.checked)} />合并连续节点</label>
        <label className="check"><input type="checkbox" checked={draft.frustumCullingEnabled} onChange={event => update("frustumCullingEnabled", event.target.checked)} />视锥剔除</label>
        <label className="check"><input type="checkbox" checked={draft.debuggerEnabled} onChange={event => update("debuggerEnabled", event.target.checked)} />LOD 层级诊断着色</label>
      </details>
      <p>参数通过 AHoLo `LodSplat.setConfig()` 生效，不重切片、不改变 SVO、标签或航线。</p>
      <div className="aholo-tuning-actions">
        <button type="button" onClick={reset}>恢复 6M 默认</button>
        <button className="primary">应用</button>
      </div>
    </form>}
  </div>;
}
