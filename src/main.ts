import './styles.css';
import { FIXED_CIRCLE_RADIUS_PIXELS } from './gaussian-circle-selector';
import { startMonitor } from './monitor';
import { GsViewer } from './viewer';

type DatasetStatus = 'awaiting-upload' | 'uploaded' | 'building' | 'ready' | 'failed';
type CollisionStatus = 'not-built' | 'building' | 'ready' | 'failed' | 'unavailable';

interface CollisionState {
  status: CollisionStatus;
  progress: number;
  stage: string;
  error?: string | null;
  revision?: string | null;
  voxelSize: number;
  voxelOpacity: number;
  bytes?: number;
  nodeCount?: number;
  debugMeshUrl?: string;
  debugMeshBytes?: number;
  debugMeshMode?: 'faces';
}

interface Dataset {
  id: string;
  name: string;
  status: DatasetStatus;
  progress: number;
  stage: string;
  error?: string | null;
  lodLevels: number;
  ratios: number[];
  source?: { bytes: number; sha256: string };
  visual?: {
    revision: string;
    renderUrl: string;
    counts: number[];
    gaussianEntries: number;
    chunkCount: number;
    bytes?: number;
    workerCount?: number;
  } | null;
  activeVisualRevision?: string | null;
  activeCollisionRevision?: string | null;
  collision: CollisionState;
  labelCount?: number;
  builtin?: boolean;
}

interface InspectionLabel {
  id: string;
  datasetId: string;
  title: string;
  position: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number } | null;
  collisionRevision?: string;
  sourceSha256?: string;
  visualRevision?: string;
  selectionMethod?: string;
  selectionRadiusPixels?: number;
  neighborCount?: number;
  normalPlanarity?: number;
  residentLodLevels?: number[];
  residentFileCount?: number;
  resolved: boolean;
  createdAt: string;
}

interface LabelSnapshot {
  sourceSha256: string | null;
  visualRevision: string | null;
  selectionDefaults?: { selectionRadiusPixels: number };
  labels: InspectionLabel[];
}

interface DatasetListResponse {
  datasets: Dataset[];
  activeTask: { type: 'visual' | 'collision'; datasetId: string } | null;
  sogWorkerCount: number;
}

interface CardSettings {
  lodLevels: number;
  voxelSize: number;
  voxelOpacity: number;
}

const required = <T extends Element>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`页面缺少必要节点：${selector}`);
  return element;
};

const canvas = required<HTMLCanvasElement>('#application-canvas');
const selectionCircle = required<HTMLDivElement>('#selection-circle');
const status = required<HTMLDivElement>('#status');
const statusText = required<HTMLSpanElement>('#status-text');
const fileInput = required<HTMLInputElement>('#ply-file');
const fileName = required<HTMLElement>('#file-name');
const levelInput = required<HTMLInputElement>('#lod-levels');
const ratioPreview = required<HTMLElement>('#ratio-preview');
const uploadButton = required<HTMLButtonElement>('#upload-button');
const progress = required<HTMLProgressElement>('#build-progress');
const buildStage = required<HTMLElement>('#build-stage');
const reloadButton = required<HTMLButtonElement>('#reload-datasets');
const cardsContainer = required<HTMLDivElement>('#dataset-cards');
const taskMode = required<HTMLElement>('#task-mode');
const inspectionPopup = required<HTMLElement>('#inspection-popup');
const inspectionPopupClose = required<HTMLButtonElement>('#inspection-popup-close');
const inspectionPopupTitle = required<HTMLElement>('#inspection-popup-title');
const inspectionPopupDataset = required<HTMLElement>('[data-popup="dataset"]');
const inspectionPopupPosition = required<HTMLElement>('[data-popup="position"]');
const inspectionPopupNormal = required<HTMLElement>('[data-popup="normal"]');
const inspectionPopupRadius = required<HTMLElement>('[data-popup="radius"]');
const inspectionPopupNeighbors = required<HTMLElement>('[data-popup="neighbors"]');
const inspectionPopupMethod = required<HTMLElement>('[data-popup="method"]');
const inspectionPopupCreated = required<HTMLElement>('[data-popup="created"]');

const viewer = new GsViewer(canvas);
const cardSettings = new Map<string, CardSettings>();
const labelsByDataset = new Map<string, LabelSnapshot>();
let datasets: Dataset[] = [];
let selectedDatasetId = '';
let loadedRevision = '';
let selectedLabelId = '';
let displayedLabelSignature = '';
let activeTask: DatasetListResponse['activeTask'] = null;
let pickingDatasetId = '';
let pickInFlight = false;
let markerPickInFlight = false;
let pointerStart: { x: number; y: number } | undefined;

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
let pollTimer: number | undefined;
let disposed = false;
let stopMonitor: (() => void) | undefined;

