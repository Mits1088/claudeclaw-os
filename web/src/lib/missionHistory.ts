export type MissionHistoryStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface MissionHistoryTask {
  id: string;
  title: string;
  prompt: string;
  assigned_agent: string | null;
  status: MissionHistoryStatus;
  priority: number;
  created_by: string;
  created_at: number;
  available_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

export type MissionHistoryOutcome = 'all' | 'completed' | 'failed' | 'cancelled' | 'blocked';

export interface MissionHistoryFilters {
  search?: string;
  agentId?: 'all' | 'unassigned' | string;
  outcome?: MissionHistoryOutcome;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);

export function isTerminalMissionStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function historyTimestamp(task: MissionHistoryTask): number {
  return task.completed_at ?? task.created_at;
}

/** Return terminal tasks newest-first without mutating the caller's array. */
export function sortMissionHistory<T extends MissionHistoryTask>(tasks: readonly T[]): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => isTerminalMissionStatus(task.status))
    .sort((a, b) => {
      const byTime = historyTimestamp(b.task) - historyTimestamp(a.task);
      if (byTime !== 0) return byTime;
      const byId = a.task.id.localeCompare(b.task.id);
      return byId !== 0 ? byId : a.index - b.index;
    })
    .map(({ task }) => task);
}

/** Filter all loaded mission records using the archive's visible controls. */
export function filterMissionHistory<T extends MissionHistoryTask>(
  tasks: readonly T[],
  filters: MissionHistoryFilters = {},
): T[] {
  const query = filters.search?.trim().toLocaleLowerCase() ?? '';
  const agentId = filters.agentId ?? 'all';
  const outcome = filters.outcome ?? 'all';

  return sortMissionHistory(tasks).filter((task) => {
    if (outcome !== 'all' && task.status !== outcome) return false;
    if (agentId === 'unassigned' && task.assigned_agent !== null) return false;
    if (agentId !== 'all' && agentId !== 'unassigned' && task.assigned_agent !== agentId) return false;
    if (!query) return true;

    const searchable = [task.id, task.title, task.prompt, task.result ?? '', task.error ?? '']
      .join('\n')
      .toLocaleLowerCase();
    return searchable.includes(query);
  });
}
