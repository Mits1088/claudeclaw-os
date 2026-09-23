import { useMemo, useState } from 'preact/hooks';
import { ChevronDown, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { apiDelete } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import {
  filterMissionHistory,
  sortMissionHistory,
  type MissionHistoryOutcome,
  type MissionHistoryTask,
} from '@/lib/missionHistory';

export type { MissionHistoryTask } from '@/lib/missionHistory';

interface MissionHistoryListProps {
  tasks: MissionHistoryTask[];
  onChange: () => void;
  showAgent?: boolean;
  emptyMessage?: string;
  initialLimit?: number;
}

interface MissionHistoryArchiveProps {
  tasks: MissionHistoryTask[];
  agents: Array<{ id: string; name: string }>;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function outcomeTone(status: MissionHistoryTask['status']): 'done' | 'failed' | 'cancelled' {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'blocked') return 'failed';
  return 'cancelled';
}

function outcomeColor(status: MissionHistoryTask['status']): string {
  if (status === 'completed') return 'var(--color-status-done)';
  if (status === 'failed' || status === 'blocked') return 'var(--color-status-failed)';
  return 'var(--color-text-faint)';
}

function completionTime(task: MissionHistoryTask): number {
  return task.completed_at ?? task.created_at;
}

function exactDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function MissionHistoryEntry({
  task,
  showAgent,
  agentNames,
  onChange,
}: {
  task: MissionHistoryTask;
  showAgent: boolean;
  agentNames?: ReadonlyMap<string, string>;
  onChange: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const timestamp = completionTime(task);
  const agentName = task.assigned_agent
    ? agentNames?.get(task.assigned_agent) ?? task.assigned_agent
    : 'Unassigned';
  const canDelete = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';

  async function deleteTask() {
    if (!confirmingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await apiDelete<{ ok: boolean }>(`/api/mission/tasks/${task.id}`);
      if (!response.ok) {
        setDeleteError('The task was not deleted. Try again.');
        return;
      }
      onChange();
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : 'The task could not be deleted.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <details
      class="group overflow-hidden rounded-md border border-l-2 border-[var(--color-border)] bg-[var(--color-elevated)]"
      style={{ borderLeftColor: outcomeColor(task.status) }}
    >
      <summary class="flex min-w-0 cursor-pointer list-none items-start gap-2.5 px-2.5 py-2 outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--color-text)_3%,transparent)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] [&::-webkit-details-marker]:hidden">
        <div class="min-w-0 flex-1">
          <div class="line-clamp-2 break-words text-[12px] font-medium leading-snug text-[var(--color-text)] [overflow-wrap:anywhere]">
            {task.title}
          </div>
          <div class="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--color-text-faint)]">
            <Pill tone={outcomeTone(task.status)}>{task.status}</Pill>
            {showAgent && <span class="min-w-0 truncate">{task.assigned_agent ? `@${agentName}` : agentName}</span>}
            <time dateTime={new Date(timestamp * 1000).toISOString()} title={exactDate(timestamp)}>
              {formatRelativeTime(timestamp)}
            </time>
          </div>
        </div>
        <ChevronDown
          size={13}
          aria-hidden="true"
          class="mt-0.5 shrink-0 text-[var(--color-text-faint)] transition-transform group-open:rotate-180"
        />
      </summary>

      <div class="select-text border-t border-[var(--color-border)] px-2.5 py-2.5 text-[11px] leading-relaxed">
        <HistoryText label="Task title" value={task.title} />
        <HistoryText label="Prompt" value={task.prompt} mono />
        {task.result && <HistoryText label="Result" value={task.result} />}
        {task.error && <HistoryText label="Error" value={task.error} tone="failed" mono />}
        <div class="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--color-text-faint)]">
          <span class="font-mono">ID {task.id}</span>
          <span>{task.completed_at !== null ? 'Finished' : 'Recorded'} {exactDate(timestamp)}</span>
          <span>Created by {task.created_by || 'dashboard'}</span>
          {task.priority > 0 && <span>Priority {task.priority}</span>}
        </div>
        <div class="mt-2.5 border-t border-[var(--color-border)] pt-2.5">
          {canDelete ? (
            confirmingDelete ? (
              <div role="group" aria-label={`Confirm deletion of ${task.title}`} class="space-y-2">
                <p class="text-[11px] text-[var(--color-text-muted)]">Permanently delete this task from history?</p>
                <div class="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void deleteTask()} disabled={deleting} class="rounded-md border border-[var(--color-status-failed)] px-2 py-1 text-[10.5px] text-[var(--color-status-failed)] disabled:opacity-45">
                    {deleting ? 'Deleting…' : 'Delete permanently'}
                  </button>
                  <button type="button" onClick={() => { setConfirmingDelete(false); setDeleteError(null); }} disabled={deleting} class="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10.5px] text-[var(--color-text-muted)] disabled:opacity-45">Keep task</button>
                </div>
              </div>
            ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleting}
              class="inline-flex select-none items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[10.5px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-status-failed)] hover:text-[var(--color-status-failed)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-wait disabled:opacity-45"
            >
              <Trash2 size={11} aria-hidden="true" />
              {deleting ? 'Deleting…' : 'Delete task'}
            </button>
            )
          ) : task.status === 'blocked' ? (
            <p class="text-[10.5px] text-[var(--color-text-faint)]">
              Legacy blocked records are read-only and cannot be deleted.
            </p>
          ) : null}
          {deleteError && (
            <p role="alert" class="mt-2 break-words text-[10.5px] text-[var(--color-status-failed)] [overflow-wrap:anywhere]">
              {deleteError}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

function HistoryText({
  label,
  value,
  mono = false,
  tone = 'default',
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'default' | 'failed';
}) {
  return (
    <section class="mb-2.5 last:mb-0">
      <div class="mb-1 text-[10px] font-medium text-[var(--color-text-faint)]">{label}</div>
      <div
        class={[
          'whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
          mono ? 'font-mono' : '',
          tone === 'failed' ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-muted)]',
        ].join(' ')}
      >
        {value}
      </div>
    </section>
  );
}

function HistoryEntries({
  history,
  showAgent,
  emptyMessage,
  initialLimit,
  agentNames,
  onChange,
}: {
  history: MissionHistoryTask[];
  showAgent: boolean;
  emptyMessage: string;
  initialLimit: number;
  agentNames?: ReadonlyMap<string, string>;
  onChange: () => void;
}) {
  const pageSize = 10;
  const [visibleCount, setVisibleCount] = useState(Math.max(1, initialLimit));
  const visible = history.slice(0, visibleCount);
  const remaining = Math.max(0, history.length - visible.length);

  if (history.length === 0) {
    return (
      <div class="rounded-md border border-dashed border-[var(--color-border)] px-3 py-5 text-center text-[11px] text-[var(--color-text-faint)]">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <div class="space-y-1.5">
        {visible.map((task) => (
          <MissionHistoryEntry
            key={task.id}
            task={task}
            showAgent={showAgent}
            agentNames={agentNames}
            onChange={onChange}
          />
        ))}
      </div>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setVisibleCount((count) => count + pageSize)}
          class="mt-2 w-full rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          Show 10 older <span class="text-[var(--color-text-faint)]">({remaining} remaining)</span>
        </button>
      )}
    </div>
  );
}

export function MissionHistoryList({
  tasks,
  onChange,
  showAgent = false,
  emptyMessage = 'No completed tasks yet',
  initialLimit = 10,
}: MissionHistoryListProps) {
  const history = useMemo(() => sortMissionHistory(tasks), [tasks]);
  return (
    <HistoryEntries
      history={history}
      showAgent={showAgent}
      emptyMessage={emptyMessage}
      initialLimit={initialLimit}
      onChange={onChange}
    />
  );
}

export function MissionHistoryArchive({
  tasks,
  agents,
  loading,
  error,
  onRefresh,
}: MissionHistoryArchiveProps) {
  const [search, setSearch] = useState('');
  const [agentId, setAgentId] = useState('all');
  const [outcome, setOutcome] = useState<MissionHistoryOutcome>('all');

  const history = useMemo(
    () => filterMissionHistory(tasks, { search, agentId, outcome }),
    [tasks, search, agentId, outcome],
  );
  const allHistoryCount = useMemo(() => sortMissionHistory(tasks).length, [tasks]);
  const archiveAgents = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, { id: agent.id, name: agent.name || agent.id }]));
    for (const task of tasks) {
      if (task.assigned_agent && !byId.has(task.assigned_agent)) {
        byId.set(task.assigned_agent, { id: task.assigned_agent, name: task.assigned_agent });
      }
    }
    return [...byId.values()];
  }, [agents, tasks]);
  const agentNames = useMemo(() => new Map(archiveAgents.map((agent) => [agent.id, agent.name])), [archiveAgents]);
  const filtersActive = search.trim() !== '' || agentId !== 'all' || outcome !== 'all';
  const filterKey = `${search.trim().toLocaleLowerCase()}|${agentId}|${outcome}`;

  function resetFilters() {
    setSearch('');
    setAgentId('all');
    setOutcome('all');
  }

  return (
    <div class="min-h-full">
      <div class="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 sm:px-6">
        <div class="flex flex-wrap items-center gap-2">
          <label class="relative min-w-[min(210px,100%)] flex-1">
            <span class="sr-only">Search task history</span>
            <Search
              size={13}
              aria-hidden="true"
              class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]"
            />
            <input
              type="search"
              value={search}
              onInput={(event) => setSearch((event.currentTarget as HTMLInputElement).value)}
              placeholder="Search history"
              class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] py-1.5 pl-8 pr-2.5 text-[12px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
            />
          </label>
          <select
            aria-label="Filter history by agent"
            value={agentId}
            onChange={(event) => setAgentId((event.currentTarget as HTMLSelectElement).value)}
            class="max-w-full rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="all">All agents</option>
            <option value="unassigned">Unassigned</option>
            {archiveAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          <select
            aria-label="Filter history by outcome"
            value={outcome}
            onChange={(event) => setOutcome((event.currentTarget as HTMLSelectElement).value as MissionHistoryOutcome)}
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2.5 py-1.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          >
            <option value="all">All outcomes</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="blocked">Blocked</option>
          </select>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh task history"
            title="Refresh"
            class="rounded-md border border-[var(--color-border)] p-1.5 text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] disabled:opacity-40"
          >
            <RefreshCw size={13} class={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div class="mt-2 flex min-h-5 flex-wrap items-center gap-2 text-[10.5px] text-[var(--color-text-faint)]" aria-live="polite">
          <span>{history.length} of {allHistoryCount} historical tasks</span>
          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              class="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            >
              <RotateCcw size={10} aria-hidden="true" />
              Reset filters
            </button>
          )}
        </div>
      </div>

      <div class="px-4 py-3 sm:px-6">
        {error && (
          <div role="alert" class="mb-3 rounded-md border border-[var(--color-status-failed)] bg-[color-mix(in_srgb,var(--color-status-failed)_7%,transparent)] p-3">
            <div class="text-[12px] font-medium text-[var(--color-status-failed)]">Task history could not be refreshed</div>
            <div class="mt-1 break-all font-mono text-[10.5px] text-[var(--color-text-muted)]">{error}</div>
            <button type="button" onClick={onRefresh} class="mt-2 text-[11px] text-[var(--color-accent)] hover:underline">
              Try again
            </button>
          </div>
        )}

        {loading && allHistoryCount === 0 ? (
          <div class="py-12 text-center text-[11px] text-[var(--color-text-faint)]">Loading task history…</div>
        ) : (
          <HistoryEntries
            key={filterKey}
            history={history}
            showAgent
            emptyMessage={filtersActive ? 'No history matches these filters' : 'No completed tasks yet'}
            initialLimit={20}
            agentNames={agentNames}
            onChange={onRefresh}
          />
        )}
      </div>
    </div>
  );
}