const setStatus = (message: string, state: 'loading' | 'ready' | 'error' = 'loading') => {
  statusText.textContent = message;
  status.classList.toggle('is-ready', state === 'ready');
  status.classList.toggle('is-error', state === 'error');
};

const createRatios = (levelCount: number) =>
  Array.from({ length: levelCount }, (_, index) => Math.ceil((100 * (levelCount - index)) / levelCount));

const clampInteger = (value: number, minimum: number, maximum: number, fallback: number) =>
  Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;

const refreshRatioPreview = () => {
  const levelCount = clampInteger(Number(levelInput.value), 1, 20, 5);
  levelInput.value = String(levelCount);
  ratioPreview.textContent = createRatios(levelCount).map((value) => `${value}%`).join(' / ');
};

const formatBytes = (value?: number) => {
  if (!value) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
};

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
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

const getSelectedLabel = () => {
  if (!selectedLabelId) return undefined;
  const dataset = datasets.find((item) => item.id === selectedDatasetId);
  const label = dataset && currentLabels(dataset).find((item) => item.id === selectedLabelId);
  return dataset && label ? { dataset, label } : undefined;
};

const renderInspectionPopup = () => {
  const selected = getSelectedLabel();
  inspectionPopup.hidden = !selected;
  if (!selected) return;
  const { dataset, label } = selected;
  inspectionPopupTitle.textContent = label.title;
  inspectionPopupDataset.textContent = dataset.name;
  inspectionPopupPosition.textContent =
    `${label.position.x.toFixed(3)}, ${label.position.y.toFixed(3)}, ${label.position.z.toFixed(3)}`;
  inspectionPopupNormal.textContent = label.normal
    ? `${label.normal.x.toFixed(4)}, ${label.normal.y.toFixed(4)}, ${label.normal.z.toFixed(4)}`
    : '旧算法未计算';
  inspectionPopupRadius.textContent = label.selectionRadiusPixels === undefined
    ? '—'
    : `${label.selectionRadiusPixels} px`;
  inspectionPopupNeighbors.textContent = label.neighborCount?.toLocaleString('zh-CN') ?? '—';
  inspectionPopupMethod.textContent = label.selectionMethod === 'loaded-lod-gpu-circle-pca-v1'
    ? '当前 LOD · GPU 圆形多选 + PCA'
    : '旧体素算法';
  const created = new Date(label.createdAt);
  inspectionPopupCreated.textContent = Number.isNaN(created.valueOf())
    ? label.createdAt || '—'
    : created.toLocaleString('zh-CN', { hour12: false });
};

const clearSelectedInspectionLabel = () => {
  selectedLabelId = '';
  viewer.setSelectedInspectionPoint(null);
  renderInspectionPopup();
  renderDatasetCards();
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
    renderInspectionPopup();
  }
  return snapshot;
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

const updateSelectedCards = () => {
  for (const card of cardsContainer.querySelectorAll<HTMLElement>('.dataset-card')) {
    card.classList.toggle('is-selected', card.dataset.datasetId === selectedDatasetId);
  }
};

const loadDataset = async (dataset: Dataset) => {
  if (!dataset.visual) {
    setStatus(`${dataset.name} 尚未完成切片。`, 'error');
    return;
  }
  const revisionKey = `${dataset.id}:${dataset.visual.revision}`;
  const switchingDataset = selectedDatasetId !== dataset.id;
  selectedDatasetId = dataset.id;
  if (switchingDataset) {
    selectedLabelId = '';
    renderInspectionPopup();
  }
  updateSelectedCards();
  if (loadedRevision !== revisionKey) {
    setStatus(`正在加载 ${dataset.name}…`);
    await viewer.load(dataset.visual.renderUrl, dataset.name);
    loadedRevision = revisionKey;
    displayedLabelSignature = '';
  }
  await fetchInspectionLabels(dataset);
  syncViewerInspectionPoints(dataset);
  const count = dataset.visual.counts[0] ?? 0;
  setStatus(
    `${dataset.name} · LOD0 ${count.toLocaleString('zh-CN')} Gaussian · ${dataset.lodLevels} 层`,
    'ready'
  );
};

