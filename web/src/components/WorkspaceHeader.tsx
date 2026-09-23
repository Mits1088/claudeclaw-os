import { workspaceName } from '@/lib/personalization';

export function WorkspaceHeader() {
  const name = workspaceName.value;

  return (
    <div class="px-3 pt-3 pb-1">
      <div class="flex items-center gap-2 pl-2 pr-12 md:pr-2 py-2">
        <div
          aria-hidden="true"
          class="w-6 h-6 rounded shrink-0 border border-[var(--color-border)]"
          style={{
            background: 'linear-gradient(135deg, var(--color-accent) 0%, var(--color-elevated) 100%)',
          }}
        />
        <span class="min-w-0 text-[14px] font-semibold text-[var(--color-text)] truncate" title={name}>
          {name}
        </span>
      </div>
    </div>
  );
}
