import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentResult } from './agent.js';
import type { ProviderFailure } from './agent-engine/types.js';
import type { ProviderConfig } from './provider.js';

const harness = vi.hoisted(() => ({
  provider: { type: 'claude', model: 'primary' } as ProviderConfig,
  results: [] as Array<AgentResult | Promise<AgentResult>>,
  runAgentCalls: [] as unknown[][],
  queued: [] as Array<() => Promise<void>>,
}));

vi.mock('./agent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent.js')>();
  return {
    ...actual,
    runAgent: vi.fn(async (...args: unknown[]) => {
      harness.runAgentCalls.push(args);
      const result = harness.results.shift();
      if (!result) throw new Error('Missing scheduler test runAgent result');
      return await result;
    }),
  };
});

// The queue and notification surfaces are external I/O. Keep their boundary,
// but execute each scheduler-owned callback explicitly in the test.
vi.mock('./message-queue.js', () => ({
  messageQueue: {
    enqueue: vi.fn((_chatId: string, callback: () => Promise<void>) => {
      harness.queued.push(callback);
    }),
  },
}));
vi.mock('./bot.js', () => ({
  formatForTelegram: vi.fn((text: string) => text),
  splitMessage: vi.fn((text: string) => [text]),
}));
vi.mock('./memory-ingest.js', () => ({ ingestConversationTurn: vi.fn(async () => {}) }));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Dashboard-selected provider state is configuration, not part of the
// scheduler/recovery behavior under acceptance here.
vi.mock('./active-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./active-provider.js')>();
  return { ...actual, getSelectedProviderConfig: vi.fn(() => ({ ...harness.provider })) };
});

const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-provider-scheduler-'));
const configRoot = path.join(disposableRoot, 'config');
const storeRoot = path.join(disposableRoot, 'store');
const priorEnv = {
  config: process.env.CLAUDECLAW_CONFIG,
  store: process.env.CLAUDECLAW_STORE_DIR,
  key: process.env.DB_ENCRYPTION_KEY,
};

process.env.CLAUDECLAW_CONFIG = configRoot;
process.env.CLAUDECLAW_STORE_DIR = storeRoot;
process.env.DB_ENCRYPTION_KEY = '11'.repeat(32);

type DbModule = typeof import('./db.js');
type SchedulerModule = typeof import('./scheduler.js');
let db: DbModule;
let scheduler: SchedulerModule;

function writePolicy(agent: string, trigger: 'unavailable' | 'unavailable+ratelimit' = 'unavailable'): void {
  const dir = path.join(configRoot, 'agents', agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), [
    'fallback:',
    '  providers:',
    '    - type: openai',
    `      model: fallback-${agent}`,
    '  max_attempts: 3',
    '  max_runtime_seconds: 900',
    '  cooldown_seconds: 60',
    `  trigger: ${trigger}`,
    '',
  ].join('\n'));
}

function failed(failure: ProviderFailure): AgentResult {
  return {
    text: failure.message,
    newSessionId: undefined,
    usage: null,
    stopReason: 'error',
    failure,
  };
}

function success(text = 'completed evidence'): AgentResult {
  return { text, newSessionId: undefined, usage: null };
}

async function runOne(agent: string): Promise<ReturnType<typeof vi.fn>> {
  const send = vi.fn(async () => {});
  const stop = scheduler.initScheduler(send, agent, undefined, 'persistent', undefined, false);
  stop();
  await scheduler.runDueTasks();
  expect(harness.queued, `expected one queued scheduler callback for ${agent}`).toHaveLength(1);
  await harness.queued.shift()!();
  return send;
}

function seedTask(id: string, agent: string, role = 'task'): void {
  db.createMissionTask(id, `Task ${id}`, `Execute ${id}`, agent, 'main', 5, null, null, role);
}

