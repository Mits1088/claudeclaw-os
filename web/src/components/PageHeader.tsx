import type { ComponentChildren } from 'preact';

export interface PageHeaderProps {
  title: string;
  breadcrumb?: string;
  actions?: ComponentChildren;
  tabs?: ComponentChildren;
}

export function PageHeader({ title, breadcrumb, actions, tabs }: PageHeaderProps) {
  return (
    <div class="shrink-0 min-w-0 border-b border-[var(--color-border)]">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3">
        {breadcrumb && (
          <div class="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
            <span>{breadcrumb}</span>
            <span class="text-[var(--color-text-faint)]">›</span>
          </div>
        )}
        <h1 class="text-[14px] font-semibold text-[var(--color-text)]">{title}</h1>
        {actions && <div class="page-header-actions ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
      {tabs && (
        <div class="page-toolbar flex items-center gap-1 px-6 pb-2 overflow-x-auto">{tabs}</div>
      )}
    </div>
  );
}

export interface TabProps {
  label: string;
  active?: boolean;
  count?: number;
  onClick?: () => void;
}

export function Tab({ label, active, count, onClick }: TabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active === true}
      class={[
        'toolbar-control control-button shrink-0 whitespace-nowrap px-3 rounded-md transition-colors flex items-center gap-1.5',
        active
          ? 'control-accent'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]',
      ].join(' ')}
    >
      {label}
      {typeof count === 'number' && (
        <span class="text-[10px] text-[var(--color-text-faint)] tabular-nums">{count}</span>
      )}
    </button>
  );
}