const visualLabel = (dataset: Dataset) => {
  if (dataset.status === 'building') {
    return `切片中 ${Math.round(dataset.progress)}%`;
  }
  if (dataset.visual) return '已切片';
  if (dataset.status === 'failed') return '切片失败';
  return '未切片';
};

const collisionLabel = (collision: CollisionState) => {
  if (collision.status === 'building') return `体素中 ${Math.round(collision.progress)}%`;
  if (collision.status === 'ready') return '体素已就绪';
  if (collision.status === 'failed') return '体素失败';
  if (collision.status === 'unavailable') return '无体素';
  return '未计算体素';
};

const makeNumberInput = (roleName: string, title: string, min: string, max: string, step: string) => {
  const label = document.createElement('label');
  label.className = 'compact-field';
  const caption = document.createElement('span');
  caption.textContent = title;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = min;
  input.max = max;
  input.step = step;
  input.dataset.role = roleName;
  label.append(caption, input);
  return label;
};

const createCard = (id: string) => {
  const card = document.createElement('article');
  card.className = 'dataset-card';
  card.dataset.datasetId = id;

  const header = document.createElement('div');
  header.className = 'dataset-card-header';
  const titleBox = document.createElement('div');
  const title = document.createElement('h2');
  title.dataset.role = 'name';
  const size = document.createElement('small');
  size.dataset.role = 'source-size';
  titleBox.append(title, size);
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'card-view';
  view.dataset.action = 'view';
  view.textContent = '查看';
  header.append(titleBox, view);

  const badges = document.createElement('div');
  badges.className = 'status-badges';
  for (const roleName of ['visual-status', 'collision-status']) {
    const badge = document.createElement('span');
    badge.dataset.role = roleName;
    badges.append(badge);
  }

  const meta = document.createElement('p');
  meta.className = 'card-meta';
  meta.dataset.role = 'meta';
  const stage = document.createElement('p');
  stage.className = 'card-stage';
  stage.dataset.role = 'stage';
  const cardProgress = document.createElement('progress');
  cardProgress.max = 100;
  cardProgress.dataset.role = 'progress';

  const settings = document.createElement('div');
  settings.className = 'card-settings';
  settings.dataset.role = 'settings';
  settings.append(
    makeNumberInput('lod-input', 'LOD 层', '1', '20', '1'),
    makeNumberInput('voxel-size', '体素 m', '0.02', '5', '0.01'),
    makeNumberInput('voxel-opacity', '阈值', '0', '1', '0.01')
  );

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  for (const [action, label] of [
    ['build', '切片'],
    ['label', '添加巡检点'],
    ['collision', '计算体素'],
    ['display-gs', '显示高斯'],
    ['display-voxel', '显示体素'],
    ['delete', '删除']
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.textContent = label;
    if (action === 'display-gs' || action === 'display-voxel') {
      button.classList.add('visibility-toggle');
      button.setAttribute('aria-pressed', 'false');
    }
    if (action === 'build') button.className = 'primary';
    if (action === 'delete') button.className = 'danger';
    actions.append(button);
  }

  const pointSection = document.createElement('section');
  pointSection.className = 'inspection-list-section';
  pointSection.dataset.role = 'inspection-section';
  const pointHeader = document.createElement('header');
  const pointTitle = document.createElement('span');
  pointTitle.textContent = '场景巡检点';
  const pointCount = document.createElement('small');
  pointCount.dataset.role = 'inspection-count';
  pointHeader.append(pointTitle, pointCount);
  const pointList = document.createElement('div');
  pointList.className = 'inspection-list';
  pointList.dataset.role = 'inspection-list';
  pointSection.append(pointHeader, pointList);

  card.append(header, badges, meta, stage, cardProgress, settings, actions, pointSection);
  cardsContainer.append(card);
  return card;
};

const role = <T extends HTMLElement>(card: HTMLElement, name: string) => {
  const element = card.querySelector<T>(`[data-role="${name}"]`);
  if (!element) throw new Error(`数据卡片缺少节点：${name}`);
  return element;
};

const actionButton = (card: HTMLElement, action: string) => {
  const button = card.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  if (!button) throw new Error(`数据卡片缺少操作：${action}`);
  return button;
};

const renderCardLabels = (dataset: Dataset, card: HTMLElement) => {
  const section = role(card, 'inspection-section');
  const list = role(card, 'inspection-list');
  const labels = currentLabels(dataset);
  role(card, 'inspection-count').textContent = String(labels.length);
  section.hidden = Boolean(dataset.builtin);
  list.replaceChildren();

  if (labels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'inspection-list-empty';
    empty.textContent = '暂无巡检点';
    list.append(empty);
    return;
  }

  const activeVisualRevision = labelsByDataset.get(dataset.id)?.visualRevision;
  for (const label of labels) {
    const item = document.createElement('div');
    const selected = dataset.id === selectedDatasetId && label.id === selectedLabelId;
    const active = label.resolved && label.selectionMethod === 'loaded-lod-gpu-circle-pca-v1' &&
      label.visualRevision === activeVisualRevision;
    item.className = `inspection-list-item${selected ? ' is-selected' : ''}${active ? '' : ' is-stale'}`;

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'inspection-list-select';
    select.dataset.labelAction = 'select';
    select.dataset.labelId = label.id;
    select.title = active ? `在场景中选择 ${label.title}` : '旧拾取算法或旧视觉版本：保留在列表中但不再绘制';
    const dot = document.createElement('span');
    dot.className = 'inspection-list-dot';
    const content = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = label.title;
    const position = document.createElement('small');
    position.textContent =
      `${label.position.x.toFixed(2)}, ${label.position.y.toFixed(2)}, ${label.position.z.toFixed(2)}`;
    content.append(title, position);
    select.append(dot, content);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'inspection-list-delete';
    remove.dataset.labelAction = 'delete';
    remove.dataset.labelId = label.id;
    remove.title = `删除 ${label.title}`;
    remove.setAttribute('aria-label', `删除 ${label.title}`);
    remove.textContent = '×';
    item.append(select, remove);
    list.append(item);
  }
};

const updateCard = (dataset: Dataset) => {
  const card = cardsContainer.querySelector<HTMLElement>(`[data-dataset-id="${dataset.id}"]`) ?? createCard(dataset.id);
  const settings = cardSettings.get(dataset.id) ?? {
    lodLevels: dataset.lodLevels || 5,
    voxelSize: dataset.collision?.voxelSize || 0.2,
    voxelOpacity: dataset.collision?.voxelOpacity ?? 0.1
  };
  cardSettings.set(dataset.id, settings);

  role(card, 'name').textContent = dataset.name;
  role(card, 'source-size').textContent = dataset.builtin ? '随应用提供' : formatBytes(dataset.source?.bytes);
  const visualBadge = role(card, 'visual-status');
  visualBadge.textContent = visualLabel(dataset);
  visualBadge.className = `badge ${dataset.visual ? 'is-ready' : dataset.status === 'failed' ? 'is-error' : ''}`;
  const collisionBadge = role(card, 'collision-status');
  collisionBadge.textContent = collisionLabel(dataset.collision);
  collisionBadge.className = `badge ${dataset.collision.status === 'ready' ? 'is-ready' : dataset.collision.status === 'failed' ? 'is-error' : ''}`;
  const gaussianCount = dataset.visual?.counts[0];
  role(card, 'meta').textContent = dataset.visual
    ? `${dataset.lodLevels} LOD · ${gaussianCount?.toLocaleString('zh-CN') ?? '—'} GS · ${formatBytes(dataset.visual.bytes)}` +
      (dataset.collision.status === 'ready' ? ` · SVO ${formatBytes(dataset.collision.bytes)}` : '') +
      (dataset.collision.debugMeshBytes ? ` · 调试网格 ${formatBytes(dataset.collision.debugMeshBytes)}` : '') +
      ` · 巡检点 ${dataset.labelCount ?? 0}`
    : `等待切片 · ${dataset.lodLevels} LOD`;
  role(card, 'stage').textContent = ['building', 'ready', 'failed'].includes(dataset.collision.status)
      ? dataset.collision.error || dataset.collision.stage
      : dataset.error || dataset.stage || dataset.collision.stage;

  const cardProgress = role<HTMLProgressElement>(card, 'progress');
  const running = dataset.status === 'building' || dataset.collision.status === 'building';
  cardProgress.hidden = !running;
  cardProgress.value = dataset.collision.status === 'building'
      ? dataset.collision.progress
      : dataset.progress;

  const settingsBox = role(card, 'settings');
  settingsBox.hidden = Boolean(dataset.builtin);
  settingsBox.classList.toggle('visual-locked', Boolean(dataset.visual));
  const lodInput = role<HTMLInputElement>(card, 'lod-input');
  const voxelSizeInput = role<HTMLInputElement>(card, 'voxel-size');
  const voxelOpacityInput = role<HTMLInputElement>(card, 'voxel-opacity');
  if (document.activeElement !== lodInput) lodInput.value = String(settings.lodLevels);
  if (document.activeElement !== voxelSizeInput) voxelSizeInput.value = String(settings.voxelSize);
  if (document.activeElement !== voxelOpacityInput) voxelOpacityInput.value = String(settings.voxelOpacity);

  const heavyTaskRunning = Boolean(activeTask);
  const build = actionButton(card, 'build');
  build.textContent = '切片';
  build.hidden = Boolean(dataset.visual);
  build.disabled = Boolean(dataset.builtin) || !dataset.source || heavyTaskRunning || dataset.status === 'awaiting-upload';
  const lodField = lodInput.closest<HTMLElement>('.compact-field');
  if (lodField) lodField.hidden = Boolean(dataset.visual);
  const collision = actionButton(card, 'collision');
  collision.textContent = dataset.collision.status === 'ready' ? '重新计算体素' : '计算体素';
  collision.disabled = Boolean(dataset.builtin) || !dataset.visual || heavyTaskRunning || dataset.status === 'building';
  const sceneLoaded = selectedDatasetId === dataset.id && loadedRevision.startsWith(`${dataset.id}:`);
  const displayGaussian = actionButton(card, 'display-gs');
  const gaussianVisible = sceneLoaded && viewer.gaussianVisible;
  displayGaussian.classList.toggle('is-active', gaussianVisible);
  displayGaussian.setAttribute('aria-pressed', String(gaussianVisible));
  displayGaussian.disabled = Boolean(dataset.builtin) || !dataset.visual ||
    (heavyTaskRunning && !sceneLoaded);
  displayGaussian.title = '独立显示或隐藏 Gaussian；不会关闭体素和巡检点';

  const voxelDebug = actionButton(card, 'display-voxel');
  const voxelDebugVisible = selectedDatasetId === dataset.id &&
    Boolean(dataset.collision.debugMeshUrl) && viewer.voxelDebugUrl === dataset.collision.debugMeshUrl;
  voxelDebug.classList.toggle('is-active', voxelDebugVisible);
  voxelDebug.setAttribute('aria-pressed', String(voxelDebugVisible));
  voxelDebug.disabled = Boolean(dataset.builtin) || !dataset.visual ||
    (!dataset.collision.debugMeshUrl && dataset.collision.status !== 'ready') ||
    (heavyTaskRunning && !voxelDebugVisible);
  voxelDebug.title = dataset.collision.debugMeshUrl
    ? `按需加载 ${formatBytes(dataset.collision.debugMeshBytes)} 的体素面网格；仅用于调试，不参与碰撞判断`
    : dataset.collision.status === 'ready'
      ? '点击后可按当前体素参数生成调试网格；不会自动改参'
      : '体素计算完成后可用于调试显示';
  const label = actionButton(card, 'label');
  label.textContent = pickingDatasetId === dataset.id ? '取消选择' : '选择巡检点';
  label.classList.toggle('is-active', pickingDatasetId === dataset.id);
  label.disabled = Boolean(dataset.builtin) || !dataset.visual || !dataset.source ||
    pickInFlight || heavyTaskRunning;
  actionButton(card, 'delete').disabled = Boolean(dataset.builtin) || activeTask?.datasetId === dataset.id;
  actionButton(card, 'view').disabled = !dataset.visual;
  const actions = card.querySelector<HTMLElement>('.card-actions')!;
  actions.hidden = Boolean(dataset.builtin);
  actions.classList.toggle('visual-locked', Boolean(dataset.visual));
  renderCardLabels(dataset, card);
  card.classList.toggle('is-selected', dataset.id === selectedDatasetId);
};

const renderDatasetCards = () => {
  const ids = new Set(datasets.map((dataset) => dataset.id));
  for (const card of cardsContainer.querySelectorAll<HTMLElement>('.dataset-card')) {
    if (!ids.has(card.dataset.datasetId || '')) card.remove();
  }
  for (const dataset of datasets) updateCard(dataset);
  cardsContainer.querySelector('.empty-cards')?.remove();
  if (datasets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-cards';
    empty.textContent = '尚无数据，请先上传 PLY。';
    cardsContainer.append(empty);
  }
};

const refreshDatasets = async (autoLoad = false) => {
  const response = await requestJson<DatasetListResponse>('/api/datasets');
  datasets = response.datasets;
  activeTask = response.activeTask;
  taskMode.textContent = `SOG ${response.sogWorkerCount} workers · GS 圆形多选 / 体素避障独立`;
  const ids = new Set(datasets.map((dataset) => dataset.id));
  for (const id of labelsByDataset.keys()) {
    if (!ids.has(id)) labelsByDataset.delete(id);
  }
  if (!datasets.some((dataset) => dataset.id === selectedDatasetId)) {
    selectedLabelId = '';
    renderInspectionPopup();
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
  renderDatasetCards();
  const selected = datasets.find((dataset) => dataset.id === selectedDatasetId);
  if (selected) syncViewerInspectionPoints(selected);
  if (autoLoad && selectedDatasetId) {
    if (selected?.visual) await loadDataset(selected);
  }
};

const uploadFile = (dataset: Dataset, file: File) =>
  new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', `/api/datasets/${dataset.id}/source`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        progress.value = (event.loaded / event.total) * 100;
        buildStage.textContent = `正在上传 PLY：${Math.round((event.loaded / event.total) * 100)}%`;
      }
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

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileName.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : '尚未选择文件';
  uploadButton.disabled = !file;
  progress.value = 0;
  buildStage.textContent = file ? '上传后将在下方创建数据卡片' : '选择 PLY 后开始';
});