describe('mission scheduler provider failure acceptance', () => {
  beforeAll(async () => {
    fs.mkdirSync(configRoot, { recursive: true });
    db = await import('./db.js');
    scheduler = await import('./scheduler.js');
    db.initDatabase();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T18:00:00Z'));
    vi.clearAllMocks();
    harness.results.length = 0;
    harness.runAgentCalls.length = 0;
    harness.queued.length = 0;
    harness.provider = { type: 'claude', model: 'primary' };
  });

  afterAll(() => {
    vi.useRealTimers();
    if (priorEnv.config === undefined) delete process.env.CLAUDECLAW_CONFIG;
    else process.env.CLAUDECLAW_CONFIG = priorEnv.config;
    if (priorEnv.store === undefined) delete process.env.CLAUDECLAW_STORE_DIR;
    else process.env.CLAUDECLAW_STORE_DIR = priorEnv.store;
    if (priorEnv.key === undefined) delete process.env.DB_ENCRYPTION_KEY;
    else process.env.DB_ENCRYPTION_KEY = priorEnv.key;
  });

  it('retries a proven pre-execution unavailable failure on the configured fallback', async () => {
    const agent = 'safe-unavailable';
    writePolicy(agent);
    harness.provider = { type: 'claude', model: `primary-${agent}` };
    seedTask('safe-unavailable-task', agent);
    harness.results.push(failed({
      category: 'unavailable', execution: 'not_started', provider: 'claude', message: '503 service unavailable',
    }));

    await runOne(agent);

    expect(db.getMissionTask('safe-unavailable-task')).toMatchObject({
      id: 'safe-unavailable-task', status: 'queued', error: 'fallback_provider',
    });
    expect(db.getMissionProviderRecovery('safe-unavailable-task')).toMatchObject({
      attempts: 1,
      reason: 'fallback_provider',
      provider_json: expect.stringContaining(`fallback-${agent}`),
    });
    expect(harness.runAgentCalls[0][8]).toMatchObject({ type: 'claude', model: `primary-${agent}` });

    harness.results.push(success());
    await vi.advanceTimersByTimeAsync(10_000);
    await runOne(agent);
    expect(harness.runAgentCalls[1][8]).toMatchObject({ type: 'openai', model: `fallback-${agent}` });
    expect(db.getMissionTask('safe-unavailable-task')).toMatchObject({ status: 'completed', result: 'completed evidence' });
  });

  it('keeps an active mission healthy past 15 minutes under default limits', async () => {
    const agent = 'default-runtime';
    const dir = path.join(configRoot, 'agents', agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.yaml'), '{}\n');
    seedTask('default-runtime-task', agent);

    let resolveResult!: (result: AgentResult) => void;
    harness.results.push(new Promise<AgentResult>((resolve) => { resolveResult = resolve; }));
    const send = vi.fn(async () => {});
    const stop = scheduler.initScheduler(send, agent, undefined, 'persistent', undefined, false);
    stop();
    await scheduler.runDueTasks();
    expect(harness.queued).toHaveLength(1);

    const running = harness.queued.shift()!();
    await Promise.resolve();
    const abortController = harness.runAgentCalls[0][5] as AbortController;
    const watchdog = harness.runAgentCalls[0][11] as { touch(): void };

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    watchdog.touch();
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(abortController.signal.aborted).toBe(false);
    expect(db.getMissionTask('default-runtime-task')).toMatchObject({ status: 'running' });

    resolveResult(success('completed after sixteen minutes'));
    await running;
    expect(db.getMissionTask('default-runtime-task')).toMatchObject({
      status: 'completed', result: 'completed after sixteen minutes',
    });
  });

  it.each([
    ['unavailable+ratelimit', true],
    ['unavailable', false],
  ] as const)('applies the configured rate-limit trigger %s', async (trigger, retries) => {
    const agent = `rate-${retries ? 'on' : 'off'}`;
    const id = `${agent}-task`;
    writePolicy(agent, trigger);
    harness.provider = { type: 'claude', model: `primary-${agent}` };
    seedTask(id, agent);
    harness.results.push(failed({
      category: 'rate_limit', execution: 'not_started', provider: 'claude', message: '429 rate limited',
    }));

    await runOne(agent);

    expect(db.getMissionTask(id)?.status).toBe(retries ? 'queued' : 'failed');
    expect(db.getMissionProviderRecovery(id)).toMatchObject({
      attempts: retries ? 1 : 0,
      reason: retries ? 'fallback_provider' : 'rate_limit_trigger_disabled',
    });
  });

  it('does not retry an authentication failure', async () => {
    const agent = 'auth-failure';
    writePolicy(agent, 'unavailable+ratelimit');
    harness.provider = { type: 'claude', model: `primary-${agent}` };
    seedTask('auth-failure-task', agent);
    harness.results.push(failed({
      category: 'auth', execution: 'not_started', provider: 'claude', message: '401 invalid token',
    }));

    await runOne(agent);

    expect(harness.runAgentCalls).toHaveLength(1);
    expect(db.getMissionTask('auth-failure-task')).toMatchObject({ status: 'failed' });
    expect(db.getMissionProviderRecovery('auth-failure-task')).toMatchObject({ attempts: 0, reason: 'non_recoverable' });
  });

  it.each([
    ['started', 'execution_started'],
    ['unknown', 'execution_unknown'],
  ] as const)('does not retry ambiguous execution certainty %s', async (execution, reason) => {
    const agent = `certainty-${execution}`;
    const id = `${agent}-task`;
    writePolicy(agent);
    harness.provider = { type: 'claude', model: `primary-${agent}` };
    seedTask(id, agent);
    harness.results.push(failed({
      category: 'unavailable', execution, provider: 'claude', message: 'connection lost after dispatch',
    }));

    await runOne(agent);

    expect(harness.runAgentCalls).toHaveLength(1);
    expect(db.getMissionTask(id)).toMatchObject({ status: 'failed' });
    expect(db.getMissionProviderRecovery(id)).toMatchObject({ attempts: 0, reason });
  });

  it('fails an unsupported coordinator closed with blocked_capability', async () => {
    const agent = 'unsupported-coordinator';
    const dir = path.join(configRoot, 'agents', agent);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.yaml'), '{}\n');
    harness.provider = { type: 'acp-codex', model: 'gpt-unsupported-coordinator' };
    seedTask('unsupported-coordinator-task', agent, 'coordinator');

    const send = await runOne(agent);

    expect(harness.runAgentCalls).toHaveLength(0);
    expect(db.getMissionTask('unsupported-coordinator-task')).toMatchObject({
      status: 'failed', error: expect.stringContaining('blocked_capability'),
    });
    expect(send).toHaveBeenCalledWith(expect.stringContaining('blocked_capability'));
  });

  it('switches provider without replacing workflow history or resetting budgets', async () => {
    const agent = 'workflow-worker';
    writePolicy(agent);
    harness.provider = { type: 'claude', model: `primary-${agent}` };
    db.createMissionWorkflow({
      id: 'provider-history-workflow',
      rootTaskId: 'provider-history-root',
      title: 'Preserve workflow state',
      objective: 'Complete on an explicitly configured provider',
      initialPrompt: 'Return durable evidence',
      ownerAgent: 'workflow-owner',
      workerAgent: agent,
      priority: 5,
      maxDepth: 3,
      maxTasks: 7,
      maxFanout: 2,
      deadlineAt: null,
    });
    const original = db.getMissionWorkflow('provider-history-workflow')!;
    harness.results.push(failed({
      category: 'unavailable', execution: 'not_started', provider: 'claude', message: 'backend 503 before execution',
    }));

    await runOne(agent);
    const deferred = db.getMissionWorkflow('provider-history-workflow')!;
    expect(deferred).toMatchObject({
      id: original.id,
      tasks_created: original.tasks_created,
      current_step: original.current_step,
      max_depth: original.max_depth,
      max_tasks: original.max_tasks,
      max_fanout: original.max_fanout,
    });
    expect(db.getMissionWorkflowTasks(original.id).map((task) => task.id)).toEqual(['provider-history-root']);

    harness.results.push(success('fallback completion'));
    await vi.advanceTimersByTimeAsync(10_000);
    await runOne(agent);

    expect(harness.runAgentCalls.map((call) => (call[8] as ProviderConfig).type)).toEqual(['claude', 'openai']);
    expect(db.getMissionTask('provider-history-root')).toMatchObject({
      id: 'provider-history-root', workflow_id: original.id, status: 'completed', result: 'fallback completion',
    });
    expect(db.getMissionWorkflow('provider-history-workflow')).toMatchObject({
      tasks_created: original.tasks_created,
      // The successful worker outcome advances the workflow exactly once;
      // provider retry itself did not consume or reset a workflow step.
      current_step: original.current_step + 1,
      max_depth: original.max_depth,
      max_tasks: original.max_tasks,
      max_fanout: original.max_fanout,
    });
    expect(db.getMissionWorkflowOutcomes(original.id)).toHaveLength(1);
    expect(db.getMissionWorkflowTasks(original.id).filter((task) => task.role === 'task')).toHaveLength(1);
  });
});
