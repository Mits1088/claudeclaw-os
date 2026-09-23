import { describe, expect, it } from 'vitest';

type MissionHistoryStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'blocked';
interface MissionHistoryTask {
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
interface HistoryHelpers {
  isTerminalMissionStatus(status: string): boolean;
  sortMissionHistory(tasks: readonly MissionHistoryTask[]): MissionHistoryTask[];
  filterMissionHistory(
    tasks: readonly MissionHistoryTask[],
    filters?: { search?: string; agentId?: string; outcome?: 'all' | 'completed' | 'failed' | 'cancelled' | 'blocked' },
  ): MissionHistoryTask[];
}

// Keep the server build's rootDir isolated while exercising the real web helper
// through Vitest's module runner.
const historyModulePath = ['..', 'web', 'src', 'lib', 'missionHistory.ts'].join('/');
const {
  filterMissionHistory,
  isTerminalMissionStatus,
  sortMissionHistory,
} = await import(historyModulePath) as HistoryHelpers;

function task(
  id: string,
  status: MissionHistoryStatus,
  overrides: Partial<MissionHistoryTask> = {},
): MissionHistoryTask {
  return {
    id,
    title: `Task ${id}`,
    prompt: `Prompt ${id}`,
    assigned_agent: 'main',
    status,
    priority: 5,
    created_by: 'dashboard',
    created_at: 100,
    available_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    ...overrides,
  };
}

describe('mission history view helpers', () => {
  it('isolates terminal outcomes from active task states', () => {
    const tasks = [
      task('queued', 'queued'),
      task('running', 'running'),
      task('waiting', 'waiting'),
      task('complete', 'completed'),
      task('failed', 'failed'),
      task('cancelled', 'cancelled'),
      task('blocked', 'blocked'),
    ];

    expect(sortMissionHistory(tasks).map((item) => item.id)).toEqual(['blocked', 'cancelled', 'complete', 'failed']);
    expect(isTerminalMissionStatus('completed')).toBe(true);
    expect(isTerminalMissionStatus('blocked')).toBe(true);
    expect(isTerminalMissionStatus('waiting')).toBe(false);
  });

  it('keeps legacy blocked records in history and filters them by outcome', () => {
    const blocked = task('legacy-blocked', 'blocked', { error: 'Quarantined by rollback' });
    const completed = task('new-complete', 'completed');

    expect(filterMissionHistory([completed, blocked], { outcome: 'blocked' })).toEqual([blocked]);
  });

  it('orders by completion time and falls back to creation time', () => {
    const tasks = [
      task('finished-later', 'completed', { created_at: 10, completed_at: 400 }),
      task('missing-completion', 'failed', { created_at: 500 }),
      task('finished-earlier', 'completed', { created_at: 300, completed_at: 350 }),
    ];

    expect(sortMissionHistory(tasks).map((item) => item.id)).toEqual([
      'missing-completion',
      'finished-later',
      'finished-earlier',
    ]);
  });

  it('moves a task into history when polling reports it completed', () => {
    const active = task('handoff', 'running', { started_at: 120 });
    expect(sortMissionHistory([active])).toEqual([]);

    const completed = { ...active, status: 'completed' as const, completed_at: 180, result: 'Done' };
    expect(sortMissionHistory([completed])).toEqual([completed]);
  });

  it('composes text, agent, and outcome filters across full task details', () => {
    const tasks = [
      task('match', 'failed', {
        assigned_agent: 'research',
        title: 'Quarterly synthesis',
        prompt: 'Review the current research',
        result: 'Contained the rare phrase Silver Comet',
        error: 'Source timeout',
      }),
      task('wrong-agent', 'failed', {
        assigned_agent: 'main',
        result: 'Silver Comet',
      }),
      task('wrong-outcome', 'completed', {
        assigned_agent: 'research',
        error: 'Silver Comet',
      }),
    ];

    expect(filterMissionHistory(tasks, {
      search: 'silver comet',
      agentId: 'research',
      outcome: 'failed',
    }).map((item) => item.id)).toEqual(['match']);
  });

  it('filters unassigned history independently of assigned agents', () => {
    const tasks = [
      task('unassigned', 'completed', { assigned_agent: null }),
      task('assigned', 'completed', { assigned_agent: 'main' }),
    ];

    expect(filterMissionHistory(tasks, { agentId: 'unassigned' }).map((item) => item.id)).toEqual(['unassigned']);
  });

  it('does not mutate input and keeps duplicate ties stable', () => {
    const first = task('same-id', 'completed', { title: 'First', completed_at: 200 });
    const second = task('same-id', 'completed', { title: 'Second', completed_at: 200 });
    const laterId = task('z-id', 'completed', { completed_at: 200 });
    const earlierId = task('a-id', 'completed', { completed_at: 200 });
    const input = [laterId, first, earlierId, second];
    const snapshot = [...input];

    const sorted = sortMissionHistory(input);

    expect(input).toEqual(snapshot);
    expect(sorted.map((item) => item.id)).toEqual(['a-id', 'same-id', 'same-id', 'z-id']);
    expect(sorted[1]).toBe(first);
    expect(sorted[2]).toBe(second);
  });
});
