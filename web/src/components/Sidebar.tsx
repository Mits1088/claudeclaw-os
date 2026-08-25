import { Link, useLocation } from 'wouter-preact';
import { Search, ChevronDown, X, Cpu } from 'lucide-preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { ROUTES, SECTION_LABEL, type RouteSection } from '@/lib/routes';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { commandPaletteOpen } from '@/lib/command-palette';
import { chatUnread } from '@/lib/chat-stream';
import { useFetch } from '@/lib/useFetch';
import { modelLabel } from '@/lib/modelLabels';
import { sidebarOpen, closeSidebar } from '@/lib/sidebar';
import {
  collapsedSections,
  toggleSectionCollapsed,
  runtimeDetailsCollapsed,
  toggleRuntimeDetailsCollapsed,
  workspaceName,
  modKeyLabel,
} from '@/lib/personalization';

const SECTIONS: RouteSection[] = ['workspace', 'intelligence', 'collaborate', 'configure'];

export function Sidebar() {
  const [pathname] = useLocation();
  const collapsed = collapsedSections.value;
  const modLabel = modKeyLabel();
  const open = sidebarOpen.value;

  // Mobile: fixed drawer that slides in from the left. Desktop (>=md):
  // always-visible inline column. Tailwind's `md:` prefix flips between
  // the two without extra JS.
  const asideClass = [
    'flex flex-col h-screen w-[280px] bg-[var(--color-sidebar)] border-r border-[var(--color-border)]',
    'fixed inset-y-0 left-0 z-50 transform transition-transform duration-200',
    open ? 'translate-x-0' : '-translate-x-full',
    'md:static md:translate-x-0 md:w-[260px] md:shrink-0',
  ].join(' ');

  return (
    <aside class={asideClass}>
      <WorkspaceSwitcher />

      {/* Mobile-only close button. Inline-flex with absolute position so
       *  it doesn't disturb the existing header layout. */}
      <button
        type="button"
        onClick={closeSidebar}
        class="md:hidden absolute top-3 right-3 p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
        aria-label="Close menu"
      >
        <X size={16} />
      </button>

      <button
        type="button"
        onClick={() => { commandPaletteOpen.value = true; closeSidebar(); }}
        class="mx-3 mt-1 mb-2 flex items-center gap-2 px-3 py-2 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors text-[13px]"
      >
        <Search size={15} />
        <span>Search</span>
        <span class="ml-auto text-[10.5px] text-[var(--color-text-faint)]">{modLabel}K</span>
      </button>

      <nav class="flex-1 overflow-y-auto px-2 pb-3">
        {SECTIONS.map((section) => {
          const items = ROUTES.filter((r) => r.section === section);
          if (items.length === 0) return null;
          const isCollapsed = collapsed.has(section);
          return (
            <div key={section} class="mt-3 first:mt-1">
              <button
                type="button"
                onClick={() => toggleSectionCollapsed(section)}
                class="w-full flex items-center gap-1.5 px-2.5 py-1.5 section-label hover:text-[var(--color-text-muted)] transition-colors group"
                aria-expanded={!isCollapsed}
              >
                <ChevronDown
                  size={11}
                  class="text-[var(--color-text-faint)] transition-transform"
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                />
                <span>{SECTION_LABEL[section]}</span>
              </button>
              {!isCollapsed && items.map((r) => {
                const active = pathname === r.path || (pathname === '/' && r.path === '/mission');
                const Icon = r.icon;
                const unread = r.path === '/chat' ? chatUnread.value : 0;
                return (
                  <Link
                    key={r.path}
                    href={r.path}
                    onClick={closeSidebar}
                    class={[
                      'flex items-center gap-2.5 px-3 py-2 rounded-md text-[14px] transition-colors',
                      active
                        ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                        : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)]',
                    ].join(' ')}
                  >
                    <Icon size={16} />
                    <span class="flex-1">{r.label}</span>
                    {unread > 0 && (
                      <span class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-semibold tabular-nums bg-[var(--color-accent)] text-white">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <SidebarFooter />
    </aside>
  );
}

interface Health {
  killSwitches: Record<string, boolean>;
  uptimeSeconds?: number;
}

interface ProviderStatus {
  providerType: 'claude' | 'opencode' | 'openrouter' | 'gemini' | 'acp-codex' | 'openai' | 'acp' | 'anthropic-compatible';
  label: string;
  model: string;
  runtime: string;
  // Short reasoning descriptor (e.g. "high", "off"). Empty when the model uses
  // adaptive thinking and exposes no dial.
  reasoning?: string;
}

// "2d 4h", "3h 12m", "18m", "42s" — two units max, coarse-first.
function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function SidebarFooter() {
  const health = useFetch<Health>('/api/health', 30_000);
  const provider = useFetch<ProviderStatus>('/api/provider/status', 15_000);
  const switches = health.data?.killSwitches || {};
  const off = Object.entries(switches).filter(([, on]) => !on);
  const anyOff = off.length > 0;
  const name = workspaceName.value;
  const providerName = provider.data?.label ?? 'Claude';
  const modelName = modelLabel(provider.data?.model ?? 'claude-opus-4-8');
  const reasoning = provider.data?.reasoning?.trim();
  // Combine model + thinking as "Opus 4.8 (high)". Omit the clause for models
  // that expose no dial (adaptive thinking).
  const modelWithReasoning = reasoning ? `${modelName} (${reasoning})` : modelName;
  const collapsed = runtimeDetailsCollapsed.value;

  // The /api/health poll only refreshes every 30s, so the raw uptime sits
  // frozen between polls. Anchor the last server value to the moment it landed
  // and advance it locally on a 30s tick so the line reads as live.
  const rawUptime = health.data?.uptimeSeconds;
  const anchor = useRef<{ base: number; at: number } | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (rawUptime == null) return;
    anchor.current = { base: rawUptime, at: Date.now() };
    forceTick((n) => n + 1);
  }, [rawUptime]);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const liveUptime = anchor.current
    ? anchor.current.base + Math.floor((Date.now() - anchor.current.at) / 1000)
    : null;
  const uptime = liveUptime != null ? formatUptime(liveUptime) : null;

  return (
    <div class="border-t border-[var(--color-border)]">
      {/* The block navigates to Settings (where provider/model are configured).
       *  The collapse chevron is an absolutely-positioned sibling — not nested
       *  inside the <a> — so toggling details never triggers navigation and the
       *  markup stays valid. */}
      <div class="relative">
        <Link
          href="/settings"
          aria-label="Active runtime"
          title="Provider and model are configured under Agents or Settings"
          class="block px-3 py-3 hover:bg-[var(--color-elevated)] transition-colors"
        >
          {/* Identity header: the Cpu icon replaces the old status dot and
           *  carries the kill-switch signal via its tint. Right padding leaves
           *  room for the collapse chevron. */}
          <div class="flex items-center gap-2.5 pr-6">
            <div
              class="h-8 w-8 shrink-0 rounded-md border border-[var(--color-border)] flex items-center justify-center"
              style={{
                backgroundColor: anyOff
                  ? 'color-mix(in srgb, var(--color-status-failed) 18%, transparent)'
                  : 'var(--color-elevated)',
                color: anyOff ? 'var(--color-status-failed)' : 'var(--color-text-muted)',
              }}
            >
              <Cpu size={14} />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[12.5px] font-medium text-[var(--color-text)] truncate">{name}</div>
              <div class="truncate text-[11px] text-[var(--color-text-faint)]">
                {anyOff
                  ? off.length + ' kill switch' + (off.length === 1 ? '' : 'es') + ' off'
                  : 'All systems normal'}
              </div>
            </div>
          </div>

          {!collapsed && (
            <>
              <div class="mt-2.5 flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[11px] leading-none">
                <span class="text-[var(--color-text-faint)]">Runtime</span>
                <span class="min-w-0 max-w-[160px] truncate text-right font-medium text-[var(--color-text-muted)]" title={providerName}>
                  {providerName}
                </span>
              </div>
              <div class="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[11px] leading-none">
                <span class="text-[var(--color-text-faint)]">Model</span>
                <span class="min-w-0 max-w-[160px] truncate text-right font-medium text-[var(--color-text-muted)]" title={modelWithReasoning}>
                  {modelWithReasoning}
                </span>
              </div>
              {uptime && (
                <div class="mt-1.5 flex items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-[11px] leading-none">
                  <span class="text-[var(--color-text-faint)]">Uptime</span>
                  <span class="font-medium tabular-nums text-[var(--color-text-muted)]">{uptime}</span>
                </div>
              )}
            </>
          )}
        </Link>

        <button
          type="button"
          onClick={toggleRuntimeDetailsCollapsed}
          class="absolute top-3 right-2 p-1 rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)] transition-colors"
          aria-label={collapsed ? 'Show runtime details' : 'Hide runtime details'}
          aria-expanded={!collapsed}
        >
          <ChevronDown
            size={14}
            class="transition-transform"
            style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          />
        </button>
      </div>
    </div>
  );
}
