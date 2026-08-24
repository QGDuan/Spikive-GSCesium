import { useEffect, useMemo, useState } from 'react';
import type { AppShellProps, LabelMetadata, PendingSelection } from './contracts';
import { LABEL_TYPES } from './contracts';
import { shortRevision } from './format';
import { Button, EmptyState, Icon, SectionHeading, UiContainer } from './primitives';

const LabelEditor = ({ initial, creating, selection, startTypeAvailable, onCancel, onSave }: {
  initial: LabelMetadata;
  creating: boolean;
  selection?: PendingSelection;
  startTypeAvailable: boolean;
  onCancel(): void;
  onSave(value: LabelMetadata): void;
}) => {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial.title, initial.description, initial.type]);
  return <div className="label-editor">
    <SectionHeading>{creating ? '初始化标签' : '编辑标签'}</SectionHeading>
    {selection && <div className="selection-summary"><Icon name="pin"/><span>{selection.position.x.toFixed(3)}, {selection.position.y.toFixed(3)}, {selection.position.z.toFixed(3)}</span><small>{selection.neighborCount.toLocaleString('zh-CN')} 个前表面采样</small></div>}
    <label className="field"><span>名称</span><input autoFocus maxLength={80} value={value.title} onChange={(event) => setValue({ ...value, title: event.target.value })} placeholder="例：1# 电机侧面"/></label>
    <label className="field"><span>说明</span><textarea rows={3} maxLength={500} value={value.description} onChange={(event) => setValue({ ...value, description: event.target.value })} placeholder="可选：记录观测对象或缺陷情况"/></label>
    <fieldset className="type-select"><legend>类型</legend>{LABEL_TYPES.map((type) => {
      const disabled = type === '起点' && !startTypeAvailable && value.type !== '起点';
      return <button type="button" key={type} disabled={disabled} title={disabled ? '当前场景已有起点' : undefined} aria-pressed={value.type === type} className={value.type === type ? 'is-active' : ''} onClick={() => setValue({ ...value, type })}><i/>{type}</button>;
    })}</fieldset>
    {!startTypeAvailable && value.type !== '起点' && <small className="field-help">当前场景已有起点；每个场景最多一个。</small>}
    <div className="editor-actions"><Button tone="ghost" icon="close" onClick={onCancel}>取消</Button><Button tone="primary" icon="check" disabled={!value.title.trim()} onClick={() => onSave({ ...value, title: value.title.trim(), description: value.description.trim() })}>保存标签</Button></div>
  </div>;
};

export const LabelPanel = (props: AppShellProps) => {
  const [query, setQuery] = useState(props.labelFilterQuery);
  useEffect(() => setQuery(props.labelFilterQuery), [props.labelFilterQuery]);
  const dataset = props.datasets.find((item) => item.id === props.selectedDatasetId);
  const sceneReady = Boolean(dataset && !dataset.builtin && dataset.visual && props.loadedRevision.startsWith(`${dataset.id}:`));
  return <UiContainer variant="panel" className="workspace-panel" aria-label="标签管理">
    <header className="workspace-header"><div><span className="overline">INSPECTION LABELS</span><h1>标签管理</h1></div><span className="header-count">{props.labelTotal}</span></header>
    <div className="workspace-scroll">
      <UiContainer as="div" variant="subtle" className={`scene-binding${sceneReady ? ' is-ready' : ''}`}><Icon name="database"/><span><small>当前场景</small><strong>{dataset?.name ?? '尚未加载场景'}</strong></span>{dataset?.visual && <code>{shortRevision(dataset.activeVisualRevision)}</code>}</UiContainer>
      {!sceneReady && <p className="binding-help">请先到“场景”页查看一个已切片的自定义场景。</p>}
      <Button tone={props.picking ? 'active' : 'primary'} icon={props.picking ? 'close' : 'plus'} aria-pressed={props.picking} disabled={!sceneReady} onClick={props.picking ? props.onCancelPick : props.onStartPick}>{props.picking ? '取消 5px 圆选' : '在当前场景新建标签'}</Button>
      <div className="filter-block">
        <form className="search-control" onSubmit={(event) => { event.preventDefault(); props.onLabelFilter(props.labelFilterType, query.trim()); }}><Icon name="search"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或说明"/><button type="submit">查询</button></form>
        <div className="filter-chips"><button type="button" aria-pressed={!props.labelFilterType} className={!props.labelFilterType ? 'is-active' : ''} onClick={() => props.onLabelFilter(undefined, query.trim())}>全部</button>{LABEL_TYPES.map((type) => <button type="button" key={type} aria-pressed={props.labelFilterType === type} className={props.labelFilterType === type ? 'is-active' : ''} onClick={() => props.onLabelFilter(type, query.trim())}>{type.replace('巡检点', '巡检')}</button>)}</div>
      </div>
      <div className="label-list">
        {props.labels.length === 0 && <EmptyState compact icon="tag" title={sceneReady ? '当前条件下无标签' : '场景加载后显示标签'}/>}
        {props.labels.map((label) => <button type="button" aria-pressed={label.id === props.selectedLabel?.id} key={label.id} className={`label-row${label.id === props.selectedLabel?.id ? ' is-selected' : ''}`} onClick={() => props.onSelectLabel(label.id)}><i className={`label-type-dot label-type-dot--${LABEL_TYPES.indexOf(label.type)}`}/><span><strong>{label.title}</strong><small>{label.type} · {label.position.x.toFixed(2)}, {label.position.y.toFixed(2)}, {label.position.z.toFixed(2)}</small></span>{label.inUse && <em>使用中</em>}</button>)}
      </div>
    </div>
  </UiContainer>;
};

