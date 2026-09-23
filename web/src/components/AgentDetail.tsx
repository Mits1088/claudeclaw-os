import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { Camera, Trash2, ExternalLink, LayoutGrid, List } from 'lucide-preact';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Pill } from '@/components/Pill';
import { Tab } from '@/components/PageHeader';
import { useFetch } from '@/lib/useFetch';
import { formatRelativeTime, formatCost } from '@/lib/format';
import { chatId, dashboardToken } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { showCosts } from '@/lib/theme';
import { modelLabel } from '@/lib/modelLabels';
import { describeCron } from '@/lib/cron';

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  model: string;
  running: boolean;
  todayTurns: number;
  todayCost: number;
}

interface ConvoTurn { role: 'user' | 'assistant'; content: string; created_at?: number; }
interface ScheduledTask { id: string; prompt: string; schedule: string; next_run: number; status: string; last_status: string | null; }
interface HiveEntry { id: number; action: string; summary: string; created_at: number; }
interface AgentTokens { todayCost: number; todayTurns: number; allTimeCost: number; }

export function AgentOverview({ agent, onBusyChange }: { agent: AgentSummary; onBusyChange: (busy: boolean) => void }) {
  return <div class="space-y-5"><AvatarSettings agent={agent} onBusyChange={onBusyChange} /><OverviewTab agent={agent} /></div>;
}

type ActivityView = 'list' | 'grid';
const ACTIVITY_VIEW_KEY = 'claudeclaw.agentActivity.view';
const activitySections = [
  { id: 'chat', label: 'Chat', path: '/chat' },
  { id: 'tasks', label: 'Scheduled', path: '/scheduled' },
  { id: 'hive', label: 'Hive Mind', path: '/hive' },
] as const;

function loadActivityView(): ActivityView {
  try { return localStorage.getItem(ACTIVITY_VIEW_KEY) === 'grid' ? 'grid' : 'list'; }
  catch { return 'list'; }
}

