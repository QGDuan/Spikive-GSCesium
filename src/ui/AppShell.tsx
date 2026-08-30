import { useState } from 'react';
import type { AppShellProps } from './contracts';
import { InspectionCard, LabelPanel } from './LabelPanel';
import { PerformanceCard } from './PerformanceCard';
import { Button, UiContainer } from './primitives';
import { ScenePanel } from './ScenePanel';
import { MissionPanel } from './MissionPanel';

export type {
  AppShellProps,
  CameraMode,
  CardSettings,
  CollisionState,
  Dataset,
  DatasetAction,
  FlightMission,
  FlightProfile,
  FlightWaypoint,
  InspectionLabel,
  LabelMetadata,
  LabelType,
  MissionInput,
  PendingSelection,
  WorkspaceTab
} from './contracts';
export { LABEL_TYPES } from './contracts';

const PRODUCT_TITLE = '面向建运一体化转型的实景三维多场景孪生应用底座系统';

export const AppShell = (props: AppShellProps) => {
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const workspaceProps = { ...props, workspaceCollapsed, onWorkspaceCollapse: () => setWorkspaceCollapsed((value) => !value) };
  return <>
  <header className="top-nav">
    <div className="brand" title={PRODUCT_TITLE}><span className="brand-title">{PRODUCT_TITLE}</span></div>
    <div className="top-nav-actions">
      <Button
        type="button"
        size="compact"
        tone={props.cameraMode === 'first-person' ? 'active' : 'default'}
        className="camera-mode-toggle"
        aria-pressed={props.cameraMode === 'first-person'}
        aria-label={props.cameraMode === 'first-person' ? '当前为第一人称，点击切换为第三人称' : '当前为第三人称，点击切换为第一人称'}
        title={props.cameraMode === 'first-person' ? '切换为第三人称' : '切换为第一人称'}
        onClick={() => props.onCameraMode(props.cameraMode === 'first-person' ? 'third-person' : 'first-person')}
      >{props.cameraMode === 'first-person' ? '第一人称' : '第三人称'}</Button>
      <span className="backend-badge"><i/><span data-metric="backend">初始化中</span></span>
    </div>
  </header>
  <div className={`left-dock${workspaceCollapsed ? ' is-collapsed' : ''}`}>{props.activeTab === 'scenes' ? <ScenePanel {...workspaceProps}/> : props.activeTab === 'labels' ? <LabelPanel {...workspaceProps}/> : <MissionPanel {...workspaceProps}/>}</div>
  <InspectionCard {...props}/>
  <PerformanceCard/>
  <UiContainer as="div" variant="floating" className={`global-status global-status--${props.status.state}`} role="status" aria-live="polite"><i/>{props.status.message}</UiContainer>
  </>;
};
