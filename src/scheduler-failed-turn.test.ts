import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNextMissionTask, completeMissionTask, maybeReleaseJoinForMission, updateTaskAfterRun } from './db.js';

// Routing regression for failed turns: both engines can surface a failure as a
// normal (non-thrown, non-aborted) result — Claude SDK via usage.isError /
// stopReason 'error_during_execution', Codex app-server via the error message
// in result.text with stopReason 'error'. The scheduler must route those to
// 'failed', never to the success path. runAgent is mocked: no real LLM call in
// tests — the system under test here is the routing layer, not the engine.

const state = vi.hoisted(() => ({
  dueTasks: [] as Array<{ id: string; prompt: string; schedule: string; acceptance_check?: string | null }>,
  mission: null as Record<string, unknown> | null,
  agentResult: { text: 'ok', newSessionId: undefined, usage: null } as Record<string, unknown>,
  enqueued: [] as Array<() => Promise<void>>,
}));

vi.mock('./config.js', () => ({
  AGENT_ID: 'main',
  ALLOWED_CHAT_ID: 'chat-1',
  agentMcpAllowlist: [],
  agentDefaultModel: undefined,
  agentProvider: undefined,
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
  getDueTasks: vi.fn(() => state.dueTasks),
  getSession: vi.fn(() => undefined),
  logConversationTurn: vi.fn(),
  markTaskRunning: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  resetStuckTasks: vi.fn(() => 0),
  claimNextMissionTask: vi.fn(() => {
    const m = state.mission;
    state.mission = null;
    return m;
  }),
  completeMissionTask: vi.fn(),
  maybeReleaseJoinForMission: vi.fn(),
  resetStuckMissionTasks: vi.fn(() => 0),
  getMissionTask: vi.fn(() => null),
  areAllGroupChildrenTerminal: vi.fn(() => false),
  getGroupChildren: vi.fn(() => []),
  getJoinMission: vi.fn(() => null),
  releaseJoinMission: vi.fn(() => false),
  updateMissionPrompt: vi.fn(),
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
  // Mirrors the real predicate (unit-tested in agent.test.ts); importing the
  // actual module here would pull the whole engine tree under partial mocks.
  isFailedTurn: (r: { usage?: { isError?: boolean } | null; stopReason?: string }) =>
    r.usage?.isError === true || r.stopReason?.startsWith('error') === true,
  runAgent: vi.fn(async () => state.agentResult),
}));

async function runSchedulerCycle(send: (text: string) => Promise<void>) {
  const { initScheduler } = await import('./scheduler.js');
  initScheduler(send as never, 'main');
  await vi.runOnlyPendingTimersAsync();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  for (const fn of state.enqueued) await fn();
}

describe('scheduler failed-turn routing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    state.dueTasks = [];
    state.mission = null;
    state.enqueued.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('routes an errored cron task run to last_status failed', async () => {
    state.dueTasks = [{ id: 'cron-1', prompt: 'daily briefing', schedule: '0 8 * * *', acceptance_check: null }];
    state.agentResult = {
      text: null,
      newSessionId: undefined,
      stopReason: 'error_during_execution',
      usage: { isError: true },
    };
    const send = vi.fn(async () => {});

    await runSchedulerCycle(send);

    expect(vi.mocked(updateTaskAfterRun)).toHaveBeenCalledWith(
      'cron-1',
      expect.any(Number),
      expect.stringContaining('Agent run failed (error_during_execution)'),
      'failed',
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining('❌ Task failed'));
  });

  it('keeps a Codex error message as the error, never as the result', async () => {
    state.dueTasks = [{ id: 'cron-2', prompt: 'sync inbox', schedule: '0 8 * * *', acceptance_check: null }];
    state.agentResult = {
      text: 'stream disconnected before completion',
      newSessionId: undefined,
      stopReason: 'error',
      usage: null,
    };
    const send = vi.fn(async () => {});

    await runSchedulerCycle(send);

    expect(vi.mocked(updateTaskAfterRun)).toHaveBeenCalledWith(
      'cron-2',
      expect.any(Number),
      expect.stringContaining('Agent run failed (error): stream disconnected'),
      'failed',
    );
    // The error text must not be delivered as a task result.
    expect(send).not.toHaveBeenCalledWith('stream disconnected before completion');
  });

  it('routes an errored mission run to failed and enters the join-release path', async () => {
    state.mission = {
      id: 'm1',
      title: 'Research X',
      prompt: 'go',
      role: 'task',
      group_id: 'g1',
      created_by: 'main',
      assigned_agent: 'research',
      status: 'running',
    };
    state.agentResult = {
      text: null,
      newSessionId: undefined,
      stopReason: 'error_during_execution',
      usage: { isError: true },
    };
    const send = vi.fn(async () => {});

    await runSchedulerCycle(send);

    expect(vi.mocked(claimNextMissionTask)).toHaveBeenCalled();
    expect(vi.mocked(completeMissionTask)).toHaveBeenCalledWith(
      'm1',
      null,
      'failed',
      expect.stringContaining('Agent run failed (error_during_execution)'),
    );
    expect(vi.mocked(maybeReleaseJoinForMission)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', status: 'failed' }),
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining('❌ Mission task failed'));
  });

  it('still routes a healthy run to the success path', async () => {
    state.mission = {
      id: 'm2',
      title: 'Report Y',
      prompt: 'go',
      role: 'task',
      group_id: null,
      created_by: 'main',
      assigned_agent: 'research',
      status: 'running',
    };
    state.agentResult = { text: 'all good', newSessionId: undefined, usage: null };
    const send = vi.fn(async () => {});

    await runSchedulerCycle(send);

    expect(vi.mocked(completeMissionTask)).toHaveBeenCalledWith('m2', 'all good', 'completed');
    expect(send).toHaveBeenCalledWith('all good');
  });
});