export function AgentActivity({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [activeTab, setActiveTab] = useState<typeof activitySections[number]['id']>('chat');
  const [view, setView] = useState<ActivityView>(loadActivityView);
  const section = activitySections.find((item) => item.id === activeTab)!;
  const href = `${section.path}?agent=${encodeURIComponent(agentId)}`;
  function changeView(next: ActivityView) {
    setView(next);
    try { localStorage.setItem(ACTIVITY_VIEW_KEY, next); } catch {}
  }
  return (
    <div class="agent-activity">
      <div class="page-toolbar flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] mb-4 pb-3">
        <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Activity sections">
          {activitySections.map((item) => <Tab key={item.id} label={item.label} active={activeTab === item.id} onClick={() => setActiveTab(item.id)} />)}
        </div>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <Link href={href} class="toolbar-control control-button gap-1.5 px-3 rounded-md text-[var(--color-control-text)] hover:bg-[var(--color-control-hover)]"
            aria-label={`Open ${section.label} for ${agentName}`} title={`Open ${section.label} with ${agentName} selected`}>
            Open {section.label}<ExternalLink size={13} />
          </Link>
          <div class="toolbar-segmented" role="group" aria-label="Activity layout">
            <button type="button" aria-label="Grid view" title="Grid view" aria-pressed={view === 'grid'} onClick={() => changeView('grid')}
              class={`toolbar-control toolbar-icon control-button ${view === 'grid' ? 'control-accent' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]'}`}><LayoutGrid size={14} /></button>
            <button type="button" aria-label="List view" title="List view" aria-pressed={view === 'list'} onClick={() => changeView('list')}
              class={`toolbar-control toolbar-icon control-button ${view === 'list' ? 'control-accent' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]'}`}><List size={14} /></button>
          </div>
        </div>
      </div>

      {activeTab === 'chat' && <ConversationTab agentId={agentId} view={view} />}
      {activeTab === 'tasks' && <TasksTab agentId={agentId} view={view} />}
      {activeTab === 'hive' && <HiveTab agentId={agentId} view={view} />}
    </div>
  );
}

function AvatarSettings({ agent, onBusyChange }: { agent: AgentSummary; onBusyChange: (busy: boolean) => void }) {
  // Cache-bust the avatar by bumping a counter every time we upload or
  // delete — the AgentAvatar component reads `?token=...` only and
  // would otherwise serve the stale cached image.
  const [avatarVersion, setAvatarVersion] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  async function pickAndUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      pushToast({ tone: 'error', title: 'Image too large', description: 'Max 5 MB.', durationMs: 6000 });
      input.value = '';
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('image', file);
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/avatar?token=${encodeURIComponent(dashboardToken)}`, {
        method: 'PUT',
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error || `HTTP ${res.status}`);
      }
      setAvatarVersion((v) => v + 1);
      pushToast({
        tone: 'success',
        title: 'Avatar updated',
        description: 'Telegram propagation needs @BotFather → /setuserpic on your phone.',
        durationMs: 8000,
      });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Upload failed', description: err?.message || String(err), durationMs: 7000 });
    } finally {
      setBusy(false);
      input.value = '';
    }
  }

  async function clearAvatar() {
    if (!confirm(`Remove the custom avatar for ${agent.id}? The dashboard will fall back to Telegram's avatar (if set) or initials.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/avatar?token=${encodeURIComponent(dashboardToken)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error || `HTTP ${res.status}`);
      }
      setAvatarVersion((v) => v + 1);
      pushToast({ tone: 'success', title: 'Avatar removed' });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Delete failed', description: err?.message || String(err), durationMs: 7000 });
    } finally { setBusy(false); }
  }

  function openBotFather() {
    // Deep-links to BotFather in the Telegram app (or web) so the user
    // can finish the loop with /setuserpic. The actual upload to
    // BotFather can't be automated via the Bot API.
    window.open('https://t.me/BotFather', '_blank', 'noreferrer');
  }

  return (
    <div class="flex items-start gap-4 rounded-lg border border-[var(--color-border)] p-4">
      <div class="relative shrink-0 group">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          class="relative block rounded-full focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none disabled:opacity-50"
          title="Change avatar"
        >
          {/* cacheBust appends ?v=<n> to the avatar URL so the browser
              skips its 1h HTTP cache and refetches after upload/delete.
              Without this, the new image bytes are on disk but every
              IMG element across the dashboard keeps showing the old
              cached PNG until the cache expires. */}
          <AgentAvatar
            agentId={agent.id}
            name={agent.name}
            running={agent.running}
            size={56}
            cacheBust={avatarVersion}
          />
          <span class="absolute inset-0 rounded-full flex items-center justify-center bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity">
            <Camera size={16} />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={pickAndUpload}
          class="hidden"
        />
      </div>
      <div class="flex-1 min-w-0">
        <h3 class="text-[13px] font-medium text-[var(--color-text)]">Profile image</h3>
        <p class="text-[12px] text-[var(--color-text-muted)] mt-1">Personalize how this agent appears in your workspace.</p>
        <div class="flex flex-wrap items-center gap-2 mt-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] border border-[var(--color-border)] transition-colors disabled:opacity-40"
          >
            <Camera size={11} /> {busy ? 'Working…' : 'Change avatar'}
          </button>
          <button
            type="button"
            onClick={clearAvatar}
            disabled={busy}
            class="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] border border-[var(--color-border)] hover:border-[var(--color-status-failed)] transition-colors disabled:opacity-40"
            title="Remove custom avatar (revert to Telegram or initials)"
          >
            <Trash2 size={11} />
          </button>
          <button
            type="button"
            onClick={openBotFather}
            class="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors"
            title="Telegram bot avatars can only be set via @BotFather → /setuserpic"
          >
            Set on Telegram <ExternalLink size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ agent }: { agent: AgentSummary }) {
  const tokens = useFetch<AgentTokens>(`/api/agents/${agent.id}/tokens`);
  const costsOn = showCosts.value;
  return (
    <div class="space-y-3">
      <div class={(costsOn ? 'sm:grid-cols-3' : 'grid-cols-1') + ' grid gap-2'}>
        <Kpi label="Today turns" value={String(agent.todayTurns)} />
        {costsOn && <Kpi label="Today cost" value={formatCost(agent.todayCost)} />}
        {costsOn && <Kpi label="Lifetime cost" value={formatCost(tokens.data?.allTimeCost || 0)} />}
      </div>
      <Section label="Configuration">
        <Row label="Model"><Pill tone="neutral">{modelLabel(agent.model)}</Pill></Row>
      </Section>
    </div>
  );
}

interface ActivityPanelProps { agentId: string; view: ActivityView; }

