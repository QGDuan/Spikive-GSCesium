import { useEffect, useMemo, useState } from 'react';
import type { AppShellProps, FlightProfile, MissionInput } from './contracts';
import { shortRevision } from './format';
import { Button, EmptyState, Icon, SectionHeading, StatusMark, UiContainer } from './primitives';

const DEFAULT_PROFILE: FlightProfile = {
  speed: 3,
  inflationRadius: 0.5,
  observationDistance: 3,
  minimumSpacing: 0.5,
  maximumSpacing: 5
};

const profileFields: Array<{ key: keyof FlightProfile; label: string; minimum: number }> = [
  { key: 'speed', label: '飞行速度 / m·s⁻¹', minimum: 0.1 },
  { key: 'inflationRadius', label: '无人机膨胀系数 / m', minimum: 0.1 },
  { key: 'observationDistance', label: '观察距离 / m（仅巡检）', minimum: 0.1 },
  { key: 'minimumSpacing', label: '最小点间距 / m', minimum: 0 },
  { key: 'maximumSpacing', label: '最大点间距 / m', minimum: 0.1 }
];

const statusInfo = (status: 'draft' | 'valid' | 'invalid') => status === 'valid'
  ? { state: 'ready' as const, label: '规划有效' }
  : status === 'invalid'
    ? { state: 'error' as const, label: '规划失败' }
    : { state: 'idle' as const, label: '待规划' };

