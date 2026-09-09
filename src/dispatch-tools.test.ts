import { beforeEach, describe, expect, it } from 'vitest';

import type { ProviderConfig } from './provider.js';
import {
  _initTestDatabase,
  _testMarkLegacyWorkflowMission,
  createMissionTask,
  claimNextMissionTask,
  completeMissionTask,
  failStuckMissionTasks,
  getAllScheduledTasks,
  getHiveMindEntries,
  getMissionTask,
  getMissionChain,
  getMissionTasks,
} from './db.js';
import type { TurnToolPolicy } from './agent-engine/types.js';
import {
  DISPATCH_SERVER_NAME,
  DISPATCH_STDIO_SERVER_NAME,
  buildDispatchSdkTools,
  deriveToolSchema,
  dispatchMcpServersFor,
  dispatchToolEntries,
  dispatchToolNames,
  dispatchToolsAllowed,
} from './dispatch-tools.js';
import { actionHandbackMission } from './cli-actions.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const built = buildDispatchSdkTools().find((t) => t.name === name);
  if (!built) throw new Error(`no dispatch tool named '${name}'`);
  // The handler is invoked directly with structured args, exactly as the SDK
  // MCP transport would after schema validation.
  return built.handler(args as never, {}) as unknown as Promise<ToolResult>;
}

const asText = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');

// ── per-handler unit tests (isolated in-memory store) ────────────────────────

