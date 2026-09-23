import { useEffect, useState, useMemo } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import { Brain as BrainIcon, Box, List as ListIcon } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { StatusDot } from '@/components/Pill';
import { PrivacyToggle } from '@/components/PrivacyToggle';
import { BrainGraph } from '@/components/BrainGraph';
import { useFetch } from '@/lib/useFetch';
import { formatRelativeTime, resolveAgentName, seedAgentNames } from '@/lib/format';
import { privacyBlur } from '@/lib/privacy';
import { hasWebGL } from '@/lib/webgl';
import { useAgentQuery } from '@/lib/agentQuery';

// Lazy-load 3D so the ~150KB three.js bundle only ships when the user
// flips to the 3D view. Default 2D path stays cheap.
const BrainGraph3D = lazy(() =>
  import('@/components/BrainGraph3D').then((m) => ({ default: m.BrainGraph3D })),
);

interface HiveEntry {
  id: number;
  agent_id: string;
  chat_id: string;
  action: string;
  summary: string;
  artifacts: string | null;
  created_at: number;
}

interface HiveAgent { id: string; name?: string; running?: boolean; }

const AGENT_HUE: Record<string, string> = {
  main: 'var(--color-accent)',
  research: '#5eb6ff',
  comms: '#10b981',
  content: '#f59e0b',
  ops: '#a78bfa',
};

const VIEW_KEY = 'claudeclaw.hive.view';
type ViewMode = 'brain2d' | 'brain3d' | 'activity';

function loadView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'brain2d' || v === 'brain3d' || v === 'activity') return v;
    // Migrate the old 'brain' value to 'brain2d'.
    if (v === 'brain') return 'brain2d';
  } catch {}
  return 'brain2d';
}

