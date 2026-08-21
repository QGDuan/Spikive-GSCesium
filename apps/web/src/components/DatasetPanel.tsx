import { useState } from "react";
import * as tus from "tus-js-client";
import type { Dataset } from "@spikive/shared";
import { api } from "../api";

interface DatasetPanelProps {
  datasets: Dataset[];
  selectedId: string | null;
  onSelect(id: string): void;
  onFocus(id: string): void;
  onCreated(id: string): void;
  onClearView(): void;
  onRetry(id: string, voxelSize: number): Promise<void>;
  onRebuild(id: string): Promise<void>;
  onBuildAholo(id: string): Promise<void>;
  onSwitchRenderer(id: string, backend: Dataset["visualBackend"]): Promise<void>;
  onDelete(id: string): void;
  onMessage(value: string): void;
}

export function DatasetPanel({ datasets, selectedId, onSelect, onFocus, onCreated, onClearView, onRetry, onRebuild, onBuildAholo, onSwitchRenderer, onDelete, onMessage }: DatasetPanelProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [rebuildingId, setRebuildingId] = useState<string | null>(null);
  const selectedDataset = datasets.find(value => value.id === selectedId) ?? null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file") as File;
    if (!file?.name.toLowerCase().endsWith(".ply")) {
      onMessage("请选择 .ply 文件");
      return;
    }

    setUploading(true);
    setProgress(0);
    let createdDataset: Dataset | null = null;
    try {
      const sceneType = String(form.get("sceneType")) as "outdoor" | "indoor";
      createdDataset = await api.createDataset({
        name: String(form.get("name") || file.name.replace(/\.ply$/i, "")),
        sourceFileName: file.name,
        sourceSize: file.size,
        sceneType,
        inputConvention: "graphdeco",
        voxelSize: Number(form.get("voxelSize")),
        voxelOpacity: 0.1,
        indoorSeed: sceneType === "indoor"
          ? { x: Number(form.get("seedX")), y: Number(form.get("seedY")), z: Number(form.get("seedZ")) }
          : null,
        placement: {
          longitude: Number(form.get("longitude")),
          latitude: Number(form.get("latitude")),
          height: Number(form.get("height")),
          heading: 0,
          pitch: 0,
          roll: 0,
          scale: 1
        }
      });
      onCreated(createdDataset.id);
      onMessage("数据集已创建，正在断点上传");
      await uploadPly(file, createdDataset.id, setProgress);
      onMessage("上传完成，后台开始生成 3D Tiles 和碰撞体");
    } catch (error) {
      if (createdDataset) await api.deleteDataset(createdDataset.id).catch(() => undefined);
      onMessage(`上传失败，已清理未完成记录：${errorMessage(error)}`);
    } finally {
      setUploading(false);
    }
  }

  async function retry(event: React.FormEvent<HTMLFormElement>, dataset: Dataset) {
    event.preventDefault();
    const voxelSize = Number(new FormData(event.currentTarget).get("voxelSize"));
    if (!Number.isFinite(voxelSize) || voxelSize < 0.02 || voxelSize > 2) {
      onMessage("体素尺寸必须在 0.02～2 m 之间");
      return;
    }
    setRetryingId(dataset.id);
    try {
      await onRetry(dataset.id, voxelSize);
    } catch (error) {
      onMessage(`重新排队失败：${errorMessage(error)}`);
    } finally {
      setRetryingId(null);
    }
  }

  return <>
    <h2>GS 数据</h2>
    <form onSubmit={submit} className="form-grid">
      <label>名称<input name="name" placeholder="变电站巡检模型" /></label>
      <label>PLY 文件<input name="file" type="file" accept=".ply" required /></label>
      <div className="row">
        <label>经度<input name="longitude" type="number" step="any" defaultValue="121.4737" required /></label>
        <label>纬度<input name="latitude" type="number" step="any" defaultValue="31.2304" required /></label>
      </div>
      <div className="row">
        <label>高度(m)<input name="height" type="number" step="any" defaultValue="0" /></label>
        <label>体素(m)<input name="voxelSize" type="number" min="0.02" max="2" step="0.01" defaultValue="0.1" /></label>
      </div>
      <label>场景<select name="sceneType"><option value="outdoor">室外 / 变电站</option><option value="indoor">室内封闭空间</option></select></label>
      <fieldset>
        <legend>室内自由空间 Seed（室外忽略）</legend>
        <div className="row triple">
          <input name="seedX" type="number" step="any" defaultValue="0" aria-label="Seed X" />
          <input name="seedY" type="number" step="any" defaultValue="0" aria-label="Seed Y" />
          <input name="seedZ" type="number" step="any" defaultValue="1" aria-label="Seed Z" />
        </div>
      </fieldset>
      <button className="primary" disabled={uploading}>{uploading ? `上传 ${progress}%` : "创建并上传"}</button>
    </form>
    <hr />
    <p className="hint">单击选择，双击定位到模型</p>
    <div className="list">
      {datasets.map(value => <div className="dataset-entry" key={value.id}>
        <button
          className={`list-item ${selectedId === value.id ? "selected" : ""}`}
          onClick={() => onSelect(value.id)}
          onDoubleClick={() => onFocus(value.id)}
        >
          <strong>{value.name}</strong>
          <span>{statusLabel(value.status)} · {value.progress}%</span>
          <small>{value.stage}</small>
          {value.error && <small className="dataset-error" title={value.error}>{value.error}</small>}
        </button>
        {value.status === "failed" && <form className="retry-controls" onSubmit={event => void retry(event, value)}>
          <label>人工确认体素尺寸 (m)
            <input name="voxelSize" type="number" min="0.02" max="2" step="0.001" defaultValue={suggestedVoxelSize(value)} required />
          </label>
          <small>尺寸越大越省内存，但细障碍表达越少；平台不会自动修改。</small>
          <button className="secondary" disabled={retryingId === value.id}>{retryingId === value.id ? "排队中…" : "确认参数并重试"}</button>
        </form>}
      </div>)}
    </div>
    <div className="view-actions">
      <button type="button" className="secondary" disabled={!selectedId} onClick={onClearView}>清除模型显示</button>
      <button
        type="button"
        className="secondary"
        disabled={selectedDataset?.status !== "ready" || rebuildingId === selectedId}
        onClick={() => {
          if (!selectedId) return;
          setRebuildingId(selectedId);
          void onRebuild(selectedId)
            .catch(error => onMessage(`高清切片重建失败：${errorMessage(error)}`))
            .finally(() => setRebuildingId(null));
        }}
      >{rebuildingId === selectedId ? "已排队…" : "重建高清切片"}</button>
      <button
        type="button"
        className="secondary"
        disabled={selectedDataset?.status !== "ready" || rebuildingId === selectedId}
        onClick={() => {
          if (!selectedId) return;
          setRebuildingId(selectedId);
          void onBuildAholo(selectedId)
            .catch(error => onMessage(`AHoLo 候选构建失败：${errorMessage(error)}`))
            .finally(() => setRebuildingId(null));
        }}
      >构建 AHoLo 候选</button>
      <button
        type="button"
        className="secondary"
        disabled={!selectedDataset || selectedDataset.status !== "ready" || (!selectedDataset.aholoVisualRevision && selectedDataset.visualBackend === "cesium-3dtiles")}
        onClick={() => selectedDataset && void onSwitchRenderer(
          selectedDataset.id,
          selectedDataset.visualBackend === "cesium-3dtiles" ? "aholo-chunk-lod" : "cesium-3dtiles"
        ).catch(error => onMessage(`Renderer 切换失败：${errorMessage(error)}`))}
      >{selectedDataset?.visualBackend === "aholo-chunk-lod" ? "回滚 Cesium" : "启用 AHoLo"}</button>
      <button type="button" className="danger" disabled={!selectedId || uploading} onClick={() => selectedId && onDelete(selectedId)}>永久删除所选模型</button>
    </div>
  </>;
}

function uploadPly(file: File, datasetId: string, onProgress: (progress: number) => void) {
  return new Promise<void>((resolve, reject) => {
    new tus.Upload(file, {
      endpoint: "/api/uploads",
      chunkSize: 16 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000],
      metadata: { datasetId, filename: file.name, filetype: file.type },
      onError: reject,
      onProgress: (sent, total) => onProgress(total > 0 ? Math.round(sent / total * 100) : 0),
      onSuccess: () => resolve()
    }).start();
  });
}

const statusLabel = (status: Dataset["status"]) => ({
  created: "待上传",
  uploading: "上传中",
  queued: "排队",
  tiling: "切片中",
  collision_processing: "碰撞处理中",
  rebuilding: "高清重建中",
  ready: "已就绪",
  failed: "失败"
})[status];

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function suggestedVoxelSize(dataset: Dataset) {
  const value = /建议人工确认后改为不小于 ([\d.]+) m/.exec(dataset.error ?? "")?.[1];
  if (value) return Number(value);
  return Math.min(2, Math.ceil(dataset.voxelSize * 1.5 * 1000) / 1000);
}