describe('dispatch tool handlers reuse the db layer on an isolated store', () => {
  beforeEach(() => {
    // Fresh in-memory DB per test. The action layer's ensureDatabase() sees this
    // open handle and never touches a real on-disk store.
    _initTestDatabase();
  });

  it('mission_create queues a task assigned to the resolved agent', async () => {
    const r = await callTool('mission_create', { prompt: 'do the thing', agent: 'main', title: 'T', priority: 3 });
    expect(r.isError).toBeFalsy();
    const tasks = getMissionTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_agent).toBe('main');
    expect(tasks[0].title).toBe('T');
    expect(tasks[0].priority).toBe(3);
  });

  it('mission_create leaves the task unassigned when agent is omitted', async () => {
    await callTool('mission_create', { prompt: 'assign me later' });
    expect(getMissionTasks()[0].assigned_agent).toBeNull();
  });

  it('mission_create persists a future availability gate', async () => {
    const r = await callTool('mission_create', {
      prompt: 'later', agent: 'main', at: '2099-01-02T03:04:05-07:00',
    });
    expect(r.isError).toBeFalsy();
    expect(asText(r)).toContain('2099-01-02T10:04:05.000Z');
    expect(getMissionTasks()[0].available_at).toBe(4071031445);
    expect(claimNextMissionTask('main')).toBeNull();
  });

  it('mission_create rejects an unknown agent and writes nothing', async () => {
    const r = await callTool('mission_create', { prompt: 'x', agent: 'definitely-not-an-agent' });
    expect(r.isError).toBe(true);
    expect(asText(r)).toContain("unknown agent 'definitely-not-an-agent'");
    expect(getMissionTasks()).toHaveLength(0);
  });

  it('mission_list / mission_result / mission_cancel round-trip', async () => {
    await callTool('mission_create', { prompt: 'p1', agent: 'main' });
    const [t] = getMissionTasks();

    expect(asText(await callTool('mission_list', {}))).toContain(t.id);
    expect(asText(await callTool('mission_result', { id: t.id }))).toContain(t.id);

    const cancel = await callTool('mission_cancel', { id: t.id });
    expect(asText(cancel)).toContain('Cancelled');
    expect(getMissionTask(t.id)?.status).toBe('cancelled');
  });

  it('mission_result errors on an unknown id', async () => {
    const r = await callTool('mission_result', { id: 'nope' });
    expect(r.isError).toBe(true);
    expect(asText(r)).toContain('Task not found');
  });

  it('mission_gather creates one child per task plus a parked join', async () => {
    const r = await callTool('mission_gather', {
      summary_agent: 'main',
      tasks: ['main:first', 'main:second'],
      title: 'G',
    });
    expect(r.isError).toBeFalsy();
    const tasks = getMissionTasks();
    expect(tasks).toHaveLength(3); // 2 children + 1 join
    const join = tasks.find((t) => t.role === 'join');
    expect(join?.status).toBe('waiting');
    expect(tasks.filter((t) => t.role === 'task')).toHaveLength(2);
  });

  it('mission_handback errors when the parent task does not exist', async () => {
    const r = await callTool('mission_handback', { task_id: 'ghost', report: 'done' });
    expect(r.isError).toBe(true);
    expect(asText(r)).toContain('Task not found');
  });

  it('keeps self-handback rejected while allowing an explicit bounded continuation', async () => {
    await callTool('mission_create', { prompt: 'resume after restart', agent: 'main', title: 'Self recap' });
    const [parent] = getMissionTasks();

    const r = await callTool('mission_handback', { task_id: parent.id, report: 'resumed' });

    expect(r.isError).toBe(true);
    expect(asText(r)).toContain('complete it directly without a handback');
    expect(getMissionTasks()).toHaveLength(1);

    expect(claimNextMissionTask('main')?.id).toBe(parent.id);
    const continued = await callTool('mission_continue', {
      task_id: parent.id, prompt: 'next bounded step', idempotency_key: 'step-1', max_steps: 2,
    });
    expect(continued.isError).toBeFalsy();
    const next = getMissionTasks().find((task) => task.role === 'continuation');
    expect(next).toMatchObject({
      assigned_agent: 'main', created_by: 'main', parent_task_id: parent.id,
      chain_id: parent.id, continuation_step: 1, continuation_limit: 2,
    });
    expect(next?.prompt).toContain("use the Task ID from this mission's own runtime metadata");
    expect(next?.prompt).toContain('Never reuse a parent task id');
  });

  it('deduplicates continuation retries and enforces the fixed chain bound', async () => {
    await callTool('mission_create', { prompt: 'start', agent: 'main', title: 'Chain' });
    const [root] = getMissionTasks();
    expect(claimNextMissionTask('main')?.id).toBe(root.id);
    const args = { task_id: root.id, prompt: 'step one', idempotency_key: 'one', max_steps: 1 };
    const first = await callTool('mission_continue', args);
    const replay = await callTool('mission_continue', { ...args, idempotency_key: 'another-key' });
    expect(first.isError).toBeFalsy();
    expect(asText(replay)).toContain('Existing continuation');
    expect(getMissionTasks()).toHaveLength(2);

    const next = getMissionTasks().find((task) => task.role === 'continuation')!;
    expect(completeMissionTask(root.id, 'continued', 'completed')).toBe(true);
    expect(claimNextMissionTask('main')?.id).toBe(next.id);
    const exhausted = await callTool('mission_continue', {
      task_id: next.id, prompt: 'too far', idempotency_key: 'two',
    });
    expect(exhausted.isError).toBe(true);
    expect(asText(exhausted)).toContain('chain exhausted');
    expect(getMissionTasks()).toHaveLength(2);
  });

  it('requires a running parent for a new continuation but permits a later replay', async () => {
    await callTool('mission_create', { prompt: 'start', agent: 'main', title: 'Eligibility' });
    const [root] = getMissionTasks();

    const queued = await callTool('mission_continue', {
      task_id: root.id, prompt: 'not yet', idempotency_key: 'queued', max_steps: 2,
    });
    expect(queued.isError).toBe(true);
    expect(asText(queued)).toContain('cannot continue while queued');

    expect(claimNextMissionTask('main')?.id).toBe(root.id);
    const first = await callTool('mission_continue', {
      task_id: root.id, prompt: 'now', idempotency_key: 'first', max_steps: 2,
    });
    expect(first.isError).toBeFalsy();
    expect(completeMissionTask(root.id, 'continued', 'completed')).toBe(true);

    const replay = await callTool('mission_continue', {
      task_id: root.id, prompt: 'retry after completion', idempotency_key: 'retry', max_steps: 2,
    });
    expect(replay.isError).toBeFalsy();
    expect(asText(replay)).toContain('Existing continuation');
    expect(getMissionTasks().filter((task) => task.role === 'continuation')).toHaveLength(1);
  });

  it('cancels queued chain work idempotently and permanently blocks advancement', async () => {
    await callTool('mission_create', { prompt: 'start', agent: 'main', title: 'Cancelable' });
    const [root] = getMissionTasks();
    expect(claimNextMissionTask('main')?.id).toBe(root.id);
    const first = await callTool('mission_continue', {
      task_id: root.id, prompt: 'queued next', idempotency_key: 'one', max_steps: 3,
    });
    expect(first.isError).toBeFalsy();
    expect(getMissionChain(root.id)?.status).toBe('active');

    const cancelled = await callTool('mission_cancel_chain', { chain_id: root.id });
    expect(cancelled.isError).toBeFalsy();
    expect(asText(cancelled)).toContain('1 queued task(s) stopped');
    expect(getMissionChain(root.id)?.status).toBe('cancelled');
    expect(getMissionTasks().find((task) => task.role === 'continuation')?.status).toBe('cancelled');

    const repeat = await callTool('mission_cancel_chain', { chain_id: root.id });
    expect(asText(repeat)).toContain('already cancelled');
    const blocked = await callTool('mission_continue', {
      task_id: root.id, prompt: 'must not queue', idempotency_key: 'two', max_steps: 3,
    });
    expect(blocked.isError).toBe(true);
    expect(asText(blocked)).toContain('is cancelled');
    expect(getMissionTasks()).toHaveLength(2);
  });

  it('leaves a running step alive but prevents it from recreating a cancelled chain', async () => {
    await callTool('mission_create', { prompt: 'root', agent: 'main', title: 'Running cancel' });
    const [root] = getMissionTasks();
    expect(claimNextMissionTask('main')?.id).toBe(root.id);
    await callTool('mission_continue', {
      task_id: root.id, prompt: 'running step', idempotency_key: 'one', max_steps: 3,
    });
    expect(completeMissionTask(root.id, 'continued', 'completed')).toBe(true);
    const running = claimNextMissionTask('main');
    expect(running?.role).toBe('continuation');

    const cancelled = await callTool('mission_cancel_chain', { chain_id: root.id });
    expect(asText(cancelled)).toContain('0 queued task(s) stopped');
    expect(getMissionTask(running!.id)?.status).toBe('running');
    const blocked = await callTool('mission_continue', {
      task_id: running!.id, prompt: 'another step', idempotency_key: 'two',
    });
    expect(blocked.isError).toBe(true);
    expect(asText(blocked)).toContain('is cancelled');
    expect(getMissionTasks().filter((task) => task.role === 'continuation')).toHaveLength(1);
  });

  it('does not let another agent cancel a chain it does not own', async () => {
    await callTool('mission_create', { prompt: 'root', agent: 'main', title: 'Owned' });
    const [root] = getMissionTasks();
    expect(claimNextMissionTask('main')?.id).toBe(root.id);
    await callTool('mission_continue', {
      task_id: root.id, prompt: 'next', idempotency_key: 'one', max_steps: 2,
    });
    const { actionCancelMissionChain } = await import('./cli-actions.js');
    expect(() => actionCancelMissionChain({ chainId: root.id, createdBy: 'amos' }))
      .toThrow('not owned by @amos');
    expect(getMissionChain(root.id)?.status).toBe('active');
  });

  it('rejects continuation from cross-agent and terminal handback tasks', async () => {
    createMissionTask('cross', 'Cross', 'work', 'main', 'amos', 5);
    const cross = await callTool('mission_continue', {
      task_id: 'cross', prompt: 'next', idempotency_key: 'x', max_steps: 2,
    });
    expect(cross.isError).toBe(true);
    expect(asText(cross)).toContain('not a self-directed task');

    createMissionTask('terminal', 'Terminal', 'relay', 'main', 'main', 5, null, null, 'handback');
    const terminal = await callTool('mission_continue', {
      task_id: 'terminal', prompt: 'next', idempotency_key: 'y', max_steps: 2,
    });
    expect(terminal.isError).toBe(true);
    expect(asText(terminal)).toContain('terminal handback');
  });

  it('marks handback missions terminal and rejects a handback of a handback', async () => {
    createMissionTask('parent', 'Original', 'do work', 'main', 'dashboard', 5);
    expect(claimNextMissionTask('main')?.id).toBe('parent');
    const first = await callTool('mission_handback', { task_id: 'parent', report: 'finished' });
    expect(first.isError).toBeFalsy();

    const handback = getMissionTasks().find((task) => task.parent_task_id === 'parent');
    expect(handback?.role).toBe('handback');

    const second = await callTool('mission_handback', { task_id: handback!.id, report: 'relay complete' });
    expect(second.isError).toBe(true);
    expect(asText(second)).toContain('terminal handback');
    expect(getMissionTasks()).toHaveLength(2);
  });

  it('routes main to Amos work back to main as one terminal handback', () => {
    createMissionTask('delegated', 'Delegated', 'inspect', 'amos', 'main', 5);
    expect(claimNextMissionTask('amos')?.id).toBe('delegated');
    const result = actionHandbackMission({ taskId: 'delegated', report: 'done', createdBy: 'amos' });
    expect(result).toMatchObject({ kind: 'agent', dest: 'main', parentId: 'delegated' });
    const relay = getMissionTask(result.missionId);
    expect(relay).toMatchObject({ assigned_agent: 'main', created_by: 'amos', role: 'handback' });
  });

  it('deduplicates repeated handbacks and rejects the first before execution starts', () => {
    createMissionTask('delegated-retry', 'Delegated retry', 'inspect', 'amos', 'main', 5);
    expect(() => actionHandbackMission({
      taskId: 'delegated-retry', report: 'too early', createdBy: 'amos',
    })).toThrow('cannot create a handback while queued');

    expect(claimNextMissionTask('amos')?.id).toBe('delegated-retry');
    const first = actionHandbackMission({ taskId: 'delegated-retry', report: 'done', createdBy: 'amos' });
    expect(completeMissionTask('delegated-retry', 'done', 'completed')).toBe(true);
    const replay = actionHandbackMission({ taskId: 'delegated-retry', report: 'done again', createdBy: 'amos' });

    expect(replay).toMatchObject({ missionId: first.missionId, duplicate: true });
    expect(getMissionTasks().filter((task) => task.role === 'handback')).toHaveLength(1);
  });

  it('does not let retained Crew rows manufacture ordinary handbacks or continuations', async () => {
    createMissionTask('legacy-crew', 'Retained', 'historical work', 'main', 'main', 5);
    _testMarkLegacyWorkflowMission('legacy-crew', 'retired-workflow');

    const handback = await callTool('mission_handback', { task_id: 'legacy-crew', report: 'escape' });
    const continuation = await callTool('mission_continue', {
      task_id: 'legacy-crew', prompt: 'escape', idempotency_key: 'escape', max_steps: 2,
    });
    expect(handback.isError).toBe(true);
    expect(continuation.isError).toBe(true);
    expect(asText(handback)).toContain('retained Crew workflow task');
    expect(asText(continuation)).toContain('retained Crew workflow task');
    expect(getMissionTasks()).toHaveLength(1);
  });

  it('cancels queued continuation descendants when their running parent is interrupted', async () => {
    await callTool('mission_create', { prompt: 'start', agent: 'main', title: 'Interrupted' });
    const [root] = getMissionTasks();
    expect(claimNextMissionTask('main')?.id).toBe(root.id);
    await callTool('mission_continue', {
      task_id: root.id, prompt: 'must not run after restart', idempotency_key: 'one', max_steps: 2,
    });

    expect(failStuckMissionTasks('main', 'execution unknown')).toBe(1);
    expect(getMissionTask(root.id)?.status).toBe('failed');
    expect(getMissionChain(root.id)?.status).toBe('cancelled');
    expect(getMissionTasks().find((task) => task.role === 'continuation')?.status).toBe('cancelled');
    expect(claimNextMissionTask('main')).toBeNull();
  });

  it('schedule_create stores a recurring task', async () => {
    const r = await callTool('schedule_create', { prompt: 'weekly', cron: '0 9 * * 1', agent: 'main' });
    expect(r.isError).toBeFalsy();
    expect(getAllScheduledTasks()).toHaveLength(1);
  });

  it('schedule_create rejects an invalid cron and writes nothing', async () => {
    const r = await callTool('schedule_create', { prompt: 'p', cron: 'not-a-cron' });
    expect(r.isError).toBe(true);
    expect(asText(r)).toContain('Invalid cron');
    expect(getAllScheduledTasks()).toHaveLength(0);
  });

  it('schedule_list / pause / resume / delete round-trip', async () => {
    await callTool('schedule_create', { prompt: 'p', cron: '0 9 * * 1', agent: 'main' });
    const [s] = getAllScheduledTasks();

    expect(asText(await callTool('schedule_list', {}))).toContain(s.id);

    await callTool('schedule_pause', { id: s.id });
    expect(getAllScheduledTasks()[0].status).toBe('paused');

    await callTool('schedule_resume', { id: s.id });
    expect(getAllScheduledTasks()[0].status).toBe('active');

    await callTool('schedule_delete', { id: s.id });
    expect(getAllScheduledTasks()).toHaveLength(0);
  });

  it('hive_log then hive_read round-trips through the store', async () => {
    await callTool('hive_log', { action: 'unit-test', summary: 'dispatch round trip', agent: 'main' });
    const read = await callTool('hive_read', { limit: 5 });
    expect(asText(read)).toContain('unit-test');
    expect(asText(read)).toContain('dispatch round trip');
    expect(getHiveMindEntries(5)).toHaveLength(1);
  });

  it('hive_path returns the store db path without opening the db', async () => {
    expect(asText(await callTool('hive_path', {}))).toMatch(/claudeclaw\.db$/);
  });
});

