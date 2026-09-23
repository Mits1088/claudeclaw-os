import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Plus, Wand2, X, History, Inbox, GripVertical, Maximize2, Minimize2, LayoutGrid as LayoutIcon, Check, Clock3, RotateCcw } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { AgentStatusBadge, Pill, StatusDot } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { Modal, Drawer } from '@/components/Modal';
import { AgentAvatar } from '@/components/AgentAvatar';
import { MissionColumnPanels } from '@/components/MissionColumnPanels';
import { MissionHistoryArchive, MissionHistoryList } from '@/components/MissionHistory';
import { isTerminalMissionStatus, sortMissionHistory } from '@/lib/missionHistory';
import { missionInboxMode, resetMissionPanels, setMissionInboxMode, shouldShowMissionInbox, type MissionInboxMode } from '@/lib/missionBoardPreferences';
import { useFetch } from '@/lib/useFetch';
import { apiPost, apiPatch } from '@/lib/api';
import { formatRelativeTime, resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { uiScale } from '@/lib/theme';
import {
  workspaceName,
  missionColumnOrder,
  missionColumnWidths,
  setMissionColumnOrder,
  setMissionColumnWidth,
  setMissionColumnWidthsBulk,
} from '@/lib/personalization';

interface MissionTask {
  id: string;
  title: string;
  prompt: string;
  assigned_agent: string | null;
  status: 'queued' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  created_by: string;
  created_at: number;
  available_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

interface Agent { id: string; name: string; description: string; running: boolean; }

type TaskVisibility = 'all' | 'active' | 'attention';

function missionCountdown(seconds: number): string {
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return 'in <1m';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `in ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

function missionAvailability(task: MissionTask): string | null {
  if (task.status !== 'queued' || !task.available_at) return null;
  const runAt = new Date(task.available_at * 1000);
  if (Number.isNaN(runAt.getTime())) return null;
  const localTime = runAt.toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `Runs once ${localTime} · ${missionCountdown(task.available_at - Math.floor(Date.now() / 1000))}`;
}

export function MissionControl() {
  const [location, navigate] = useLocation();
  const tasks = useFetch<{ tasks: MissionTask[] }>('/api/mission/tasks', 15_000);
  const agents = useFetch<{ agents: Agent[] }>('/api/agents', 60_000);

  const [createOpen, setCreateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('all');
  const [taskVisibility, setTaskVisibility] = useState<TaskVisibility>('all');
  const [hideEmptyColumns, setHideEmptyColumns] = useState(false);
  const boardViewportRef = useRef<HTMLDivElement>(null);
  const [boardViewportWidth, setBoardViewportWidth] = useState(0);

  // ?new=1 from the command palette opens the create modal.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('new') === '1') {
      setCreateOpen(true);
      url.searchParams.delete('new');
      navigate(url.pathname);
    }
  }, [location]);

  const { activeTasks, historicalTasks, totalActive, unassignedCount } = useMemo(() => {
    const all = tasks.data?.tasks ?? [];
    const active = all.filter((task) => !isTerminalMissionStatus(task.status));
    return {
      activeTasks: active,
      historicalTasks: sortMissionHistory(all),
      totalActive: active.length,
      unassignedCount: active.filter((task) => !task.assigned_agent).length,
    };
  }, [tasks.data]);
  const inboxMode = missionInboxMode.value;
  const inboxVisible = shouldShowMissionInbox(inboxMode, unassignedCount);

  async function autoAssignAll() {
    setBulkAssigning(true);
    try {
      const res = await apiPost<{ assigned: number }>('/api/mission/tasks/auto-assign-all');
      tasks.refresh();
      if (typeof res?.assigned === 'number') {
        // Tiny inline feedback; toast system is a follow-up.
        console.info(`Auto-assigned ${res.assigned} task${res.assigned === 1 ? '' : 's'}`);
      }
    } catch (err: any) {
      alert('Auto-assign failed: ' + (err?.message || err));
    } finally { setBulkAssigning(false); }
  }

  const loading = (tasks.loading && !tasks.data) || (agents.loading && !agents.data);
  const error = tasks.error || agents.error;
  const wsName = workspaceName.value;
  const headerTitle = wsName && wsName !== 'ClaudeClaw' ? `${wsName} · Tasks` : 'Mission Control';

  // Apply user-saved column order on top of API agent order. Any agents
  // not in the saved order keep their API position; saved agents that no
  // longer exist are skipped.
  const orderedAgents = useMemo(() => {
    const live = agents.data?.agents ?? [];
    const saved = missionColumnOrder.value;
    if (saved.length === 0) return live;
    const byId = new Map(live.map((a) => [a.id, a]));
    const out: Agent[] = [];
    for (const id of saved) {
      const a = byId.get(id);
      if (a) { out.push(a); byId.delete(id); }
    }
    for (const a of live) if (byId.has(a.id)) out.push(a);
    return out;
  }, [agents.data, missionColumnOrder.value]);

  const { filteredAgents, filteredByAgent, filteredHistoryByAgent, filteredInbox } = useMemo(() => {
    const filteredTasks = taskVisibility === 'attention' ? [] : activeTasks;
    const filteredHistory = taskVisibility === 'active' ? [] : historicalTasks.filter((task) => taskVisibility !== 'attention' || task.status === 'failed' || task.status === 'blocked');
    const inbox = filteredTasks.filter((task) => !task.assigned_agent);
    const byAgent: Record<string, MissionTask[]> = {};
    const historyByAgent: Record<string, MissionTask[]> = {};
    for (const task of filteredTasks) {
      if (task.assigned_agent) (byAgent[task.assigned_agent] ??= []).push(task);
    }
    for (const task of filteredHistory) {
      if (task.assigned_agent) (historyByAgent[task.assigned_agent] ??= []).push(task);
    }
    let nextAgents = selectedAgent === 'all'
      ? orderedAgents
      : orderedAgents.filter((agent) => agent.id === selectedAgent);
    if (hideEmptyColumns) nextAgents = nextAgents.filter((agent) => (byAgent[agent.id]?.length ?? 0) + (historyByAgent[agent.id]?.length ?? 0) > 0);
    return {
      filteredAgents: nextAgents,
      filteredByAgent: byAgent,
      filteredHistoryByAgent: historyByAgent,
      filteredInbox: inbox,
    };
  }, [activeTasks, historicalTasks, orderedAgents, selectedAgent, taskVisibility, hideEmptyColumns]);

  const filtersActive = selectedAgent !== 'all' || taskVisibility !== 'all' || hideEmptyColumns;
  function resetViewFilters() {
    setSelectedAgent('all');
    setTaskVisibility('all');
    setHideEmptyColumns(false);
  }

  useEffect(() => {
    const el = boardViewportRef.current;
    if (!el) return;
    const update = () => setBoardViewportWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, error]);

  function handleColumnDrop(targetId: string, draggedId: string) {
    if (targetId === draggedId) return;
    const ids = orderedAgents.map((a) => a.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, draggedId);
    setMissionColumnOrder(next);
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title={headerTitle}
        actions={
          <>
            <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums mr-2">
              {totalActive} active · {unassignedCount} unassigned · {tasks.data?.tasks?.length ?? 0} total
            </span>
            <LayoutMenu agents={orderedAgents} visibleAgentCount={filteredAgents.length} viewportWidth={boardViewportWidth} inboxVisible={inboxVisible} />
            <button
              type="button"
              onClick={() => { setHistoryOpen(true); tasks.refresh(); }}
              class="control-button inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors"
            >
              <History size={13} /> All history
            </button>
            {unassignedCount > 0 && (
              <button
                type="button"
                onClick={autoAssignAll}
                disabled={bulkAssigning}
                class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] border border-[var(--color-border)] transition-colors disabled:opacity-40"
              >
                <Wand2 size={13} /> {bulkAssigning ? 'Assigning…' : `Auto-assign all (${unassignedCount})`}
              </button>
            )}
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              class="control-button inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium control-accent transition-colors"
            >
              <Plus size={14} /> New Task
            </button>
          </>
        }
      />

      {error && <PageState error={error} />}
      {loading && <PageState loading />}

      {!loading && !error && (
        <>
          <ViewControls
            agents={orderedAgents}
            selectedAgent={selectedAgent}
            onSelectedAgent={setSelectedAgent}
            taskVisibility={taskVisibility}
            onTaskVisibility={setTaskVisibility}
            hideEmptyColumns={hideEmptyColumns}
            onHideEmptyColumns={setHideEmptyColumns}
            inboxMode={inboxMode}
            unassignedCount={unassignedCount}
            filtersActive={filtersActive}
            onReset={resetViewFilters}
          />
          <div ref={boardViewportRef} class="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
            <div class="flex gap-3 p-4 h-full min-w-max">
              {inboxVisible && <InboxColumn tasks={filteredInbox} onChange={tasks.refresh} agents={orderedAgents} filtered={taskVisibility === 'attention'} />}
              {filteredAgents.map((a) => (
              <AgentColumn
                key={a.id}
                agent={a}
                tasks={filteredByAgent[a.id] ?? []}
                historyTasks={filteredHistoryByAgent[a.id] ?? []}
                historyEnabled={taskVisibility !== 'active'}
                onChange={tasks.refresh}
                onColumnDrop={handleColumnDrop}
              />
              ))}
              {filteredAgents.length === 0 && (!inboxVisible || filteredInbox.length === 0) && (
                <FilteredEmptyState onReset={resetViewFilters} />
              )}
            </div>
          </div>
        </>
      )}

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        agents={agents.data?.agents ?? []}
        onCreated={tasks.refresh}
      />

      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="All task history">
        {historyOpen && <MissionHistoryArchive tasks={historicalTasks} agents={agents.data?.agents ?? []} loading={tasks.loading} error={tasks.error} onRefresh={tasks.refresh} />}
      </Drawer>
    </div>
  );
}

function ViewControls({
  agents,
  selectedAgent,
  onSelectedAgent,
  taskVisibility,
  onTaskVisibility,
  hideEmptyColumns,
  onHideEmptyColumns,
  inboxMode,
  unassignedCount,
  filtersActive,
  onReset,
}: {
  agents: Agent[];
  selectedAgent: string;
  onSelectedAgent: (agentId: string) => void;
  taskVisibility: TaskVisibility;
  onTaskVisibility: (visibility: TaskVisibility) => void;
  hideEmptyColumns: boolean;
  onHideEmptyColumns: (hide: boolean) => void;
  inboxMode: MissionInboxMode;
  unassignedCount: number;
  filtersActive: boolean;
  onReset: () => void;
}) {
  const visibilityOptions: Array<{ value: TaskVisibility; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'attention', label: 'Needs attention' },
  ];
  return (
    <div class="page-toolbar shrink-0 flex flex-wrap items-center gap-3 px-4 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      <label class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
        <span>Agent</span>
        <select
          aria-label="Show agent"
          value={selectedAgent}
          onChange={(event) => onSelectedAgent((event.currentTarget as HTMLSelectElement).value)}
          class="toolbar-control min-w-[150px] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md px-2.5 text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        >
          <option value="all">All agents</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
        </select>
      </label>

      <div class="flex flex-wrap max-w-full items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
        <span>Tasks</span>
        <div class="toolbar-segmented" role="group" aria-label="Task visibility">
          {visibilityOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={taskVisibility === option.value}
              onClick={() => onTaskVisibility(option.value)}
              class={[
                'toolbar-control control-button items-center px-2.5 transition-colors',
                taskVisibility === option.value
                  ? 'control-accent'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              ].join(' ')}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <label title="Hide agents with no active work or history matching this view" class="inline-flex min-h-[32px] items-center gap-2 text-[13px] text-[var(--color-text-muted)] cursor-pointer select-none">
        <input
          type="checkbox"
          checked={hideEmptyColumns}
          onChange={(event) => onHideEmptyColumns((event.currentTarget as HTMLInputElement).checked)}
          class="h-[14px] w-[14px] accent-[var(--color-accent)]"
        />
        Hide empty columns
      </label>

      <label class="flex flex-wrap items-center gap-2 border-l border-[var(--color-border)] pl-3 text-[13px] text-[var(--color-text-muted)]">
        <span class="inline-flex items-center gap-1.5"><Inbox size={14} /> Inbox <span aria-live="polite" class={`tabular-nums ${unassignedCount > 0 ? 'text-[var(--color-accent)] font-semibold' : ''}`}>{unassignedCount}</span></span>
        <select
          aria-label="Inbox visibility"
          value={inboxMode}
          onChange={(event) => setMissionInboxMode(event.currentTarget.value as MissionInboxMode)}
          class="toolbar-control rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2.5 text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        >
          <option value="show">Show</option>
          <option value="hide">Hide</option>
          <option value="auto">Hide when empty</option>
        </select>
      </label>

      {filtersActive && (
        <button
          type="button"
          onClick={onReset}
          class="toolbar-control control-button ml-auto inline-flex items-center gap-1.5 px-2 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors"
        >
          <RotateCcw size={14} aria-hidden="true" /> Reset view
        </button>
      )}
    </div>
  );
}

function FilteredEmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div class="w-[320px] shrink-0 self-start rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-card)] px-6 py-8 text-center">
      <div class="text-[13px] font-medium text-[var(--color-text)]">No matching columns</div>
      <div class="mt-1 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
        No active work or history matches the current view.
      </div>
      <button
        type="button"
        onClick={onReset}
        class="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-text)] hover:border-[var(--color-border-strong)]"
      >
        <RotateCcw size={12} aria-hidden="true" /> Reset view
      </button>
    </div>
  );
}

// ── Columns ─────────────────────────────────────────────────────────

// Inbox is pinned leftmost and not draggable/resizable — it's a fixed
// landing zone for unassigned tasks. Width chosen to match the default
// agent column width but slightly narrower since inbox cards are simpler.
function InboxColumn({ tasks, agents, onChange, filtered }: { tasks: MissionTask[]; agents: Agent[]; onChange: () => void; filtered: boolean }) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  return (
    <div
      class="w-[300px] shrink-0 flex flex-col bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg overflow-hidden"
      onDragOver={(e) => e.preventDefault()}
    >
      <div class="px-3 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
        <Inbox size={15} class="text-[var(--color-text-muted)]" />
        <div class="flex-1 min-w-0">
          <div class="text-[13.5px] font-medium text-[var(--color-text)]">Inbox</div>
          <div class="text-[10.5px] text-[var(--color-text-faint)] uppercase tracking-wider">Unassigned</div>
        </div>
        <span class="text-[11.5px] text-[var(--color-text-muted)] tabular-nums">{tasks.length}</span>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
        {tasks.length === 0 && (
          <div class="text-[11.5px] text-[var(--color-text-faint)] text-center py-6">
            {filtered ? 'No unassigned tasks in this view' : 'All tasks are assigned'}
          </div>
        )}
        {tasks.map((t) => (
          <InboxCard
            key={t.id}
            task={t}
            agents={agents}
            onChange={onChange}
            onDragStart={() => setDraggingId(t.id)}
            onDragEnd={() => setDraggingId(null)}
            isDragging={draggingId === t.id}
          />
        ))}
      </div>
    </div>
  );
}

// Width presets cycled by the maximize/minimize buttons in the header.
// Tracks the resize handle's clamping range from personalization.ts
// (240–640). Three quick stops give keyboard-free "compact / normal /
// wide" behavior without needing the mouse.
const WIDTH_PRESETS = [260, 320, 480];
const DEFAULT_WIDTH = 320;
const MIN_COLUMN_WIDTH = 240;
const MAX_COLUMN_WIDTH = 640;
const COLUMN_DRAG_MIME = 'application/x-mission-column';

function AgentColumn({
  agent, tasks, historyTasks, historyEnabled, onChange, onColumnDrop,
}: {
  agent: Agent;
  tasks: MissionTask[];
  historyTasks: MissionTask[];
  historyEnabled: boolean;
  onChange: () => void;
  onColumnDrop: (targetId: string, draggedId: string) => void;
}) {
  const [taskDragOver, setTaskDragOver] = useState(false);
  const [columnDragOver, setColumnDragOver] = useState(false);

  const widths = missionColumnWidths.value;
  const width = widths[agent.id] ?? DEFAULT_WIDTH;

  function cyclePreset(direction: 'up' | 'down') {
    const stops = WIDTH_PRESETS;
    const i = stops.findIndex((px) => px >= width);
    const idx = i < 0 ? stops.length - 1 : i;
    const next = direction === 'up'
      ? Math.min(stops.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    setMissionColumnWidth(agent.id, stops[next]);
  }

  // Card dropped from inbox or another column.
  async function handleTaskDrop(taskId: string) {
    try {
      await apiPatch(`/api/mission/tasks/${taskId}`, { assigned_agent: agent.id });
      onChange();
    } catch (err: any) {
      alert('Reassign failed: ' + (err?.message || err));
    }
  }

  // Top-level drop handler discriminates between a card drop (text/plain
  // is a task id) and a column reorder (custom MIME type).
  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setTaskDragOver(false); setColumnDragOver(false);
    const draggedColumnId = e.dataTransfer?.getData(COLUMN_DRAG_MIME);
    if (draggedColumnId) {
      onColumnDrop(agent.id, draggedColumnId);
      return;
    }
    const taskId = e.dataTransfer?.getData('text/plain');
    if (taskId) void handleTaskDrop(taskId);
  }

  return (
    <div
      class={[
        'shrink-0 flex flex-col bg-[var(--color-card)] border rounded-lg overflow-hidden relative pr-[5px] transition-colors',
        taskDragOver
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : columnDragOver
          ? 'border-[var(--color-accent)]'
          : 'border-[var(--color-border)]',
      ].join(' ')}
      role="group"
      aria-label={`${agent.name || agent.id} task column`}
      data-agent-column={agent.id}
      style={{ width: width + 'px' }}
      onDragOver={(e) => {
        e.preventDefault();
        const isColumn = Array.from(e.dataTransfer?.types ?? []).includes(COLUMN_DRAG_MIME);
        if (isColumn) setColumnDragOver(true); else setTaskDragOver(true);
      }}
      onDragLeave={(e) => {
        const rel = e.relatedTarget as Node | null;
        if (rel && (e.currentTarget as Node).contains(rel)) return;
        setTaskDragOver(false); setColumnDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div
        class="agent-column-banner px-3 py-3 border-b border-[var(--color-border)] bg-[var(--color-agent-banner)] flex items-center gap-2"
      >
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer?.setData(COLUMN_DRAG_MIME, agent.id);
            e.dataTransfer!.effectAllowed = 'move';
          }}
          class="cursor-grab active:cursor-grabbing text-[var(--color-text-faint)] hover:text-[var(--color-text-muted)] -ml-1"
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </button>
        <AgentAvatar agentId={agent.id} name={agent.name} running={agent.running} size={40} />
        <div class="flex-1 min-w-0">
          <div class="text-[13.5px] font-semibold text-[var(--color-text)] truncate">{agent.name || agent.id}</div>
          <div class="mt-0.5 flex">
            <AgentStatusBadge running={agent.running} />
          </div>
        </div>
        <span title={`${tasks.length} active tasks`} class="text-[11.5px] text-[var(--color-text-muted)] tabular-nums">{tasks.length}</span>
        <div class="flex items-center">
          <button
            type="button"
            onClick={() => cyclePreset('down')}
            disabled={width <= WIDTH_PRESETS[0]}
            class="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] disabled:opacity-30 transition-colors"
            title="Narrower"
          >
            <Minimize2 size={12} />
          </button>
          <button
            type="button"
            onClick={() => cyclePreset('up')}
            disabled={width >= WIDTH_PRESETS[WIDTH_PRESETS.length - 1]}
            class="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)] disabled:opacity-30 transition-colors"
            title="Wider"
          >
            <Maximize2 size={12} />
          </button>
        </div>
      </div>

      <MissionColumnPanels
        agentId={agent.id}
        agentName={agent.name || agent.id}
        activeCount={tasks.length}
        historyCount={historyTasks.length}
        historyEnabled={historyEnabled}
        activeContent={tasks.length ? tasks.map((task) => <TaskCard key={task.id} task={task} onChange={onChange} />) : <div class="px-3 py-6 text-center text-[11.5px] text-[var(--color-text-faint)]">No active tasks in this view</div>}
        historyContent={<MissionHistoryList tasks={historyTasks} onChange={onChange} />}
      />

      <ResizeHandle agentId={agent.id} currentWidth={width} />
    </div>
  );
}

// A dedicated 5px rail keeps resizing clear of each panel's scrollbar.
// Pointer capture keeps the interaction
// active beyond the handle. clientX reflects the zoomed surface while
// saved widths use layout pixels, so normalize the delta by UI scale.
function ResizeHandle({ agentId, currentWidth }: { agentId: string; currentWidth: number }) {
  const startX = useRef(0);
  const startWidth = useRef(0);
  const startScale = useRef(1);
  const dragging = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);

  useEffect(() => () => {
    if (pointerId.current !== null && handleRef.current?.hasPointerCapture(pointerId.current)) {
      handleRef.current.releasePointerCapture(pointerId.current);
    }
    pointerId.current = null;
    dragging.current = false;
  }, []);

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
    startWidth.current = currentWidth;
    startScale.current = uiScale.value || 1;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    if (!dragging.current) return;
    const dx = (e.clientX - startX.current) / startScale.current;
    setMissionColumnWidth(agentId, startWidth.current + dx);
  }
  function onUp() {
    dragging.current = false;
    const captured = pointerId.current;
    pointerId.current = null;
    if (captured !== null && handleRef.current?.hasPointerCapture(captured)) {
      handleRef.current.releasePointerCapture(captured);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setMissionColumnWidth(agentId, currentWidth - step);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setMissionColumnWidth(agentId, currentWidth + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setMissionColumnWidth(agentId, MIN_COLUMN_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      setMissionColumnWidth(agentId, MAX_COLUMN_WIDTH);
    }
  }

  return (
    <div
      ref={handleRef}
      onPointerDown={onPointerDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onKeyDown={onKeyDown}
      role="separator"
      aria-label={`Resize ${agentId} column`}
      aria-orientation="vertical"
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      aria-valuenow={currentWidth}
      tabIndex={0}
      class="group absolute inset-y-0 right-0 z-10 flex w-[5px] items-center justify-center border-l border-[var(--color-border)] bg-[var(--color-card)] cursor-col-resize touch-none outline-none hover:bg-[var(--color-accent-soft)] focus-visible:bg-[var(--color-accent-soft)]"
      title="Drag to resize. Use arrow keys for precise sizing."
    >
      <span aria-hidden="true" class="h-5 w-px rounded-full bg-[var(--color-text-faint)] group-hover:bg-[var(--color-accent)] group-focus-visible:bg-[var(--color-accent)]" />
    </div>
  );
}

// ── Layout menu ─────────────────────────────────────────────────────
//
// Layout presets snap every agent column to the same width. Viewport
// choices size columns against the board's measured width so 2/3/4 agents
// fit beside the Inbox; remaining agents continue in horizontal scroll.
//
// Inbox is intentionally not affected — it stays pinned at its
// hand-picked width regardless of layout choice.

const INBOX_WIDTH = 300;
const PAGE_PADDING_X = 32; // p-4 on container = 16 each side
const COLUMN_GAP = 12; // gap-3

function LayoutMenu({ agents, visibleAgentCount, viewportWidth, inboxVisible }: { agents: Agent[]; visibleAgentCount: number; viewportWidth: number; inboxVisible: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const widths = missionColumnWidths.value;

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  function applyUniform(px: number) {
    const next: Record<string, number> = {};
    for (const a of agents) next[a.id] = px;
    setMissionColumnWidthsBulk(next);
    setOpen(false);
  }

  function widthForVisibleCount(count: number): number | null {
    if (viewportWidth <= 0 || visibleAgentCount < count) return null;
    const gaps = count - 1 + (inboxVisible ? 1 : 0);
    const available = viewportWidth - (inboxVisible ? INBOX_WIDTH : 0) - PAGE_PADDING_X - gaps * COLUMN_GAP;
    const per = Math.floor(available / count);
    if (per < MIN_COLUMN_WIDTH) return null;
    return Math.min(MAX_COLUMN_WIDTH, per);
  }

  function applyVisibleCount(count: number) {
    const per = widthForVisibleCount(count);
    if (per === null) return;
    const next: Record<string, number> = {};
    for (const a of agents) next[a.id] = per;
    setMissionColumnWidthsBulk(next);
    setOpen(false);
  }

  function reset() {
    setMissionColumnWidthsBulk({});
    setOpen(false);
  }

  // Detect "currently active" preset by checking whether all agent
  // columns share a single width that matches one of our presets.
  const sample = agents[0] ? widths[agents[0].id] : undefined;
  const allSame = agents.length > 0 && agents.every((a) => widths[a.id] === sample);
  const activeVisibleCount = allSame
    ? [2, 3, 4].find((count) => widthForVisibleCount(count) === sample) ?? null
    : null;
  const activePreset =
    !allSame || activeVisibleCount !== null ? null
    : sample === 260 ? 'compact'
    : sample === 320 ? 'normal'
    : sample === 480 ? 'wide'
    : sample === undefined ? 'reset'
    : null;

  // PageHeader actions wrap on compact screens. Anchor the popup toward
  // whichever viewport edge has more physical room, then convert that
  // room back to the unzoomed CSS pixels used inside the scaled root.
  const layoutButtonRect = ref.current?.getBoundingClientRect();
  const appliedScale = uiScale.value || 1;
  const roomToLeft = layoutButtonRect ? layoutButtonRect.right - 8 : 280 * appliedScale;
  const roomToRight = layoutButtonRect ? window.innerWidth - layoutButtonRect.left - 8 : 280 * appliedScale;
  const alignPopupLeft = roomToRight > roomToLeft;
  const popupMaxWidth = Math.max(120, Math.min(280, (alignPopupLeft ? roomToRight : roomToLeft) / appliedScale));

  return (
    <div ref={ref} class="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        class="control-button inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors"
        title="Column layout presets"
      >
        <LayoutIcon size={13} /> Layout
      </button>
      {open && (
        <div
          class={[
            'layout-menu absolute top-full mt-1 z-50 w-[280px] bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg shadow-2xl overflow-hidden',
            alignPopupLeft ? 'left-0' : 'right-0',
          ].join(' ')}
          style={{ maxWidth: `${popupMaxWidth}px` }}
        >
          <div class="layout-menu-section px-3 py-2 section-label">Uniform width</div>
          <LayoutItem
            label="Compact"
            hint="260 px each"
            active={activePreset === 'compact'}
            onClick={() => applyUniform(260)}
          />
          <LayoutItem
            label="Normal"
            hint="320 px each"
            active={activePreset === 'normal'}
            onClick={() => applyUniform(320)}
          />
          <LayoutItem
            label="Wide"
            hint="480 px each"
            active={activePreset === 'wide'}
            onClick={() => applyUniform(480)}
          />
          <div class="layout-menu-section px-3 py-2 section-label">Columns on screen</div>
          {[2, 3, 4].map((count) => {
            const width = widthForVisibleCount(count);
            return (
              <LayoutItem
                key={count}
                label={`${count} agents visible`}
                hint={width === null ? 'not enough room' : `${width} px each`}
                active={activeVisibleCount === count}
                disabled={width === null}
                onClick={() => applyVisibleCount(count)}
              />
            );
          })}
          <div class="layout-menu-note px-3 py-2 text-[10.5px] leading-relaxed text-[var(--color-text-muted)]">
            {inboxVisible ? 'Inbox uses 300 px. ' : 'Inbox is hidden. '}Additional agents continue horizontally.
          </div>
          <LayoutItem
            label="Reset widths"
            hint="clear custom widths"
            active={activePreset === 'reset'}
            onClick={reset}
          />
          <LayoutItem
            label="Reset panels"
            hint="60/40 with both panels open"
            onClick={() => { resetMissionPanels(agents.map((agent) => agent.id)); setOpen(false); }}
          />
        </div>
      )}
    </div>
  );
}

function LayoutItem({
  label, hint, active, disabled, onClick,
}: {
  label: string; hint: string; active?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      class={`layout-menu-item control-menu-item w-full flex items-center gap-2 px-3 py-2 text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'control-accent' : 'text-[var(--color-text)]'}`}
    >
      <span>{label}</span>
      <span class="ml-auto text-[10.5px] text-[var(--color-text-muted)]">{hint}</span>
      {active && <Check size={12} class="ml-1 shrink-0" />}
    </button>
  );
}

// ── Cards ──────────────────────────────────────────────────────────

function InboxCard({
  task, agents, onChange, onDragStart, onDragEnd, isDragging,
}: {
  task: MissionTask; agents: Agent[]; onChange: () => void;
  onDragStart: () => void; onDragEnd: () => void; isDragging: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  async function autoAssign() {
    setBusy('assign');
    try {
      const res = await apiPost<{ ok: boolean; assigned_agent?: string }>(`/api/mission/tasks/${task.id}/auto-assign`);
      onChange();
      pushToast({
        tone: 'success',
        title: 'Auto-assigned',
        description: res.assigned_agent ? `Routed to @${resolveAgentName(res.assigned_agent)}.` : 'Routed.',
      });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Auto-assign failed', description: err?.message || String(err), durationMs: 6000 });
    } finally { setBusy(null); }
  }

  async function manualAssign(agentId: string) {
    setBusy('manual');
    try {
      await apiPatch(`/api/mission/tasks/${task.id}`, { assigned_agent: agentId });
      onChange();
      pushToast({ tone: 'success', title: 'Assigned', description: `Routed to @${resolveAgentName(agentId)}.` });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Assign failed', description: err?.message || String(err), durationMs: 6000 });
    } finally { setBusy(null); }
  }

  async function cancel() {
    setBusy('cancel');
    try {
      const result = await apiPost<{ ok: boolean }>(`/api/mission/tasks/${task.id}/cancel`);
      if (!result.ok) throw new Error('This task is no longer active. Refresh the board to see its current status.');
      onChange();
      setDetailsOpen(false);
      pushToast({ tone: 'success', title: 'Task cancelled' });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Cancel failed', description: err?.message || String(err), durationMs: 6000 });
    } finally { setBusy(null); }
  }

  return (
    <>
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer?.setData('text/plain', task.id); onDragStart(); }}
      onDragEnd={onDragEnd}
      class={[
        'bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md p-2.5 transition-all',
        isDragging ? 'opacity-40' : 'hover:border-[var(--color-border-strong)] cursor-grab',
      ].join(' ')}
    >
      <div
        class="cursor-pointer"
        onClick={() => setDetailsOpen(true)}
        title="Open task details"
      >
        <div class="flex items-center gap-1.5 mb-1">
          <Pill tone="neutral">unassigned</Pill>
          <span class="ml-auto text-[10px] text-[var(--color-text-faint)] tabular-nums">
            {formatRelativeTime(task.created_at)}
          </span>
        </div>
        <div class="text-[12.5px] text-[var(--color-text)] leading-snug mb-1.5 line-clamp-2">
          {task.title}
        </div>
      </div>
      {/* draggable=false on the action row stops the parent's HTML5 drag
          from swallowing button clicks. Without it, mousedown on Auto /
          select / Trash gets intercepted as drag-prep and onClick never
          fires. The card body above stays draggable so reassign-by-drag
          still works. */}
      <div
        class="flex items-center gap-1"
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={autoAssign}
          disabled={busy !== null}
          class="control-button inline-flex items-center gap-1 px-2 py-1 rounded text-[10.5px] font-medium control-accent transition-colors disabled:opacity-40"
        >
          <Wand2 size={11} /> {busy === 'assign' ? '…' : 'Auto'}
        </button>
        <select
          value=""
          onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) manualAssign(v); }}
          disabled={busy !== null}
          class="flex-1 bg-[var(--color-card)] border border-[var(--color-border)] rounded text-[10.5px] text-[var(--color-text-muted)] px-1 py-0.5 outline-none"
        >
          <option value="">Assign to…</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
        </select>
        <button
          type="button"
          onClick={cancel}
          disabled={busy !== null}
          class="inline-flex items-center gap-1 px-2 py-1 rounded text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] transition-colors disabled:opacity-40"
          aria-label={`Cancel task: ${task.title}`}
        >
          <X size={11} /> {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </div>

    <TaskDetailsModal
      open={detailsOpen}
      onClose={() => setDetailsOpen(false)}
      task={task}
      agents={agents}
      busy={busy}
      onAutoAssign={async () => { await autoAssign(); setDetailsOpen(false); }}
      onManualAssign={async (agentId) => { await manualAssign(agentId); setDetailsOpen(false); }}
      onCancel={cancel}
    />
    </>
  );
}

// Modal preview for an unassigned inbox task. Opened when the user
// clicks the card body. Lets them see the full prompt + assign or
// cancel in a focused view rather than fighting the cramped action
// row in the card.
function TaskDetailsModal({
  open, onClose, task, agents, busy, onAutoAssign, onManualAssign, onCancel,
}: {
  open: boolean;
  onClose: () => void;
  task: MissionTask;
  agents: Agent[];
  busy: string | null;
  onAutoAssign: () => Promise<void> | void;
  onManualAssign: (agentId: string) => Promise<void> | void;
  onCancel: () => Promise<void> | void;
}) {
  const [pickerAgent, setPickerAgent] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={'Task · ' + task.id.slice(0, 8)}
      width={560}
      footer={
        <>
          <button
            type="button"
            onClick={() => onCancel()}
            disabled={busy !== null}
            class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] border border-[var(--color-border)] hover:border-[var(--color-status-failed)] transition-colors disabled:opacity-40"
          >
            <X size={12} /> {busy === 'cancel' ? 'Cancelling…' : 'Cancel task'}
          </button>
          <div class="ml-auto flex items-center gap-2">
            <select
              value={pickerAgent}
              onChange={(e) => setPickerAgent((e.target as HTMLSelectElement).value)}
              disabled={busy !== null}
              class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2 py-1 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">Assign to…</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
            <button
              type="button"
              onClick={() => pickerAgent && onManualAssign(pickerAgent)}
              disabled={!pickerAgent || busy !== null}
              class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] bg-[var(--color-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === 'manual' ? 'Assigning…' : 'Assign'}
            </button>
            <button
              type="button"
              onClick={() => onAutoAssign()}
              disabled={busy !== null}
              class="control-button inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium control-accent disabled:opacity-40 transition-colors"
            >
              <Wand2 size={12} /> {busy === 'assign' ? 'Classifying…' : 'Auto-assign'}
            </button>
          </div>
        </>
      }
    >
      <div class="space-y-3">
        <div>
          <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Title</div>
          <div class="text-[14px] text-[var(--color-text)] leading-snug">{task.title}</div>
        </div>
        {task.prompt && task.prompt !== task.title && (
          <div>
            <div class="text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Prompt</div>
            <div class="text-[12.5px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono leading-relaxed bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3">
              {task.prompt}
            </div>
          </div>
        )}
        <div class="grid grid-cols-3 gap-3 pt-1">
          <Stat label="Created" value={formatRelativeTime(task.created_at)} />
          <Stat label="Priority" value={task.priority > 0 ? 'P' + task.priority : '—'} />
          <Stat label="Created by" value={task.created_by || 'dashboard'} />
        </div>
      </div>
    </Modal>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">{label}</div>
      <div class="text-[12.5px] text-[var(--color-text)] tabular-nums">{value}</div>
    </div>
  );
}

function TaskCard({ task, onChange }: { task: MissionTask; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const priorityTone = task.priority >= 7 ? 'high' : task.priority >= 4 ? 'medium' : 'low';
  const draggable = task.status === 'queued';
  const availability = missionAvailability(task);
  const statusTone = task.status === 'waiting' ? 'queued'
    : task.status === 'completed' ? 'done'
    : task.status === 'blocked' ? 'failed'
    : task.status === 'queued' || task.status === 'running' || task.status === 'failed' || task.status === 'cancelled' ? task.status
    : 'neutral';

  async function cancel() {
    setActionError(null);
    setBusy('cancel');
    try {
      const result = await apiPost<{ ok: boolean }>(`/api/mission/tasks/${task.id}/cancel`);
      if (!result.ok) throw new Error('This task is no longer active. Refresh the board to see its current status.');
      onChange();
      pushToast({ tone: 'success', title: 'Task cancelled' });
    } catch (err: any) { setActionError(err?.message || String(err)); }
    finally { setBusy(null); }
  }

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => { if (draggable) e.dataTransfer?.setData('text/plain', task.id); }}
      onClick={() => setExpanded((v) => !v)}
      class={[
        'bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-md p-2.5 transition-colors',
        draggable ? 'cursor-grab' : 'cursor-pointer',
        'hover:border-[var(--color-border-strong)]',
      ].join(' ')}
    >
      <div class="flex items-center gap-1.5 mb-1">
        <StatusDot tone={statusTone} />
        <span class="text-[10px] text-[var(--color-text-faint)] tabular-nums uppercase tracking-wider">
          {task.id.slice(0, 6)}
        </span>
        <span class="ml-auto text-[10px] text-[var(--color-text-faint)]">
          {formatRelativeTime(task.completed_at || task.started_at || task.created_at)}
        </span>
      </div>
      <div class={'text-[12.5px] text-[var(--color-text)] leading-snug mb-1.5 ' + (expanded ? '' : 'line-clamp-2')}>
        {task.title}
      </div>
      {availability && (
        <div
          class="flex items-center gap-1 mb-1.5 text-[10.5px] tabular-nums text-[var(--color-accent)]"
          title={new Date(task.available_at! * 1000).toISOString()}
        >
          <Clock3 size={11} aria-hidden="true" />
          <span>{availability}</span>
        </div>
      )}
      <div class="flex items-center gap-1.5 flex-wrap">
        {task.priority > 0 && <Pill tone={priorityTone}>P{task.priority}</Pill>}
        <Pill tone={statusTone}>{task.status}</Pill>
        <div class="ml-auto flex items-center gap-1">
          {(task.status === 'queued' || task.status === 'running' || task.status === 'waiting') && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); cancel(); }}
              disabled={busy !== null}
              draggable={false}
              onPointerDown={(e) => e.stopPropagation()}
              onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              class="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--color-border)] text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-status-failed)] hover:border-[var(--color-status-failed)] transition-colors disabled:opacity-40"
              aria-label={`Cancel task: ${task.title}`}
            >
              <X size={11} /> {busy === 'cancel' ? 'Cancelling…' : 'Cancel task'}
            </button>
          )}
        </div>
      </div>
      {actionError && <div role="alert" class="mt-2 text-[11px] text-[var(--color-status-failed)]">{actionError}</div>}
      {expanded && task.prompt && task.prompt !== task.title && (
        <div class="mt-2 text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap font-mono leading-relaxed">
          {task.prompt}
        </div>
      )}
      {expanded && task.result && (
        <div class="mt-2 text-[11px] text-[var(--color-text)] whitespace-pre-wrap leading-relaxed border-t border-[var(--color-border)] pt-2">
          {task.result}
        </div>
      )}
      {task.error && (
        <div class="mt-1.5 text-[10.5px] text-[var(--color-status-failed)] line-clamp-2 font-mono">
          {task.error}
        </div>
      )}
    </div>
  );
}

// ── Create modal ───────────────────────────────────────────────────

function CreateTaskModal({
  open, onClose, agents, onCreated,
}: {
  open: boolean; onClose: () => void; agents: Agent[]; onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<string>('');
  const [priority, setPriority] = useState(5);
  const [autoAssign, setAutoAssign] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function close() {
    setTitle(''); setPrompt(''); setAgent(''); setPriority(5); setAutoAssign(true); setErr(null);
    onClose();
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: any = { title: title.trim(), prompt: prompt.trim(), priority };
      if (!autoAssign && agent) body.assigned_agent = agent;
      const created = await apiPost<{ task: MissionTask }>('/api/mission/tasks', body);
      if (autoAssign && !agent) {
        // Fire auto-assign in background; don't block the modal close.
        apiPost(`/api/mission/tasks/${created.task.id}/auto-assign`).catch(() => {});
      }
      onCreated();
      close();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="New mission task"
      width={520}
      footer={
        <>
          <button type="button" onClick={close} class="px-3 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !title.trim() || !prompt.trim()}
            class="control-button ml-auto px-3 py-1.5 rounded text-[12px] font-medium control-accent disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div class="space-y-3">
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Title</label>
          <input
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="Short label (max 200 chars)"
            maxLength={200}
            autoFocus
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <div>
          <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Prompt</label>
          <textarea
            value={prompt}
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="Full instructions for the agent. Max 10000 chars."
            maxLength={10000}
            rows={6}
            class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-accent)] resize-none font-mono"
          />
          <div class="text-[10px] text-[var(--color-text-faint)] mt-0.5 tabular-nums">{prompt.length} / 10000</div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Assign</label>
            <select
              value={autoAssign ? '__auto' : agent}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                if (v === '__auto') { setAutoAssign(true); setAgent(''); }
                else { setAutoAssign(false); setAgent(v); }
              }}
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
            >
              <option value="__auto">Auto (Gemini classifier)</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          </div>
          <div>
            <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">Priority (0–10)</label>
            <input
              type="number"
              min={0}
              max={10}
              value={priority}
              onInput={(e) => setPriority(Math.max(0, Math.min(10, Number((e.target as HTMLInputElement).value) || 0)))}
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] tabular-nums outline-none focus:border-[var(--color-accent)]"
            />
          </div>
        </div>
        {err && <div class="text-[var(--color-status-failed)] text-[11px]">{err}</div>}
      </div>
    </Modal>
  );
}
