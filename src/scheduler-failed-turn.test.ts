vi.mock('./mission-provider-execution.js', () => ({ prepareMissionProvider: vi.fn((_mission, provider) => ({ kind: 'run', attempt: { provider } })), recoverMissionProvider: vi.fn(() => false), settleMissionProviderHealth: vi.fn(() => null) }));
vi.mock('./mission-reporting.js', () => ({ deliverMissionWorkflowReport: vi.fn(async () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimNextMissionTask, completeMissionTask, maybeReleaseJoinForMission, updateTaskAfterRun, saveTokenUsage } from './db.js';
import { settleMissionProviderHealth } from './mission-provider-execution.js';

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
  missionCompleted: false,
}));

vi.mock('./config.js', () => ({
  AGENT_ID: 'main',
  ALLOWED_CHAT_ID: 'chat-1',
  SCHEDULER_IDLE_TIMEOUT_MS: 900_000,
  SCHEDULER_MAX_RUNTIME_MS: 1_800_000,
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
  saveTokenUsage: vi.fn(),
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
  completeMissionTask: vi.fn(() => { state.missionCompleted = true; }),
  maybeReleaseJoinForMission: vi.fn(),
  resetStuckMissionTasks: vi.fn(() => 0),
  failStuckMissionTasks: vi.fn(() => 0),
  reconcileMissionControl: vi.fn(() => ({
    expiredWorkflows: 0, recoveredOutcomes: 0, releasedJoins: 0,
    blockedJoins: 0, queuedCoordinators: 0, blockedOutcomes: 0,
  })),
  getMissionTask: vi.fn(() => null),
  areAllGroupChildrenTerminal: vi.fn(() => false),
  getGroupChildren: vi.fn(() => []),
  getJoinMission: vi.fn(() => null),
  releaseJoinMission: vi.fn(() => false),
  updateMissionPrompt: vi.fn(),
  isWorkerLeaseCurrent: vi.fn(() => true),
  markWorkerTaskScopeStarted: vi.fn(() => true),
  deactivateWorkerIfTaskScopeDrained: vi.fn(() => state.missionCompleted),
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

async function runSchedulerCycle(
  send: (text: string) => Promise<void>,
  worker?: { instanceId: string; lifecycle: 'persistent' | 'task-scoped'; onDrained?: () => void },
) {
  const { initScheduler } = await import('./scheduler.js');
  initScheduler(send as never, 'main', worker?.instanceId, worker?.lifecycle, worker?.onDrained);
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
    state.missionCompleted = false;
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

    expect(send).toHaveBeenNthCalledWith(1, '🕐 Scheduled job running: "daily briefing"\nJob ID: cron-1');
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

    expect(send).toHaveBeenNthCalledWith(1, '🎯 Mission task running: "Research X"\nTask ID: m1');
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

    expect(send).toHaveBeenNthCalledWith(1, '🎯 Mission task running: "Report Y"\nTask ID: m2');
    expect(vi.mocked(completeMissionTask)).toHaveBeenCalledWith('m2', 'all good', 'completed');
    expect(send).toHaveBeenCalledWith('all good');
  });

  it('preserves completed execution and settles health when ancillary usage recording fails', async () => {
    state.mission = { id: 'usage-busy', title: 'Executed work', prompt: 'go', role: 'task',
      workflow_id: 'wf-usage', created_by: 'main', assigned_agent: 'research', status: 'running' };
    state.agentResult = { text: 'completed evidence', usage: { inputTokens: 10, outputTokens: 4 } };
    vi.mocked(saveTokenUsage).mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
    await runSchedulerCycle(vi.fn(async () => {}));
    expect(settleMissionProviderHealth).toHaveBeenCalledTimes(1);
    expect(completeMissionTask).toHaveBeenCalledTimes(1);
    expect(completeMissionTask).toHaveBeenCalledWith('usage-busy', 'completed evidence', 'completed');
  });

  it('persists workflow worker findings without publishing intermediate completion', async () => {
    state.mission = {
      id: 'workflow-worker', title: 'Verify missing evidence', prompt: 'verify',
      role: 'task', workflow_id: 'wf-1', created_by: 'main', assigned_agent: 'research', status: 'running',
    };
    state.agentResult = { text: 'unverified intermediate finding', usage: null };
    const send = vi.fn(async () => {});
    await runSchedulerCycle(send);
    expect(completeMissionTask).toHaveBeenCalledWith('workflow-worker', 'unverified intermediate finding', 'completed');
    expect(send).not.toHaveBeenCalled();
  });

  it('arms a task-scoped worker and requests shutdown only after its mission completes', async () => {
    state.mission = {
      id: 'scope-root',
      title: 'One bounded task',
      prompt: 'finish this task',
      assigned_agent: 'temporary',
      created_by: 'main',
      role: 'task',
      continuation_limit: 1,
    };
    state.agentResult = { text: 'done', newSessionId: undefined, usage: null };
    const send = vi.fn(async () => {});
    const onDrained = vi.fn();

    await runSchedulerCycle(send, {
      instanceId: 'worker-instance',
      lifecycle: 'task-scoped',
      onDrained,
    });

    const db = await import('./db.js');
    expect(vi.mocked(db.markWorkerTaskScopeStarted)).toHaveBeenCalledWith('main', 'worker-instance', 'scope-root');
    expect(vi.mocked(db.deactivateWorkerIfTaskScopeDrained)).toHaveBeenCalled();
    expect(onDrained).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['idle_timeout', 'Timed out after 15 minutes without provider activity'],
    ['max_runtime', 'Stopped after reaching the 30-minute maximum runtime'],
  ] as const)('records the scheduler watchdog reason for a %s mission', async (abortReason, expected) => {
    state.mission = {
      id: 'm-timeout',
      title: 'Long worker task',
      prompt: 'go',
      role: 'task',
      group_id: null,
      created_by: 'main',
      assigned_agent: 'research',
      status: 'running',
    };
    state.agentResult = {
      text: null,
      newSessionId: undefined,
      usage: null,
      aborted: true,
      abortReason,
    };
    const send = vi.fn(async () => {});

    await runSchedulerCycle(send);

    expect(vi.mocked(completeMissionTask)).toHaveBeenCalledWith(
      'm-timeout',
      null,
      'failed',
      expected,
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining(expected));
  });
});