// ── schema derivation (guards drift from the descriptors) ────────────────────

describe('dispatch tool schemas are derived from the descriptor specs', () => {
  it('each schema exactly mirrors its descriptor spec params (keys + required-ness)', () => {
    for (const entry of dispatchToolEntries()) {
      const schemaKeys = Object.keys(entry.schema).sort();
      const paramNames = entry.spec.params.map((p) => p.name).sort();
      expect(schemaKeys, `schema keys for ${entry.spec.name}`).toEqual(paramNames);

      for (const p of entry.spec.params) {
        // Optional params accept `undefined`; required params reject it.
        const acceptsUndefined = entry.schema[p.name].safeParse(undefined).success;
        expect(acceptsUndefined, `${entry.spec.name}.${p.name} optional?`).toBe(!p.required);
      }
    }
  });

  it('deriveToolSchema is a pure function of the spec (independent of the built tool)', () => {
    for (const entry of dispatchToolEntries()) {
      expect(Object.keys(deriveToolSchema(entry.spec)).sort()).toEqual(
        entry.spec.params.map((p) => p.name).sort(),
      );
    }
  });

  it('promotes exactly the mission/schedule/hive command set', () => {
    expect(dispatchToolNames().sort()).toEqual(
      [
        'hive_log', 'hive_path', 'hive_read',
        'mission_cancel', 'mission_cancel_chain', 'mission_create', 'mission_gather',
        'mission_continue', 'mission_handback', 'mission_list', 'mission_result',
        'schedule_create', 'schedule_delete', 'schedule_list',
        'schedule_pause', 'schedule_resume',
      ].sort(),
    );
  });

  it('every built SDK tool name matches a descriptor spec name', () => {
    expect(buildDispatchSdkTools().map((t) => t.name).sort()).toEqual(dispatchToolNames().sort());
  });
});