levelInput.addEventListener('change', refreshRatioPreview);
levelInput.addEventListener('input', refreshRatioPreview);

uploadButton.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  uploadButton.disabled = true;
  levelInput.disabled = true;
  progress.value = 0;
  buildStage.textContent = '正在创建数据卡片…';
  try {
    const dataset = await requestJson<Dataset>('/api/datasets', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, size: file.size, lodLevels: Number(levelInput.value) })
    });
    selectedDatasetId = dataset.id;
    await refreshDatasets();
    await uploadFile(dataset, file);
    progress.value = 100;
    buildStage.textContent = 'PLY 已上传，请在数据卡片中点击“切片”。';
    fileInput.value = '';
    fileName.textContent = '尚未选择文件';
    await refreshDatasets();
  } catch (error) {
    buildStage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    uploadButton.disabled = !fileInput.files?.[0];
    levelInput.disabled = false;
  }
});

cardsContainer.addEventListener('input', (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-role]');
  const card = input?.closest<HTMLElement>('[data-dataset-id]');
  if (!input || !card?.dataset.datasetId) return;
  const dataset = datasets.find((item) => item.id === card.dataset.datasetId);
  if (!dataset) return;
  const settings = cardSettings.get(dataset.id) ?? {
    lodLevels: dataset.lodLevels,
    voxelSize: dataset.collision.voxelSize,
    voxelOpacity: dataset.collision.voxelOpacity
  };
  if (input.dataset.role === 'lod-input') settings.lodLevels = Number(input.value);
  if (input.dataset.role === 'voxel-size') settings.voxelSize = Number(input.value);
  if (input.dataset.role === 'voxel-opacity') settings.voxelOpacity = Number(input.value);
  cardSettings.set(dataset.id, settings);
});