export const MissionPanel = (props: AppShellProps) => {
  const dataset = props.datasets.find((item) => item.id === props.selectedDatasetId);
  const ready = Boolean(dataset && !dataset.builtin && dataset.visual && props.loadedRevision.startsWith(`${dataset.id}:`));
  const start = props.missionLabels.find((label) => label.type === '起点') ??
    (props.startLabelId ? props.missionLabels.find((label) => label.id === props.startLabelId) : undefined);
  const targets = useMemo(() => props.missionLabels.filter((label) => label.type !== '起点'), [props.missionLabels]);
  const [name, setName] = useState('巡检航线');
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  useEffect(() => {
    setLabelIds([]);
    setConfirmDeleteId('');
  }, [props.selectedDatasetId]);
  useEffect(() => {
    const available = new Set(targets.map((label) => label.id));
    setLabelIds((current) => current.filter((id) => available.has(id)));
  }, [targets]);
  const toggleTarget = (id: string) => setLabelIds((current) => current.includes(id)
    ? current.filter((item) => item !== id)
    : [...current, id]);
  const input: MissionInput = { name: name.trim(), startLabelId: start?.id ?? '', labelIds, profile };
  const profileValues = Object.values(profile);
  const profileValid = profileValues.every((value) => Number.isFinite(value) && value <= 10_000 &&
    Math.abs(value * 10 - Math.round(value * 10)) < 1e-8) &&
    profile.speed > 0 && profile.inflationRadius > 0 && profile.observationDistance > 0 &&
    profile.minimumSpacing >= 0 && profile.maximumSpacing > 0;
  const canCreate = ready && Boolean(input.name && input.startLabelId && input.labelIds.length) &&
    profileValid && profile.maximumSpacing >= profile.minimumSpacing;
  return <UiContainer variant="panel" className="workspace-panel" aria-label="飞行路线规划">
    <header className="workspace-header"><div><span className="overline">FLIGHT ROUTES</span><h1>飞行路线</h1></div><span className="header-count">{props.missions.length}</span></header>
    <div className="workspace-scroll">
      <UiContainer as="div" variant="subtle" className={`scene-binding${ready ? ' is-ready' : ''}`}><Icon name="database"/><span><small>当前场景</small><strong>{dataset?.name ?? '尚未加载场景'}</strong></span>{dataset?.visual && <code>{shortRevision(dataset.activeVisualRevision)}</code>}</UiContainer>
      {!ready && <p className="binding-help">请先到“场景”页查看一个已切片的自定义场景。</p>}
      <UiContainer variant="subtle" className="mission-create">
        <SectionHeading aside="局部 Z-up · 体素安全真值">新建航线</SectionHeading>
        <label className="field"><span>航线名称</span><input maxLength={80} value={name} onChange={(event) => setName(event.target.value)}/></label>
        <label className="field"><span>起点</span><select value={start?.id ?? ''} disabled><option value={start?.id ?? ''}>{start ? start.title : '当前场景尚未建立起点标签'}</option></select></label>
        <div className="mission-profile">{profileFields.map((field) => <label key={field.key}><span>{field.label}</span><input type="number" step="0.1" min={field.minimum} value={profile[field.key]} onChange={(event) => setProfile({ ...profile, [field.key]: Number(event.target.value) })}/></label>)}</div>
        <fieldset className="mission-targets"><legend>巡检顺序</legend>{targets.length === 0 && <small>当前场景还没有可加入的巡检标签。</small>}{targets.map((label) => {
          const order = labelIds.indexOf(label.id);
          return <button type="button" key={label.id} className={order >= 0 ? 'is-active' : ''} aria-pressed={order >= 0} onClick={() => toggleTarget(label.id)}><i>{order >= 0 ? order + 1 : '+'}</i><span>{label.title}</span><small>{label.type}</small></button>;
        })}</fieldset>
        <Button tone="primary" icon="plus" disabled={!canCreate} onClick={() => { props.onCreateMission(input); setLabelIds([]); }}>建立航线</Button>
      </UiContainer>
      <SectionHeading className="mission-list-heading" aside="红点：标签节点 · 蓝点：途经点">航线</SectionHeading>
      <div className="mission-list">
        {props.missions.length === 0 && <EmptyState compact icon="route" title={ready ? '当前场景尚无航线' : '场景加载后显示航线'}/>}
        {props.missions.map((mission) => {
          const status = statusInfo(mission.status);
          const selected = props.selectedMissionId === mission.id;
          const planning = props.planningMissionId === mission.id;
          return <UiContainer as="article" variant="card" key={mission.id} className={`mission-card${selected ? ' is-selected' : ''}`}>
            <button type="button" className="mission-card__select" onClick={() => props.onSelectMission(mission.id)}><span><strong>{mission.name}</strong><small>{mission.labelIds.length} 个标签 · {mission.waypoints.length} 个航点</small></span><StatusMark state={status.state}>{status.label}</StatusMark></button>
            <div className="mission-card__profile"><span>{mission.profile.speed.toFixed(1)} m/s</span><span>膨胀 {mission.profile.inflationRadius.toFixed(1)} m</span><span>观察 {mission.profile.observationDistance.toFixed(1)} m</span><span>{mission.profile.minimumSpacing.toFixed(1)}–{mission.profile.maximumSpacing.toFixed(1)} m</span></div>
            {mission.error && <p className="mission-error">{mission.error}</p>}
            <div className="mission-card__actions"><Button size="compact" icon="route" tone="primary" disabled={planning || dataset?.collision.status !== 'ready'} onClick={() => props.onPlanMission(mission.id)}>{planning ? '计算中…' : mission.status === 'draft' ? '计算航线' : '重新计算'}</Button>{confirmDeleteId === mission.id ? <><Button size="compact" tone="ghost" onClick={() => setConfirmDeleteId('')}>取消</Button><Button size="compact" tone="danger" onClick={() => props.onDeleteMission(mission.id)}>确认删除</Button></> : <Button size="compact" tone="ghost" icon="trash" onClick={() => setConfirmDeleteId(mission.id)}>删除</Button>}</div>
          </UiContainer>;
        })}
      </div>
    </div>
    <footer className="workspace-footer">按选定标签顺序规划 · 有效航线绿色 · 失败安全前缀橙色</footer>
  </UiContainer>;
};
