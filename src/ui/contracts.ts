export type WorkspaceTab = 'scenes' | 'labels' | 'missions';
export type LabelType = '起点' | '缺陷点' | '常态化巡检点' | '关键巡检点' | '一般巡检点';
export const LABEL_TYPES: LabelType[] = ['起点', '缺陷点', '常态化巡检点', '关键巡检点', '一般巡检点'];

export interface CollisionState {
  status: 'not-built' | 'building' | 'ready' | 'failed' | 'unavailable';
  progress: number;
  stage: string;
  error?: string | null;
  revision?: string | null;
  voxelSize: number;
  voxelOpacity: number;
  coordinateSystem?: 'source-ply-local-z-up-meters';
  sourceToVoxelTransform?: 'rotate-z-180';
  bytes?: number;
  debugMeshUrl?: string;
  debugMeshBytes?: number;
}

export interface Dataset {
  id: string;
  name: string;
  status: 'awaiting-upload' | 'uploaded' | 'building' | 'ready' | 'failed';
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
  missionCount?: number;
  builtin?: boolean;
}

export interface FlightProfile {
  speed: number;
  inflationRadius: number;
  observationDistance: number;
  minimumSpacing: number;
  maximumSpacing: number;
}

export interface FlightWaypoint {
  id: string;
  sequence: number;
  type: 'start' | 'inspection' | 'transit';
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  speed: number;
  targetLabelId: string | null;
  clearance: number;
  valid: boolean;
}

export interface FlightMission {
  id: string;
  datasetId: string;
  name: string;
  startLabelId: string;
  labelIds: string[];
  profile: FlightProfile;
  collisionRevision: string | null;
  status: 'draft' | 'valid' | 'invalid';
  error: string | null;
  waypoints: FlightWaypoint[];
  createdAt: string;
  updatedAt: string;
}

export interface MissionInput {
  name: string;
  startLabelId: string;
  labelIds: string[];
  profile: FlightProfile;
}

export interface InspectionLabel {
  id: string;
  datasetId: string;
  title: string;
  description: string;
  type: LabelType;
  position: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number } | null;
  sourceSha256?: string;
  visualRevision?: string;
  selectionMethod?: string;
  selectionRadiusPixels?: number;
  neighborCount?: number;
  normalPlanarity?: number;
  residentLodLevels?: number[];
  residentFileCount?: number;
  resolved: boolean;
  usageCount?: number;
  inUse?: boolean;
  createdAt: string;
  updatedAt?: string;
  distance?: number;
}

export interface LabelMetadata {
  title: string;
  description: string;
  type: LabelType;
}

export interface PendingSelection {
  position: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  neighborCount: number;
}

export interface CardSettings {
  lodLevels: number;
  voxelSize: number;
  voxelOpacity: number;
}

export type DatasetAction = 'view' | 'build' | 'collision' | 'display-gs' | 'display-voxel' | 'delete';

export interface AppShellProps {
  activeTab: WorkspaceTab;
  datasets: Dataset[];
  selectedDatasetId: string;
  activeTask: { type: 'visual' | 'collision'; datasetId: string } | null;
  workerCount: number;
  cardSettings: Record<string, CardSettings>;
  loadedRevision: string;
  gaussianVisible: boolean;
  voxelDebugUrl?: string;
  upload: { progress: number; stage: string; busy: boolean };
  status: { message: string; state: 'loading' | 'ready' | 'error' };
  labels: InspectionLabel[];
  missionLabels: InspectionLabel[];
  labelTotal: number;
  startLabelId?: string | null;
  selectedLabel?: InspectionLabel;
  labelFilterType?: LabelType;
  labelFilterQuery: string;
  picking: boolean;
  pendingSelection?: PendingSelection;
  missions: FlightMission[];
  selectedMissionId?: string;
  planningMissionId?: string;
  onTab(tab: WorkspaceTab): void;
  onReload(): void;
  onUpload(file: File, lodLevels: number): void;
  onCardSettings(datasetId: string, patch: Partial<CardSettings>): void;
  onDatasetAction(action: DatasetAction, datasetId: string): void;
  onStartPick(): void;
  onCancelPick(): void;
  onCancelPending(): void;
  onClearLabelSelection(): void;
  onCreateLabel(metadata: LabelMetadata): void;
  onUpdateLabel(labelId: string, metadata: LabelMetadata): void;
  onDeleteLabel(labelId: string): void;
  onSelectLabel(labelId: string): void;
  onLabelFilter(type: LabelType | undefined, query: string): void;
  onCreateMission(input: MissionInput): void;
  onSelectMission(missionId: string): void;
  onPlanMission(missionId: string): void;
  onDeleteMission(missionId: string): void;
}
