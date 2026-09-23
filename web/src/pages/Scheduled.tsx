import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Pause, Play, Trash2, Clock, LayoutGrid, List, CheckSquare, Pencil, Search, RotateCcw, RefreshCw, LoaderCircle } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { Pill } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { PrivacyToggle } from '@/components/PrivacyToggle';
import { ConfirmModal } from '@/components/ConfirmModal';
import { EditTaskModal } from '@/components/EditTaskModal';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiDelete } from '@/lib/api';
import { formatRelativeTime, resolveAgentName } from '@/lib/format';
import { privacyBlur } from '@/lib/privacy';
import { pushToast } from '@/lib/toasts';
import { describeCron } from '@/lib/cron';
import { useAgentQuery } from '@/lib/agentQuery';

interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  created_at: number;
  agent_id: string;
  started_at: number | null;
  last_status: 'success' | 'failed' | 'timeout' | null;
  can_run_now?: boolean;
  run_now_disabled_reason?: string | null;
}

interface ScheduledTasksResponse {
  tasks: ScheduledTask[];
  capabilities?: { runNow?: boolean; runNowAgent?: string };
}

type ViewMode = 'cards' | 'list';
type StatusFilter = 'all' | ScheduledTask['status'];
type NextRunSort = 'soonest' | 'latest';
type TaskAction = 'pause' | 'resume' | 'run';

function formatCountdown(unixSeconds: number): string {
  const diff = unixSeconds - Date.now() / 1000;
  if (diff < 0) return 'overdue';
  if (diff < 60) return 'in ' + Math.floor(diff) + 's';
  if (diff < 3600) return 'in ' + Math.floor(diff / 60) + 'm';
  if (diff < 86400) return 'in ' + Math.floor(diff / 3600) + 'h';
  return 'in ' + Math.floor(diff / 86400) + 'd';
}

const VIEW_KEY = 'claudeclaw.scheduled.view';

function loadView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'cards' || v === 'list') return v;
  } catch {}
  return 'cards';
}