function ConversationTab({ agentId, view }: ActivityPanelProps) {
  const { data, loading, error } = useFetch<{ turns: ConvoTurn[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/conversation?chatId=${encodeURIComponent(chatId)}&limit=10`,
  );
  const turns = data?.turns ?? [];

  if (loading) return <Loading />;
  if (error) return <ErrorBlock error={error} />;
  if (turns.length === 0) return <Empty text="No chat history yet. Open Chat to start a conversation." />;

  return (
    <ActivityList view={view} columns={['When', 'From', 'Message']} count={turns.length} noun="recent messages">
      {turns.map((t, i) => (
        <ActivityItem key={i} when={t.created_at ? formatRelativeTime(t.created_at) : 'Recent'}
          label={<Pill tone={t.role === 'user' ? 'accent' : 'neutral'}>{t.role === 'user' ? 'You' : 'Agent'}</Pill>}
          summary={t.content} />
      ))}
    </ActivityList>
  );
}

function TasksTab({ agentId, view }: ActivityPanelProps) {
  const { data, loading, error } = useFetch<{ tasks: ScheduledTask[] }>(`/api/agents/${encodeURIComponent(agentId)}/tasks`);
  const tasks = data?.tasks ?? [];

  if (loading) return <Loading />;
  if (error) return <ErrorBlock error={error} />;
  if (tasks.length === 0) return <Empty text={`No scheduled tasks for ${agentId}.`} />;

  return (
    <ActivityList view={view} columns={['Status', 'Schedule', 'Prompt']} count={tasks.length} noun="scheduled tasks">
      {tasks.map((t) => (
        <ActivityItem key={t.id}
          when={<Pill tone={t.status === 'paused' ? 'cancelled' : t.status === 'running' ? 'running' : 'done'}>{t.status}</Pill>}
          label={describeCron(t.schedule).text} summary={t.prompt}
          detail={<>
            <span>{t.status === 'paused' ? 'Paused' : t.status === 'running' ? 'Running now' : t.next_run ? `Next: ${new Date(t.next_run * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Next run not set'}</span>
            {t.last_status && <Pill tone={t.last_status === 'success' ? 'done' : 'failed'}>Last: {t.last_status}</Pill>}
          </>} />
      ))}
    </ActivityList>
  );
}

function HiveTab({ agentId, view }: ActivityPanelProps) {
  const { data, loading, error } = useFetch<{ entries: HiveEntry[] }>(`/api/hive-mind?agent=${encodeURIComponent(agentId)}&limit=30`);
  const entries = data?.entries ?? [];

  if (loading) return <Loading />;
  if (error) return <ErrorBlock error={error} />;
  if (entries.length === 0) return <Empty text={`No hive mind activity for ${agentId} yet.`} />;

  return (
    <ActivityList view={view} columns={['When', 'Activity', 'Summary']} count={entries.length} noun="recent entries">
      {entries.map((e) => (
        <ActivityItem key={e.id} when={formatRelativeTime(e.created_at)} label={e.action.replace(/[_-]+/g, ' ')} summary={e.summary} />
      ))}
    </ActivityList>
  );
}

function ActivityList({ view, columns, count, noun, children }: {
  view: ActivityView; columns: [string, string, string]; count: number; noun: string; children: ComponentChildren;
}) {
  return <div class={`activity-results is-${view}`}>
    <p class="mb-2 text-[11px] text-[var(--color-text-muted)]">{count} {noun}</p>
    {view === 'list' && <div class="activity-list-head" aria-hidden="true">{columns.map((label) => <span key={label}>{label}</span>)}</div>}
    <ul class="activity-items" aria-label={noun}>{children}</ul>
  </div>;
}

function ActivityItem({ when, label, summary, detail }: {
  when: ComponentChildren; label: ComponentChildren; summary: string; detail?: ComponentChildren;
}) {
  return <li class="min-w-0">
    <div class="activity-item">
      <span class="activity-when">{when}</span>
      <span class="activity-label">{label}</span>
      <span class="activity-content">
        <span class="activity-summary">{summary}</span>
        {detail && <span class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">{detail}</span>}
      </span>
    </div>
  </li>;
}

// ── Tiny helpers ───────────────────────────────────────────────────

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-2.5">
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-0.5">{label}</div>
      <div class="text-[15px] font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
    </div>
  );
}

function Section({ label, children }: any) {
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1.5">{label}</div>
      <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3 space-y-1.5">
        {children}
      </div>
    </div>
  );
}

function Row({ label, children }: any) {
  return (
    <div class="flex items-center justify-between text-[12px]">
      <span class="text-[var(--color-text-muted)]">{label}</span>
      {children}
    </div>
  );
}

function Loading() { return <div class="text-[11px] text-[var(--color-text-faint)] py-6 text-center">Loading…</div>; }
function Empty({ text }: { text: string }) { return <div class="text-[11.5px] text-[var(--color-text-faint)] py-8 text-center">{text}</div>; }
function ErrorBlock({ error }: { error: string }) {
  return (
    <div class="text-[var(--color-status-failed)] text-[11.5px] font-mono p-3 bg-[var(--color-elevated)] border border-[var(--color-status-failed)] rounded">
      {error}
    </div>
  );
}