// ── asymmetric access policy (lockdown) ──────────────────────────────────────

describe('provider access policy — Claude in-process, native OpenAI stdio, rest restricted', () => {
  const p = (type: ProviderConfig['type']): ProviderConfig => ({ type });
  const ctx = (type?: ProviderConfig['type'], policy: TurnToolPolicy = {}) =>
    ({ provider: type ? p(type) : undefined, ...policy });

  it('grants dispatch tools to Claude and native OpenAI only', () => {
    expect(dispatchToolsAllowed(ctx('claude'))).toBe(true);
    expect(dispatchToolsAllowed(ctx('openai'))).toBe(true);
    expect(dispatchToolsAllowed(ctx('acp-codex'))).toBe(false); // Codex over ACP, not native
    expect(dispatchToolsAllowed(ctx('openrouter'))).toBe(false);
    expect(dispatchToolsAllowed(ctx('acp'))).toBe(false);
    expect(dispatchToolsAllowed(ctx('gemini'))).toBe(false);
    expect(dispatchToolsAllowed(ctx(undefined))).toBe(false);
  });

  it('a restricted provider gets no dispatch MCP server, so the gated tools are unreachable', () => {
    expect(dispatchMcpServersFor(ctx('acp-codex'))).toEqual({});
    expect(dispatchMcpServersFor(ctx('openrouter'))).toEqual({});
    expect(dispatchMcpServersFor(ctx('acp'))).toEqual({});
  });

  it('the Claude provider gets exactly the one in-process dispatch server', () => {
    const servers = dispatchMcpServersFor(ctx('claude'));
    expect(Object.keys(servers)).toEqual([DISPATCH_SERVER_NAME]);
  });

  it('the native OpenAI provider gets exactly the one stdio dispatch bridge', () => {
    const servers = dispatchMcpServersFor(ctx('openai'));
    expect(Object.keys(servers)).toEqual([DISPATCH_STDIO_SERVER_NAME]);
    const entry = servers[DISPATCH_STDIO_SERVER_NAME] as { command: string; args: string[]; env: Record<string, string> };
    expect(entry.command).toBe(process.execPath);
    expect(entry.args[0]).toMatch(/dispatch-mcp-server\.js$/);
    // Everything the out-of-process server needs is passed EXPLICITLY (Codex
    // scrubs the env of servers it spawns).
    expect(entry.env.CLAUDECLAW_STORE_DIR).toBeTruthy();
    expect(entry.env.CLAUDECLAW_DISPATCH_AGENT).toBeTruthy();
  });

});

