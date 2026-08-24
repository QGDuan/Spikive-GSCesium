import {
  createElement,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode
} from 'react';

export type IconName = 'database' | 'tag' | 'refresh' | 'upload' | 'eye' | 'cube' |
  'trash' | 'plus' | 'search' | 'pin' | 'edit' | 'close' | 'check' | 'route';

export const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ');

export const Icon = ({ name }: { name: IconName }) => {
  const paths: Record<IconName, ReactNode> = {
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    tag: <><path d="M20 13 13 20 4 11V4h7Z"/><circle cx="8.5" cy="8.5" r="1.2"/></>,
    refresh: <><path d="M20 6v5h-5"/><path d="M18.5 9A7.5 7.5 0 1 0 19 15"/></>,
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 20h16"/></>,
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
    cube: <><path d="m12 2 9 5-9 5-9-5Z"/><path d="m3 7 9 5 9-5v10l-9 5-9-5Z"/><path d="M12 12v10"/></>,
    trash: <><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    pin: <><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    edit: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10Z"/><path d="m13.5 6.5 3.5 3.5"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    route: <><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h3a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3h1"/></>
  };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
};

export const Button = ({ children, icon, tone = 'default', size = 'default', className, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: IconName;
    tone?: 'default' | 'primary' | 'danger' | 'active' | 'ghost';
    size?: 'default' | 'compact';
  }) => (
  <button {...props} className={cx('ui-button', `ui-button--${tone}`, size === 'compact' && 'ui-button--compact', className)}>
    {icon && <Icon name={icon}/>}<span>{children}</span>
  </button>
);

type ContainerElement = 'div' | 'section' | 'aside' | 'article' | 'header' | 'footer';

export const UiContainer = ({ as = 'section', variant = 'panel', className, children, ...props }:
  HTMLAttributes<HTMLElement> & {
    as?: ContainerElement;
    variant?: 'panel' | 'floating' | 'card' | 'subtle';
  }) => createElement(as, {
  ...props,
  className: cx('ui-container', `ui-container--${variant}`, className)
}, children);

export const StatusMark = ({ state, children }: {
  state: 'idle' | 'busy' | 'ready' | 'error';
  children: ReactNode;
}) => <span className={cx('ui-status', `ui-status--${state}`)}><i/>{children}</span>;

export const SectionHeading = ({ children, aside, className }: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) => <div className={cx('ui-section-heading', className)}><span>{children}</span>{aside && <small>{aside}</small>}</div>;

export const EmptyState = ({ icon, title, description, compact = false }: {
  icon: IconName;
  title: ReactNode;
  description?: ReactNode;
  compact?: boolean;
}) => <div className={cx('ui-empty', compact && 'ui-empty--compact')}><Icon name={icon}/><span>{title}</span>{description && <small>{description}</small>}</div>;
