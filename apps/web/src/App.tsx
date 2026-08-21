import { useCallback, useEffect, useRef, useState } from "react";
import type { Dataset, InspectionLabel, Mission, SurfaceHit } from "@spikive/shared";
import { api } from "./api";
import { AholoScene } from "./AholoScene";
import { DatasetPanel } from "./components/DatasetPanel";
import { InspectionLabelPopup } from "./components/InspectionLabelPopup";
import { LabelPanel } from "./components/LabelPanel";
import { MissionPanel } from "./components/MissionPanel";
import { selectMissionForScene } from "./mission-selection";
import "./styles.css";

type Tab = "data" | "labels" | "mission";
interface FocusRequest { datasetId: string; sequence: number }

const POLL_INTERVAL_MS = 2500;

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [labels, setLabels] = useState<InspectionLabel[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMission, setActiveMission] = useState<Mission | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  const [labelMode, setLabelMode] = useState(false);
  const [pendingPick, setPendingPick] = useState<SurfaceHit | null>(null);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [message, setMessage] = useState("创建数据集并上传 Gaussian PLY");
  const [aholoRuntimeFailed, setAholoRuntimeFailed] = useState(false);
  const initializedDatasetSelection = useRef(false);
  const reportedPollingFailure = useRef(false);
  const focusSequence = useRef(0);
  const dataset = datasets.find(value => value.id === selectedId) ?? null;
  const selectedLabel = labels.find(value => value.id === selectedLabelId && value.datasetId === selectedId) ?? null;

  useEffect(() => setAholoRuntimeFailed(false), [dataset?.id, dataset?.aholoVisualRevision]);
  useEffect(() => {
    setSelectedLabelId(current => current && labels.some(label => label.id === current && label.datasetId === selectedId) ? current : null);
  }, [labels, selectedId]);

  const applyDatasets = useCallback((values: Dataset[]) => {
    setDatasets(values);
    setSelectedId(current => {
      if (!initializedDatasetSelection.current) {
        initializedDatasetSelection.current = true;
        return current ?? values[0]?.id ?? null;
      }
      return current && !values.some(value => value.id === current) ? null : current;
    });
  }, []);

  const refreshDatasets = useCallback(async () => {
    applyDatasets(await api.datasets());
  }, [applyDatasets]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const values = await api.datasets();
        if (stopped) return;
        applyDatasets(values);
        reportedPollingFailure.current = false;
      } catch (error) {
        if (!stopped && !reportedPollingFailure.current) {
          reportedPollingFailure.current = true;
          setMessage(`数据服务暂时不可用：${errorMessage(error)}`);
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyDatasets]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setLabels([]);
      setMissions([]);
      setActiveMission(null);
      setPendingPick(null);
      setLabelMode(false);
      setFocusRequest(null);
      return;
    }
    void Promise.all([api.labels(selectedId), api.missions(selectedId)])
      .then(([nextLabels, nextMissions]) => {
        if (cancelled) return;
        setLabels(nextLabels);
        setMissions(nextMissions);
        setActiveMission(current => selectMissionForScene(current, nextMissions));
      })
      .catch(error => {
        if (!cancelled) setMessage(`场景关联数据加载失败：${errorMessage(error)}`);
      });
    return () => { cancelled = true; };
  }, [selectedId, dataset?.updatedAt]);

  const refreshLabels = useCallback(async () => {
    if (!selectedId) return;
    setLabels(await api.labels(selectedId));
  }, [selectedId]);

  const refreshMissions = useCallback(async () => {
    if (!selectedId) return;
    const nextMissions = await api.missions(selectedId);
    setMissions(nextMissions);
    setActiveMission(current => current ? nextMissions.find(mission => mission.id === current.id) ?? null : null);
  }, [selectedId]);

  const onPickLabel = useCallback((hit: SurfaceHit) => {
    setSelectedLabelId(null);
    setPendingPick(hit);
    setLabelMode(false);
    setTab("labels");
    setMessage("已通过碰撞 SVO 拾取 GS 表面并计算法向，请填写巡检标签");
  }, []);

  const selectDataset = useCallback((id: string) => {
    setSelectedId(id);
    setSelectedLabelId(null);
    setActiveMission(null);
    setPendingPick(null);
    setLabelMode(false);
    setFocusRequest(null);
  }, []);

  const clearModelView = useCallback(() => {
    setSelectedId(null);
    setLabels([]);
    setMissions([]);
    setActiveMission(null);
    setSelectedLabelId(null);
    setPendingPick(null);
    setLabelMode(false);
    setFocusRequest(null);
    setMessage("已清除模型、标签和航迹显示；数据仍保留");
  }, []);

  const deleteDataset = useCallback(async (id: string) => {
    const target = datasets.find(value => value.id === id);
    if (!target || !window.confirm(`永久删除“${target.name}”？\n\nPLY、AHoLo 视觉、碰撞数据、巡检标签和全部航迹任务都会被删除，且无法恢复。`)) return;
    try {
      await api.deleteDataset(id);
      if (selectedId === id) {
        setSelectedId(null);
        setLabels([]);
        setMissions([]);
        setActiveMission(null);
        setSelectedLabelId(null);
        setPendingPick(null);
        setLabelMode(false);
      }
      await refreshDatasets();
      setMessage(`已永久删除模型“${target.name}”及其全部关联数据`);
    } catch (error) {
      setMessage(`删除模型失败：${errorMessage(error)}`);
    }
  }, [datasets, refreshDatasets, selectedId]);

  const retryDataset = useCallback(async (id: string, voxelSize: number) => {
    await api.updateDataset(id, { voxelSize });
    await api.retryDataset(id);
    await refreshDatasets();
    setMessage(`已按人工确认的 ${voxelSize} m 体素尺寸重新排队`);
  }, [refreshDatasets]);

  const buildAholoVisuals = useCallback(async (id: string) => {
    const target = datasets.find(value => value.id === id);
    if (!target || !window.confirm(`为“${target.name}”${target.aholoVisualRevision ? "重建" : "构建"} AHoLo Chunk LOD？\n\n将串行生成高精度 ESZ 和无损 PLY 对照；碰撞、标签和航迹不会改变。`)) return;
    await api.rebuildDatasetVisuals(id);
    await refreshDatasets();
    setMessage(`“${target.name}”已开始${target.aholoVisualRevision ? "重建" : "构建"} AHoLo 视觉`);
  }, [datasets, refreshDatasets]);

  const deleteMission = useCallback(async (id: string) => {
    const target = missions.find(value => value.id === id);
    if (!target || !window.confirm(`永久删除任务“${target.name}”？\n\n该任务及全部航迹点都会被删除，且无法恢复；模型和巡检标签会保留。`)) return;
    try {
      await api.deleteMission(id);
      setActiveMission(current => current?.id === id ? null : current);
      await refreshMissions();
      setMessage(`已永久删除航迹任务“${target.name}”`);
    } catch (error) {
      setMessage(`删除任务失败：${errorMessage(error)}`);
    }
  }, [missions, refreshMissions]);

  const selectInspectionLabel = useCallback((id: string) => {
    setSelectedLabelId(id);
    setMessage("已选中巡检对象；场景高亮并显示空间详情");
  }, []);
  const closeInspectionLabel = useCallback(() => setSelectedLabelId(null), []);

  return <div className="app-shell">
    <header>
      <div><span className="brand-mark">S</span><strong>Spikive GS Inspector</strong></div>
      <span className="status-text">{message}</span>
      <span className="safety">规划结果需人工安全复核</span>
    </header>
    <aside>
      <nav>
        {(["data", "labels", "mission"] as Tab[]).map(value => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>
          {value === "data" ? "数据" : value === "labels" ? "巡检标签" : "航迹规划"}
        </button>)}
      </nav>
      <section className="panel">
        {tab === "data" && <DatasetPanel
          datasets={datasets}
          selectedId={selectedId}
          onSelect={selectDataset}
          onFocus={id => {
            selectDataset(id);
            setFocusRequest({ datasetId: id, sequence: ++focusSequence.current });
            setMessage("正在定位到 GS 数据");
          }}
          onCreated={id => {
            selectDataset(id);
            void refreshDatasets().catch(error => setMessage(`刷新数据集失败：${errorMessage(error)}`));
          }}
          onClearView={clearModelView}
          onRetry={retryDataset}
          onBuildAholo={buildAholoVisuals}
          onDelete={id => void deleteDataset(id)}
          onMessage={setMessage}
        />}
        {tab === "labels" && <LabelPanel
          dataset={dataset}
          labels={labels}
          missions={missions}
          labelMode={labelMode}
          pendingPick={pendingPick}
          onToggleMode={() => { setLabelMode(current => !current); setPendingPick(null); setSelectedLabelId(null); }}
          onCancelPending={() => { setPendingPick(null); setMessage("已取消待保存标签"); }}
          onSaved={async () => { setPendingPick(null); await refreshLabels(); }}
          onRefresh={async () => { await Promise.all([refreshLabels(), refreshMissions()]); }}
          onMessage={setMessage}
        />}
        {tab === "mission" && <MissionPanel
          dataset={dataset}
          labels={labels}
          missions={missions}
          activeMission={activeMission}
          onMission={setActiveMission}
          onClearView={() => { setActiveMission(null); setMessage("已清除航迹显示；任务记录仍保留"); }}
          onDelete={id => void deleteMission(id)}
          onRefresh={refreshMissions}
          onMessage={setMessage}
        />}
      </section>
    </aside>
    <main>
      {!aholoRuntimeFailed
        ? <AholoScene
            dataset={dataset}
            labels={labels}
            mission={activeMission}
            labelMode={labelMode}
            pendingPick={pendingPick}
            selectedLabelId={selectedLabelId}
            focusRequest={focusRequest}
            onPickLabel={onPickLabel}
            onSelectLabel={selectInspectionLabel}
            onMessage={setMessage}
            onFatal={reason => { setAholoRuntimeFailed(true); setMessage(`AHoLo 已有界停止：${reason}`); }}
          />
        : <div className="scene-empty scene-error">
            <span>AHoLo 渲染已停止，业务数据未受影响。</span>
            <button type="button" className="secondary" onClick={() => setAholoRuntimeFailed(false)}>重新加载 AHoLo</button>
          </div>}
      <div className="legend">
        <span><i className="orange" />GS 巡检标签</span>
        <span><i className="red" />标签航迹点</span>
        <span><i className="blue" />途经点</span>
        <span><i className="green" />已校验航线</span>
      </div>
      {selectedLabel && <InspectionLabelPopup label={selectedLabel} onClose={closeInspectionLabel} />}
    </main>
  </div>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
