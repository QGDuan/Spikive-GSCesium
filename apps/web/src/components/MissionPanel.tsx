import { useEffect, useState } from "react";
import type { Dataset, InspectionLabel, Mission } from "@spikive/shared";
import { api } from "../api";

interface MissionPanelProps {
  dataset: Dataset | null;
  labels: InspectionLabel[];
  missions: Mission[];
  activeMission: Mission | null;
  onMission(mission: Mission): void;
  onClearView(): void;
  onDelete(id: string): void;
  onRefresh(): Promise<void>;
  onMessage(value: string): void;
}

export function MissionPanel({ dataset, labels, missions, activeMission, onMission, onClearView, onDelete, onRefresh, onMessage }: MissionPanelProps) {
  const [planning, setPlanning] = useState(false);
  const [startLabelId, setStartLabelId] = useState("");
  const [planningFeedback, setPlanningFeedback] = useState<PlanningFeedback | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!planningFeedback || (planningFeedback.phase !== "creating" && planningFeedback.phase !== "planning")) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - planningFeedback.startedAt) / 1_000)));
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [planningFeedback]);

  useEffect(() => {
    if (startLabelId && !labels.some(label => label.id === startLabelId && label.resolutionStatus === "resolved")) setStartLabelId("");
  }, [labels, startLabelId]);

  async function planExistingMission(mission: Mission) {
    setPlanning(true);
    const startedAt = Date.now();
    onMission(mission);
    setPlanningFeedback({ phase: "planning", missionName: mission.name, startedAt, detail: "正在加载场景碰撞体并计算逐段通路" });
    onMessage(`正在计算航线“${mission.name}”…`);
    try {
      const planned = await api.planMission(mission.id);
      onMission(planned);
      await onRefresh();
      const valid = planned.status === "valid";
      setPlanningFeedback({
        phase: valid ? "complete" : "failed",
        missionName: planned.name,
        startedAt,
        detail: planningResultDetail(planned)
      });
      onMessage(valid
        ? `航线“${planned.name}”已通过碰撞复检并显示`
        : planned.waypoints.length
          ? `规划失败，已显示 ${planned.waypoints.length} 个安全前缀预览点；该路线不可导出或执行`
          : `规划失败：${planned.error}`);
    } catch (error) {
      await onRefresh().catch(() => undefined);
      const detail = errorMessage(error);
      setPlanningFeedback({ phase: "failed", missionName: mission.name, startedAt, detail });
      onMessage(`规划失败：${detail}`);
    } finally {
      setPlanning(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dataset) return;
    const form = new FormData(event.currentTarget);
    const startLabel = startLabelId ? labels.find(label => label.id === startLabelId) : undefined;
    const labelIds = labels.filter(label => form.get(`label-${label.id}`)).map(label => label.id);
    if (!labelIds.length) {
      onMessage("至少选择一个巡检标签");
      return;
    }
    setPlanning(true);
    const startedAt = Date.now();
    const missionName = String(form.get("name"));
    setPlanningFeedback({ phase: "creating", missionName, startedAt, detail: "正在建立场景绑定的航线任务记录" });
    onMessage(`正在建立航线任务“${missionName}”…`);
    try {
      const mission = await api.createMission({
        datasetId: dataset.id,
        name: missionName,
        homeLocal: startLabel?.positionLocal ?? { x: Number(form.get("homeX")), y: Number(form.get("homeY")), z: Number(form.get("homeZ")) },
        startLabelId: startLabel?.id ?? null,
        labelIds,
        flightProfile: {
          droneRadius: Number(form.get("radius")),
          safetyMargin: Number(form.get("margin")),
          observationDistance: Number(form.get("distance")),
          speed: Number(form.get("speed")),
          minimumWaypointSpacing: Number(form.get("spacing")),
          maximumSegmentLength: Number(form.get("maximumSegmentLength"))
        }
      });
      onMission(mission);
      setPlanningFeedback({ phase: "planning", missionName: mission.name, startedAt, detail: "任务已建立，正在加载碰撞体并计算 Home → 标签 → Home 通路" });
      onMessage(`任务“${mission.name}”已建立，正在进行碰撞规划…`);
      await onRefresh();
      const planned = await api.planMission(mission.id);
      onMission(planned);
      await onRefresh();
      const valid = planned.status === "valid";
      setPlanningFeedback({
        phase: valid ? "complete" : "failed",
        missionName: planned.name,
        startedAt,
        detail: planningResultDetail(planned)
      });
      onMessage(valid
        ? `航线“${planned.name}”已生成并显示`
        : planned.waypoints.length
          ? `规划失败，已显示 ${planned.waypoints.length} 个安全前缀预览点；该路线不可导出或执行`
          : `规划失败：${planned.error}`);
    } catch (error) {
      await onRefresh().catch(() => undefined);
      const detail = errorMessage(error);
      setPlanningFeedback({ phase: "failed", missionName, startedAt, detail });
      onMessage(`规划失败：${detail}`);
    } finally {
      setPlanning(false);
    }
  }

  return <>
    <h2>航迹规划</h2>
    <p className="hint">Home 和航迹点是自由空间坐标。每个航段都按“机体半径 + 安全余量”做扫掠碰撞；直线受阻时运行三维 A*，再平滑、细分并逐段复检。</p>
    <div className="view-actions">
      <button type="button" className="secondary" disabled={!activeMission} onClick={onClearView}>清除路线显示</button>
      <button type="button" className="secondary" disabled={planning || !dataset} onClick={() => void onRefresh().then(() => onMessage("航线任务列表已刷新")).catch(error => onMessage(`刷新任务失败：${errorMessage(error)}`))}>刷新任务列表</button>
      <button type="button" className="secondary" disabled={!activeMission || planning || dataset?.collisionStatus !== "ready"} onClick={() => activeMission && void planExistingMission(activeMission)}>{planning ? "计算中…" : "重新规划当前任务"}</button>
      <button type="button" className="danger" disabled={!activeMission || planning} onClick={() => activeMission && onDelete(activeMission.id)}>永久删除当前任务</button>
    </div>
    {planningFeedback && <div className={`planning-feedback ${planningFeedback.phase}`} role="status" aria-live="polite">
      <div>
        <i />
        <strong>{planningFeedback.phase === "creating" ? "建立任务" : planningFeedback.phase === "planning" ? "碰撞规划" : planningFeedback.phase === "complete" ? "规划完成" : "规划失败"}</strong>
        <span>{planningFeedback.phase === "creating" || planningFeedback.phase === "planning" ? `${elapsedSeconds}s` : planningFeedback.missionName}</span>
      </div>
      <p>{planningFeedback.detail}</p>
    </div>}
    <form onSubmit={submit} className="form-grid">
      <label>任务名称<input name="name" defaultValue="变电站巡检任务" required /></label>
      <fieldset>
        <legend>起点</legend>
        <label>起点方式<select value={startLabelId} onChange={event => setStartLabelId(event.target.value)}>
          <option value="">自由空间 Home 坐标</option>
          {labels.filter(label => label.resolutionStatus === "resolved").map(label => <option key={label.id} value={label.id}>标签 · {label.title}</option>)}
        </select></label>
        {startLabelId
          ? <small>系统会从标签法向、观察距离和碰撞体推导安全起点，并在任务结束时返回该点；不会直接飞到标签表面。</small>
          : <div className="row triple">
              <input name="homeX" type="number" step="any" placeholder="X" required />
              <input name="homeY" type="number" step="any" placeholder="Y" required />
              <input name="homeZ" type="number" step="any" placeholder="Z" required />
            </div>}
      </fieldset>
      <fieldset>
        <legend>飞行与安全参数（必须确认）</legend>
        <div className="row">
          <label>机体半径<input name="radius" type="number" min="0.01" step="0.1" defaultValue="0.4" required /></label>
          <label>安全余量<input name="margin" type="number" min="0" step="0.1" defaultValue="0.6" required /></label>
        </div>
        <div className="row">
          <label>观察距离<input name="distance" type="number" min="0.1" step="0.5" defaultValue="3" required /></label>
          <label>速度 m/s<input name="speed" type="number" min="0.1" step="0.5" defaultValue="2" required /></label>
        </div>
        <div className="row">
          <label>最小点间距<input name="spacing" type="number" min="0.1" step="0.1" defaultValue="0.5" required /></label>
          <label>最大航段长度<input name="maximumSegmentLength" type="number" min="0.1" max="500" step="0.5" defaultValue={Math.max(5, dataset?.voxelSize ?? 0)} required /></label>
        </div>
        <small>最大航段控制长直线的细分密度；它不会提升碰撞体本身的体素精度。</small>
      </fieldset>
      <fieldset>
        <legend>按显示顺序巡检并返航</legend>
        {labels.map((label, index) => <label className="check" key={label.id}>
          <input type="checkbox" name={`label-${label.id}`} disabled={label.resolutionStatus !== "resolved" || label.id === startLabelId} defaultChecked={label.resolutionStatus === "resolved"} />
          <span>{index + 1}. {label.title}</span>
          <small>{label.id === startLabelId ? "作为起点" : label.resolutionStatus}</small>
        </label>)}
      </fieldset>
      <button className="primary" disabled={planning || dataset?.collisionStatus !== "ready"}>{planning ? "碰撞规划中…" : "生成避障航迹"}</button>
    </form>
    <hr />
    <div className="list">
      {missions.map(mission => <div className="mission-entry" key={mission.id}>
        <button
          type="button"
          className={`list-item ${activeMission?.id === mission.id ? "selected" : ""}`}
          onClick={() => onMission(mission)}
        >
          <strong>{mission.name}</strong>
          <span>{mission.status} · {mission.status === "invalid" && mission.waypoints.length ? "部分预览 " : ""}{mission.waypoints.length} 点 · {routeLength(mission).toFixed(1)} m</span>
          <small>{mission.startLabelId ? `标签起点 · ${labels.find(label => label.id === mission.startLabelId)?.title ?? mission.startLabelId}` : "自由空间 Home 起点"}</small>
          {mission.status === "valid" && <small>逐段扫掠已复检 · 最大航段 {maximumRouteSegment(mission).toFixed(1)} m</small>}
          {mission.status === "invalid" && mission.waypoints.length > 0 && <small>仅显示失败位置之前的已复检前缀 · 禁止导出或执行</small>}
          {mission.error && <small>{mission.error}</small>}
        </button>
        <div className="mission-actions">
          <button type="button" className="secondary" disabled={planning || dataset?.collisionStatus !== "ready"} onClick={() => void planExistingMission(mission)}>{mission.status === "draft" || mission.status === "invalid" ? "计算航线" : "重新计算"}</button>
          <button type="button" className="danger" disabled={planning} onClick={() => onDelete(mission.id)}>删除航线任务</button>
        </div>
      </div>)}
    </div>
  </>;
}

interface PlanningFeedback {
  phase: "creating" | "planning" | "complete" | "failed";
  missionName: string;
  startedAt: number;
  detail: string;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function planningResultDetail(mission: Mission) {
  if (mission.status === "valid") return `碰撞复检通过，已生成 ${mission.waypoints.length} 个航迹点并显示到地图`;
  if (mission.waypoints.length) {
    return `规划未通过；已显示失败位置之前的 ${mission.waypoints.length} 个安全前缀预览点。预览禁止导出或执行。${mission.error ?? ""}`;
  }
  return mission.error ?? "规划未通过碰撞复检";
}

function routeLength(mission: Mission) {
  return mission.waypoints.slice(1).reduce((total, point, index) => total + pointDistance(mission.waypoints[index]!.positionLocal, point.positionLocal), 0);
}

function maximumRouteSegment(mission: Mission) {
  return mission.waypoints.slice(1).reduce((maximum, point, index) => Math.max(maximum, pointDistance(mission.waypoints[index]!.positionLocal, point.positionLocal)), 0);
}

function pointDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
