import './styles.css';
import { createRoot } from 'react-dom/client';
import { FIXED_CIRCLE_RADIUS_PIXELS, type GaussianCircleSelection } from './gaussian-circle-selector';
import { startMonitor } from './monitor';
import {
  AppShell,
  type AppShellProps,
  type CardSettings,
  type Dataset,
  type InspectionLabel,
  type LabelMetadata,
  type LabelType,
  type WorkspaceTab
} from './ui/AppShell';
import { GsViewer } from './viewer';

interface LabelSnapshot {
  sourceSha256: string | null;
  visualRevision: string | null;
  selectionDefaults?: { selectionRadiusPixels: number };
  labelTypes?: LabelType[];
  total?: number;
  limit?: number;
  offset?: number;
  labels: InspectionLabel[];
}

interface DatasetListResponse {
  datasets: Dataset[];
  activeTask: AppShellProps['activeTask'];
  sogWorkerCount: number;
}

const required = <T extends Element>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`页面缺少必要节点：${selector}`);
  return element;
};

const canvas = required<HTMLCanvasElement>('#application-canvas');
const selectionCircle = required<HTMLDivElement>('#selection-circle');
const root = createRoot(required<HTMLDivElement>('#ui-root'));
const viewer = new GsViewer(canvas);
const cardSettings = new Map<string, CardSettings>();
const labelsByDataset = new Map<string, LabelSnapshot>();

let datasets: Dataset[] = [];
let selectedDatasetId = '';
let loadedRevision = '';
let selectedLabelId = '';
let activeTab: WorkspaceTab = 'scenes';
let labelFilterType: LabelType | undefined;
let labelFilterQuery = '';
let labelPanelLabels: InspectionLabel[] = [];
let labelPanelTotal = 0;
let pendingLabelSelection: GaussianCircleSelection | undefined;
let displayedLabelSignature = '';
let activeTask: AppShellProps['activeTask'] = null;
let workerCount = 0;
let pickingDatasetId = '';
let pickInFlight = false;
let markerPickInFlight = false;
let pointerStart: { x: number; y: number } | undefined;
let statusState: AppShellProps['status'] = { message: '正在初始化 PlayCanvas…', state: 'loading' };
let uploadState: AppShellProps['upload'] = { progress: 0, stage: '选择 PLY 后开始', busy: false };
let pollTimer: number | undefined;
let stopMonitor: (() => void) | undefined;
let disposed = false;

const clampInteger = (value: number, minimum: number, maximum: number, fallback: number) =>
  Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;

const formatBytes = (value?: number) => {
  if (!value) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
};

const requestJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    cache: 'no-store'
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败：HTTP ${response.status}`);
  return body;
};

const currentLabels = (dataset: Dataset) => labelsByDataset.get(dataset.id)?.labels ?? [];

const visibleLabels = (dataset: Dataset) => {
  const snapshot = labelsByDataset.get(dataset.id);
  if (!snapshot) return [];
  return snapshot.labels.filter(
    (label) => label.resolved && label.selectionMethod === 'loaded-lod-gpu-circle-pca-v1' &&
      label.visualRevision === snapshot.visualRevision
  );
};

const runAction = (operation: () => void | Promise<void>) => {
  void Promise.resolve(operation()).catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  });
};

const renderUi = () => {
  const selectedDataset = datasets.find((item) => item.id === selectedDatasetId);
  const selectedLabel = selectedDataset
    ? currentLabels(selectedDataset).find((label) => label.id === selectedLabelId)
    : undefined;
  root.render(<AppShell
    activeTab={activeTab}
    datasets={datasets}
    selectedDatasetId={selectedDatasetId}
    activeTask={activeTask}
    workerCount={workerCount}
    cardSettings={Object.fromEntries(cardSettings)}
    loadedRevision={loadedRevision}
    gaussianVisible={viewer.gaussianVisible}
    voxelDebugUrl={viewer.voxelDebugUrl}
    upload={uploadState}
    status={statusState}
    labels={labelPanelLabels}
    labelTotal={labelPanelTotal}
    selectedLabel={selectedLabel}
    labelFilterType={labelFilterType}
    labelFilterQuery={labelFilterQuery}
    picking={Boolean(pickingDatasetId)}
    pendingSelection={pendingLabelSelection}
    onTab={(tab) => { activeTab = tab; renderUi(); }}
    onReload={() => runAction(() => refreshDatasets())}
    onUpload={(file, lodLevels) => runAction(() => createDataset(file, lodLevels))}
    onCardSettings={(datasetId, patch) => {
      const dataset = datasets.find((item) => item.id === datasetId);
      if (!dataset) return;
      cardSettings.set(datasetId, {
        ...(cardSettings.get(datasetId) ?? defaultCardSettings(dataset)),
        ...patch
      });
      renderUi();
    }}
    onDatasetAction={(action, datasetId) => runAction(() => handleDatasetAction(action, datasetId))}
    onStartPick={() => runAction(startLabelPick)}
    onCancelPick={() => { cancelLabelPick(); setStatus('已取消添加巡检点。', 'ready'); }}
    onCancelPending={() => {
      pendingLabelSelection = undefined;
      renderUi();
      setStatus('已取消未保存的标签选择。', 'ready');
    }}
    onClearLabelSelection={() => {
      selectedLabelId = '';
      viewer.setSelectedInspectionPoint(null);
      renderUi();
    }}
    onCreateLabel={(metadata) => runAction(() => createInspectionLabel(metadata))}
    onUpdateLabel={(labelId, metadata) => runAction(() => updateInspectionLabel(labelId, metadata))}
    onDeleteLabel={(labelId) => runAction(() => deleteInspectionLabel(labelId))}
    onSelectLabel={(labelId) => runAction(() => selectInspectionLabel(labelId))}
    onLabelFilter={(type, query) => runAction(async () => {
      labelFilterType = type;
      labelFilterQuery = query.trim();
      await refreshLabelPanel();
    })}
  />);
};

const setStatus = (message: string, state: AppShellProps['status']['state'] = 'loading') => {
  statusState = { message, state };
  renderUi();
};

const defaultCardSettings = (dataset: Dataset): CardSettings => ({
  lodLevels: dataset.lodLevels || 5,
  voxelSize: dataset.collision.voxelSize || 0.2,
  voxelOpacity: dataset.collision.voxelOpacity ?? 0.1
});

const setSelectionCircleVisible = (visible: boolean) => {
  selectionCircle.hidden = !visible;
};

const updateSelectionCircle = (event: PointerEvent) => {
  if (!pickingDatasetId) return;
  selectionCircle.style.left = `${event.clientX}px`;
  selectionCircle.style.top = `${event.clientY}px`;
  selectionCircle.style.width = `${FIXED_CIRCLE_RADIUS_PIXELS * 2}px`;
  selectionCircle.style.height = `${FIXED_CIRCLE_RADIUS_PIXELS * 2}px`;
};

const fetchInspectionLabels = async (dataset: Dataset, force = false) => {
  if (dataset.builtin || !dataset.visual) {
    const empty: LabelSnapshot = { sourceSha256: null, visualRevision: null, labels: [] };
    labelsByDataset.set(dataset.id, empty);
    return empty;
  }
  const cached = labelsByDataset.get(dataset.id);
  const revisionMatches = (cached?.visualRevision ?? '') === (dataset.activeVisualRevision ?? '');
  const countMatches = cached?.labels.length === (dataset.labelCount ?? 0);
  if (!force && cached && revisionMatches && countMatches) return cached;
  const snapshot = await requestJson<LabelSnapshot>(`/api/datasets/${dataset.id}/labels`);
  labelsByDataset.set(dataset.id, snapshot);
  if (selectedDatasetId === dataset.id && selectedLabelId &&
      !snapshot.labels.some((label) => label.id === selectedLabelId)) {
    selectedLabelId = '';
  }
  return snapshot;
};

const refreshLabelPanel = async () => {
  const dataset = datasets.find((item) => item.id === selectedDatasetId);
  if (!dataset || dataset.builtin || !dataset.visual || !loadedRevision.startsWith(`${dataset.id}:`)) {
    labelPanelLabels = [];
    labelPanelTotal = 0;
    renderUi();
    return;
  }
  const params = new URLSearchParams({ limit: '200' });
  if (labelFilterType) params.set('type', labelFilterType);
  if (labelFilterQuery) params.set('q', labelFilterQuery);
  const snapshot = await requestJson<LabelSnapshot>(`/api/datasets/${dataset.id}/labels?${params}`);
  labelPanelLabels = snapshot.labels;
  labelPanelTotal = snapshot.total ?? snapshot.labels.length;
  renderUi();
};

const syncViewerInspectionPoints = (dataset: Dataset) => {
  if (!loadedRevision.startsWith(`${dataset.id}:`)) return;
  const labels = visibleLabels(dataset);
  const signature = `${loadedRevision}:${labelsByDataset.get(dataset.id)?.visualRevision ?? ''}:` +
    labels.map((label) => {
      const position = `${label.position.x},${label.position.y},${label.position.z}`;
      const normal = label.normal ? `${label.normal.x},${label.normal.y},${label.normal.z}` : 'none';
      return `${label.id}:${position}:${normal}`;
    }).join('|');
  if (signature !== displayedLabelSignature) {
    viewer.setInspectionPoints(labels);
    displayedLabelSignature = signature;
  }
  viewer.setSelectedInspectionPoint(selectedLabelId);
};

const loadDataset = async (dataset: Dataset) => {
  if (!dataset.visual) throw new Error(`${dataset.name} 尚未完成切片。`);
  const revisionKey = `${dataset.id}:${dataset.visual.revision}`;
  const contextChanged = selectedDatasetId !== dataset.id || loadedRevision !== revisionKey;
  if (loadedRevision !== revisionKey) {
    setStatus(`正在加载 ${dataset.name}…`);
    await viewer.load(dataset.visual.renderUrl, dataset.name);
    loadedRevision = revisionKey;
    displayedLabelSignature = '';
  }
  selectedDatasetId = dataset.id;
  if (contextChanged) {
    selectedLabelId = '';
    labelFilterType = undefined;
    labelFilterQuery = '';
  }
  await fetchInspectionLabels(dataset);
  syncViewerInspectionPoints(dataset);
  const count = dataset.visual.counts[0] ?? 0;
  setStatus(`${dataset.name} · LOD0 ${count.toLocaleString('zh-CN')} Gaussian · ${dataset.lodLevels} 层`, 'ready');
};

const refreshDatasets = async (autoLoad = false) => {
  const response = await requestJson<DatasetListResponse>('/api/datasets');
  datasets = response.datasets;
  activeTask = response.activeTask;
  workerCount = response.sogWorkerCount;
  const ids = new Set(datasets.map((dataset) => dataset.id));
  for (const id of labelsByDataset.keys()) if (!ids.has(id)) labelsByDataset.delete(id);
  for (const dataset of datasets) {
    if (!cardSettings.has(dataset.id)) cardSettings.set(dataset.id, defaultCardSettings(dataset));
  }
  if (!datasets.some((dataset) => dataset.id === selectedDatasetId)) {
    selectedLabelId = '';
    selectedDatasetId = datasets.find((dataset) => !dataset.builtin && dataset.visual)?.id ??
      datasets.find((dataset) => dataset.visual)?.id ?? '';
  }
  await Promise.all(datasets.map(async (dataset) => {
    try {
      await fetchInspectionLabels(dataset);
    } catch (error) {
      console.warn(`读取“${dataset.name}”巡检点列表失败：`, error);
    }
  }));
  const selected = datasets.find((dataset) => dataset.id === selectedDatasetId);
  if (selected) syncViewerInspectionPoints(selected);
  if (selected) await refreshLabelPanel();
  else renderUi();
  if (autoLoad && selected?.visual) await loadDataset(selected);
};

const uploadFile = (dataset: Dataset, file: File) => new Promise<void>((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('PUT', `/api/datasets/${dataset.id}/source`);
  request.setRequestHeader('Content-Type', 'application/octet-stream');
  request.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const value = (event.loaded / event.total) * 100;
    uploadState = { progress: value, stage: `正在上传 PLY：${Math.round(value)}%`, busy: true };
    renderUi();
  };
  request.onload = () => {
    if (request.status >= 200 && request.status < 300) return resolve();
    try {
      reject(new Error((JSON.parse(request.responseText) as { error?: string }).error || `上传失败：HTTP ${request.status}`));
    } catch {
      reject(new Error(`上传失败：HTTP ${request.status}`));
    }
  };
  request.onerror = () => reject(new Error('PLY 上传网络中断。'));
  request.onabort = () => reject(new Error('PLY 上传已取消。'));
  request.send(file);
});

const createDataset = async (file: File, lodLevels: number) => {
  uploadState = { progress: 0, stage: '正在创建场景卡片…', busy: true };
  renderUi();
  try {
    const dataset = await requestJson<Dataset>('/api/datasets', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, size: file.size, lodLevels: clampInteger(lodLevels, 1, 20, 5) })
    });
    await refreshDatasets();
    await uploadFile(dataset, file);
    uploadState = { progress: 100, stage: 'PLY 已上传，请在场景卡片中点击“开始切片”。', busy: false };
    await refreshDatasets();
  } catch (error) {
    uploadState = { progress: 0, stage: error instanceof Error ? error.message : String(error), busy: false };
    renderUi();
    throw error;
  }
};

const handleDatasetAction = async (action: Parameters<AppShellProps['onDatasetAction']>[0], datasetId: string) => {
  const dataset = datasets.find((item) => item.id === datasetId);
  if (!dataset) return;
  const settings = cardSettings.get(dataset.id) ?? defaultCardSettings(dataset);
  if (action === 'view') {
    cancelLabelPick();
    await loadDataset(dataset);
  } else if (action === 'build') {
    await requestJson(`/api/datasets/${dataset.id}/build`, {
      method: 'POST',
      body: JSON.stringify({ lodLevels: clampInteger(settings.lodLevels, 1, 20, dataset.lodLevels) })
    });
    setStatus(`${dataset.name} 已进入切片任务。`);
  } else if (action === 'collision') {
    if (dataset.collision.status === 'ready' &&
        !window.confirm(`重新计算“${dataset.name}”的体素？当前版本会保留到新版校验通过。`)) return;
    if (selectedDatasetId === dataset.id) viewer.clearVoxelDebug();
    await requestJson(`/api/datasets/${dataset.id}/collision/build`, {
      method: 'POST',
      body: JSON.stringify({ voxelSize: settings.voxelSize, voxelOpacity: settings.voxelOpacity })
    });
    setStatus(`${dataset.name} 已进入 GPU 并行体素任务。`);
  } else if (action === 'display-gs') {
    const sceneWasLoaded = loadedRevision.startsWith(`${dataset.id}:`);
    const visible = sceneWasLoaded ? !viewer.gaussianVisible : true;
    await loadDataset(dataset);
    viewer.setGaussianVisible(visible);
    setStatus(visible ? `${dataset.name} Gaussian 已显示。` : `${dataset.name} Gaussian 已隐藏；体素和巡检点状态不变。`, 'ready');
  } else if (action === 'display-voxel') {
    const debugMeshUrl = dataset.collision.debugMeshUrl;
    if (!debugMeshUrl) {
      if (dataset.collision.status !== 'ready') throw new Error('请先完成体素计算。');
      if (!window.confirm(
        `“${dataset.name}”的旧体素版本没有调试网格。是否使用当前 ${settings.voxelSize} m / ` +
        `透明度 ${settings.voxelOpacity} 参数重新生成？系统不会自动改参，旧版本会保留到新版本校验通过。`
      )) return;
      await requestJson(`/api/datasets/${dataset.id}/collision/build`, {
        method: 'POST',
        body: JSON.stringify({ voxelSize: settings.voxelSize, voxelOpacity: settings.voxelOpacity })
      });
      setStatus(`${dataset.name} 已按当前参数进入体素调试网格生成任务。`);
      await refreshDatasets();
      return;
    }
    const alreadyVisible = viewer.voxelDebugUrl === debugMeshUrl;
    if (!alreadyVisible && (dataset.collision.debugMeshBytes ?? 0) >= 256 * 1024 ** 2 &&
        !window.confirm(`“${dataset.name}”的体素调试网格为 ${formatBytes(dataset.collision.debugMeshBytes)}，加载期间会明显占用内存和显存。继续显示吗？`)) return;
    await loadDataset(dataset);
    setStatus(`正在按需加载 ${dataset.name} 的体素调试网格（${formatBytes(dataset.collision.debugMeshBytes)}）…`);
    const visible = await viewer.toggleVoxelDebug(debugMeshUrl, dataset.name);
    setStatus(visible ? `${dataset.name} 体素调试网格已显示；青色网格仅用于检查，不参与碰撞判断。` : `${dataset.name} 体素调试网格已隐藏并释放。`, 'ready');
  } else if (action === 'delete') {
    await requestJson(`/api/datasets/${dataset.id}`, { method: 'DELETE' });
    cardSettings.delete(dataset.id);
    labelsByDataset.delete(dataset.id);
    if (selectedDatasetId === dataset.id) {
      cancelLabelPick();
      selectedDatasetId = '';
      loadedRevision = '';
      selectedLabelId = '';
      displayedLabelSignature = '';
      labelPanelLabels = [];
      labelPanelTotal = 0;
      viewer.clear();
    }
    setStatus(`${dataset.name} 已永久删除。`, 'ready');
  }
  await refreshDatasets(action === 'delete');
};

const selectInspectionLabel = async (labelId: string) => {
  const dataset = datasets.find((item) => item.id === selectedDatasetId);
  const label = dataset && currentLabels(dataset).find((item) => item.id === labelId);
  if (!dataset || !label) return;
  await loadDataset(dataset);
  selectedLabelId = label.id;
  viewer.setSelectedInspectionPoint(label.id);
  labelFilterType = undefined;
  labelFilterQuery = '';
  await refreshLabelPanel();
  activeTab = 'labels';
  setStatus(`${label.title} · (${label.position.x.toFixed(2)}, ${label.position.y.toFixed(2)}, ${label.position.z.toFixed(2)})`, 'ready');
};

const deleteInspectionLabel = async (labelId: string) => {
  const dataset = datasets.find((item) => item.id === selectedDatasetId);
  const label = dataset && currentLabels(dataset).find((item) => item.id === labelId);
  if (!dataset || !label) return;
  await requestJson(`/api/datasets/${dataset.id}/labels/${label.id}`, { method: 'DELETE' });
  await fetchInspectionLabels(dataset, true);
  if (selectedLabelId === label.id) {
    selectedLabelId = '';
    viewer.setSelectedInspectionPoint(null);
  }
  displayedLabelSignature = '';
  syncViewerInspectionPoints(dataset);
  await refreshDatasets();
  await refreshLabelPanel();
  setStatus(`${label.title} 已删除。`, 'ready');
};

const cancelLabelPick = () => {
  pickingDatasetId = '';
  pointerStart = undefined;
  canvas.classList.remove('is-picking');
  setSelectionCircleVisible(false);
  renderUi();
};

const startLabelPick = async () => {
  const dataset = datasets.find((item) => item.id === selectedDatasetId);
  if (!dataset || dataset.builtin || !dataset.visual || !dataset.source) throw new Error('请先在标签页选择已切片的自定义场景。');
  await loadDataset(dataset);
  viewer.setGaussianVisible(true);
  pendingLabelSelection = undefined;
  pickingDatasetId = dataset.id;
  canvas.classList.add('is-picking');
  setSelectionCircleVisible(true);
  renderUi();
  setStatus(`单击 GS 表面：使用当前驻留 LOD 的 ${FIXED_CIRCLE_RADIUS_PIXELS}px GPU 圆选中心计算法向。`);
};

const createInspectionLabel = async (metadata: LabelMetadata) => {
  const dataset = datasets.find((item) => item.id === selectedDatasetId);
  const selection = pendingLabelSelection;
  if (!dataset || !selection) return;
  const label = await requestJson<InspectionLabel>(`/api/datasets/${dataset.id}/labels/select`, {
    method: 'POST',
    body: JSON.stringify({ ...selection, ...metadata, visualRevision: dataset.activeVisualRevision })
  });
  pendingLabelSelection = undefined;
  await fetchInspectionLabels(dataset, true);
  selectedLabelId = label.id;
  displayedLabelSignature = '';
  syncViewerInspectionPoints(dataset);
  viewer.setSelectedInspectionPoint(label.id);
  await refreshDatasets();
  await refreshLabelPanel();
  setStatus(`${label.title} 已建立 · ${label.type} · ${label.neighborCount ?? 0} 个 GS`, 'ready');
};

const updateInspectionLabel = async (labelId: string, metadata: LabelMetadata) => {
  const dataset = datasets.find((item) => item.id === selectedDatasetId);
  if (!dataset) return;
  const updated = await requestJson<InspectionLabel>(`/api/labels/${labelId}`, {
    method: 'PATCH',
    body: JSON.stringify(metadata)
  });
  await fetchInspectionLabels(dataset, true);
  selectedLabelId = updated.id;
  displayedLabelSignature = '';
  syncViewerInspectionPoints(dataset);
  await refreshLabelPanel();
  setStatus(`${updated.title} 的标签信息已更新。`, 'ready');
};

const onPointerDown = (event: PointerEvent) => {
  if (event.button !== 0 || pickInFlight || markerPickInFlight) return;
  pointerStart = { x: event.clientX, y: event.clientY };
};

const onPointerUp = async (event: PointerEvent) => {
  const start = pointerStart;
  pointerStart = undefined;
  if (!start || event.button !== 0 || pickInFlight || markerPickInFlight) return;
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
  if (!pickingDatasetId) {
    const dataset = datasets.find((item) => item.id === selectedDatasetId);
    if (!dataset || !loadedRevision.startsWith(`${dataset.id}:`)) return;
    markerPickInFlight = true;
    try {
      const labelId = await viewer.pickInspectionPoint(event.clientX, event.clientY);
      if (labelId) await selectInspectionLabel(labelId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      markerPickInFlight = false;
    }
    return;
  }
  const dataset = datasets.find((item) => item.id === pickingDatasetId);
  if (!dataset) return;
  pickInFlight = true;
  renderUi();
  setStatus(`正在用固定 ${FIXED_CIRCLE_RADIUS_PIXELS}px GPU 圆形区域选择当前 LOD…`);
  try {
    const selection = await viewer.pickGaussianCircle(event.clientX, event.clientY);
    if (!selection) throw new Error('点击位置没有可选的 Gaussian，请贴近目标后重新选择。');
    pendingLabelSelection = selection;
    cancelLabelPick();
    setStatus(`已选择 ${selection.neighborCount.toLocaleString('zh-CN')} 个当前 LOD Gaussian 中心，请在标签页完成初始化。`, 'ready');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    pickInFlight = false;
    renderUi();
  }
};

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || pickInFlight) return;
  if (pickingDatasetId) {
    cancelLabelPick();
    setStatus('已取消添加巡检点。', 'ready');
    return;
  }
  if (selectedLabelId) {
    selectedLabelId = '';
    viewer.setSelectedInspectionPoint(null);
    renderUi();
  }
};

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', updateSelectionCircle);
canvas.addEventListener('pointerup', onPointerUp);
window.addEventListener('keydown', onKeyDown);

const dispose = () => {
  if (disposed) return;
  disposed = true;
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  stopMonitor?.();
  canvas.removeEventListener('pointerdown', onPointerDown);
  canvas.removeEventListener('pointermove', updateSelectionCircle);
  canvas.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('keydown', onKeyDown);
  root.unmount();
  viewer.dispose();
};

window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);

const start = async () => {
  renderUi();
  setStatus('正在创建 PlayCanvas 图形设备…');
  await viewer.initialize();
  stopMonitor = startMonitor(viewer);
  setStatus(`PlayCanvas ${viewer.backend} 已就绪，正在读取场景卡片…`);
  await refreshDatasets(true);
  pollTimer = window.setInterval(() => {
    void refreshDatasets().catch((error) => console.warn('场景卡片状态刷新失败：', error));
  }, 1_500);
};

start().catch((error: unknown) => {
  console.error(error);
  setStatus(error instanceof Error ? error.message : String(error), 'error');
});
