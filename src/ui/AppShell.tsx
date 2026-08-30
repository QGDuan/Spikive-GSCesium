import { useState } from 'react';
import type { AppShellProps } from './contracts';
import { InspectionCard, LabelPanel } from './LabelPanel';
import { PerformanceCard } from './PerformanceCard';
import { UiContainer } from './primitives';
import { ScenePanel } from './ScenePanel';
import { MissionPanel } from './MissionPanel';

export type {
  AppShellProps,
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

const PRODUCT_TITLE = '实景三维底座';

export const AppShell = (props: AppShellProps) => {
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const workspaceProps = { ...props, workspaceCollapsed, onWorkspaceCollapse: () => setWorkspaceCollapsed((value) => !value) };
  return <>
  <header className="top-nav">
    <div className="brand" title={PRODUCT_TITLE}><span className="brand-title">{PRODUCT_TITLE}</span></div>
    <span className="backend-badge"><i/><span data-metric="backend">初始化中</span></span>
  </header>
  <div className={`left-dock${workspaceCollapsed ? ' is-collapsed' : ''}`}>{props.activeTab === 'scenes' ? <ScenePanel {...workspaceProps}/> : props.activeTab === 'labels' ? <LabelPanel {...workspaceProps}/> : <MissionPanel {...workspaceProps}/>}</div>
  <InspectionCard {...props}/>
  <PerformanceCard/>
  <UiContainer as="div" variant="floating" className={`global-status global-status--${props.status.state}`} role="status" aria-live="polite"><i/>{props.status.message}</UiContainer>
  </>;
};