const selectInspectionLabel = async (dataset: Dataset, labelId: string) => {
  const label = currentLabels(dataset).find((item) => item.id === labelId);
  if (!label) return;
  await loadDataset(dataset);
  selectedLabelId = label.id;
  viewer.setSelectedInspectionPoint(label.id);
  renderInspectionPopup();
  renderDatasetCards();
  setStatus(
    `${label.title} · (${label.position.x.toFixed(2)}, ${label.position.y.toFixed(2)}, ${label.position.z.toFixed(2)})`,
    'ready'
  );
};

const deleteInspectionLabel = async (dataset: Dataset, labelId: string) => {
  const label = currentLabels(dataset).find((item) => item.id === labelId);
  if (!label || !window.confirm(`删除“${label.title}”？被航线引用的巡检点不能删除。`)) return;
  await requestJson(`/api/datasets/${dataset.id}/labels/${label.id}`, { method: 'DELETE' });
  await fetchInspectionLabels(dataset, true);
  if (selectedDatasetId === dataset.id && selectedLabelId === label.id) {
    selectedLabelId = '';
    viewer.setSelectedInspectionPoint(null);
    renderInspectionPopup();
  }
  displayedLabelSignature = '';
  syncViewerInspectionPoints(dataset);
  await refreshDatasets();
  setStatus(`${label.title} 已删除。`, 'ready');
};