export const InspectionCard = (props: AppShellProps) => {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setEditing(false); setConfirmDelete(false); }, [props.selectedLabel?.id, props.pendingSelection]);
  const pendingInitial = useMemo<LabelMetadata>(() => ({
    title: `巡检点_${props.labelTotal + 1}`, description: '', type: '一般巡检点'
  }), [props.pendingSelection, props.labelTotal]);
  if (props.pendingSelection) return <UiContainer as="aside" variant="floating" className="inspection-card" aria-label="初始化巡检点">
    <LabelEditor key={`${props.pendingSelection.position.x}:${props.pendingSelection.position.y}:${props.pendingSelection.position.z}`} initial={pendingInitial} creating selection={props.pendingSelection} startTypeAvailable={!props.startLabelId} onCancel={props.onCancelPending} onSave={props.onCreateLabel}/>
  </UiContainer>;
  const label = props.selectedLabel;
  if (!label) return null;
  return <UiContainer as="aside" variant="floating" className="inspection-card" aria-label="巡检点详情">
    {editing ? <LabelEditor initial={{ title: label.title, description: label.description, type: label.type }} creating={false} startTypeAvailable={!props.startLabelId || props.startLabelId === label.id} onCancel={() => setEditing(false)} onSave={(value) => { props.onUpdateLabel(label.id, value); setEditing(false); }}/>
      : <section className="label-detail">
        <div className="label-detail__head"><div><span>{label.type}</span><h2>{label.title}</h2></div><div className="card-head-actions"><Button size="compact" icon="edit" onClick={() => setEditing(true)}>编辑</Button><Button size="compact" tone="ghost" icon="close" aria-label="关闭巡检点卡片" onClick={props.onClearLabelSelection}>关闭</Button></div></div>
        {label.description && <p>{label.description}</p>}
        <dl><div><dt>坐标 / m</dt><dd>{label.position.x.toFixed(3)}, {label.position.y.toFixed(3)}, {label.position.z.toFixed(3)}</dd></div><div><dt>法向</dt><dd>{label.normal ? `${label.normal.x.toFixed(4)}, ${label.normal.y.toFixed(4)}, ${label.normal.z.toFixed(4)}` : '—'}</dd></div><div><dt>拟合邻域</dt><dd>{label.neighborCount?.toLocaleString('zh-CN') ?? '—'} 个前表面采样 · {label.selectionRadiusPixels ?? 5}px</dd></div></dl>
        {confirmDelete ? <div className="inline-confirm"><span>{label.inUse ? '标签正在被任务使用' : '删除后不可恢复'}</span><Button size="compact" onClick={() => setConfirmDelete(false)}>取消</Button><Button size="compact" tone="danger" disabled={label.inUse} onClick={() => props.onDeleteLabel(label.id)}>确认删除</Button></div>
          : <Button icon="trash" tone="ghost" disabled={label.inUse} onClick={() => setConfirmDelete(true)}>{label.inUse ? `被 ${label.usageCount} 处引用` : '删除标签'}</Button>}
      </section>}
  </UiContainer>;
};