export function HiveMind() {
  const [filter, setFilter] = useAgentQuery();
  const [view, setView] = useState<ViewMode>(loadView());
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const agentList = useFetch<{ agents: HiveAgent[] }>('/api/agents', 60_000);
  // Seed the global name cache whenever we get an agents response.
  useEffect(() => {
    if (agentList.data?.agents) seedAgentNames(agentList.data.agents);
  }, [agentList.data]);
  const path = filter === 'all'
    ? '/api/hive-mind?limit=200'
    : `/api/hive-mind?agent=${encodeURIComponent(filter)}&limit=200`;
  const { data, loading, error } = useFetch<{ entries: HiveEntry[] }>(path, 30_000);
  const entries = data?.entries ?? [];
  const allAgents: HiveAgent[] = agentList.data?.agents ?? [...new Set(entries.map((entry) => entry.agent_id))].map((id) => ({ id }));
  const blurOn = !!privacyBlur('hive').value;

  // Resolve to 2D if user requested 3D but the browser can't do WebGL.
  const webgl = useMemo(() => hasWebGL(), []);
  const effectiveView: ViewMode = view === 'brain3d' && !webgl ? 'brain2d' : view;
  // One-time hint when we silently downgraded.
  const downgraded = view === 'brain3d' && !webgl;

  function setViewPersisted(v: ViewMode) {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch {}
  }

  function toggleRow(id: number) {
    if (!blurOn) return;
    const next = new Set(revealed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setRevealed(next);
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Hive Mind"
        actions={
          <>
            <PrivacyToggle section="hive" />
            <ViewSwitcher view={view} onChange={setViewPersisted} webglAvailable={webgl} />
          </>
        }
      />
      <HiveToolbar
        agents={allAgents}
        activeAgent={filter}
        onAgentChange={setFilter}
        loadingAgents={agentList.loading && !agentList.data}
        entries={entries}
        loadingEntries={loading}
      />
      {downgraded && (
        <div class="px-6 py-2 text-[11px] text-[var(--color-text-muted)] bg-[var(--color-elevated)] border-b border-[var(--color-border)]">
          WebGL isn't available on this device. Showing the 2D brain instead.
        </div>
      )}
      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}
      {!loading && !error && entries.length === 0 && (
        <PageState
          empty
          emptyTitle="No activity yet"
          emptyDescription="Every agent action — Telegram messages, delegated tasks, memory consolidations, kill-switch refusals — lands here as it happens."
        />
      )}

      {entries.length > 0 && effectiveView === 'brain2d' && (
        <BrainGraph
          entries={entries}
          agentFilter={filter}
          agentColors={AGENT_HUE}
          blurOn={blurOn}
        />
      )}

      {entries.length > 0 && effectiveView === 'brain3d' && (
        <Suspense fallback={
          <div class="flex-1 flex items-center justify-center text-[12px] text-[var(--color-text-muted)]">
            Loading 3D engine…
          </div>
        }>
          <BrainGraph3D
            entries={entries}
            agentFilter={filter}
            agentColors={AGENT_HUE}
            blurOn={blurOn}
          />
        </Suspense>
      )}

      {entries.length > 0 && effectiveView === 'activity' && (
        <div class="flex-1 overflow-y-auto">
          <table class="w-full text-[12px]">
            <thead class="sticky top-0 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
              <tr class="text-left">
                <th class="px-6 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[12%]">When</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[12%]">Agent</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[14%]">Action</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Summary</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} class="border-b border-[var(--color-border)] hover:bg-[var(--color-control-hover)] transition-colors">
                  <td class="px-6 py-2 text-[var(--color-text-faint)] tabular-nums whitespace-nowrap">
                    {formatRelativeTime(e.created_at)}
                  </td>
                  <td class="px-3 py-2">
                    <span class="inline-flex items-center gap-1.5" style={{ color: AGENT_HUE[e.agent_id] || 'var(--color-text-muted)' }}>
                      <span class="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
                      {resolveAgentName(e.agent_id)}
                    </span>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-[var(--color-text-muted)]">{e.action}</td>
                  <td class="px-3 py-2 text-[var(--color-text)] truncate max-w-0">
                    <span
                      class={[blurOn ? 'privacy-blur' : '', revealed.has(e.id) ? 'revealed' : ''].filter(Boolean).join(' ')}
                      onClick={(ev) => { ev.stopPropagation(); toggleRow(e.id); }}
                    >
                      {e.summary}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function HiveToolbar({ agents, activeAgent, onAgentChange, loadingAgents, entries, loadingEntries }: {
  agents: HiveAgent[];
  activeAgent: string;
  onAgentChange: (agentId: string) => void;
  loadingAgents: boolean;
  entries: HiveEntry[];
  loadingEntries: boolean;
}) {
  const selected = agents.find((agent) => agent.id === activeAgent);
  const onlineAgents = agents.filter((agent) => agent.running === true);
  const offlineAgents = agents.filter((agent) => agent.running === false);
  const unknownAgents = agents.filter((agent) => typeof agent.running !== 'boolean');
  const statusKnown = activeAgent === 'all'
    ? agents.length > 0 && unknownAgents.length === 0
    : typeof selected?.running === 'boolean';
  const isOnline = activeAgent === 'all' ? onlineAgents.length > 0 : selected?.running === true;
  const latestEntry = entries.reduce((latest, entry) => Math.max(latest, entry.created_at), 0);
  const inputClass = 'toolbar-control rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';

  return <div class="page-toolbar shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]" aria-label="Hive Mind filters">
    <label class="flex items-center gap-2 min-w-0">
      <span class="text-[13px] text-[var(--color-text-muted)]">Agent</span>
      <select value={activeAgent} onChange={(event) => onAgentChange(event.currentTarget.value)}
        aria-label="Filter Hive Mind by agent" class={`${inputClass} w-[min(260px,60vw)] min-w-[150px] px-2.5`}>
        <option value="all">All agents</option>
        {[
          { label: 'Online', agents: onlineAgents },
          { label: 'Offline', agents: offlineAgents },
          { label: 'Status unavailable', agents: unknownAgents },
        ].filter((group) => group.agents.length).map((group) => <optgroup key={group.label} label={group.label}>
          {group.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name || resolveAgentName(agent.id)}</option>)}
        </optgroup>)}
        {activeAgent !== 'all' && !selected && <option value={activeAgent}>{resolveAgentName(activeAgent)}</option>}
      </select>
    </label>

    <span aria-label="Agent status" class="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)] whitespace-nowrap">
      <StatusDot tone={statusKnown && isOnline ? 'done' : 'cancelled'} />
      {loadingAgents ? 'Loading agents…' : !statusKnown ? 'Status unavailable' : activeAgent === 'all'
        ? `${onlineAgents.length} of ${agents.length} online`
        : isOnline ? 'Online' : 'Offline'}
    </span>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[var(--color-text-faint)] tabular-nums sm:ml-auto">
      <span title="Up to 200 most recent entries for the selected agents"><span class="uppercase tracking-wider">Entries</span> <span class="text-[var(--color-text-muted)]">{loadingEntries ? '…' : entries.length}</span></span>
      {latestEntry > 0 && <span><span class="uppercase tracking-wider">Latest entry</span> <span class="text-[var(--color-text-muted)]">{formatRelativeTime(latestEntry)}</span></span>}
    </div>
  </div>;
}

function ViewSwitcher({
  view, onChange, webglAvailable,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
  webglAvailable: boolean;
}) {
  return (
    <div class="toolbar-segmented">
      <ViewBtn icon={<BrainIcon size={13} />} title="2D brain" active={view === 'brain2d'} onClick={() => onChange('brain2d')} />
      <ViewBtn
        icon={<Box size={13} />}
        title={webglAvailable ? '3D brain' : '3D brain (WebGL not available)'}
        active={view === 'brain3d'}
        onClick={() => onChange('brain3d')}
        disabled={!webglAvailable}
      />
      <ViewBtn icon={<ListIcon size={13} />} title="Activity table" active={view === 'activity'} onClick={() => onChange('activity')} />
    </div>
  );
}

function ViewBtn({
  icon, title, active, onClick, disabled,
}: {
  icon: any;
  title: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      class={[
        'toolbar-control toolbar-icon control-button inline-flex items-center justify-center transition-colors',
        active ? 'control-accent' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
        disabled ? 'opacity-30 cursor-not-allowed' : '',
      ].join(' ')}
    >
      {icon}
    </button>
  );
}
