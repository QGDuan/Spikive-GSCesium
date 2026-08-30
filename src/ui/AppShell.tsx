import type { AppShellProps } from './contracts';
import { InspectionCard, LabelPanel } from './LabelPanel';
import { PerformanceCard } from './PerformanceCard';
import { Icon, UiContainer } from './primitives';
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

const PRODUCT_TITLE = '面向建运一体化转型的实景三维多场景孪生应用底座系统';

export const AppShell = (props: AppShellProps) => <>
  <nav className="top-nav" aria-label="主导航">
    <div className="brand" title={PRODUCT_TITLE}><span className="brand-title">{PRODUCT_TITLE}</span></div>
    <div className="nav-tabs" aria-label="工作区">
      <button type="button" aria-current={props.activeTab === 'scenes' ? 'page' : undefined} className={props.activeTab === 'scenes' ? 'is-active' : ''} onClick={() => props.onTab('scenes')}><Icon name="database"/><span>场景</span></button>
      <button type="button" aria-current={props.activeTab === 'labels' ? 'page' : undefined} className={props.activeTab === 'labels' ? 'is-active' : ''} onClick={() => props.onTab('labels')}><Icon name="tag"/><span>标签</span></button>
      <button type="button" aria-current={props.activeTab === 'missions' ? 'page' : undefined} className={props.activeTab === 'missions' ? 'is-active' : ''} onClick={() => props.onTab('missions')}><Icon name="route"/><span>航线</span></button>
    </div>
    <span className="backend-badge"><i/><span data-metric="backend">初始化中</span></span>
  </nav>
  <div className="left-dock">{props.activeTab === 'scenes' ? <ScenePanel {...props}/> : props.activeTab === 'labels' ? <LabelPanel {...props}/> : <MissionPanel {...props}/>}</div>
  <InspectionCard {...props}/>
  <PerformanceCard/>
  <UiContainer as="div" variant="floating" className={`global-status global-status--${props.status.state}`} role="status" aria-live="polite"><i/>{props.status.message}</UiContainer>
</>;
