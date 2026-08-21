import type { Dataset, InspectionLabel, Mission, SurfaceHit } from "@spikive/shared";
import { api } from "../api";

interface LabelPanelProps {
  dataset: Dataset | null;
  labels: InspectionLabel[];
  missions: Mission[];
  labelMode: boolean;
  pendingPick: SurfaceHit | null;
  onToggleMode(): void;
  onCancelPending(): void;
  onSaved(): Promise<void>;
  onRefresh(): Promise<void>;
  onMessage(value: string): void;
}

export function LabelPanel({ dataset, labels, missions, labelMode, pendingPick, onToggleMode, onCancelPending, onSaved, onRefresh, onMessage }: LabelPanelProps) {
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dataset || !pendingPick) return;
    const form = new FormData(event.currentTarget);
    try {
      await api.createLabel(dataset.id, {
        title: String(form.get("title")),
        description: String(form.get("description") || ""),
        category: String(form.get("category") || "巡检点"),
        color: String(form.get("color")),
        positionLocal: pendingPick.position,
        surfaceNormalLocal: pendingPick.normal
      });
      await onSaved();
      onMessage("巡检标签已保存并解析表面法向");
    } catch (error) {
      onMessage(`保存标签失败：${errorMessage(error)}`);
    }
  }

  async function deleteLabel(label: InspectionLabel) {
    if (!window.confirm(`永久删除标签“${label.title}”？\n\n此操作无法恢复。`)) return;
    try {
      await api.deleteLabel(label.id);
      await onRefresh();
      onMessage(`已删除标签“${label.title}”`);
    } catch (error) {
      onMessage(`删除标签失败：${errorMessage(error)}`);
    }
  }

  async function flipLabel(label: InspectionLabel) {
    try {
      await api.flipLabel(label.id);
      await onRefresh();
      onMessage(`已翻转标签“${label.title}”的表面法向；引用任务需要重新规划`);
    } catch (error) {
      onMessage(`翻转法向失败：${errorMessage(error)}`);
    }
  }

  async function resolveLabel(label: InspectionLabel) {
    try {
      const resolved = await api.resolveLabel(label.id);
      await onRefresh();
      onMessage(resolved.resolutionStatus === "resolved"
        ? `标签“${label.title}”已重新解析表面法向；引用任务需要重新规划`
        : `标签“${label.title}”不在可靠碰撞表面，请先删除引用任务，再删除并重新拾取该标签`);
    } catch (error) {
      onMessage(`重新解析标签失败：${errorMessage(error)}`);
    }
  }

  return <>
    <h2>巡检标签</h2>
    <p className="hint">标签必须由用户手动拾取 GS 表面。点击时显示十字反馈，命中后场景中会保留橙色“待保存标签”点；航迹不会在此模式创建。</p>
    <button className={labelMode ? "danger" : "primary"} disabled={!dataset || dataset.status !== "ready"} onClick={onToggleMode}>
      {labelMode ? "退出拾取模式" : pendingPick ? "重新拾取 GS 标签" : "开始拾取 GS 标签"}
    </button>
    {pendingPick && <form onSubmit={save} className="form-grid card">
      <strong>GS 局部坐标</strong>
      <code>{pendingPick.position.x.toFixed(3)}, {pendingPick.position.y.toFixed(3)}, {pendingPick.position.z.toFixed(3)}</code>
      <strong>SVO 表面法向</strong>
      <code>{pendingPick.normal.x.toFixed(3)}, {pendingPick.normal.y.toFixed(3)}, {pendingPick.normal.z.toFixed(3)}</code>
      <label>标题<input name="title" required autoFocus placeholder="设备/缺陷名称" /></label>
      <label>分类<input name="category" defaultValue="巡检点" /></label>
      <label>颜色<input name="color" type="color" defaultValue="#ffb020" /></label>
      <label>描述<textarea name="description" rows={3} /></label>
      <div className="actions">
        <button className="primary">保存标签</button>
        <button type="button" onClick={onCancelPending}>取消待保存点</button>
      </div>
    </form>}
    <div className="list label-list">
      {labels.map(label => {
        const usingMissions = missions.filter(mission => mission.startLabelId === label.id || mission.labelIds.includes(label.id));
        return <div className="card" key={label.id}>
          <div className="card-title">
            <i style={{ background: label.color }} />
            <strong>{label.title}</strong>
            <span className={label.resolutionStatus}>{label.resolutionStatus}</span>
          </div>
          <small>{label.category} · snap {label.snapDistance?.toFixed(3) ?? "--"}m</small>
          {usingMissions.length > 0 && <small className="usage-warning">正在被 {usingMissions.map(mission => mission.name).join("、")} 使用，请先永久删除任务</small>}
          <div className="actions">
            <button onClick={() => void resolveLabel(label)}>重新解析表面</button>
            <button onClick={() => void flipLabel(label)}>翻转法向</button>
            <button
              className="text-danger"
              disabled={usingMissions.length > 0}
              title={usingMissions.length > 0 ? "请先永久删除引用该标签的航迹任务" : "永久删除标签"}
              onClick={() => void deleteLabel(label)}
            >{usingMissions.length > 0 ? "使用中，不可删除" : "删除"}</button>
          </div>
        </div>;
      })}
    </div>
  </>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