export function Scheduled() {
  const { data, loading, error, refresh } = useFetch<ScheduledTasksResponse>('/api/tasks', 30_000);
  const agentList = useFetch<{ agents: { id: string; name?: string }[] }>('/api/agents', 60_000);
  const tasks = data?.tasks ?? [];
  const runNowAvailable = data?.capabilities?.runNow === true;
  const runNowAgent = data?.capabilities?.runNowAgent;
  const [view, setView] = useState<ViewMode>(loadView());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState<null | 'single' | 'bulk'>(null);
  const [pendingSingle, setPendingSingle] = useState<ScheduledTask | null>(null);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [details, setDetails] = useState<ScheduledTask | null>(null);
  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useAgentQuery();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [nextRunSort, setNextRunSort] = useState<NextRunSort>('soonest');
  const [busy, setBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState<Record<string, TaskAction>>({});
  const taskActionsInFlight = useRef(new Set<string>());
  const blurOn = privacyBlur('scheduled').value === true;
  const agentNames = useMemo(
    () => new Map((agentList.data?.agents ?? []).map((agent) => [agent.id, agent.name || resolveAgentName(agent.id)])),
    [agentList.data],
  );
  const getAgentName = (agentId: string) => agentNames.get(agentId) || resolveAgentName(agentId);

  const agentOptions = useMemo(() => {
    const ids = Array.from(new Set(tasks.map((task) => task.agent_id)));
    return ids.sort((a, b) => getAgentName(a).localeCompare(getAgentName(b)));
  }, [tasks, agentNames]);

  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return tasks
      .filter((task) => !normalizedQuery || task.prompt.toLocaleLowerCase().includes(normalizedQuery))
      .filter((task) => agentFilter === 'all' || task.agent_id === agentFilter)
      .filter((task) => statusFilter === 'all' || task.status === statusFilter)
      .map((task, index) => ({ task, index }))
      .sort((a, b) => {
        const difference = a.task.next_run - b.task.next_run;
        return (nextRunSort === 'soonest' ? difference : -difference) || a.index - b.index;
      })
      .map(({ task }) => task);
  }, [tasks, query, agentFilter, statusFilter, nextRunSort]);

  const visibleIdsKey = visibleTasks.map((task) => task.id).join('\u0000');
  useEffect(() => {
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    setSelected((current) => {
      const next = new Set(Array.from(current).filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleIdsKey]);

  const hasFilters = query.trim() !== '' || agentFilter !== 'all' || statusFilter !== 'all';
  const allVisibleSelected = visibleTasks.length > 0 && visibleTasks.every((task) => selected.has(task.id));

  function setViewPersisted(v: ViewMode) {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch {}
  }

  function resetFilters() {
    setQuery('');
    setAgentFilter('all');
    setStatusFilter('all');
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function selectAllVisible() {
    const next = new Set(selected);
    if (allVisibleSelected) visibleTasks.forEach((task) => next.delete(task.id));
    else visibleTasks.forEach((task) => next.add(task.id));
    setSelected(next);
  }

  async function performBulkDelete() {
    setBusy(true);
    const currentTaskIds = new Set(tasks.map((task) => task.id));
    const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
    const ids = Array.from(selected).filter((id) => currentTaskIds.has(id) && visibleTaskIds.has(id));
    let ok = 0, failed = 0;
    for (const id of ids) {
      try { await apiDelete(`/api/tasks/${id}`); ok++; } catch { failed++; }
    }
    setSelected(new Set());
    refresh();
    setBusy(false);
    if (failed === 0) pushToast({ tone: 'warn', title: `Deleted ${ok} task${ok === 1 ? '' : 's'}` });
    else pushToast({ tone: 'error', title: `Deleted ${ok}, failed ${failed}`, description: 'Check the audit log for details.', durationMs: 7000 });
  }

  async function performSingleDelete() {
    if (!pendingSingle) return;
    setBusy(true);
    try {
      await apiDelete(`/api/tasks/${pendingSingle.id}`);
      pushToast({ tone: 'warn', title: 'Task deleted' });
      refresh();
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Delete failed', description: err?.message || String(err), durationMs: 6000 });
    } finally {
      setBusy(false);
      setPendingSingle(null);
    }
  }

  async function action(task: ScheduledTask, act: 'pause' | 'resume') {
    if (taskActionsInFlight.current.has(task.id)) return;
    taskActionsInFlight.current.add(task.id);
    setTaskBusy((current) => ({ ...current, [task.id]: act }));
    try {
      if (act === 'pause') await apiPost(`/api/tasks/${task.id}/pause`);
      else await apiPost(`/api/tasks/${task.id}/resume`);
      refresh();
      pushToast({ tone: 'success', title: act === 'pause' ? 'Task paused' : 'Task resumed' });
    } catch (err: any) {
      pushToast({ tone: 'error', title: `${act} failed`, description: err?.message || String(err), durationMs: 6000 });
    } finally {
      taskActionsInFlight.current.delete(task.id);
      setTaskBusy((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  }

  async function runNow(task: ScheduledTask) {
    if (task.status === 'running' || taskActionsInFlight.current.has(task.id)) return;
    taskActionsInFlight.current.add(task.id);
    setTaskBusy((current) => ({ ...current, [task.id]: 'run' }));
    try {
      await apiPost(`/api/tasks/${task.id}/run`);
      refresh();
      pushToast({ tone: 'success', title: 'Task queued', description: 'One run requested. The schedule and paused state are preserved.' });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Run now failed', description: err?.message || String(err), durationMs: 6000 });
    } finally {
      taskActionsInFlight.current.delete(task.id);
      setTaskBusy((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  }

  function requestDelete(task: ScheduledTask) {
    setPendingSingle(task);
    setConfirmOpen('single');
  }

  return (
    <div class="flex flex-col h-full min-w-0">
      <PageHeader title="Scheduled" actions={<>
        <span class="text-[11.5px] text-[var(--color-text-muted)] tabular-nums">
          {hasFilters ? `${visibleTasks.length} of ${tasks.length}` : tasks.length} scheduled{selected.size > 0 ? ` · ${selected.size} selected` : ''}
        </span>
        {selected.size > 0 && (
          <button type="button" onClick={() => setConfirmOpen('bulk')} disabled={busy} class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-white bg-[var(--color-status-failed)] hover:opacity-90 transition-opacity disabled:opacity-40">
            <Trash2 size={12} /> Delete {selected.size}
          </button>
        )}
        <PrivacyToggle section="scheduled" />
        <ViewSwitcher view={view} onChange={setViewPersisted} />
      </>} />

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}
      {!loading && !error && tasks.length === 0 && (
        <PageState empty emptyTitle="No scheduled tasks" emptyDescription="Use mission-cli or ask the bot to create a recurring task. They'll show up here when they're scheduled." />
      )}

      {tasks.length > 0 && <>
        <FilterBar query={query} agentFilter={agentFilter} statusFilter={statusFilter} nextRunSort={nextRunSort} agentOptions={agentOptions} getAgentName={getAgentName} visibleCount={visibleTasks.length} totalCount={tasks.length} allVisibleSelected={allVisibleSelected} onQueryChange={setQuery} onAgentChange={setAgentFilter} onStatusChange={setStatusFilter} onSortChange={setNextRunSort} onSelectAll={selectAllVisible} onReset={resetFilters} hasFilters={hasFilters} />

        {visibleTasks.length === 0 ? (
          <div class="flex-1 flex items-center justify-center p-6 text-center"><div>
            <div class="text-[13px] font-medium text-[var(--color-text)]">No matching tasks</div>
            <div class="mt-1 text-[11.5px] text-[var(--color-text-muted)]">Try a different prompt, agent, or status.</div>
            <button type="button" onClick={resetFilters} class="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--color-border)] text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]"><RotateCcw size={12} /> Reset filters</button>
          </div></div>
        ) : view === 'cards' ? (
          <div key="cards" class="flex-1 overflow-y-auto p-4 sm:p-6">
            <div class="grid gap-3 items-stretch" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
              {visibleTasks.map((task) => <TaskCard key={task.id} task={task} agentName={getAgentName(task.agent_id)} blurOn={blurOn} selected={selected.has(task.id)} busyAction={taskBusy[task.id]} runNowUnavailableReason={!runNowAvailable ? 'Run now requires the updated server' : task.can_run_now !== true ? task.run_now_disabled_reason || `Run now is only available for ${runNowAgent || 'main'} agent tasks` : undefined} onToggleSelect={() => toggleSelect(task.id)} onAction={(act) => action(task, act)} onRunNow={() => runNow(task)} onDeleteRequest={() => requestDelete(task)} onEdit={() => setEditing(task)} onDetails={() => setDetails(task)} />)}
            </div>
          </div>
        ) : (
          <div key="list" class="flex-1 min-h-0 overflow-auto">
            <table class="w-full min-w-[1000px] table-fixed text-[12.5px]">
              <colgroup><col style={{ width: '40px' }} /><col /><col style={{ width: '180px' }} /><col style={{ width: '92px' }} /><col style={{ width: '116px' }} /><col style={{ width: '112px' }} /><col style={{ width: '144px' }} /></colgroup>
              <thead class="sticky top-0 bg-[var(--color-bg)] border-b border-[var(--color-border)] z-10"><tr class="text-left">
                <th class="pl-4 pr-1 py-2.5"><button type="button" onClick={selectAllVisible} class="p-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title={allVisibleSelected ? 'Clear visible selection' : 'Select all visible tasks'} aria-label={allVisibleSelected ? 'Clear visible selection' : 'Select all visible tasks'}><CheckSquare size={14} class={allVisibleSelected ? 'text-[var(--color-accent)]' : ''} /></button></th>
                <TableHeading>Prompt</TableHeading><TableHeading>Schedule</TableHeading><TableHeading>Next run</TableHeading><TableHeading>Status</TableHeading><TableHeading>Agent</TableHeading><TableHeading align="right">Actions</TableHeading>
              </tr></thead>
              <tbody>{visibleTasks.map((task) => <TaskListRow key={task.id} task={task} agentName={getAgentName(task.agent_id)} blurOn={blurOn} selected={selected.has(task.id)} busyAction={taskBusy[task.id]} runNowUnavailableReason={!runNowAvailable ? 'Run now requires the updated server' : task.can_run_now !== true ? task.run_now_disabled_reason || `Run now is only available for ${runNowAgent || 'main'} agent tasks` : undefined} onToggleSelect={() => toggleSelect(task.id)} onAction={(act) => action(task, act)} onRunNow={() => runNow(task)} onDeleteRequest={() => requestDelete(task)} onEdit={() => setEditing(task)} onDetails={() => setDetails(task)} />)}</tbody>
            </table>
          </div>
        )}
      </>}

      <TaskDetailsModal task={details} agentName={details ? getAgentName(details.agent_id) : ''} blurOn={blurOn} onClose={() => setDetails(null)} onEdit={(task) => { setDetails(null); setEditing(task); }} />
      <EditTaskModal open={editing !== null} task={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ConfirmModal open={confirmOpen === 'single'} onClose={() => { setConfirmOpen(null); setPendingSingle(null); }} onConfirm={performSingleDelete} title="Delete this scheduled task?" body={pendingSingle ? truncateForBlur(pendingSingle.prompt, 140, blurOn) : ''} detail="The task and its schedule are removed. Past run results stay in the history table." confirmLabel="Delete" destructive />
      <ConfirmModal open={confirmOpen === 'bulk'} onClose={() => setConfirmOpen(null)} onConfirm={performBulkDelete} title={`Delete ${selected.size} scheduled task${selected.size === 1 ? '' : 's'}?`} body="All selected tasks will be removed and won't fire again. Past run results stay in the history table." confirmLabel={`Delete ${selected.size}`} destructive />
    </div>
  );
}

function truncateForBlur(text: string, max: number, blur: boolean): string {
  if (blur) return '(prompt hidden — turn off blur to see full text)';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

interface FilterBarProps {
  query: string; agentFilter: string; statusFilter: StatusFilter; nextRunSort: NextRunSort; agentOptions: string[]; getAgentName: (agentId: string) => string;
  visibleCount: number; totalCount: number; allVisibleSelected: boolean; onQueryChange: (value: string) => void; onAgentChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void; onSortChange: (value: NextRunSort) => void; onSelectAll: () => void; onReset: () => void; hasFilters: boolean;
}

function FilterBar(props: FilterBarProps) {
  const { query, agentFilter, statusFilter, nextRunSort, agentOptions, getAgentName, visibleCount, totalCount, allVisibleSelected, onQueryChange, onAgentChange, onStatusChange, onSortChange, onSelectAll, onReset, hasFilters } = props;
  const inputClass = 'toolbar-control rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';
  return (
    <div class="page-toolbar shrink-0 flex flex-wrap items-center gap-2 px-4 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      <label class="relative flex-1 min-w-[min(220px,100%)] max-w-[520px]">
        <span class="sr-only">Search task prompts</span><Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] pointer-events-none" />
        <input type="search" value={query} onInput={(event) => onQueryChange(event.currentTarget.value)} placeholder="Search prompts" aria-label="Search task prompts" class={`${inputClass} w-full pl-8 pr-3`} />
      </label>
      <select value={agentFilter} onChange={(event) => onAgentChange(event.currentTarget.value)} aria-label="Filter by agent" class={`${inputClass} px-2.5 min-w-[130px]`}>
        <option value="all">All agents</option>{agentOptions.map((agentId) => <option value={agentId} key={agentId}>{getAgentName(agentId)}</option>)}
        {agentFilter !== 'all' && !agentOptions.includes(agentFilter) && <option value={agentFilter}>{getAgentName(agentFilter)}</option>}
      </select>
      <select value={statusFilter} onChange={(event) => onStatusChange(event.currentTarget.value as StatusFilter)} aria-label="Filter by task status" class={`${inputClass} px-2.5 min-w-[120px]`}>
        <option value="all">All statuses</option><option value="active">Active</option><option value="running">Running</option><option value="paused">Paused</option>
      </select>
      <select value={nextRunSort} onChange={(event) => onSortChange(event.currentTarget.value as NextRunSort)} aria-label="Sort by next run" class={`${inputClass} px-2.5 min-w-[150px]`}>
        <option value="soonest">Next run: soonest</option><option value="latest">Next run: latest</option>
      </select>
      <span class="ml-auto text-[11.5px] text-[var(--color-text-faint)] tabular-nums whitespace-nowrap">{visibleCount} of {totalCount}</span>
      <button type="button" onClick={onSelectAll} class="toolbar-control control-button inline-flex items-center gap-1.5 px-2.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]">
        <CheckSquare size={14} class={allVisibleSelected ? 'text-[var(--color-accent)]' : ''} /> {allVisibleSelected ? 'Clear selection' : 'Select visible'}
      </button>
      {hasFilters && <button type="button" onClick={onReset} class="toolbar-control control-button inline-flex items-center gap-1.5 px-2.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]"><RotateCcw size={14} /> Reset</button>}
    </div>
  );
}

function TableHeading({ children, align = 'left' }: { children: string; align?: 'left' | 'right' }) {
  return <th class={`px-3 py-2.5 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] ${align === 'right' ? 'text-right' : ''}`}>{children}</th>;
}

function ViewSwitcher({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return <div class="toolbar-segmented" role="group" aria-label="Scheduled task view">
    <button type="button" onClick={() => onChange('cards')} aria-label="Card view" aria-pressed={view === 'cards'} class={['toolbar-control toolbar-icon control-button inline-flex items-center justify-center transition-colors', view === 'cards' ? 'control-accent' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'].join(' ')} title="Card view"><LayoutGrid size={14} /></button>
    <button type="button" onClick={() => onChange('list')} aria-label="List view" aria-pressed={view === 'list'} class={['toolbar-control toolbar-icon control-button inline-flex items-center justify-center transition-colors', view === 'list' ? 'control-accent' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'].join(' ')} title="List view"><List size={14} /></button>
  </div>;
}

interface RowProps {
  task: ScheduledTask; agentName: string; blurOn: boolean; selected: boolean; busyAction?: TaskAction; runNowUnavailableReason?: string; onToggleSelect: () => void; onAction: (act: 'pause' | 'resume') => void;
  onRunNow: () => void; onDeleteRequest: () => void; onEdit: () => void; onDetails: () => void;
}

function statusTone(task: ScheduledTask) { return task.status === 'running' ? 'running' : task.status === 'paused' ? 'cancelled' : 'done'; }
function lastStatusTone(task: ScheduledTask) { return task.last_status === 'success' ? 'done' : task.last_status === 'timeout' ? 'medium' : 'failed'; }

function TaskPrompt({ prompt, blurOn, onDetails, card = false }: { prompt: string; blurOn: boolean; onDetails: () => void; card?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => setRevealed(false), [prompt, blurOn]);
  const label = blurOn ? (revealed ? 'Hide scheduled task prompt' : 'Reveal scheduled task prompt') : 'View scheduled task details';
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        if (blurOn) setRevealed((value) => !value);
        else onDetails();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      aria-label={label}
      aria-pressed={blurOn ? revealed : undefined}
      title={blurOn ? label : undefined}
      style={{ cursor: 'pointer' }}
      class={`min-w-0 w-full text-left text-[var(--color-text)] leading-snug hover:text-[var(--color-accent)] ${card ? 'flex-1 min-h-[3.5rem] text-[12.5px] line-clamp-3' : 'line-clamp-2'} ${blurOn ? (revealed ? 'privacy-blur revealed' : 'privacy-blur') : ''}`}
    >{prompt}</button>
  );
}

function TaskCard(props: RowProps) {
  const { task, agentName, blurOn, selected, busyAction, runNowUnavailableReason, onToggleSelect, onAction, onRunNow, onDeleteRequest, onEdit, onDetails } = props;
  return (
    <article
      aria-label={`View details for scheduled task assigned to ${agentName}`}
      onClick={onDetails}
      class={['group h-full min-h-[220px] flex flex-col bg-[var(--color-card)] border rounded-lg p-4 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-[var(--color-accent)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--color-bg)]', selected ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'].join(' ')}
    >
      <div class="flex items-start gap-2.5">
        <input type="checkbox" checked={selected} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={onToggleSelect} aria-label={`Select scheduled task for ${agentName}`} class="mt-0.5 shrink-0 cursor-pointer accent-[var(--color-accent)]" />
        <TaskPrompt prompt={task.prompt} blurOn={blurOn} onDetails={onDetails} card />
      </div>
      <div class="mt-4 grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px]">
        <span class="text-[var(--color-text-faint)]">Schedule</span><span class="text-[var(--color-text-muted)] leading-snug inline-flex items-start gap-1.5"><Clock size={11} class="mt-0.5 shrink-0" /> {describeCron(task.schedule).text}</span>
        <span class="text-[var(--color-text-faint)]">Next run</span><span class="text-[var(--color-accent)] tabular-nums">{task.status === 'active' ? formatCountdown(task.next_run) : '—'}</span>
        <span class="text-[var(--color-text-faint)]">Agent</span><span class="font-mono text-[var(--color-text-muted)] truncate">@{agentName}</span>
      </div>
      <div class="mt-3 flex items-center gap-1.5 flex-wrap">
        <Pill tone={statusTone(task)}>{task.status}</Pill>{task.last_status && <Pill tone={lastStatusTone(task)}>last: {task.last_status}</Pill>}{task.last_run && <span class="text-[10px] text-[var(--color-text-faint)]">ran {formatRelativeTime(task.last_run)}</span>}
      </div>
      <div class="mt-auto pt-3 border-t border-[var(--color-border)] flex items-center justify-end gap-2">
        <RowActions task={task} busyAction={busyAction} runNowUnavailableReason={runNowUnavailableReason} onAction={onAction} onRunNow={onRunNow} onDeleteRequest={onDeleteRequest} onEdit={onEdit} />
      </div>
    </article>
  );
}

function TaskListRow(props: RowProps) {
  const { task, agentName, blurOn, selected, busyAction, runNowUnavailableReason, onToggleSelect, onAction, onRunNow, onDeleteRequest, onEdit, onDetails } = props;
  return <tr
    onClick={onDetails}
    class={`${selected ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-control-hover)]'} group cursor-pointer border-b border-[var(--color-border)] transition-colors focus-within:bg-[var(--color-elevated)]`}
  >
    <td class="pl-4 pr-1 py-3"><input type="checkbox" checked={selected} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={onToggleSelect} aria-label={`Select scheduled task for ${agentName}`} class="cursor-pointer accent-[var(--color-accent)]" /></td>
    <td class="px-3 py-3 min-w-[300px]"><TaskPrompt prompt={task.prompt} blurOn={blurOn} onDetails={onDetails} /></td>
    <td class="px-3 py-3 text-[var(--color-text-muted)] leading-snug break-words">{describeCron(task.schedule).text}</td>
    <td class="px-3 py-3 text-[var(--color-text-faint)] tabular-nums whitespace-nowrap">{task.status === 'active' ? formatCountdown(task.next_run) : '—'}</td>
    <td class="px-3 py-3"><div class="flex flex-col items-start gap-1"><Pill tone={statusTone(task)}>{task.status}</Pill>{task.last_status && <Pill tone={lastStatusTone(task)}>last: {task.last_status}</Pill>}</div></td>
    <td class="px-3 py-3 font-mono text-[11px] text-[var(--color-text-muted)] truncate">@{agentName}</td>
    <td class="px-3 py-3 text-right whitespace-nowrap"><RowActions task={task} busyAction={busyAction} runNowUnavailableReason={runNowUnavailableReason} onAction={onAction} onRunNow={onRunNow} onDeleteRequest={onDeleteRequest} onEdit={onEdit} /></td>
  </tr>;
}

function RowActions({ task, busyAction, runNowUnavailableReason, onAction, onRunNow, onDeleteRequest, onEdit }: { task: ScheduledTask; busyAction?: TaskAction; runNowUnavailableReason?: string; onAction: (act: 'pause' | 'resume') => void; onRunNow: () => void; onDeleteRequest: () => void; onEdit: () => void }) {
  const busy = busyAction !== undefined;
  const runNowTitle = task.status === 'running' ? 'Task is already running' : runNowUnavailableReason || (busyAction === 'run' ? 'Starting task…' : 'Run task now');
  const iconButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors disabled:opacity-35 disabled:cursor-not-allowed';
  return <div class="inline-flex items-center gap-0.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <button type="button" onClick={onEdit} disabled={busy} class={iconButtonClass} title="Edit task" aria-label="Edit scheduled task"><Pencil size={12} /></button>
    <button type="button" onClick={onRunNow} disabled={busy || task.status === 'running' || runNowUnavailableReason !== undefined} class={`${iconButtonClass} hover:text-[var(--color-accent)]`} title={runNowTitle} aria-label={runNowTitle}>
      {busyAction === 'run' ? <LoaderCircle size={12} class="animate-spin" /> : <Play size={12} />}
    </button>
    {task.status === 'active' && <button type="button" onClick={() => onAction('pause')} disabled={busy} class={iconButtonClass} title={busyAction === 'pause' ? 'Pausing schedule…' : 'Pause schedule'} aria-label="Pause schedule">{busyAction === 'pause' ? <LoaderCircle size={12} class="animate-spin" /> : <Pause size={12} />}</button>}
    {task.status === 'paused' && <button type="button" onClick={() => onAction('resume')} disabled={busy} class={`${iconButtonClass} hover:text-[var(--color-accent)]`} title={busyAction === 'resume' ? 'Resuming schedule…' : 'Resume schedule'} aria-label="Resume schedule">{busyAction === 'resume' ? <LoaderCircle size={12} class="animate-spin" /> : <RefreshCw size={12} />}</button>}
    <button type="button" onClick={onDeleteRequest} disabled={busy} class={`${iconButtonClass} hover:text-[var(--color-status-failed)]`} title="Delete task" aria-label="Delete scheduled task"><Trash2 size={12} /></button>
  </div>;
}

function TaskDetailsModal({ task, agentName, blurOn, onClose, onEdit }: { task: ScheduledTask | null; agentName: string; blurOn: boolean; onClose: () => void; onEdit: (task: ScheduledTask) => void }) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => setRevealed(false), [task?.id, blurOn]);
  if (!task) return null;
  const blurClass = blurOn && !revealed ? 'privacy-blur privacy-blur-static' : '';
  return <Modal open onClose={onClose} title="Scheduled task details" width={720} footer={<>
    <button type="button" onClick={onClose} class="ml-auto px-3 py-1.5 rounded border border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Close</button>
    <button type="button" onClick={() => onEdit(task)} class="control-button inline-flex items-center gap-1.5 px-3 py-1.5 rounded control-accent text-[12px] hover:opacity-90"><Pencil size={12} /> Edit task</button>
  </>}>
    <div class="flex flex-wrap items-center gap-2 mb-4"><Pill tone={statusTone(task)}>{task.status}</Pill>{task.last_status && <Pill tone={lastStatusTone(task)}>last: {task.last_status}</Pill>}<span class="text-[11px] font-mono text-[var(--color-text-muted)]">@{agentName}</span>
      {blurOn && <button type="button" onClick={() => setRevealed((value) => !value)} class="ml-auto text-[11px] text-[var(--color-accent)] hover:underline">{revealed ? 'Hide private text' : 'Reveal private text'}</button>}
    </div>
    <DetailLabel>Prompt</DetailLabel>
    <div class={`mt-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-[var(--color-text)] ${blurClass}`}>{task.prompt}</div>
    <div class="mt-4 grid gap-3 sm:grid-cols-2"><DetailBlock label="Schedule" value={describeCron(task.schedule).text} detail={task.schedule} /><DetailBlock label="Next run" value={task.status === 'paused' ? 'Not scheduled while paused' : task.status === 'running' ? 'Running now' : formatCountdown(task.next_run)} /><DetailBlock label="Last run" value={task.last_run ? formatRelativeTime(task.last_run) : 'No completed run'} /><DetailBlock label="Agent" value={agentName} /></div>
    <div class="mt-5"><DetailLabel>Last result</DetailLabel>{task.last_result ? <div class={`mt-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[11.5px] font-mono leading-relaxed whitespace-pre-wrap break-words text-[var(--color-text-muted)] ${blurClass}`}>{task.last_result}</div> : <div class="mt-1.5 text-[11.5px] text-[var(--color-text-faint)]">No result has been recorded.</div>}</div>
  </Modal>;
}

function DetailLabel({ children }: { children: string }) { return <div class="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-faint)]">{children}</div>; }
function DetailBlock({ label, value, detail }: { label: string; value: string; detail?: string }) { return <div class="rounded-lg border border-[var(--color-border)] p-3"><DetailLabel>{label}</DetailLabel><div class="mt-1 text-[12px] text-[var(--color-text)]">{value}</div>{detail && <div class="mt-1 font-mono text-[10.5px] text-[var(--color-text-faint)] break-all">{detail}</div>}</div>; }
