import { useEffect, useRef, useState } from 'react';
import type { CardSettings, CollisionState, Dataset, DatasetAction, WorkspacePanelProps } from './contracts';
import { createRatios, formatBytes } from './format';
import { Button, EmptyState, Icon, SectionHeading, StatusMark, UiContainer, WorkspaceHeader } from './primitives';

const visualStatus = (dataset: Dataset) => dataset.status === 'building'
  ? { state: 'busy' as const, label: `切片 ${Math.round(dataset.progress)}%` }
  : dataset.visual
    ? { state: 'ready' as const, label: '已切片' }
    : dataset.status === 'failed'
      ? { state: 'error' as const, label: '切片失败' }
      : { state: 'idle' as const, label: '未切片' };

const collisionStatus = (collision: CollisionState) => collision.status === 'building'
  ? { state: 'busy' as const, label: `体素 ${Math.round(collision.progress)}%` }
  : collision.status === 'ready'
    ? { state: 'ready' as const, label: '体素就绪' }
    : collision.status === 'failed'
      ? { state: 'error' as const, label: '体素失败' }
      : { state: 'idle' as const, label: collision.status === 'unavailable' ? '无体素' : '未计算' };

const SceneCard = ({ dataset, selected, loaded, busy, settings, gaussianVisible, voxelDebugUrl,
  onSettings, onAction }: {
  dataset: Dataset;
  selected: boolean;
  loaded: boolean;
  busy: boolean;
  settings: CardSettings;
  gaussianVisible: boolean;
  voxelDebugUrl?: string;
  onSettings(patch: Partial<CardSettings>): void;
  onAction(action: DatasetAction): void;
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const visual = visualStatus(dataset);
  const collision = collisionStatus(dataset.collision);
  const taskRunning = dataset.status === 'building' || dataset.collision.status === 'building' || dataset.collision.debugMeshStatus === 'building';
  const voxelVisible = loaded && Boolean(dataset.collision.debugMeshUrl) && voxelDebugUrl === dataset.collision.debugMeshUrl;
  return <UiContainer as="article" variant="card" className={`scene-card${selected ? ' is-selected' : ''}`}>
    <div className="scene-card__head">
      <div className="scene-card__title"><strong title={dataset.name}>{dataset.name}</strong></div>
      <Button size="compact" icon="eye" onClick={() => onAction('view')} disabled={!dataset.visual || busy} aria-label={`查看 ${dataset.name}`}>查看</Button>
    </div>
    <div className="status-row"><StatusMark state={visual.state}>{visual.label}</StatusMark><StatusMark state={collision.state}>{collision.label}</StatusMark></div>
    <div className="scene-card__meta">
      {dataset.visual
        ? <><span>{dataset.labelCount ?? 0} 标签</span><span>{dataset.missionCount ?? 0} 航线</span></>
        : <span>等待首次切片</span>}
    </div>
    <p className={`scene-card__stage${dataset.error || dataset.collision.error ? ' is-error' : ''}`}>
      {dataset.collision.debugMeshStatus === 'building' ? '正在单独生成调试网格，碰撞版本不变' : dataset.collision.debugMeshError || dataset.collision.error || dataset.error || (dataset.collision.status === 'building' ? dataset.collision.stage : dataset.stage)}
    </p>
    {taskRunning && <progress value={dataset.collision.status === 'building' ? dataset.collision.progress : dataset.progress} max="100"/>}
    {!dataset.builtin && <>
      <div className="settings-grid">
        <label><span>构建资源模式</span><select disabled={busy} value={settings.resourceProfile} onChange={(event) => onSettings({ resourceProfile: event.target.value as CardSettings['resourceProfile'] })}><option value="low-memory">低资源（默认）</option><option value="standard">标准</option></select></label>
        {!dataset.visual && <label><span>切片层数</span><input type="number" min="1" max="20" disabled={busy} value={settings.lodLevels} onChange={(event) => onSettings({ lodLevels: Number(event.target.value) })}/></label>}
        <label><span>体素边长（米）</span><input type="number" min="0.02" max="5" step="0.01" disabled={busy} value={settings.voxelSize} onChange={(event) => onSettings({ voxelSize: Number(event.target.value) })}/></label>
        <label><span>透明度阈值</span><input type="number" min="0" max="1" step="0.01" disabled={busy} value={settings.voxelOpacity} onChange={(event) => onSettings({ voxelOpacity: Number(event.target.value) })}/></label>
      </div>
      <div className="scene-actions">
        {!dataset.visual && <Button tone="primary" onClick={() => onAction('build')} disabled={!dataset.source || busy}>{dataset.pendingVisualRevision ? '继续切片' : '开始切片'}</Button>}
        <Button icon="cube" onClick={() => onAction('collision')} disabled={!dataset.visual || busy}>{dataset.pendingCollisionRevision ? '继续体素任务' : dataset.collision.status === 'ready' ? '重算体素' : '计算体素'}</Button>
        <Button icon={loaded && gaussianVisible ? 'check' : 'eye'} tone={loaded && gaussianVisible ? 'active' : 'default'} aria-pressed={loaded && gaussianVisible} onClick={() => onAction('display-gs')} disabled={!dataset.visual || busy}>{loaded && gaussianVisible ? '高斯已显示' : '显示高斯'}</Button>
        <Button icon={voxelVisible ? 'check' : 'cube'} tone={voxelVisible ? 'active' : 'default'} aria-pressed={voxelVisible} onClick={() => onAction('display-voxel')} disabled={!dataset.visual || (!dataset.collision.debugMeshUrl && dataset.collision.status !== 'ready') || (busy && !voxelVisible)}>{voxelVisible ? '体素已显示' : '显示体素'}</Button>
      </div>
      {taskRunning && <Button onClick={() => onAction('cancel')}>取消任务（保留进度）</Button>}
      {dataset.collision.revision && <div className="settings-grid">
        <label><span>调试分区（共 {dataset.collision.partitionCount ?? 1} 个）</span><input type="number" min="1" max={dataset.collision.partitionCount ?? 1} step="1" disabled={busy} value={settings.debugPartitionIndex + 1} onChange={(event) => onSettings({ debugPartitionIndex: Number(event.target.value) - 1 })}/></label>
        <Button onClick={() => onAction('debug')} disabled={busy || dataset.collision.partitionCount === 0}>生成该区调试网格</Button>
      </div>}
      {(dataset.visualLogUrl || dataset.collisionLogUrl) && <div className="scene-card__meta">
        {dataset.visualLogUrl && <a href={dataset.visualLogUrl} target="_blank" rel="noreferrer">切片完整日志</a>}
        {dataset.collisionLogUrl && <a href={dataset.collisionLogUrl} target="_blank" rel="noreferrer">体素完整日志</a>}
        {dataset.collision.debugMeshStatus && dataset.collision.debugMeshStatus !== 'not-built' && <a href={`/api/datasets/${dataset.id}/logs/debug.log`} target="_blank" rel="noreferrer">网格日志</a>}
      </div>}
      <div className="danger-zone">
        {confirmDelete ? <div className="inline-confirm"><span>永久删除该场景？</span><Button size="compact" onClick={() => setConfirmDelete(false)}>取消</Button><Button size="compact" tone="danger" onClick={() => onAction('delete')}>确认删除</Button></div>
          : <Button icon="trash" tone="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>删除场景</Button>}
      </div>
    </>}
  </UiContainer>;
};

export const ScenePanel = (props: WorkspacePanelProps) => {
  const [file, setFile] = useState<File>();
  const [lodLevels, setLodLevels] = useState(5);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.upload.busy || props.upload.progress !== 100) return;
    setFile(undefined);
    if (fileInput.current) fileInput.current.value = '';
  }, [props.upload.busy, props.upload.progress]);
  return <UiContainer variant="panel" className="workspace-panel" aria-label="场景管理">
    <WorkspaceHeader activeTab={props.activeTab} collapsed={props.workspaceCollapsed} onTab={props.onTab} onCollapse={props.onWorkspaceCollapse} aside={<Button size="compact" icon="refresh" tone="ghost" onClick={props.onReload} aria-label="刷新场景">刷新</Button>}/>
    <div id="workspace-content" className="workspace-scroll">
      <UiContainer variant="subtle" className="import-block">
        <SectionHeading aside="第零层保留完整数据">导入高斯点云</SectionHeading>
        <label className="file-control">
          <input ref={fileInput} type="file" accept=".ply,application/octet-stream" onChange={(event) => setFile(event.target.files?.[0])}/>
          <Icon name="upload"/><span>{file ? file.name : '选择高斯点云文件'}</span><small>{file ? formatBytes(file.size) : '本地文件'}</small>
        </label>
        <div className="import-options"><label><span>切片分级</span><input type="number" min="1" max="20" value={lodLevels} onChange={(event) => setLodLevels(Math.max(1, Math.min(20, Number(event.target.value) || 5)))}/></label><code>{createRatios(lodLevels).map((value) => `${value}%`).join(' / ')}</code></div>
        <Button tone="primary" icon="upload" disabled={!file || props.upload.busy} onClick={() => file && props.onUpload(file, lodLevels)}>{props.upload.busy ? '正在上传…' : '上传并创建数据'}</Button>
        {(props.upload.busy || props.upload.progress > 0) && <div className="task-progress"><progress max="100" value={props.upload.progress}/><span>{props.upload.stage}</span></div>}
      </UiContainer>
      <SectionHeading className="scene-list-heading" aside="默认低资源 · 重任务串行">场景</SectionHeading>
      <div className="scene-list">
        {props.datasets.length === 0 && <EmptyState icon="database" title="尚无场景" description="从上方导入高斯点云开始"/>}
        {props.datasets.map((dataset) => <SceneCard key={dataset.id} dataset={dataset}
          selected={dataset.id === props.selectedDatasetId} loaded={props.loadedRevision.startsWith(`${dataset.id}:`)}
          busy={Boolean(props.activeTask)} settings={props.cardSettings[dataset.id] ?? { lodLevels: dataset.lodLevels || 5, voxelSize: dataset.collision.voxelSize || 0.2, voxelOpacity: dataset.collision.voxelOpacity ?? 0.1, resourceProfile: dataset.resourceProfile ?? 'low-memory', debugPartitionIndex: 0 }}
          gaussianVisible={props.gaussianVisible} voxelDebugUrl={props.voxelDebugUrl}
          onSettings={(patch) => props.onCardSettings(dataset.id, patch)} onAction={(action) => props.onDatasetAction(action, dataset.id)}/>) }
      </div>
    </div>
    <footer className="workspace-footer">本地米制竖直轴向上坐标 · 不计算经纬度</footer>
  </UiContainer>;
};