// ── tool-policy gate: the Phase 0 authorization fix ──────────────────────────
//
// Dispatch exposes state-changing mission/schedule/hive verbs. A caller that
// granted NO tools must not receive it — on ANY provider. Before this gate, the
// Codex adapter injected the stdio bridge itself, so every restricted native
// OpenAI turn below silently received trusted tools it never asked for.

describe('dispatch authorization is gated on the turn tool policy', () => {
  const p = (type: ProviderConfig['type']): ProviderConfig => ({ type });

  // The real call shapes, copied from their call sites. `claude` and `openai`
  // differ ON PURPOSE for a restricted-but-non-empty allow-list: Claude applies
  // our allow-list to MCP tool NAMES, so the dispatch verbs stay unreachable with
  // the server present; the Codex runtime does not, so the server itself must be
  // withheld.
  const CALL_SHAPES: Array<{ name: string; policy: TurnToolPolicy; claude: boolean; openai: boolean }> = [
    // memory-ingest.ts — extraction turn
    { name: 'memory ingestion', policy: { allowedTools: [], disallowedTools: ['*'] }, claude: false, openai: false },
    // warroom-text-orchestrator.ts — 'say ok' / 'ok' warmups
    { name: 'war-room warmup', policy: { allowedTools: [], disallowedTools: ['*'] }, claude: false, openai: false },
    // warroom-text-router.ts — classifier turn
    { name: 'war-room routing', policy: { allowedTools: [], disallowedTools: ['*'] }, claude: false, openai: false },
    // voice bridge / any untrusted-input turn
    { name: 'untrusted voice', policy: { disallowedTools: ['*'] }, claude: false, openai: false },
    // war-room default-deny agent policy
    { name: 'default-deny war room', policy: { allowedTools: [] }, claude: false, openai: false },
    // a read-only chat profile (STRICTEST_CHAT_TOOL_PROFILE)
    { name: 'read-only allow-list', policy: { allowedTools: ['Read', 'Grep', 'Glob'] }, claude: true, openai: false },
    // a write-capable but still explicit allow-list
    { name: 'explicit write allow-list', policy: { allowedTools: ['Read', 'Bash', 'Write'] }, claude: true, openai: false },
    // normal chat / mission / scheduled turn: 'full' profile => no restriction stated
    { name: 'normal chat or mission', policy: {}, claude: true, openai: true },
    // a deny that is not deny-all, and is separately enforceable on Codex
    { name: 'WebSearch denied only', policy: { disallowedTools: ['WebSearch'] }, claude: true, openai: true },
  ];

  for (const shape of CALL_SHAPES) {
    for (const type of ['claude', 'openai'] as const) {
      const expected = shape[type];
      it(`${shape.name} on ${type} ${expected ? 'receives dispatch exactly once' : 'receives NO dispatch'}`, () => {
        const servers = dispatchMcpServersFor({ provider: p(type), ...shape.policy });
        const names = Object.keys(servers);
        if (!expected) {
          expect(names).toEqual([]);
        } else {
          expect(names).toEqual([type === 'claude' ? DISPATCH_SERVER_NAME : DISPATCH_STDIO_SERVER_NAME]);
        }
      });
    }
  }

  it('an explicit allow-list is not authorization for dispatch on the Codex runtime', () => {
    // The load-bearing asymmetry: Codex does not apply Claude tool names to MCP
    // invocation, so `allowedTools: ['Read']` + the dispatch server present would
    // still let the model call mission_create. Withhold the server instead.
    expect(dispatchMcpServersFor({ provider: p('openai'), allowedTools: ['Read'] })).toEqual({});
    expect(dispatchToolsAllowed({ provider: p('openai'), allowedTools: ['Read'] })).toBe(false);
    // Claude keeps it, because its allow-list genuinely gates the MCP tool names.
    expect(dispatchToolsAllowed({ provider: p('claude'), allowedTools: ['Read'] })).toBe(true);
  });

  it('dispatchAccess "grant" is the explicit opt-in for a restricted-but-trusted turn', () => {
    // The sanctioned path for e.g. a war-room ops agent that genuinely needs
    // mission/schedule tools — materialized centrally, never adapter-side.
    const servers = dispatchMcpServersFor({
      provider: p('openai'),
      allowedTools: ['Read', 'Bash'],
      dispatchAccess: 'grant',
    });
    expect(Object.keys(servers)).toEqual([DISPATCH_STDIO_SERVER_NAME]);
  });

  it('dispatchAccess "deny" wins over an otherwise-eligible turn', () => {
    expect(dispatchMcpServersFor({ provider: p('claude'), dispatchAccess: 'deny' })).toEqual({});
    expect(dispatchMcpServersFor({ provider: p('openai'), dispatchAccess: 'deny' })).toEqual({});
  });

  it('a deny-all tool policy still wins over an explicit grant', () => {
    for (const type of ['claude', 'openai'] as const) {
      expect(dispatchMcpServersFor({
        provider: p(type),
        disallowedTools: ['*'],
        dispatchAccess: 'grant',
      })).toEqual({});
    }
  });

  it('grant does not extend dispatch to a restricted provider type', () => {
    expect(dispatchMcpServersFor({ provider: p('openrouter'), dispatchAccess: 'grant' })).toEqual({});
    expect(dispatchMcpServersFor({ provider: p('acp'), dispatchAccess: 'grant' })).toEqual({});
  });

  it('a deny-all wins over a conflicting allow-list', () => {
    const servers = dispatchMcpServersFor({
      provider: p('openai'),
      allowedTools: ['Bash', 'Write'],
      disallowedTools: ['*'],
    });
    expect(servers).toEqual({});
  });

  it('an undefined allow-list is "no restriction stated", not deny-all', () => {
    // Guards the distinction that makes the gate safe to apply everywhere: only
    // an EXPLICITLY empty array means "nothing".
    expect(Object.keys(dispatchMcpServersFor({ provider: p('claude'), allowedTools: undefined }))).toHaveLength(1);
  });
});
