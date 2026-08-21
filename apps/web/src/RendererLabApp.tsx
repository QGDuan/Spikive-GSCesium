import { useCallback, useEffect, useState } from "react";
import type { Dataset, InspectionLabel, Mission, SurfaceHit } from "@spikive/shared";
import { AholoScene } from "./AholoScene";
import { api } from "./api";
import { InspectionLabelPopup } from "./components/InspectionLabelPopup";
import "./styles.css";

export default function RendererLabApp() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [labels, setLabels] = useState<InspectionLabel[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [missionId, setMissionId] = useState<string>("");
  const [referenceFormat, setReferenceFormat] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  const [message, setMessage] = useState("AHoLo 独立验证环境；本页不会挂载 Cesium");
  const dataset = datasets.find(value => value.id === selectedId) ?? null;
  const mission = missions.find(value => value.id === missionId) ?? null;
  const selectedLabel = labels.find(value => value.id === selectedLabelId) ?? null;

  const refresh = useCallback(async () => {
    const values = await api.datasets();
    setDatasets(values);
    setSelectedId(current => current && values.some(value => value.id === current) ? current : values[0]?.id ?? null);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!stopped) await refresh(); }
      catch (error) { if (!stopped) setMessage(`数据刷新失败：${errorMessage(error)}`); }
      if (!stopped) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) { setLabels([]); setMissions([]); setSelectedLabelId(null); return; }
    void Promise.all([api.labels(selectedId), api.missions(selectedId)]).then(([nextLabels, nextMissions]) => {
      if (cancelled) return;
      setLabels(nextLabels);
      setMissions(nextMissions);
      setMissionId(current => nextMissions.some(value => value.id === current) ? current : nextMissions[0]?.id ?? "");
    }).catch(error => { if (!cancelled) setMessage(`关联数据加载失败：${errorMessage(error)}`); });
    return () => { cancelled = true; };
  }, [selectedId, dataset?.updatedAt]);

  useEffect(() => {
    setSelectedLabelId(current => current && labels.some(label => label.id === current) ? current : null);
  }, [labels]);

  const pickLabel = async (hit: SurfaceHit) => {
    if (!dataset) return;
    setPickMode(false);
    const title = window.prompt("巡检标签名称", `巡检点 ${labels.length + 1}`)?.trim();
    if (!title) { setMessage("已取消保存标签"); return; }
    try {
      await api.createLabel(dataset.id, {
        title, description: "", category: "巡检点", color: "#ef4444",
        positionLocal: hit.position, surfaceNormalLocal: hit.normal
      });
      setLabels(await api.labels(dataset.id));
      setMessage(`已通过后端 SVO 保存标签“${title}”`);
    } catch (error) { setMessage(`保存标签失败：${errorMessage(error)}`); }
  };

  return <div className="renderer-lab-shell">
    <header>
      <div><span className="brand-mark">A</span><strong>Renderer Lab</strong></div>
      <span className="status-text">{message}</span>
      <a href="/">返回生产视图</a>
    </header>
    <aside className="renderer-lab-panel">
      <h2>AHoLo 迁移验证</h2>
      <p className="hint">本页只创建一个 AHoLo WebGL/2 上下文。生产 Cesium 入口与碰撞 SVO 保持不变。</p>
      <label>数据集
        <select value={selectedId ?? ""} onChange={event => { setSelectedId(event.target.value || null); setSelectedLabelId(null); }}>
          <option value="">请选择</option>
          {datasets.map(value => <option value={value.id} key={value.id}>{value.name} · {value.status}</option>)}
        </select>
      </label>
      <div className="lab-summary">
        <span>生产 Renderer</span><strong>{dataset?.visualBackend ?? "-"}</strong>
        <span>AHoLo revision</span><strong>{dataset?.aholoVisualRevision?.slice(0, 8) ?? "未构建"}</strong>
        <span>碰撞</span><strong>{dataset?.collisionStatus ?? "-"}</strong>
      </div>
      <button className="primary" disabled={!dataset || dataset.status !== "ready"} onClick={() => dataset && void api.rebuildDatasetVisuals(dataset.id)
        .then(() => { setMessage("AHoLo 候选已排队；ESZ 与 PLY 对照将串行构建"); return refresh(); })
        .catch(error => setMessage(`排队失败：${errorMessage(error)}`))}>构建固定 AHoLo 候选</button>
      <label className="check"><input type="checkbox" checked={referenceFormat} onChange={event => setReferenceFormat(event.target.checked)} />加载无损 PLY 对照</label>
      <label>可视化航迹
        <select value={missionId} onChange={event => setMissionId(event.target.value)}>
          <option value="">不显示</option>
          {missions.map(value => <option value={value.id} key={value.id}>{value.name} · {value.status}</option>)}
        </select>
      </label>
      <button className={pickMode ? "primary" : "secondary"} disabled={!dataset?.aholoVisualRevision || dataset.collisionStatus !== "ready"} onClick={() => { setPickMode(value => !value); setSelectedLabelId(null); }}>
        {pickMode ? "点击 GS 表面打标签" : "开启 SVO 标签拾取"}
      </button>
      <hr />
      <p className="hint">验收顺序：原始 PLY → 无损 Chunk → 高精度 ESZ → 当前 Cesium。高精度 ESZ 任一近景锚点明显失真时，不应启用生产切换。</p>
      <button className="secondary" disabled={!dataset?.aholoVisualRevision || dataset.status !== "ready"} onClick={() => dataset && void api.setRenderBackend(dataset.id, "aholo-chunk-lod")
        .then(() => refresh()).then(() => setMessage("已显式启用 AHoLo；生产页仍保证单 Renderer"))
        .catch(error => setMessage(`启用失败：${errorMessage(error)}`))}>验收后启用 AHoLo</button>
      <button className="secondary" disabled={!dataset || dataset.status !== "ready"} onClick={() => dataset && void api.setRenderBackend(dataset.id, "cesium-3dtiles")
        .then(() => refresh()).then(() => setMessage("已回滚 Cesium"))
        .catch(error => setMessage(`回滚失败：${errorMessage(error)}`))}>回滚 Cesium</button>
    </aside>
    <main>
      <AholoScene
        dataset={dataset}
        labels={labels}
        mission={mission}
        labelMode={pickMode}
        pendingPick={null}
        selectedLabelId={selectedLabelId}
        referenceFormat={referenceFormat}
        showDiagnostics
        onPickLabel={hit => void pickLabel(hit)}
        onSelectLabel={labelId => { setSelectedLabelId(labelId); setMessage("已选中巡检对象"); }}
        onMessage={setMessage}
        onFatal={reason => setMessage(`AHoLo 已停止：${reason}`)}
      />
      <div className="legend">
        <span><i className="red" />标签航迹点</span>
        <span><i className="blue" />途经点</span>
        <span><i className="green" />有效航线</span>
        <span><i className="orange" />安全前缀预览</span>
      </div>
      {selectedLabel && <InspectionLabelPopup label={selectedLabel} onClose={() => setSelectedLabelId(null)} />}
    </main>
  </div>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