cardsContainer.addEventListener('click', async (event) => {
  const labelButton = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-label-action]');
  const labelCard = labelButton?.closest<HTMLElement>('[data-dataset-id]');
  if (labelButton && labelCard?.dataset.datasetId && !labelButton.disabled) {
    const dataset = datasets.find((item) => item.id === labelCard.dataset.datasetId);
    const labelId = labelButton.dataset.labelId;
    if (!dataset || !labelId) return;
    labelButton.disabled = true;
    try {
      if (labelButton.dataset.labelAction === 'select') {
        await selectInspectionLabel(dataset, labelId);
      } else if (labelButton.dataset.labelAction === 'delete') {
        await deleteInspectionLabel(dataset, labelId);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      labelButton.disabled = false;
    }
    return;
  }

  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const card = button?.closest<HTMLElement>('[data-dataset-id]');
  if (!button || !card?.dataset.datasetId || button.disabled) return;
  const dataset = datasets.find((item) => item.id === card.dataset.datasetId);
  if (!dataset) return;
  const settings = cardSettings.get(dataset.id)!;
  button.disabled = true;
  try {
    if (button.dataset.action === 'view') {
      pickingDatasetId = '';
      canvas.classList.remove('is-picking');
      setSelectionCircleVisible(false);
      await loadDataset(dataset);
    } else if (button.dataset.action === 'build') {
      await requestJson(`/api/datasets/${dataset.id}/build`, {
        method: 'POST',
        body: JSON.stringify({ lodLevels: clampInteger(settings.lodLevels, 1, 20, dataset.lodLevels) })
      });
      setStatus(`${dataset.name} 已进入切片任务。`);
    } else if (button.dataset.action === 'collision') {
      if (dataset.collision.status === 'ready' &&
          !window.confirm(`重新计算“${dataset.name}”的体素？当前版本会保留到新版校验通过。`)) return;
      if (selectedDatasetId === dataset.id) viewer.clearVoxelDebug();
      await requestJson(`/api/datasets/${dataset.id}/collision/build`, {
        method: 'POST',
        body: JSON.stringify({ voxelSize: settings.voxelSize, voxelOpacity: settings.voxelOpacity })
      });
      setStatus(`${dataset.name} 已进入 GPU 并行体素任务。`);
    } else if (button.dataset.action === 'display-gs') {
      const sceneWasLoaded = loadedRevision.startsWith(`${dataset.id}:`);
      const visible = sceneWasLoaded ? !viewer.gaussianVisible : true;
      await loadDataset(dataset);
      viewer.setGaussianVisible(visible);
      renderDatasetCards();
      setStatus(
        visible
          ? `${dataset.name} Gaussian 已显示。`
          : `${dataset.name} Gaussian 已隐藏；体素和巡检点状态不变。`,
        'ready'
      );
    } else if (button.dataset.action === 'display-voxel') {
      const debugMeshUrl = dataset.collision.debugMeshUrl;
      if (!debugMeshUrl) {
        if (dataset.collision.status !== 'ready') {
          throw new Error('请先完成体素计算。');
        }
        if (!window.confirm(
          `“${dataset.name}”的旧体素版本没有调试网格。` +
          `是否使用当前 ${settings.voxelSize} m / 透明度 ${settings.voxelOpacity} 参数重新生成？` +
          '系统不会自动改参，旧版本会保留到新版本校验通过。'
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
          !window.confirm(
            `“${dataset.name}”的体素调试网格为 ${formatBytes(dataset.collision.debugMeshBytes)}，` +
            '加载期间会明显占用内存和显存。继续显示吗？'
          )) return;
      await loadDataset(dataset);
      setStatus(`正在按需加载 ${dataset.name} 的体素调试网格（${formatBytes(dataset.collision.debugMeshBytes)}）…`);
      const visible = await viewer.toggleVoxelDebug(debugMeshUrl, dataset.name);
      renderDatasetCards();
      setStatus(
        visible
          ? `${dataset.name} 体素调试网格已显示；青色网格仅用于检查，不参与碰撞判断。`
          : `${dataset.name} 体素调试网格已隐藏并释放。`,
        'ready'
      );
    } else if (button.dataset.action === 'label') {
      if (pickingDatasetId === dataset.id) {
        pickingDatasetId = '';
        canvas.classList.remove('is-picking');
        setSelectionCircleVisible(false);
        setStatus('已取消添加巡检点。', 'ready');
      } else {
        await loadDataset(dataset);
        viewer.setGaussianVisible(true);
        pickingDatasetId = dataset.id;
        canvas.classList.add('is-picking');
        setSelectionCircleVisible(true);
        renderDatasetCards();
        setStatus(`选择巡检点：单击 GS，使用固定半径 ${FIXED_CIRCLE_RADIUS_PIXELS}px 的圆形多选；不支持拖动。`);
      }
    } else if (button.dataset.action === 'delete') {
      if (!window.confirm(`永久删除“${dataset.name}”及其 PLY、切片和体素版本？此操作不可恢复。`)) return;
      await requestJson(`/api/datasets/${dataset.id}`, { method: 'DELETE' });
      cardSettings.delete(dataset.id);
      labelsByDataset.delete(dataset.id);
      if (selectedDatasetId === dataset.id) {
        pickingDatasetId = '';
        canvas.classList.remove('is-picking');
        setSelectionCircleVisible(false);
        selectedDatasetId = '';
        loadedRevision = '';
        selectedLabelId = '';
        displayedLabelSignature = '';
        renderInspectionPopup();
        viewer.clear();
      }
      setStatus(`${dataset.name} 已永久删除。`, 'ready');
    }
    await refreshDatasets(button.dataset.action === 'delete');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    button.disabled = false;
  }
});

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
      if (labelId) await selectInspectionLabel(dataset, labelId);
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
  renderDatasetCards();
  setStatus(`正在用固定 ${FIXED_CIRCLE_RADIUS_PIXELS}px GPU 圆形区域选择当前 LOD…`);
  try {
    const selection = await viewer.pickGaussianCircle(event.clientX, event.clientY);
    if (!selection) {
      setStatus('点击位置没有可选的 Gaussian，请贴近目标后重新选择。', 'error');
      return;
    }
    setStatus(`GPU 已选择 ${selection.neighborCount.toLocaleString('zh-CN')} 个当前 LOD 中心，正在保存巡检点…`);
    const label = await requestJson<InspectionLabel>(`/api/datasets/${dataset.id}/labels/select`, {
      method: 'POST',
      body: JSON.stringify({
        ...selection,
        visualRevision: dataset.activeVisualRevision
      })
    });
    pickingDatasetId = '';
    canvas.classList.remove('is-picking');
    setSelectionCircleVisible(false);
    await fetchInspectionLabels(dataset, true);
    selectedLabelId = label.id;
    displayedLabelSignature = '';
    syncViewerInspectionPoints(dataset);
    viewer.setSelectedInspectionPoint(label.id);
    renderInspectionPopup();
    await refreshDatasets();
    setStatus(
      `${label.title} 已添加 · ${label.neighborCount ?? 0} 个 GS · 法向 ` +
      `(${label.normal?.x.toFixed(3)}, ${label.normal?.y.toFixed(3)}, ${label.normal?.z.toFixed(3)})`,
      'ready'
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    pickInFlight = false;
    renderDatasetCards();
  }
};

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || pickInFlight) return;
  if (pickingDatasetId) {
    pickingDatasetId = '';
    pointerStart = undefined;
    canvas.classList.remove('is-picking');
    setSelectionCircleVisible(false);
    renderDatasetCards();
    setStatus('已取消添加巡检点。', 'ready');
    return;
  }
  if (selectedLabelId) clearSelectedInspectionLabel();
};

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', updateSelectionCircle);
canvas.addEventListener('pointerup', onPointerUp);
window.addEventListener('keydown', onKeyDown);
inspectionPopupClose.addEventListener('click', clearSelectedInspectionLabel);

reloadButton.addEventListener('click', () => void refreshDatasets());

const dispose = () => {
  if (disposed) return;
  disposed = true;
  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  stopMonitor?.();
  canvas.removeEventListener('pointerdown', onPointerDown);
  canvas.removeEventListener('pointermove', updateSelectionCircle);
  canvas.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('keydown', onKeyDown);
  inspectionPopupClose.removeEventListener('click', clearSelectedInspectionLabel);
  viewer.dispose();
};

window.addEventListener('pagehide', dispose, { once: true });
import.meta.hot?.dispose(dispose);

const start = async () => {
  refreshRatioPreview();
  setStatus('正在创建 PlayCanvas 图形设备…');
  await viewer.initialize();
  stopMonitor = startMonitor(viewer);
  setStatus(`PlayCanvas ${viewer.backend} 已就绪，正在读取数据卡片…`);
  await refreshDatasets(true);
  pollTimer = window.setInterval(() => {
    void refreshDatasets().catch((error) => console.warn('数据卡片状态刷新失败：', error));
  }, 1_500);
};

start().catch((error: unknown) => {
  console.error(error);
  setStatus(error instanceof Error ? error.message : String(error), 'error');
});
