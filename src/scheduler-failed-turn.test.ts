import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimNextMissionTask,
  completeMissionTask,
  maybeReleaseJoinForMission,
  missionClaimIsCurrent,
  updateTaskAfterRun,
} from './db.js';
import { runAgent } from './agent.js';
import { ingestConversationTurn } from './memory-ingest.js';

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
  currentMission: null as Record<string, unknown> | null,
  cancelDuringRun: false,
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
  getDueTasks: vi.fn(() => state.dueTasks),
  getSession: vi.fn(() => undefined),
  logConversationTurn: vi.fn(),
  markTaskRunning: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  resetStuckTasks: vi.fn(() => 0),
  claimNextMissionTask: vi.fn(() => {
    const m = state.mission;
    state.mission = null;
    state.currentMission = m ? { ...m, status: 'running' } : null;
    return m;
  }),
  completeMissionTask: vi.fn((_id: string, _result: string | null, status: string) => {
    if (state.currentMission?.status !== 'running') return false;
    state.currentMission.status = status;
    state.missionCompleted = true;
    return true;
  }),
  maybeReleaseJoinForMission: vi.fn(),
  resetStuckMissionTasks: vi.fn(() => 0),
  failStuckMissionTasks: vi.fn(() => 0),
  getMissionTask: vi.fn(() => state.currentMission),
  missionClaimIsCurrent: vi.fn(() => state.currentMission?.status === 'running'),
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
  runAgent: vi.fn(async () => {
    if (state.cancelDuringRun && state.currentMission) state.currentMission.status = 'cancelled';
    return state.agentResult;
  }),
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
    state.currentMission = null;
    state.cancelDuringRun = false;
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
      undefined,
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
    expect(vi.mocked(completeMissionTask)).toHaveBeenCalledWith(
      'm2', 'all good', 'completed', undefined, undefined,
    );
    expect(send).toHaveBeenCalledWith('all good');
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
      claiming_instance_id: 'worker-instance',
      claim_generation: 4,
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
    expect(vi.mocked(db.missionClaimIsCurrent)).toHaveBeenCalledWith('scope-root', {
      agentId: 'main', instanceId: 'worker-instance', generation: 4,
    });
    expect(vi.mocked(db.completeMissionTask)).toHaveBeenCalledWith(
      'scope-root', 'done', 'completed', undefined,
      { agentId: 'main', instanceId: 'worker-instance', generation: 4 },
    );
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
      undefined,
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining(expected));
  });

  it('drops a queued callback when its claim was cancelled before execution', async () => {
    state.mission = {
      id: 'cancel-before-callback', title: 'Queued work', prompt: 'go', role: 'task',
      group_id: 'g1', created_by: 'main', assigned_agent: 'research', status: 'running',
    };
    state.agentResult = { text: 'must not run', newSessionId: undefined, usage: null };
    const send = vi.fn(async () => {});
    const { initScheduler } = await import('./scheduler.js');
    initScheduler(send, 'main');
    await vi.runOnlyPendingTimersAsync();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(state.enqueued).toHaveLength(1);

    state.currentMission!.status = 'cancelled';
    await state.enqueued[0]!();

    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(vi.mocked(completeMissionTask)).not.toHaveBeenCalled();
    expect(vi.mocked(maybeReleaseJoinForMission)).not.toHaveBeenCalled();
  });

  it('rechecks the claim after the awaited startup notification', async () => {
    state.mission = {
      id: 'cancel-during-startup', title: 'Queued work', prompt: 'go', role: 'task',
      group_id: 'g1', created_by: 'main', assigned_agent: 'research', status: 'running',
    };
    state.agentResult = { text: 'must not run', newSessionId: undefined, usage: null };
    const send = vi.fn(async () => {
      if (state.currentMission) state.currentMission.status = 'cancelled';
    });

    await runSchedulerCycle(send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(missionClaimIsCurrent)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(completeMissionTask)).not.toHaveBeenCalled();
    expect(vi.mocked(maybeReleaseJoinForMission)).not.toHaveBeenCalled();
  });

  it('suppresses output, follow-up, and join release when cancellation wins during execution', async () => {
    state.mission = {
      id: 'cancel-in-flight', title: 'In-flight work', prompt: 'go', role: 'task',
      group_id: 'g1', created_by: 'main', assigned_agent: 'research', status: 'running',
    };
    state.agentResult = { text: 'late success', newSessionId: undefined, usage: null };
    state.cancelDuringRun = true;
    const send = vi.fn(async () => {});

    await runSchedulerCycle(send);

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeMissionTask)).toHaveBeenCalledWith(
      'cancel-in-flight', 'late success', 'completed', undefined, undefined,
    );
    expect(state.missionCompleted).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalledWith('late success');
    expect(vi.mocked(maybeReleaseJoinForMission)).not.toHaveBeenCalled();
    expect(vi.mocked(ingestConversationTurn)).not.toHaveBeenCalled();
  });
});
