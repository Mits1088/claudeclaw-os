import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from './agent-engine/types.js';
const fixture = vi.hoisted(() => ({
  pending: [] as Array<() => Promise<void>>,
  queueKeys: [] as string[],
  inputs: [] as AgentTurnInput[],
  cancel: 'none',
}));
vi.mock('./config.js', async importOriginal => ({
  ...await importOriginal<typeof import('./config.js')>(),
  CREW_MISSIONS_ENABLED: true, ALLOWED_CHAT_ID: 'interactive-chat', agentDefaultModel: undefined,
  agentMcpAllowlist: [], agentCwd: '/nonexistent/recovery-fixture', agentSystemPrompt: '',
}));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./security.js', () => ({ getScrubbedSdkEnv: () => ({}) }));
vi.mock('./kill-switches.js', () => ({ requireEnabled: () => {} }));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: () => ({ type: 'openai', model: 'fixture' }), defaultModelForProvider: () => 'fixture' }));
vi.mock('./mission-provider-policy.js', async importOriginal => ({
  ...await importOriginal<typeof import('./mission-provider-policy.js')>(),
  loadMissionProviderPolicy: () => ({ fallbackProviders: [], maxAttempts: 3, maxRuntimeSeconds: 600, cooldownSeconds: 60, retryRateLimit: false }),
}));
vi.mock('./message-queue.js', () => ({ messageQueue: {
  enqueue: (key: string, fn: () => Promise<void>) => {
    fixture.queueKeys.push(key);
    fixture.pending.push(fn);
  },
} }));
vi.mock('./bot.js', () => ({ formatForTelegram: (s: string) => s, splitMessage: (s: string) => [s] }));
vi.mock('./memory-ingest.js', () => ({ ingestConversationTurn: async () => {} }));
vi.mock('./mission-reporting.js', () => ({ deliverMissionWorkflowReport: async () => {} }));
vi.mock('./agent-engine/index.js', () => ({ EngineFactory: { forProvider: () => ({
  async *invoke(input: AgentTurnInput) {
    fixture.inputs.push(input);
    const db = await import('./db.js');
    const { getMissionExecutionContext } = await import('./mission-execution-context.js');
    const taskId = getMissionExecutionContext()!.taskId;
    if (db.getMissionTask(taskId)?.role === 'coordinator') {
      // Exercise the registered MCP server and schema validation, rather than
      // allowing the fake engine to bypass the action/authorization boundary.
      const { buildDispatchMcpServer } = await import('./dispatch-mcp-server.js');
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
      const server = buildDispatchMcpServer({ allowHiveRead: false });
      const client = new Client({ name: 'fixture-provider', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
          'mission_result', 'mission_transition', 'mission_workflow_list', 'mission_workflow_result',
        ]);
        const forged = await client.callTool({ name: 'mission_transition', arguments: {
          coordinator_task_id: 'fixture-root', disposition: 'complete', idempotency_key: 'forged',
        } });
        expect(forged.isError).toBe(true);
        const accepted = await client.callTool({ name: 'mission_transition', arguments: {
          coordinator_task_id: taskId, disposition: 'complete', idempotency_key: 'fixture-accept',
        } });
        expect(accepted.isError).not.toBe(true);
      } finally { await client.close(); await server.close(); }
    }
    if (fixture.cancel !== 'none') {
      db.cancelMissionWorkflow('scheduler-fixture', 'main');
      if (fixture.cancel === 'task') db.cancelMissionTask('fixture-root');
    }
    yield { type: 'result', text: 'synthetic scheduler evidence', usage: null };
  },
}) } }));

import { _initTestDatabase, createMissionWorkflow, getMissionTask, getMissionWorkflowOutcomes,
  getMissionGovernorReservation, getMissionGovernorStatus, getMissionWorkflow,
  getRecentConversation, getSession } from './db.js';
import { initScheduler, runDueTasks } from './scheduler.js';

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.stubEnv('HOME', '/nonexistent/recovery-fixture-home');
  _initTestDatabase();
  fixture.inputs = [];
  fixture.pending = [];
  fixture.queueKeys = [];
  fixture.cancel = 'none';
});

it.each(['none', 'workflow', 'task'])('executes a governed scheduler turn and honors cancellation=%s before completion', async cancelled => {
  fixture.cancel = cancelled;
  createMissionWorkflow({ id: 'scheduler-fixture', rootTaskId: 'fixture-root', title: 'Fixture', objective: 'Synthetic only',
    initialPrompt: 'Synthetic only', ownerAgent: 'main', workerAgent: 'fixture-worker', priority: 5,
    maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
  const sent: string[] = [];
  const stopOther = initScheduler(async text => { sent.push(text); }, 'unaddressed', undefined, 'persistent', undefined, false);
  try { await runDueTasks(); expect(fixture.pending).toHaveLength(0); } finally { stopOther(); }
  const stop = initScheduler(async text => { sent.push(text); }, 'fixture-worker', undefined, 'persistent', undefined, false);
  try {
    await runDueTasks();
    expect(fixture.pending).toHaveLength(1);
    expect(fixture.queueKeys).toEqual(['interactive-chat']);
    expect(getMissionGovernorStatus().activeReservations).toBe(1);
    await fixture.pending.shift()!();
    expect(fixture.inputs).toHaveLength(1);
    expect(fixture.inputs[0].maxTurns).toBe(3);
    expect(getMissionTask('fixture-root')?.status).toBe(cancelled === 'task' ? 'cancelled' : 'completed');
    expect(getMissionGovernorReservation('fixture-root')?.charged_turns).toBe(3);
    expect(getMissionGovernorStatus().activeReservations).toBe(0);
    expect(sent).toEqual([]);
    if (cancelled === 'none') expect(getMissionWorkflowOutcomes('scheduler-fixture')).toHaveLength(1);
    await runDueTasks();
    expect(fixture.pending).toHaveLength(0);
    expect(fixture.inputs).toHaveLength(1);
  } finally { stop(); }
  if (cancelled === 'none') {
    const stopOwner = initScheduler(async text => { sent.push(text); }, 'main', undefined, 'persistent', undefined, false);
    try {
      await runDueTasks();
      expect(fixture.pending).toHaveLength(1);
      expect(fixture.queueKeys.at(-1)).toBe('mission-control:main');
      await fixture.pending.shift()!();
      expect(fixture.inputs).toHaveLength(2);
      expect(fixture.inputs[1].sessionId).toBeUndefined();
      expect(getMissionWorkflow('scheduler-fixture')?.status).toBe('completed');
      expect(getMissionGovernorStatus().activeReservations).toBe(0);
      expect(sent).toEqual([]);
      expect(getSession('interactive-chat', 'main')).toBeUndefined();
      expect(getRecentConversation('interactive-chat', 20, 'main')).toEqual([]);
    } finally { stopOwner(); }
  } else {
    expect(getMissionWorkflow('scheduler-fixture')?.status).toBe('cancelled');
    expect(getMissionWorkflowOutcomes('scheduler-fixture').every(row => row.orchestration_state === 'blocked')).toBe(true);
  }
});
