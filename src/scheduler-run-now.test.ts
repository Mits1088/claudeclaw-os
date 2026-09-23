import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markTaskRunning, updateTaskAfterRun } from './db.js';
import type { ScheduledTask } from './db.js';

const state = vi.hoisted(() => ({
  enqueued: [] as Array<() => Promise<void>>,
  failRun: false,
}));

vi.mock('./config.js', () => ({
  AGENT_ID: 'main',
  ALLOWED_CHAT_ID: 'chat-1',
  SCHEDULER_IDLE_TIMEOUT_MS: 900_000,
  SCHEDULER_MAX_RUNTIME_MS: 1_800_000,
  agentMcpAllowlist: [],
  agentDefaultModel: undefined,
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./message-queue.js', () => ({
  messageQueue: {
    enqueue: vi.fn((_chatId: string, fn: () => Promise<void>) => {
      state.enqueued.push(fn);
    }),
  },
}));

vi.mock('./db.js', () => ({
  getDueTasks: vi.fn(() => []),
  getSession: vi.fn(() => undefined),
  logConversationTurn: vi.fn(),
  markTaskRunning: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  resetStuckTasks: vi.fn(() => 0),
  claimNextMissionTask: vi.fn(() => null),
  completeMissionTask: vi.fn(),
  resetStuckMissionTasks: vi.fn(() => 0),
  failStuckMissionTasks: vi.fn(() => 0),
  getMissionTask: vi.fn(() => null),
  missionClaimIsCurrent: vi.fn(() => true),
  maybeReleaseJoinForMission: vi.fn(),
  isWorkerLeaseCurrent: vi.fn(() => true),
  markWorkerTaskScopeStarted: vi.fn(() => true),
  deactivateWorkerIfTaskScopeDrained: vi.fn(() => false),
}));

vi.mock('./bot.js', () => ({
  formatForTelegram: vi.fn((text: string) => text),
  splitMessage: vi.fn((text: string) => [text]),
}));

vi.mock('./active-provider.js', () => ({
  getSelectedProviderConfig: vi.fn(() => undefined),
}));

vi.mock('./memory-ingest.js', () => ({
  ingestConversationTurn: vi.fn(async () => {}),
}));

vi.mock('./agent.js', () => ({
  isFailedTurn: vi.fn(() => false),
  runAgent: vi.fn(async () => {
    if (state.failRun) throw new Error('provider unavailable');
    return { text: 'manual result', newSessionId: undefined, usage: null };
  }),
}));

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    prompt: 'prepare the report',
    schedule: '0 9 * * *',
    next_run: 2_000_000_000,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: 1,
    agent_id: 'main',
    started_at: null,
    last_status: null,
    acceptance_check: null,
    resume_status: null,
    ...overrides,
  };
}

describe('scheduled task Run now', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.enqueued.length = 0;
    state.failRun = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function initializedScheduler() {
    const scheduler = await import('./scheduler.js');
    scheduler.initScheduler(vi.fn(async () => {}), 'main');
    return scheduler;
  }

  it('queues an immediate run and rejects a duplicate while it is pending', async () => {
    const scheduler = await initializedScheduler();
    const scheduled = task();

    expect(scheduler.queueScheduledTaskNow(scheduled)).toEqual({ ok: true, queued: true });
    expect(vi.mocked(markTaskRunning)).toHaveBeenCalledWith('task-1', undefined);
    expect(state.enqueued).toHaveLength(1);

    expect(scheduler.queueScheduledTaskNow(scheduled)).toMatchObject({
      ok: false,
      reason: 'already_running',
    });
  });

  it('preserves next_run when completing a paused manual run', async () => {
    const scheduler = await initializedScheduler();
    const scheduled = task({ status: 'paused', next_run: 2_100_000_000 });

    expect(scheduler.queueScheduledTaskNow(scheduled)).toEqual({ ok: true, queued: true });
    await state.enqueued[0]();

    expect(vi.mocked(updateTaskAfterRun)).toHaveBeenCalledWith(
      'task-1',
      2_100_000_000,
      'manual result',
      'success',
    );
  });

  it('cleans up its running guard after failure so the task can be retried', async () => {
    const scheduler = await initializedScheduler();
    const scheduled = task();
    state.failRun = true;

    expect(scheduler.queueScheduledTaskNow(scheduled).ok).toBe(true);
    await state.enqueued[0]();

    expect(vi.mocked(updateTaskAfterRun)).toHaveBeenCalledWith(
      'task-1',
      scheduled.next_run,
      'provider unavailable',
      'failed',
    );
    expect(scheduler.queueScheduledTaskNow(scheduled).ok).toBe(true);
  });

  it('refuses to run a task owned by another agent', async () => {
    const scheduler = await initializedScheduler();

    expect(scheduler.queueScheduledTaskNow(task({ agent_id: 'research' }))).toMatchObject({
      ok: false,
      reason: 'unsupported_agent',
    });
    expect(state.enqueued).toHaveLength(0);
  });
});
