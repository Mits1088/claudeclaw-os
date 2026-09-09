// App Server engine adapter — the Phase 2 exit gate.
//
// Driven through a FAKE manager: the transport is already covered by its own suite,
// so these exercise the adapter's own contract — thread config per capability
// profile, verify-before-turn/start, notification translation, per-turn usage from
// thread-cumulative totals, cancellation, and stale-session fallback.

import path from 'path';

import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => {
  const nodeOs = require('os');
  const nodePath = require('path');
  return {
    configDir: nodePath.join(nodeOs.tmpdir(), 'claudeclaw-appserver-adapter-test'),
    projectRoot: nodePath.join(nodeOs.tmpdir(), 'claudeclaw-appserver-proj'),
  };
});

vi.mock('../config.js', () => ({
  OPENAI_API_KEY: 'sk-test-openai',
  DEFAULT_OPENAI_MODEL: 'gpt-5.5',
  CLAUDECLAW_CONFIG: state.configDir,
  PROJECT_ROOT: state.projectRoot,
  CODEX_TRANSPORT: 'app-server',
  CODEX_APP_SERVER_MAX_CONCURRENT_TURNS: 8,
  // Read by the shared capability policy; off so profiles resolve normally.
  CODEX_DANGER_WRITE: false,
  EXFILTRATION_GUARD_ENABLED: false,
  PROTECTED_ENV_VARS: [],
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../security.js', () => ({ getScrubbedSdkEnv: () => ({ PATH: '/usr/bin' }) }));

import { CodexAppServerEngineAdapter, askUserQuestion, buildThreadConfig, friendlyAppServerError, isStaleThreadError, summarizeCommand } from './codex-app-server-adapter.js';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  ToolUserInputRequest,
} from './codex-app-server-protocol.js';
import { CodexAppServerRequestError } from './codex-app-server-client.js';
import { resolveCodexCapabilityProfile } from './codex-capability-policy.js';
import { CodexAppServerManager, type TurnSink } from './codex-app-server-manager.js';
import type { AgentEngineEvent, AgentTurnInput, AskUserQuestionAnswer, AskUserQuestionRequest } from './types.js';

const CWD = path.resolve('/tmp/agent-cwd');

describe('Codex App Server stale-session boundary', () => {
  it.each([
    'thread/resume failed: 401 unauthorized',
    'thread/resume failed: 429 rate limit',
    'thread/resume failed: model is not supported',
    'thread/resume failed: transport disconnected',
    'thread authentication missing',
  ])('does not treat %s as missing-session evidence', (message) => {
    expect(isStaleThreadError(message)).toBe(false);
  });

  it('accepts only explicit missing-session evidence', () => {
    expect(isStaleThreadError('thread/resume failed: no rollout found for thread id abc')).toBe(true);
    expect(isStaleThreadError('session id abc does not exist')).toBe(true);
  });
});

/** A scripted App Server: records requests and pushes notifications into the sink. */
class FakeServer {
  requests: Array<{ method: string; params: any }> = [];
  sinks: TurnSink[] = [];
  /**
   * Queued responses by method; a function may push notifications as a side effect.
   *
   * The two resume-hygiene methods answer by default the way the pinned binary does
   * for a thread that is not loaded and has no MCP servers, so a test only scripts
   * them when it is about them.
   */
  handlers: Record<string, (params: any) => unknown> = {
    'thread/unsubscribe': () => ({ status: 'notLoaded' }),
    'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
    'windowsSandbox/readiness': () => ({ status: 'ready' }),
  };
  released: string[] = [];
  acquired: string[] = [];
  /** Methods the server accepts and then never answers, so the caller times out. */
  withhold = new Set<string>();
  /** Reasons the adapter quarantined the connection, and the locks held at the time. */
  quarantined: Array<{ reason: string; releasedSoFar: number }> = [];
  /** Process-slot accounting: every terminal path must balance these. */
  slotsAcquired = 0;
  slotsReleased = 0;
  /** False stands for a Codex child that could not be terminated. */
  quarantineResult = true;
  /** Tail of the FIFO wait chain per thread id — the fake's real mutex. */
  private lockChain = new Map<string, Promise<void>>();

  /**
   * A REAL per-thread mutex, not a no-op: the ordering tests below only mean
   * something if the fake serializes the way CodexAppServerManager does.
   */
  private async acquireLock(threadId: string): Promise<() => void> {
    const previous = this.lockChain.get(threadId) ?? Promise.resolve();
    let releaseNext!: () => void;
    const held = new Promise<void>((resolve) => { releaseNext = resolve; });
    this.lockChain.set(threadId, previous.then(() => held));
    await previous;
    this.acquired.push(threadId);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.released.push(threadId);
      releaseNext();
    };
  }

  effective(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      thread: { id: 'thread-1' },
      model: 'gpt-5.5',
      modelProvider: 'openai',
      cwd: CWD,
      runtimeWorkspaceRoots: [CWD],
      instructionSources: [],
      approvalPolicy: 'never',
      // Default matches the default input, which resolves to workspace-agent. Tests
      // that pass a read-only tool policy override this with a readOnly sandbox.
      sandbox: { type: 'workspaceWrite', writableRoots: [CWD], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      activePermissionProfile: null,
      reasoningEffort: null,
      ...overrides,
    };
  }

  /** Reasons the manager would have poisoned the connection over. */
  protocolFaults: string[] = [];

  /**
   * Deliver as the real manager does — INCLUDING what it does when a sink rejects a
   * notification: tell every active sink the connection failed, once, and stop.
   * Swallowing the throw here would let an adapter that cannot parse a terminal look
   * like one that simply never received it.
   */
  notify(method: string, params: Record<string, unknown>): void {
    for (const sink of [...this.sinks]) {
      try {
        sink.deliver({ method, params });
      } catch (err) {
        const reason = `${method} could not be consumed: ${err instanceof Error ? err.message : String(err)}`;
        this.protocolFaults.push(reason);
        for (const s of [...this.sinks]) {
          s.deliver({ method: 'claudeclaw/transportFailed', params: { reason } });
        }
        this.sinks = [];
        return;
      }
    }
  }

  asManager(): CodexAppServerManager {
    const server = this;
    return {
      ready: async () => ({
        request: async (method: string, params: unknown, timeoutMs?: number) => {
          server.requests.push({ method, params });
          if (server.withhold.has(method)) {
            // Accepted and never answered — but any notifications the handler pushes
            // still arrive, so a turn can be underway with no response in sight. The
            // client's own timeout is what the caller eventually sees, so reproduce it
            // exactly, tag included.
            server.handlers[method]?.(params);
            await new Promise((resolve) => setTimeout(resolve, timeoutMs ?? 30_000));
            throw new CodexAppServerRequestError(
              `codex app-server request '${method}' timed out after ${timeoutMs}ms`,
              'unknown',
              method,
            );
          }
          const handler = server.handlers[method];
          if (!handler) throw new Error(`test: no handler for ${method}`);
          return handler(params);
        },
      }),
      addSink: (sink: TurnSink) => { server.sinks.push(sink); },
      removeSink: (sink: TurnSink) => { server.sinks = server.sinks.filter((s) => s !== sink); },
      acquireThreadLock: (threadId: string) => server.acquireLock(threadId),
      // Unlimited here: the real semaphore is exercised against the real manager. What
      // these tests care about is that every terminal path takes one and gives it back
      // exactly once.
      acquireTurnSlot: async () => {
        server.slotsAcquired += 1;
        let released = false;
        return () => { if (released) return; released = true; server.slotsReleased += 1; };
      },
      activeThreadCount: () => 0,
      activeTurnCount: () => 0,
      quarantine: async (reason: string) => {
        server.quarantined.push({ reason, releasedSoFar: server.released.length });
        return server.quarantineResult;
      },
      shutdown: async () => {},
    } as unknown as CodexAppServerManager;
  }
}

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { prompt: 'hi there', provider: { type: 'openai' }, cwd: CWD, ...overrides };
}

async function collect(server: FakeServer, input: AgentTurnInput): Promise<AgentEngineEvent[]> {
  const adapter = new CodexAppServerEngineAdapter({ manager: server.asManager() });
  const events: AgentEngineEvent[] = [];
  for await (const ev of adapter.invoke(input)) events.push(ev);
  return events;
}

/**
 * Same, with a hook fired the instant a `session` event is yielded — the moment a
 * real consumer learns a thread id and could start using it.
 */
async function collectWatchingSession(
  server: FakeServer,
  input: AgentTurnInput,
  onSession: (sessionId: string) => void,
): Promise<AgentEngineEvent[]> {
  const adapter = new CodexAppServerEngineAdapter({ manager: server.asManager() });
  const events: AgentEngineEvent[] = [];
  for await (const ev of adapter.invoke(input)) {
    events.push(ev);
    if (ev.type === 'session') onSession(ev.sessionId);
  }
  return events;
}

/**
 * A server that starts a thread, then completes the turn as scripted.
 *
 * `turn/start` answers with a real `TurnStartResponse` — `{ turn: Turn }`, the shape
 * the pinned binary returns — because the adapter takes the turn id from it and can no
 * longer cancel a turn the response failed to name.
 */
function scriptedServer(opts: {
  effective?: Record<string, unknown>;
  onTurnStart?: (server: FakeServer) => void;
  /** The turn the response names; fixtures notify under the same id. */
  turnId?: string;
} = {}): FakeServer {
  const server = new FakeServer();
  const turnId = opts.turnId ?? 't1';
  server.handlers['thread/start'] = () => server.effective(opts.effective);
  server.handlers['thread/resume'] = () => server.effective(opts.effective);
  server.handlers['turn/interrupt'] = () => ({});
  server.handlers['turn/start'] = () => {
    if (opts.onTurnStart) opts.onTurnStart(server);
    else {
      server.notify('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } });
      server.notify('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } });
    }
    return { turn: { id: turnId, status: 'inProgress' } };
  };
  return server;
}

describe('native Windows containment preflight', () => {
  it('requires elevated sandbox readiness before thread/start', async () => {
    const server = scriptedServer();
    server.handlers['windowsSandbox/readiness'] = () => ({ status: 'updateRequired' });
    const adapter = new CodexAppServerEngineAdapter({ manager: server.asManager(), platform: 'win32' });
    const events: AgentEngineEvent[] = [];

    for await (const event of adapter.invoke(baseInput())) events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: 'result',
      stopReason: 'error',
      text: expect.stringContaining('updateRequired'),
    });
    expect(server.requests.map((request) => request.method)).toEqual(['windowsSandbox/readiness']);
    expect(server.slotsReleased).toBe(1);
  });

  it('starts only after readiness is proven', async () => {
    const server = scriptedServer();
    const adapter = new CodexAppServerEngineAdapter({ manager: server.asManager(), platform: 'win32' });
    const events: AgentEngineEvent[] = [];

    for await (const event of adapter.invoke(baseInput())) events.push(event);

    expect(events.at(-1)?.type).toBe('result');
    expect(server.requests[0]).toEqual({ method: 'windowsSandbox/readiness', params: undefined });
    expect(server.requests.some((request) => request.method === 'thread/start')).toBe(true);
  });
});

/** Minimal client stub for driving the real manager's server-request handler. */
class FakeManagerClient {
  serverRequest!: (request: JsonRpcRequest) => Promise<
    { result: unknown } | { error: { code: number; message: string; data?: unknown } }
  >;
  async start(): Promise<unknown> { return {}; }
  async shutdown(): Promise<void> {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
});

describe('thread configuration per capability profile', () => {
  it('tool-less disables shell, host apps and web search, and sends no MCP', () => {
    const profile = resolveCodexCapabilityProfile({ allowedTools: [], disallowedTools: ['*'] }, { dangerWriteEnabled: false });
    const config = buildThreadConfig(profile, undefined) as any;
    expect(config.features).toEqual({ shell_tool: false, apps: false });
    expect(config.web_search).toBe('disabled');
    // An EMPTY table, not an omission: on a resume, saying nothing about MCP leaves
    // the previous caller's servers unstated rather than replaced.
    expect(config.mcp_servers).toEqual({});
    expect(config.sandbox_workspace_write).toBeUndefined();
  });

  it('read-only-research keeps the shell but still disables host apps', () => {
    const profile = resolveCodexCapabilityProfile({ allowedTools: ['Read', 'Grep'] }, { dangerWriteEnabled: false });
    const config = buildThreadConfig(profile, undefined) as any;
    expect(config.features).toEqual({ apps: false });
  });

  it('workspace-agent REQUESTS both temp exclusions and network off', () => {
    // Without these, temp directories become implicit writable roots and the
    // "writes confined to the workspace" promise is broader than advertised.
    const profile = resolveCodexCapabilityProfile({}, { dangerWriteEnabled: false });
    const config = buildThreadConfig(profile, undefined) as any;
    expect(config.sandbox_workspace_write).toEqual({
      network_access: false,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
    expect(config.features).toBeUndefined(); // trusted turn keeps shell + host apps
  });

  it('always hardens project docs, provider pinning and shell env', () => {
    const config = buildThreadConfig(resolveCodexCapabilityProfile({}, { dangerWriteEnabled: false }), undefined) as any;
    expect(config.project_doc_max_bytes).toBe(0);
    expect(config.model_provider).toBe('openai');
    expect(config.allow_login_shell).toBe(false);
    expect(config.shell_environment_policy.exclude).toEqual(expect.arrayContaining(['OPENAI_API_KEY', '*_TOKEN']));
  });

  it('delivers reasoning effort through config, since thread/start has no field for it', () => {
    const config = buildThreadConfig(resolveCodexCapabilityProfile({}, { dangerWriteEnabled: false }), 'high') as any;
    expect(config.model_reasoning_effort).toBe('high');
  });

  it('maps the authorized MCP set and adds nothing', () => {
    const profile = resolveCodexCapabilityProfile(
      { mcpServers: { 'files.local': { command: 'mcp-files' }, legacy: { type: 'sse', url: 'https://x' } } },
      { dangerWriteEnabled: false },
    );
    const config = buildThreadConfig(profile, undefined) as any;
    expect(Object.keys(config.mcp_servers)).toEqual(['files_local']); // sse skipped
    expect(config.mcp_servers).not.toHaveProperty('claudeclaw-dispatch');
  });
});

describe('thread start and session handling', () => {
  it('starts a thread, emits the session id, and completes', async () => {
    const server = scriptedServer();
    const events = await collect(server, baseInput());

    expect(server.requests[0].method).toBe('thread/start');
    expect(server.requests[0].params).toMatchObject({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      cwd: CWD,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
    expect(events[0]).toMatchObject({ type: 'session', sessionId: 'thread-1' });
    expect(events.at(-1)).toMatchObject({ type: 'result', stopReason: 'end_turn' });
  });

  it('does not send the unsupported none effort to GPT-6 Astra', async () => {
    const server = scriptedServer();
    await collect(server, baseInput({ model: 'gpt-6-astra', thinkingMode: 'none' }));

    expect(server.requests[0].params.config).not.toHaveProperty('model_reasoning_effort');
  });

  it('resumes an existing thread with excludeTurns and re-applies caller policy', async () => {
    // Resume is where the current caller's MCP set and policy are re-applied, and
    // where the effective policy is re-verified.
    const server = scriptedServer();
    await collect(server, baseInput({ sessionId: 'thread-1' }));

    const resume = server.requests.find((r) => r.method === 'thread/resume')!;
    expect(resume.params).toMatchObject({ threadId: 'thread-1', excludeTurns: true, approvalPolicy: 'never' });
  });

  it('carries the current runtime identity through start and resume developer instructions', async () => {
    const sol = 'You are currently running on GPT-5.6 Sol (provider: openai).';
    const luna = 'You are currently running on GPT-5.6 Luna (provider: openai).';
    const first = scriptedServer();
    await collect(first, baseInput({ runtimeIdentity: sol }));
    expect(first.requests.find((r) => r.method === 'thread/start')!.params.developerInstructions).toBe(sol);

    const second = scriptedServer();
    await collect(second, baseInput({ sessionId: 'thread-1', runtimeIdentity: luna }));
    expect(second.requests.find((r) => r.method === 'thread/resume')!.params.developerInstructions).toBe(luna);
  });

  it('uses a newly selected model on the next turn of the same thread', async () => {
    const server = scriptedServer();
    server.handlers['thread/start'] = (params) => server.effective({ model: params.model });
    server.handlers['thread/resume'] = (params) => server.effective({ model: params.model });

    await collect(server, baseInput({ model: 'gpt-5.6-sol' }));
    await collect(server, baseInput({ sessionId: 'thread-1', model: 'gpt-5.6-luna' }));

    expect(server.requests.find((r) => r.method === 'thread/start')!.params.model).toBe('gpt-5.6-sol');
    expect(server.requests.find((r) => r.method === 'thread/resume')!.params).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-5.6-luna',
    });
  });

  it('does not re-emit a session event for an unchanged resumed thread', async () => {
    const server = scriptedServer();
    const events = await collect(server, baseInput({ sessionId: 'thread-1' }));
    expect(events.filter((e) => e.type === 'session')).toHaveLength(0);
  });

  it('falls back to a fresh thread when resume reports a missing rollout', async () => {
    // The exact error the pinned binary returns for a thread with no rollout.
    const server = scriptedServer();
    server.handlers['thread/resume'] = () => {
      throw new Error('thread/resume failed: no rollout found for thread id 019f-old');
    };
    const events = await collect(server, baseInput({ sessionId: '019f-old' }));

    expect(server.requests.map((r) => r.method)).toEqual(['thread/unsubscribe', 'thread/resume', 'thread/start', 'turn/start']);
    expect(events[0]).toMatchObject({ type: 'session', sessionId: 'thread-1' });
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
  });

  it('does NOT fall back for an unrelated resume failure', async () => {
    // Only a missing thread justifies a fresh start; anything else is a real error.
    const server = scriptedServer();
    server.handlers['thread/resume'] = () => { throw new Error('429 rate limit exceeded'); };
    const events = await collect(server, baseInput({ sessionId: 'thread-1' }));

    expect(server.requests.map((r) => r.method)).toEqual(['thread/unsubscribe', 'thread/resume']);
    expect(events.at(-1)).toMatchObject({ stopReason: 'error' });
    expect((events.at(-1) as any).text).toMatch(/rate\/usage limit/);
  });

  it('classifies stale-thread errors without matching unrelated ones', () => {
    expect(isStaleThreadError('no rollout found for thread id abc')).toBe(true);
    expect(isStaleThreadError('thread not found')).toBe(true);
    expect(isStaleThreadError('429 rate limit')).toBe(false);
    expect(isStaleThreadError('model overloaded')).toBe(false);
  });

  it('explains a staged ChatGPT model rollout without dumping the upstream JSON', () => {
    const friendly = friendlyAppServerError(
      '{"error":{"message":"The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account."}}',
    );
    expect(friendly).toMatch(/not enabled.*ChatGPT Codex account/i);
    expect(friendly).toMatch(/API key/);
    expect(friendly).not.toContain('{"error"');
  });
});

describe('effective-policy verification gates the turn', () => {
  it('refuses to start a turn when the host downgrades the sandbox', async () => {
    // The observed native-Windows behaviour: workspace-write requested, readOnly
    // applied. Running anyway would report success while writing nothing.
    const server = scriptedServer({ effective: { sandbox: { type: 'readOnly', networkAccess: false } } });
    const events = await collect(server, baseInput());

    expect(server.requests.map((r) => r.method)).toEqual(['thread/start']);
    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    const result = events.at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/refused: the host applied a different SANDBOX or AUTHORIZATION policy/);
    expect(result.text).toMatch(/sandbox type is "readOnly", requested "workspace-write"/);
  });

  it('refuses when instructionSources is non-empty (persona would be doubled)', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: ['/x/AGENTS.md'] },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    expect((events.at(-1) as any).text).toMatch(/instructionSources is non-empty/);
    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
  });

  it('does NOT refuse when only the reasoning effort differs on a resumed thread', async () => {
    // The real report: changing the dashboard effort mid-conversation refused every
    // turn with a "host policy" error. Effort is fixed when the Codex thread is
    // created, so the conversation legitimately continues at the thread's value.
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: 'high' },
    });
    const events = await collect(server, baseInput({
      sessionId: 'thread-1',
      allowedTools: ['Read'],
      thinkingMode: 'medium',
    }));

    // The turn RUNS.
    expect(server.requests.map((r) => r.method)).toContain('turn/start');
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });

    // ...and the difference is reported rather than swallowed.
    const notice = events.find((e) => e.type === 'progress' && (e as any).progress.kind === 'notice') as any;
    expect(notice.progress.description).toMatch(/continues at "high"/);
    expect(notice.progress.description).toMatch(/change to "medium" applies to a new chat/);
  });

  it('applies the new effort once a fresh thread is started', async () => {
    // What /newchat does: no sessionId, so the requested effort is what the thread
    // is created with, and there is nothing to warn about.
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: 'medium' },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'], thinkingMode: 'medium' }));

    expect(server.requests[0].params.config.model_reasoning_effort).toBe('medium');
    expect(events.some((e) => e.type === 'progress' && (e as any).progress.kind === 'notice')).toBe(false);
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
  });

  it('still refuses a real sandbox violation even when an effort notice applies', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'dangerFullAccess' }, reasoningEffort: 'high' },
    });
    const events = await collect(server, baseInput({ sessionId: 'thread-1', allowedTools: ['Read'], thinkingMode: 'medium' }));
    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/sandbox type is "dangerFullAccess"/);
  });

  it('starts the turn when the effective policy matches', async () => {
    const server = scriptedServer({ effective: { sandbox: { type: 'readOnly', networkAccess: false } } });
    const events = await collect(server, baseInput({ allowedTools: ['Read', 'Grep'] }));
    expect(server.requests.map((r) => r.method)).toContain('turn/start');
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
  });

  it('rejects a response whose paths are not absolute', async () => {
    const server = scriptedServer({ effective: { cwd: '.', sandbox: { type: 'readOnly', networkAccess: false } } });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    expect((events.at(-1) as any).text).toMatch(/not absolute/);
  });
});

describe('notification translation', () => {
  it('streams text deltas and uses item snapshots for the terminal text', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 't1', itemId: 'm1', delta: 'Hel' });
        s.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 't1', itemId: 'm1', delta: 'lo' });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { type: 'agentMessage', id: 'm1', text: 'Hello' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));

    const deltas = events.filter((e) => e.type === 'text_delta') as any[];
    expect(deltas.map((d) => d.delta)).toEqual(['Hel', 'lo']);
    expect(deltas[1].accumulatedText).toBe('Hello');
    expect((events.at(-1) as any).text).toBe('Hello');
  });

  it('maps command, file, MCP and search items onto progress events', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item: { type: 'commandExecution', id: 'c1', command: 'ls -la', status: 'inProgress' } });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { type: 'commandExecution', id: 'c1', command: 'ls -la', status: 'completed', exitCode: 0 } });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { type: 'commandExecution', id: 'c2', command: 'bad-cmd', status: 'failed', exitCode: 1 } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item: { type: 'mcpToolCall', id: 'x1', server: 'obsidian', tool: 'search', status: 'inProgress' } });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { type: 'fileChange', id: 'f1', changes: [{ path: 'src/a.ts' }], status: 'completed' } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item: { type: 'webSearch', id: 'w1', query: 'codex app server' } });
        s.notify('turn/plan/updated', { threadId: 'thread-1', turnId: 't1', explanation: 'Plan', plan: [{ step: 'do it', status: 'pending' }] });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const progress = (await collect(server, baseInput({ allowedTools: ['Read'] })))
      .filter((e) => e.type === 'progress').map((e: any) => e.progress);

    expect(progress).toContainEqual(expect.objectContaining({ type: 'tool_active', kind: 'execute', description: 'ls -la' }));
    // A SUCCESSFUL command stays quiet; only a non-zero exit surfaces on completion,
    // and it surfaces as an ADVISORY carrying its exit code — never as a failure. `rg`
    // exits 1 on no match, so a failure verdict here reads as a broken agent.
    expect(progress).not.toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'execute', status: 'completed' }));
    expect(progress).not.toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'execute', status: 'failed' }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'execute', status: 'notice', description: 'bad-cmd · exit 1' }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'tool_active', kind: 'mcp', description: 'obsidian · search' }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'edit', locations: [{ path: 'src/a.ts' }] }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'tool_active', kind: 'search' }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'plan', planEntries: [{ content: 'do it', status: 'pending' }] }));
  });

  it('ignores unknown notifications and unknown item types', async () => {
    // `remoteControl/status/changed` arrives unsolicited on a real connection.
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('remoteControl/status/changed', { threadId: 'thread-1' });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { type: 'imageGeneration', id: 'i1' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
  });

  it('paragraph-breaks the streamed text between consecutive message items', async () => {
    // gpt-5.x narrates a preamble before each tool call, so a turn produces several
    // agentMessage items. `accumulated` spans the turn, so without a boundary the
    // display ran them together: "never secret values.The active files are…".
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 't1', itemId: 'm1', delta: 'never secret values.' });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { type: 'agentMessage', id: 'm1', text: 'never secret values.' } });
        s.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 't1', itemId: 'm2', delta: 'The active files are readable.' });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { type: 'agentMessage', id: 'm2', text: 'The active files are readable.' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    const deltas = events.filter((e) => e.type === 'text_delta') as any[];

    expect(deltas.at(-1).accumulatedText).toBe('never secret values.\n\nThe active files are readable.');
    expect(deltas.at(-1).accumulatedText).not.toContain('values.The');
  });

  it('does not inject a break between deltas of the SAME item', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 't1', itemId: 'm1', delta: 'Hel' });
        s.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 't1', itemId: 'm1', delta: 'lo.' });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    const deltas = events.filter((e) => e.type === 'text_delta') as any[];
    expect(deltas.at(-1).accumulatedText).toBe('Hello.');
  });

  it('opens the pre-text window on turn/started, before any item arrives', async () => {
    // The silence this closes: on a long reasoning phase nothing but turn/started has
    // been emitted yet, so anchoring on any item type leaves the chat blank.
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    const first = events.find((e) => e.type === 'progress') as any;
    expect(first.progress).toMatchObject({ type: 'tool_active', kind: 'thinking', description: 'Thinking' });
  });

  it('surfaces a reasoning item as thinking progress, summary headline only', async () => {
    // The pinned 0.144.6 wire shape: `summary` and `content` arrays, no `text`. Reading a
    // `text` member that does not exist is why this line rendered blank for every turn.
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', {
          threadId: 'thread-1',
          turnId: 't1',
          item: { type: 'reasoning', id: 'r1', summary: [], content: [] },
        });
        s.notify('item/completed', {
          threadId: 'thread-1',
          turnId: 't1',
          item: {
            type: 'reasoning',
            id: 'r1',
            summary: ['**Checking the config**\n\nThe rest of the summary stays put.'],
            content: ['THE FULL REASONING TRACE MUST NEVER BE SHOWN'],
          },
        });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const progress = (await collect(server, baseInput({ allowedTools: ['Read'] })))
      .filter((e) => e.type === 'progress').map((e: any) => e.progress);

    expect(progress).toContainEqual(expect.objectContaining({ kind: 'thinking', description: 'Checking the config', toolCallId: 'r1' }));
    // Only the headline of the SUMMARY travels...
    expect(progress.some((p: any) => p.description.includes('stays put'))).toBe(false);
    // ...and the content never does, at any length.
    expect(progress.some((p: any) => /MUST NEVER BE SHOWN/i.test(p.description))).toBe(false);
  });

  it('shows nothing rather than falling back to content when there is no summary', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/completed', {
          threadId: 'thread-1',
          turnId: 't1',
          item: { type: 'reasoning', id: 'r1', summary: [], content: ['DETAIL BEYOND THE SAFE SUMMARY'] },
        });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const progress = (await collect(server, baseInput({ allowedTools: ['Read'] })))
      .filter((e) => e.type === 'progress').map((e: any) => e.progress);

    expect(progress.some((p: any) => /DETAIL BEYOND/i.test(p.description))).toBe(false);
    // The turn still completes; an empty summary is simply nothing to display.
    expect(progress.some((p: any) => p.kind === 'thinking')).toBe(true);
  });

  it('accepts every plausible spelling of the reasoning item type', async () => {
    // `reasoning` is the pinned spelling; the other two are tolerance for a build using
    // the SDK's snake_case convention. A miss here is silent, so all three map.
    for (const type of ['reasoning', 'agentReasoning', 'agent_reasoning']) {
      const server = scriptedServer({
        effective: { sandbox: { type: 'readOnly', networkAccess: false } },
        onTurnStart: (s) => {
          s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
          s.notify('item/completed', {
            threadId: 'thread-1',
            turnId: 't1',
            item: { type, id: 'r1', summary: ['Weighing options'], content: [] },
          });
          s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
        },
      });
      const progress = (await collect(server, baseInput({ allowedTools: ['Read'] })))
        .filter((e) => e.type === 'progress').map((e: any) => e.progress);
      expect(progress, `spelling: ${type}`).toContainEqual(expect.objectContaining({ kind: 'thinking', description: 'Weighing options' }));
    }
  });

  it('emits one compact event for a compaction', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('thread/compacted', { threadId: 'thread-1', turnId: 't1' });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    expect(events.filter((e) => e.type === 'compact')).toHaveLength(1);
  });
});

describe('usage accounting', () => {
  const usageNotify = (s: FakeServer, total: number[], last: number[]) => {
    const [totalTokens, inputTokens, cachedInputTokens, outputTokens] = total;
    const [lt, li, lc, lo] = last;
    s.notify('thread/tokenUsage/updated', {
      threadId: 'thread-1',
      turnId: 't1',
      tokenUsage: {
        total: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0 },
        last: { totalTokens: lt, inputTokens: li, cachedInputTokens: lc, outputTokens: lo, reasoningOutputTokens: 0 },
        modelContextWindow: 272000,
      },
    });
  };

  it('derives per-turn usage from thread-CUMULATIVE totals', async () => {
    // The thread already carries history; only this turn's delta may be attributed
    // to it. The first report seeds from `last`, later ones add the total delta.
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        usageNotify(s, [5000, 4000, 1000, 1000], [500, 400, 100, 100]);
        usageNotify(s, [5900, 4700, 1200, 1200], [400, 300, 100, 100]);
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    const usage = (events.find((e) => e.type === 'usage') as any).usage;

    // seed 400/100/100 + delta(4700-4000=700 in, 1200-1000=200 cached, 200 out)
    // inputTokens EXCLUDES cache reads: (400+700) - (100+200) = 800
    expect(usage.inputTokens).toBe(800);
    expect(usage.cacheReadInputTokens).toBe(300);
    expect(usage.outputTokens).toBe(300);
    expect(usage.inputTokens + usage.cacheReadInputTokens).toBe(1100);
    expect(usage.contextWindow).toBe(272000);
    expect(usage.totalCostUsd).toBeGreaterThan(0);
  });

  it('never attributes a decreasing total as negative usage', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        usageNotify(s, [5000, 4000, 1000, 1000], [500, 400, 100, 100]);
        usageNotify(s, [100, 50, 10, 10], [50, 40, 10, 10]); // a reset/compaction
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const usage = ((await collect(server, baseInput({ allowedTools: ['Read'] })))
      .find((e) => e.type === 'usage') as any).usage;
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
  });

  it('emits zeroed usage when the turn reports none', async () => {
    const server = scriptedServer({ effective: { sandbox: { type: 'readOnly', networkAccess: false } } });
    const usage = ((await collect(server, baseInput({ allowedTools: ['Read'] })))
      .find((e) => e.type === 'usage') as any).usage;
    expect(usage.inputTokens).toBe(0);
    expect(usage.model).toBe('gpt-5.5');
  });
});

describe('terminal statuses', () => {
  it('maps a failed turn to a visible error result, not a bare error event', async () => {
    // agent.ts does not render bare `error` events.
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'failed', error: { message: '401 unauthorized' } } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const result = events.at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/isn't authenticated/);
  });

  it('maps an interrupted turn to aborted', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    expect(events.at(-1)).toMatchObject({ type: 'aborted', sessionId: 'thread-1' });
  });

  it('treats an unknown terminal status as a protocol error rather than guessing', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'quantum' } });
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'] }));
    // The turn does not silently report success.
    expect(events.at(-1)).not.toMatchObject({ stopReason: 'end_turn' });
  });
});

describe('cancellation is turn-scoped', () => {
  it('interrupts the specific turn and yields aborted with partial text', async () => {
    const abortController = new AbortController();
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 't1', itemId: 'm1', delta: 'partial' });
        abortController.abort();
        // The server acknowledges the interrupt with a terminal notification.
        setTimeout(() => s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } }), 5);
      },
    });
    const events = await collect(server, baseInput({ allowedTools: ['Read'], abortController }));

    const interrupt = server.requests.find((r) => r.method === 'turn/interrupt');
    expect(interrupt?.params).toEqual({ threadId: 'thread-1', turnId: 't1' });
    const aborted = events.at(-1) as any;
    expect(aborted.type).toBe('aborted');
    expect(aborted.text).toBe('partial');
  });

  it('releases the per-thread lock even when the turn fails', async () => {
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: () => { throw new Error('boom'); },
    });
    await collect(server, baseInput({ allowedTools: ['Read'] }));
    expect(server.released).toEqual(['thread-1']);
  });
});

describe('per-thread serialization spans resume and verification', () => {
  // The race this closes: `thread/resume` REWRITES shared thread state, so verifying
  // the effective policy outside the lock let a second caller reconfigure the same
  // thread between caller A's verification and A's turn/start.

  /** Hand control back to the loop so a second caller can interleave here. */
  const tick = (): Promise<void> => new Promise((resolve) => {
    const t = setTimeout(resolve, 0);
    t.unref?.();
  });

  /** Logs who is doing what, with an interleaving window inside every request. */
  function serializedServer(log: string[]): FakeServer {
    const server = new FakeServer();
    server.handlers['thread/resume'] = async (params: any) => {
      log.push(`resume:${params.developerInstructions}`);
      await tick();
      return server.effective({ sandbox: { type: 'readOnly', networkAccess: false } });
    };
    server.handlers['turn/start'] = async (params: any) => {
      const who = params.input[0].text;
      log.push(`start:${who}`);
      await tick();
      server.notify('turn/started', { threadId: 'thread-1', turn: { id: `turn-${who}`, status: 'inProgress' } });
      server.notify('turn/completed', { threadId: 'thread-1', turn: { id: `turn-${who}`, status: 'completed' } });
      log.push(`complete:${who}`);
      return { turn: { id: `turn-${who}`, status: 'inProgress' } };
    };
    return server;
  }

  const invoke = (server: FakeServer, who: string): Promise<AgentEngineEvent[]> => collect(server, baseInput({
    sessionId: 'thread-1',
    allowedTools: ['Read'],
    systemPrompt: who, // travels as developerInstructions, so resume is attributable
    prompt: who,
  }));

  it('runs two invocations on one session end to end, never interleaved', async () => {
    const log: string[] = [];
    const server = serializedServer(log);
    const [a, b] = await Promise.all([invoke(server, 'A'), invoke(server, 'B')]);

    // Before the fix this was resume:A, resume:B, start:A — B's configuration would
    // already be live on the thread by the time A's verified turn began.
    expect(log).toEqual(['resume:A', 'start:A', 'complete:A', 'resume:B', 'start:B', 'complete:B']);
    expect(a.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(b.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    // The lock is taken on the SESSION id, once per invocation, and always given back.
    expect(server.acquired).toEqual(['thread-1', 'thread-1']);
    expect(server.released).toEqual(['thread-1', 'thread-1']);
  });

  it('releases the lock when resume fails, rather than blocking the next invocation', async () => {
    const log: string[] = [];
    const server = serializedServer(log);
    const resumeOk = server.handlers['thread/resume'];
    let firstResume = true;
    server.handlers['thread/resume'] = async (params: any) => {
      if (!firstResume) return resumeOk(params);
      firstResume = false;
      log.push(`resume:${params.developerInstructions}`);
      await tick();
      throw new Error('429 rate limit exceeded'); // not a stale thread: no fallback
    };
    const [a, b] = await Promise.all([invoke(server, 'A'), invoke(server, 'B')]);

    expect(log).toEqual(['resume:A', 'resume:B', 'start:B', 'complete:B']);
    expect((a.at(-1) as any).stopReason).toBe('error');
    expect(b.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(server.released).toEqual(['thread-1', 'thread-1']);
  });

  it('releases the lock when the effective policy refuses the turn', async () => {
    const server = scriptedServer({ effective: { sandbox: { type: 'dangerFullAccess' } } });
    const events = await collect(server, baseInput({ sessionId: 'thread-1', allowedTools: ['Read'] }));

    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(server.acquired).toEqual(['thread-1']);
    expect(server.released).toEqual(['thread-1']);
    expect((events.at(-1) as any).stopReason).toBe('error');
  });

  it('releases the lock when a resumed turn is cancelled', async () => {
    const abortController = new AbortController();
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort();
        setTimeout(() => s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } }), 5);
      },
    });
    const events = await collect(server, baseInput({ sessionId: 'thread-1', allowedTools: ['Read'], abortController }));

    expect(events.at(-1)).toMatchObject({ type: 'aborted' });
    expect(server.released).toEqual(['thread-1']);
  });

  // ── locks cover every id this turn NAMES, not just the one it started with ──
  const READ_ONLY = { sandbox: { type: 'readOnly', networkAccess: false } };

  it('locks a fresh thread BEFORE its id is published to the caller', async () => {
    // The session event is how a consumer learns the id, so the lock has to exist by
    // the time that event is yielded — not after verification.
    const server = scriptedServer({ effective: READ_ONLY });
    let lockedAtSession: string[] = [];
    const events = await collectWatchingSession(server, baseInput({ allowedTools: ['Read'] }), () => {
      lockedAtSession = [...server.acquired];
    });

    expect(lockedAtSession).toEqual(['thread-1']);
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(server.released).toEqual(['thread-1']);
  });

  it('holds BOTH the stale id and the replacement id through a fallback', async () => {
    const server = scriptedServer({ effective: READ_ONLY });
    server.handlers['thread/resume'] = () => { throw new Error('no rollout found for thread id 019f-old'); };
    let lockedAtSession: string[] = [];
    const events = await collectWatchingSession(server, baseInput({ sessionId: '019f-old', allowedTools: ['Read'] }), () => {
      lockedAtSession = [...server.acquired];
    });

    // Stale id stays locked (callers still holding it are serialized); the
    // replacement is locked before it is announced.
    expect(lockedAtSession).toEqual(['019f-old', 'thread-1']);
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(server.released).toEqual(['thread-1', '019f-old']); // reverse of acquisition
  });

  it('makes a consumer of the replacement id wait for the fallback turn', async () => {
    // The exact race: the caller stores the new session id the moment it arrives and
    // immediately starts another turn on it, while the first turn has not begun.
    const log: string[] = [];
    const server = new FakeServer();
    server.handlers['thread/start'] = () => { log.push('thread/start'); return server.effective(READ_ONLY); };
    server.handlers['thread/resume'] = async (params: any) => {
      log.push(`resume:${params.threadId}`);
      await tick();
      if (params.threadId === '019f-old') throw new Error('no rollout found for thread id 019f-old');
      return server.effective(READ_ONLY);
    };
    server.handlers['turn/start'] = async (params: any) => {
      const who = params.input[0].text;
      log.push(`start:${who}`);
      await tick();
      server.notify('turn/started', { threadId: 'thread-1', turn: { id: `turn-${who}`, status: 'inProgress' } });
      server.notify('turn/completed', { threadId: 'thread-1', turn: { id: `turn-${who}`, status: 'completed' } });
      log.push(`complete:${who}`);
      return { turn: { id: `turn-${who}`, status: 'inProgress' } };
    };

    let second!: Promise<AgentEngineEvent[]>;
    const first = await collectWatchingSession(
      server,
      baseInput({ sessionId: '019f-old', allowedTools: ['Read'], prompt: 'A' }),
      (sessionId) => {
        log.push(`session:${sessionId}`);
        second = collect(server, baseInput({ sessionId, allowedTools: ['Read'], prompt: 'B' }));
      },
    );
    const secondEvents = await second;

    expect(log).toEqual([
      'resume:019f-old', 'thread/start', 'session:thread-1', 'start:A', 'complete:A',
      'resume:thread-1', 'start:B', 'complete:B',
    ]);
    expect(first.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(secondEvents.at(-1)).toMatchObject({ stopReason: 'end_turn' });
    expect(server.released).toEqual(['thread-1', '019f-old', 'thread-1']);
  });

  it('fails closed when a SUCCESSFUL resume returns a different thread id', async () => {
    const server = scriptedServer({ effective: { ...READ_ONLY, thread: { id: 'thread-other' } } });
    const events = await collect(server, baseInput({ sessionId: 'thread-1', allowedTools: ['Read'] }));

    expect(server.requests.map((r) => r.method)).toEqual(['thread/unsubscribe', 'thread/resume']);
    // Neither published nor acted on: the id we hold a lock for is the only one that
    // may run a turn.
    expect(events.some((e) => e.type === 'session')).toBe(false);
    expect(server.acquired).toEqual(['thread-1']);
    expect(server.released).toEqual(['thread-1']);
    expect((events.at(-1) as any).stopReason).toBe('error');
    expect((events.at(-1) as any).text).toMatch(/returned a different thread \(thread-other\)/);
  });

  it('releases BOTH fallback locks when the turn itself fails', async () => {
    const server = scriptedServer({ effective: READ_ONLY });
    server.handlers['thread/resume'] = () => { throw new Error('no rollout found for thread id 019f-old'); };
    server.handlers['turn/start'] = () => { throw new Error('boom'); };
    const events = await collect(server, baseInput({ sessionId: '019f-old', allowedTools: ['Read'] }));

    expect(server.acquired).toEqual(['019f-old', 'thread-1']);
    expect(server.released).toEqual(['thread-1', '019f-old']);
    expect((events.at(-1) as any).stopReason).toBe('error');
  });
});

describe('the adapter never adds an MCP server', () => {
  it('sends an EMPTY mcp_servers table when the caller authorized none', async () => {
    const server = scriptedServer({ effective: { sandbox: { type: 'readOnly', networkAccess: false } } });
    await collect(server, baseInput({ allowedTools: ['Read'] }));
    const config = server.requests[0].params.config;
    expect(config.mcp_servers).toEqual({});
  });

  it('passes through exactly the authorized set', async () => {
    const server = scriptedServer({ effective: { sandbox: { type: 'readOnly', networkAccess: false } } });
    await collect(server, baseInput({ allowedTools: ['Read'], mcpServers: { files: { command: 'mcp-files' } } }));
    expect(Object.keys(server.requests[0].params.config.mcp_servers)).toEqual(['files']);
  });
});

describe('a resumed thread carries only the MCP servers THIS turn authorized', () => {
  // Finding 2. A thread can run with authorized ClaudeClaw MCP servers and later be
  // resumed by a restricted caller. Probed against pinned 0.144.6:
  //  - a resume that REJOINS a thread already loaded in the App Server process
  //    ignores the resume parameters wholesale, so `mcp_servers: {}` clears nothing;
  //  - `thread/unsubscribe` first makes the resume rebuild the thread from these
  //    parameters (proven for the MCP table, the sandbox and the model);
  //  - `mcpServerStatus/list { threadId }` is the only view of what the thread can
  //    actually reach, so it is read back rather than assumed.
  // Neither thread response carries an MCP field, which is why none of this can be
  // inferred from the effective policy the sandbox check already verifies.

  const READ_ONLY = { sandbox: { type: 'readOnly', networkAccess: false } };

  /** A resume-capable server whose thread reports `inventory` as its MCP set. */
  function serverWithInventory(inventory: string[], effective: Record<string, unknown> = READ_ONLY): FakeServer {
    const server = scriptedServer({ effective });
    server.handlers['mcpServerStatus/list'] = () => ({
      data: inventory.map((name) => ({ name, serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: 'unsupported' })),
      nextCursor: null,
    });
    return server;
  }

  /** The restricted caller: read-only research, no MCP server authorized. */
  const restricted = { sessionId: 'thread-1', allowedTools: ['Read'] as string[] };

  it('drops the loaded thread before resuming, so the resume applies THIS table', async () => {
    const server = serverWithInventory([]);
    await collect(server, baseInput(restricted));

    expect(server.requests.map((r) => r.method)).toEqual([
      'thread/unsubscribe', 'thread/resume', 'mcpServerStatus/list', 'turn/start',
    ]);
    expect(server.requests[0].params).toEqual({ threadId: 'thread-1' });
    // The authoritative statement of the set, sent even though it is empty.
    expect(server.requests[1].params.config.mcp_servers).toEqual({});
  });

  it('refuses the turn when a server from an earlier turn is still reachable', async () => {
    // The transition the finding describes: a privileged turn authorized
    // `claudeclaw-dispatch`; this restricted caller authorizes nothing.
    const server = serverWithInventory(['claudeclaw-dispatch']);
    const events = await collect(server, baseInput(restricted));

    // Refused BEFORE turn/start: the prompt never reaches the thread.
    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    const result = events.at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/MCP servers are not the set this turn authorized/);
    expect(result.text).toMatch(/"claudeclaw-dispatch" is reachable but this turn did not authorize it/);
    // And the lock is not left held behind the refusal.
    expect(server.released).toEqual(['thread-1']);
  });

  it('refuses when the thread kept a server the turn narrowed away', async () => {
    // Same class of inheritance, one step less obvious: the caller still authorizes
    // one server, and the thread reaches that one PLUS a leftover.
    const server = serverWithInventory(['files', 'claudeclaw-dispatch']);
    const events = await collect(server, baseInput({
      ...restricted,
      mcpServers: { files: { command: 'mcp-files' } },
    }));

    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/"claudeclaw-dispatch" is reachable/);
    expect((events.at(-1) as any).text).not.toMatch(/"files" is reachable/);
  });

  it('runs the turn when the inventory is exactly the authorized set', async () => {
    const server = serverWithInventory(['files']);
    const events = await collect(server, baseInput({
      ...restricted,
      mcpServers: { files: { command: 'mcp-files' } },
    }));

    expect(server.requests.map((r) => r.method)).toContain('turn/start');
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
  });

  it('compares SANITIZED ids, the ones actually sent to Codex', async () => {
    // `files.local` travels as `files_local`, and that is the name Codex reports.
    const server = serverWithInventory(['files_local']);
    const events = await collect(server, baseInput({
      ...restricted,
      mcpServers: { 'files.local': { command: 'mcp-files' } },
    }));
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });
  });

  it('refuses when an authorized server is MISSING from the inventory', async () => {
    // The resume is supposed to REPLACE the thread's table. A server we authorized
    // and cannot see proves it did not, so the rest of the inventory proves nothing
    // either — the turn must not run on it.
    const server = serverWithInventory([]);
    const events = await collect(server, baseInput({
      ...restricted,
      mcpServers: { files: { command: 'mcp-files' } },
    }));

    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    const result = events.at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/MCP servers are not the set this turn authorized/);
    expect(result.text).toMatch(/"files" was authorized for this turn but is not reachable/);
    expect(result.text).toMatch(/did not replace the thread's own/);
    expect(server.released).toEqual(['thread-1']);
  });

  it('tolerates the host-owned apps server only for a profile that allows host apps', async () => {
    // `codex_apps` is materialized from the ACCOUNT, not from our table, so it is
    // expected on a trusted profile and is a failed gate on a restricted one.
    const trusted = serverWithInventory(['codex_apps'], { sandbox: { type: 'dangerFullAccess' } });
    const trustedEvents = await collect(trusted, baseInput({
      sessionId: 'thread-1',
      allowDangerouslySkipPermissions: true,
    }));
    // full-trust: dangerFullAccess, host apps allowed.
    expect(trusted.requests.map((r) => r.method)).toContain('turn/start');
    expect(trustedEvents.at(-1)).toMatchObject({ stopReason: 'end_turn' });

    const denied = serverWithInventory(['codex_apps']);
    const deniedEvents = await collect(denied, baseInput(restricted));
    expect(denied.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((deniedEvents.at(-1) as any).text).toMatch(/features\.apps=false did not take effect/);
  });

  it('follows the inventory cursor before deciding', async () => {
    // A leftover on page two is still a leftover.
    const server = scriptedServer({ effective: READ_ONLY });
    server.handlers['mcpServerStatus/list'] = (params: any) => (params.cursor
      ? { data: [{ name: 'claudeclaw-dispatch' }], nextCursor: null }
      : { data: [], nextCursor: 'page-2' });
    const events = await collect(server, baseInput(restricted));

    expect(server.requests.filter((r) => r.method === 'mcpServerStatus/list')).toHaveLength(2);
    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/"claudeclaw-dispatch" is reachable/);
  });

  it('fails CLOSED on an empty-string cursor rather than reading it as the last page', async () => {
    // `""` is a cursor nothing can continue from. Stopping on it would truncate the
    // inventory and report the remainder — possibly a leftover server — as clean.
    const server = scriptedServer({ effective: READ_ONLY });
    server.handlers['mcpServerStatus/list'] = () => ({ data: [], nextCursor: '' });
    const events = await collect(server, baseInput(restricted));

    expect(server.requests.filter((r) => r.method === 'mcpServerStatus/list')).toHaveLength(1);
    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/nextCursor is an empty string; only null ends the inventory/);
  });

  it('fails CLOSED when the inventory never stops paging', async () => {
    const server = scriptedServer({ effective: READ_ONLY });
    server.handlers['mcpServerStatus/list'] = () => ({ data: [], nextCursor: 'always-more' });
    const events = await collect(server, baseInput(restricted));

    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/did not finish paging after 10 pages/);
  });

  it('fails CLOSED when the inventory cannot be read', async () => {
    const server = scriptedServer({ effective: READ_ONLY });
    server.handlers['mcpServerStatus/list'] = () => { throw new Error('method not found'); };
    const events = await collect(server, baseInput(restricted));

    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/could not read the resumed thread's effective MCP servers/);
    expect(server.released).toEqual(['thread-1']);
  });

  it('fails CLOSED on an inventory response it cannot parse', async () => {
    // A page with no readable name is not an empty page.
    const server = scriptedServer({ effective: READ_ONLY });
    server.handlers['mcpServerStatus/list'] = () => ({ data: [{ tools: {} }], nextCursor: null });
    const events = await collect(server, baseInput(restricted));

    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/effective MCP inventory cannot be read/);
  });

  it('still verifies when the unsubscribe itself fails', async () => {
    // The unsubscribe is best effort; the inventory read is the gate.
    const server = serverWithInventory(['claudeclaw-dispatch']);
    server.handlers['thread/unsubscribe'] = () => { throw new Error('transport hiccup'); };
    const events = await collect(server, baseInput(restricted));

    expect(server.requests.map((r) => r.method)).toContain('mcpServerStatus/list');
    expect(server.requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect((events.at(-1) as any).text).toMatch(/did not authorize/);
  });

  it('does not read the inventory for a thread this turn STARTED', async () => {
    // A fresh thread has no earlier authority to inherit, and the read costs a
    // short-lived probe connection per configured server.
    const fresh = serverWithInventory(['claudeclaw-dispatch']);
    const events = await collect(fresh, baseInput({ allowedTools: ['Read'] }));
    expect(fresh.requests.map((r) => r.method)).toEqual(['thread/start', 'turn/start']);
    expect(events.at(-1)).toMatchObject({ stopReason: 'end_turn' });

    // Including the stale-session fallback, which ends up on a brand new thread.
    const fallback = serverWithInventory(['claudeclaw-dispatch']);
    fallback.handlers['thread/resume'] = () => { throw new Error('no rollout found for thread id 019f-old'); };
    const fallbackEvents = await collect(fallback, baseInput({ sessionId: '019f-old', allowedTools: ['Read'] }));
    expect(fallback.requests.map((r) => r.method)).toEqual([
      'thread/unsubscribe', 'thread/resume', 'thread/start', 'turn/start',
    ]);
    expect(fallbackEvents.at(-1)).toMatchObject({ stopReason: 'end_turn' });
  });
});

describe('summarizeCommand', () => {
  it('strips launcher boilerplate and starts at the meaningful payload', () => {
    expect(summarizeCommand('pwsh -NoProfile -NonInteractive -Command "Get-Content foo.txt"'))
      .toBe('Get-Content foo.txt');
    expect(summarizeCommand("bash -lc 'ls -la /tmp'")).toBe('ls -la /tmp');
    expect(summarizeCommand(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command \'rg -n "needle" src\'',
    )).toBe('rg -n "needle" src');
  });

  it('spends the width budget on the command, not the wrapper', () => {
    const payload = 'Get-ChildItem -Recurse -Filter *.ts | Select-Object -First 40 | Format-Table Name';
    const out = summarizeCommand(`pwsh -NoProfile -Command "${payload}"`, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    // The old truncate-the-raw-string behaviour cut off before the command began.
    expect(out).toContain('Get-ChildItem');
  });

  it('leaves an unwrapped command alone apart from redirection noise', () => {
    expect(summarizeCommand('npm run build 2>&1')).toBe('npm run build');
    expect(summarizeCommand('git status --short')).toBe('git status --short');
  });

  it('does not unquote a command whose quotes are internal', () => {
    expect(summarizeCommand('grep "foo" bar "baz"')).toBe('grep "foo" bar "baz"');
  });
});

describe('an uncertain turn/start is quarantined, not retried', () => {
  // `turn/start` reached the App Server and never answered. The turn may be running
  // right now. Everything here is about not compounding that: no second prompt, no
  // reuse of a connection an orphaned turn is still speaking to, and no releasing the
  // thread before the child is gone.

  /** Collect from an adapter whose turn/start ceiling is short enough to hit. */
  async function collectWithShortStart(server: FakeServer, input: AgentTurnInput): Promise<AgentEngineEvent[]> {
    const adapter = new CodexAppServerEngineAdapter({ manager: server.asManager(), turnStartTimeoutMs: 20 });
    const events: AgentEngineEvent[] = [];
    for await (const ev of adapter.invoke(input)) events.push(ev);
    return events;
  }

  /** A server that takes turn/start, emits nothing further, and never answers. */
  function withholdingServer(): FakeServer {
    const server = scriptedServer();
    server.handlers['turn/start'] = () => null;
    server.withhold.add('turn/start');
    return server;
  }

  it('quarantines the connection and sends the prompt exactly once', async () => {
    const server = withholdingServer();
    const events = await collectWithShortStart(server, baseInput());

    expect(server.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    expect(server.quarantined).toHaveLength(1);
    expect(server.quarantined[0].reason).toMatch(/turn\/start outcome unknown on thread thread-1/);
  });

  it('holds the thread lock until the quarantine is established', async () => {
    // Releasing first would let the next invocation take the thread while a turn we
    // cannot name is still running on it.
    const server = withholdingServer();
    await collectWithShortStart(server, baseInput());

    expect(server.quarantined[0].releasedSoFar).toBe(0);
    expect(server.released).toEqual(['thread-1']); // and released afterwards, exactly once
  });

  it('emits ONE terminal failure that says the prompt was not resent', async () => {
    const server = withholdingServer();
    const events = await collectWithShortStart(server, baseInput());

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    const result = results[0] as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/cannot tell whether the turn began/);
    expect(result.text).toMatch(/NOT sent again/);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
  });

  it('says so plainly when the Codex process could not be terminated', async () => {
    const server = withholdingServer();
    server.quarantineResult = false;
    const events = await collectWithShortStart(server, baseInput());

    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.text).toMatch(/could not be terminated.*restart ClaudeClaw/s);
  });

  it('quarantines even when turn/started named the turn first', async () => {
    // A server that has stopped answering turn/start is not one to send a
    // turn/interrupt to and believe the answer. Knowing the turn id is what would let
    // a later change interrupt instead of discarding the connection; today it only
    // makes the failure more diagnosable.
    const server = withholdingServer();
    let boundTurnId: string | null | undefined;
    server.handlers['turn/start'] = () => {
      server.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
      boundTurnId = server.sinks[0]?.turnId;
      return null;
    };
    await collectWithShortStart(server, baseInput());

    expect(boundTurnId).toBe('t1'); // the turn WAS named before the timeout
    expect(server.quarantined).toHaveLength(1);
    expect(server.requests.some((r) => r.method === 'turn/interrupt')).toBe(false);
  });

  it('does NOT quarantine a turn/start the server explicitly refused', async () => {
    // An error response is a definite answer: nothing is running, so the connection
    // stays usable and this is an ordinary turn failure.
    const server = scriptedServer();
    server.handlers['turn/start'] = () => {
      throw new CodexAppServerRequestError('turn/start failed: model unavailable', 'refused', 'turn/start');
    };
    const events = await collectWithShortStart(server, baseInput());

    expect(server.quarantined).toEqual([]);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.text).toMatch(/model unavailable/);
    expect(server.released).toEqual(['thread-1']);
  });

  it('treats an UNTAGGED turn/start failure as uncertain', async () => {
    // Fail closed: a failure we cannot classify at a side-effecting boundary is
    // exactly where assuming "it never happened" is unsafe.
    const server = scriptedServer();
    server.handlers['turn/start'] = () => { throw new Error('socket hang up'); };
    await collectWithShortStart(server, baseInput());

    expect(server.quarantined).toHaveLength(1);
  });
});

describe('a terminal the adapter cannot read ends the turn instead of stranding it', () => {
  // The sink's parse failure used to be caught and logged by the manager, so the
  // terminal simply vanished and the drain loop spun on until the child died.

  it('an unknown turn status fails the connection and terminates the waiting turn', async () => {
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'weird' } });
      },
    });
    const events = await collect(server, baseInput());

    expect(server.protocolFaults).toHaveLength(1);
    expect(server.protocolFaults[0]).toMatch(/unknown turn status "weird"/);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/unknown turn status "weird"/);
    // The turn ended, and it ended once.
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
  });

  it('a terminal with no turn.id is fatal rather than silently dropped', async () => {
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput());

    expect(server.protocolFaults[0]).toMatch(/turn\.id is missing/);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
  });

  it('a well-formed notification the adapter ignores does not disturb the turn', async () => {
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('remoteControl/status/changed', { threadId: 'thread-1', anything: { at: 'all' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput());

    expect(server.protocolFaults).toEqual([]);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('end_turn');
  });
});

describe('cancellation is established, not assumed', () => {
  // The turn id now comes from the turn/start RESPONSE, so cancellation works whether
  // or not turn/started arrived. And an interrupt is only reported as an abort once a
  // terminal for that exact turn confirms it.

  /** An adapter with every cancellation deadline shortened. */
  function quickAdapter(server: FakeServer): CodexAppServerEngineAdapter {
    return new CodexAppServerEngineAdapter({
      manager: server.asManager(),
      turnStartTimeoutMs: 60,
      cancelStartGraceMs: 30,
      interruptTimeoutMs: 30,
      interruptDrainMs: 60,
    });
  }

  async function collectQuick(server: FakeServer, input: AgentTurnInput): Promise<AgentEngineEvent[]> {
    const events: AgentEngineEvent[] = [];
    for await (const ev of quickAdapter(server).invoke(input)) events.push(ev);
    return events;
  }

  const completed = (s: FakeServer, id: string, status: string, afterMs = 5): void => {
    setTimeout(() => s.notify('turn/completed', { threadId: 'thread-1', turn: { id, status } }), afterMs);
  };

  it('interrupts using the RESPONSE id when turn/started never arrives', async () => {
    // The old code only knew the turn from turn/started, so an abort that beat the
    // notification skipped the interrupt entirely and reported success anyway.
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        abortController.abort(); // cancel before any notification
        completed(s, 't1', 'interrupted');
      },
    });
    const events = await collectQuick(server, baseInput({ abortController }));

    const interrupt = server.requests.find((r) => r.method === 'turn/interrupt');
    expect(interrupt?.params).toEqual({ threadId: 'thread-1', turnId: 't1' });
    expect(events.at(-1)).toMatchObject({ type: 'aborted' });
    expect(server.quarantined).toEqual([]);
  });

  it('interrupts after an abort that lands while turn/start is still waiting', async () => {
    // The response arrives after the cancellation; its turn id is what gets cancelled.
    const abortController = new AbortController();
    const server = scriptedServer();
    server.handlers['turn/start'] = async () => {
      abortController.abort();
      await new Promise((r) => setTimeout(r, 5));
      completed(server, 't1', 'interrupted');
      return { turn: { id: 't1', status: 'inProgress' } };
    };
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(server.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1); // sent once
    expect(server.requests.find((r) => r.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'thread-1', turnId: 't1' });
    expect(events.at(-1)).toMatchObject({ type: 'aborted' });
  });

  it('waits for the matching terminal before reporting the abort', async () => {
    const abortController = new AbortController();
    const order: string[] = [];
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort();
        setTimeout(() => {
          order.push('terminal');
          s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } });
        }, 20);
      },
    });
    const events = await collectQuick(server, baseInput({ abortController }));
    order.push('aborted');

    expect(order).toEqual(['terminal', 'aborted']); // not the other way round
    expect(events.at(-1)).toMatchObject({ type: 'aborted' });
  });

  it('a terminal for ANOTHER turn cannot satisfy the cancellation', async () => {
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort();
        completed(s, 't-other', 'interrupted'); // a terminal, but not for our turn
      },
    });
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(server.quarantined).toHaveLength(1);
    expect(server.quarantined[0].reason).toMatch(/no terminal confirmed the interrupt of turn t1/);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.text).toMatch(/never confirmed the turn ended/);
  });

  it('an interrupt that is never confirmed poisons the generation', async () => {
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort(); // and no terminal, ever
      },
    });
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(server.quarantined).toHaveLength(1);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
  });

  it('an interrupt REQUEST that fails poisons the generation', async () => {
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort();
      },
    });
    server.handlers['turn/interrupt'] = () => { throw new Error('interrupt rejected'); };
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(server.quarantined[0].reason).toMatch(/turn\/interrupt failed for turn t1/);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.text).toMatch(/may still be running/);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
  });

  it('cancelled with turn/start unanswered reuses the uncertain-start quarantine', async () => {
    // Nothing to interrupt: no id, no answer. The same state as an uncertain start.
    const abortController = new AbortController();
    const server = scriptedServer();
    server.withhold.add('turn/start');
    server.handlers['turn/start'] = () => { abortController.abort(); return null; };
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(server.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    expect(server.requests.some((r) => r.method === 'turn/interrupt')).toBe(false);
    expect(server.quarantined[0].reason).toMatch(/turn\/start outcome unknown/);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.text).toMatch(/cannot tell whether the turn began/);
  });

  it('a turn/start response that does not NAME its turn is quarantined', async () => {
    // The turn exists and can never be interrupted or told apart from a later one.
    const server = scriptedServer();
    server.handlers['turn/start'] = () => ({ turn: { status: 'inProgress' } });
    const events = await collectQuick(server, baseInput());

    expect(server.quarantined[0].reason).toMatch(/did not name its turn/);
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.text).toMatch(/did not name it, so ClaudeClaw cannot follow or cancel it/);
  });

  it('a turn that COMPLETED before the interrupt landed reports its answer, not an abort', async () => {
    // The cancellation lost the race. Reporting `aborted` here would throw away work
    // the model had already finished and the caller is owed.
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { id: 'm1', type: 'agentMessage', text: 'the answer' } });
        abortController.abort();
        completed(s, 't1', 'completed');
      },
    });
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', stopReason: 'end_turn', text: 'the answer' });
    expect(server.quarantined).toEqual([]);
  });

  it('a turn that FAILED before the interrupt landed reports the failure, not an abort', async () => {
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort();
        setTimeout(() => s.notify('turn/completed', {
          threadId: 'thread-1',
          turn: { id: 't1', status: 'failed', error: { message: 'model exploded' } },
        }), 5);
      },
    });
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    const result = events.at(-1) as any;
    expect(result).toMatchObject({ type: 'result', stopReason: 'error' });
    expect(result.text).toMatch(/model exploded/);
    expect(server.quarantined).toEqual([]);
  });

  it('a terminal that arrives despite an interrupt REJECTION wins, and nothing is poisoned', async () => {
    // The turn has demonstrably ended, so there is nothing outstanding to escalate —
    // whatever became of the request we sent.
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort();
        completed(s, 't1', 'interrupted', 10);
      },
    });
    server.handlers['turn/interrupt'] = () => { throw new Error('interrupt rejected'); };
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(server.quarantined).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'aborted' });
  });

  it('a terminal that arrives while the interrupt is still UNANSWERED wins too', async () => {
    const abortController = new AbortController();
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        abortController.abort();
        completed(s, 't1', 'completed', 10);
      },
    });
    server.withhold.add('turn/interrupt'); // accepted, never answered
    const events = await collectQuick(server, baseInput({ abortController }));

    expect(server.quarantined).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'result', stopReason: 'end_turn' });
  });
});

describe('cancellation before the prompt is sent', () => {
  it('emits a local abort and never sends turn/start or turn/interrupt', async () => {
    // The lock is held and the policy checks have run — all of which touch shared
    // thread state — but no turn exists yet. Nothing to interrupt, nothing to
    // quarantine, and above all no prompt on the wire.
    const abortController = new AbortController();
    const server = scriptedServer();
    server.handlers['thread/start'] = () => {
      abortController.abort(); // after the lock and before turn/start
      return server.effective();
    };

    const adapter = new CodexAppServerEngineAdapter({ manager: server.asManager(), turnStartTimeoutMs: 60 });
    const events: AgentEngineEvent[] = [];
    for await (const ev of adapter.invoke(baseInput({ abortController }))) events.push(ev);

    expect(server.requests.map((r) => r.method)).not.toContain('turn/start');
    expect(server.requests.map((r) => r.method)).not.toContain('turn/interrupt');
    expect(server.quarantined).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'aborted', text: null, sessionId: 'thread-1' });
    expect(server.released).toEqual(['thread-1']); // and the lock is given back
  });
});

describe('structured user questions reach the host resolver', () => {
  // The adapter's half of finding 8: translate between Codex's id-keyed questions and
  // the AskUserQuestionResolver the Claude SDK path already uses, and register the
  // resolver for exactly the turn's lifetime.

  const codexQuestion = (over: Partial<ToolUserInputRequest> = {}): ToolUserInputRequest => ({
    threadId: 'thread-1',
    turnId: 't1',
    itemId: 'item-1',
    autoResolutionMs: null,
    questions: [{
      id: 'q1', header: 'Approach', question: 'Which one?',
      isOther: false, isSecret: false,
      options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
    }],
    ...over,
  });

  it('registers a resolver on the sink only when the host supplies one', async () => {
    const withResolver = scriptedServer();
    let sawResolver: boolean | undefined;
    withResolver.handlers['turn/start'] = () => {
      sawResolver = typeof withResolver.sinks[0]?.askUserQuestion === 'function';
      withResolver.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      return { turn: { id: 't1', status: 'inProgress' } };
    };
    await collect(withResolver, baseInput({ onAskUserQuestion: async () => null }));
    expect(sawResolver).toBe(true);

    const without = scriptedServer();
    let sawNone: boolean | undefined;
    without.handlers['turn/start'] = () => {
      sawNone = without.sinks[0]?.askUserQuestion === undefined;
      without.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      return { turn: { id: 't1', status: 'inProgress' } };
    };
    await collect(without, baseInput());
    expect(sawNone).toBe(true);
  });

  it('the resolver is gone once the turn ends, so a later question cannot reach it', async () => {
    // Same lifetime as the sink: registered before turn/start, removed before the
    // thread lock is released.
    const server = scriptedServer();
    await collect(server, baseInput({ onAskUserQuestion: async () => null }));
    expect(server.sinks).toEqual([]);
  });

  it('maps options across and keys the answer by the Codex question id', async () => {
    let seen: AskUserQuestionRequest | null = null;
    const answer = await askUserQuestion(
      async (request) => {
        seen = request;
        return { answers: [{ header: 'Approach', question: 'Which one?', selected: ['A'] }] };
      },
      codexQuestion(),
      undefined,
    );

    expect(seen!.questions).toEqual([{
      header: 'Approach',
      question: 'Which one?',
      options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
    }]);
    expect(answer).toEqual({ q1: ['A'] });
  });

  it('keeps two questions sharing a header apart, in order', async () => {
    const answer = await askUserQuestion(
      async () => ({
        answers: [
          { header: 'Pick', question: 'first?', selected: ['one'] },
          { header: 'Pick', question: 'second?', selected: ['two'] },
        ],
      }),
      codexQuestion({
        questions: [
          { id: 'qa', header: 'Pick', question: 'first?', isOther: false, isSecret: false, options: [] },
          { id: 'qb', header: 'Pick', question: 'second?', isOther: false, isSecret: false, options: [] },
        ],
      }),
      undefined,
    );
    expect(answer).toEqual({ qa: ['one'], qb: ['two'] });
  });

  it('never routes a SECRET question to the chat UI', async () => {
    // The answer would land in message history, a transcript, and whatever the host
    // logs — the one place a credential must not end up.
    let called = false;
    const answer = await askUserQuestion(
      async () => { called = true; return { answers: [] }; },
      codexQuestion({
        questions: [{ id: 'q1', header: 'Token', question: 'Paste your API key', isOther: true, isSecret: true, options: [] }],
      }),
      undefined,
    );
    expect(called).toBe(false);
    expect(answer).toBeNull();
  });

  it('asks the non-secret questions and omits the secret one', async () => {
    const answer = await askUserQuestion(
      async (request) => ({
        answers: request.questions.map((q) => ({ header: q.header, question: q.question, selected: ['ok'] })),
      }),
      codexQuestion({
        questions: [
          { id: 'q1', header: 'Approach', question: 'Which one?', isOther: false, isSecret: false, options: [] },
          { id: 'q2', header: 'Token', question: 'Paste your API key', isOther: true, isSecret: true, options: [] },
        ],
      }),
      undefined,
    );
    expect(answer).toEqual({ q1: ['ok'] }); // q2 simply unanswered
  });

  it('declines when the resolver returns null or selects nothing', async () => {
    expect(await askUserQuestion(async () => null, codexQuestion(), undefined)).toBeNull();
    expect(await askUserQuestion(
      async () => ({ answers: [{ header: 'Approach', question: 'Which one?', selected: [] }] }),
      codexQuestion(),
      undefined,
    )).toBeNull();
  });

  it('declines the moment the turn is cancelled, without waiting for a tap', async () => {
    const abortController = new AbortController();
    const pending = askUserQuestion(
      () => new Promise(() => {}), // the user never answers
      codexQuestion(),
      abortController.signal,
    );
    abortController.abort();
    await expect(pending).resolves.toBeNull();
  });

  it('declines immediately when the turn was already cancelled', async () => {
    const abortController = new AbortController();
    abortController.abort();
    await expect(askUserQuestion(() => new Promise(() => {}), codexQuestion(), abortController.signal))
      .resolves.toBeNull();
  });
});

describe('the question wrapper detaches from both signals', () => {
  // It races the host's resolver against TWO cancellations: the caller aborting the
  // turn, and the question's own lifecycle ending in the manager. Whichever wins, both
  // listeners have to come off — a turn that asks many questions would otherwise pile
  // them up on signals that live as long as it does.

  const request: ToolUserInputRequest = {
    threadId: 'thread-1', turnId: 't1', itemId: 'item-1', autoResolutionMs: null,
    questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: false, isSecret: false, options: [] }],
  };

  /** Count abort listeners added to and removed from a signal. */
  function countingSignal(): { signal: AbortSignal; abort: () => void; added: number; removed: number } {
    const controller = new AbortController();
    const counts = { added: 0, removed: 0 };
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    Object.defineProperties(controller.signal, {
      addEventListener: {
        value: (...args: Parameters<AbortSignal['addEventListener']>) => { counts.added += 1; return add(...args); },
      },
      removeEventListener: {
        value: (...args: Parameters<AbortSignal['removeEventListener']>) => { counts.removed += 1; return remove(...args); },
      },
    });
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      get added() { return counts.added; },
      get removed() { return counts.removed; },
    };
  }

  it('settles on the QUESTION signal alone, with no human answer and no caller abort', async () => {
    // This is the sink-removal path as the adapter sees it: the manager settled the
    // App Server response and aborted the lifecycle. Without that signal this promise
    // would stay pending until the human eventually tapped.
    const caller = countingSignal();
    const question = countingSignal();

    const pending = askUserQuestion(
      () => new Promise(() => {}), // the user never answers
      request,
      caller.signal,
      question.signal,
    );
    await new Promise((r) => setImmediate(r));
    expect(caller.added).toBe(1);
    expect(question.added).toBe(1);

    question.abort(); // the manager settled the question

    await expect(pending).resolves.toBeNull();
    expect(caller.removed).toBe(1); // the losing signal is detached too
    expect(question.removed).toBe(1);
    expect(caller.signal.aborted).toBe(false); // the turn itself was never cancelled
  });

  it('detaches from both when the CALLER cancels the turn', async () => {
    const caller = countingSignal();
    const question = countingSignal();

    const pending = askUserQuestion(() => new Promise(() => {}), request, caller.signal, question.signal);
    await new Promise((r) => setImmediate(r));
    caller.abort();

    await expect(pending).resolves.toBeNull();
    expect(caller.removed).toBe(1);
    expect(question.removed).toBe(1);
  });

  it('detaches from both when the human answers first', async () => {
    const caller = countingSignal();
    const question = countingSignal();

    const answer = await askUserQuestion(
      async () => ({ answers: [{ header: 'H', question: 'Q', selected: ['A'] }] }),
      request,
      caller.signal,
      question.signal,
    );

    expect(answer).toEqual({ q1: ['A'] });
    expect(caller.removed).toBe(1);
    expect(question.removed).toBe(1);
  });

  it('declines immediately when the question signal is ALREADY aborted', async () => {
    const question = new AbortController();
    question.abort();
    let asked = false;
    const answer = await askUserQuestion(
      () => { asked = true; return new Promise(() => {}); },
      request,
      undefined,
      question.signal,
    );
    expect(answer).toBeNull();
    expect(asked).toBe(true); // the resolver is invoked, but nothing waits on it
  });

  it('works with no caller signal at all', async () => {
    const question = countingSignal();
    const pending = askUserQuestion(() => new Promise(() => {}), request, undefined, question.signal);
    await new Promise((r) => setImmediate(r));
    question.abort();
    await expect(pending).resolves.toBeNull();
    expect(question.removed).toBe(1);
  });
});

describe('turn budgets are enforced, not merely resolved', () => {
  // The profile has carried `turnBudget` since Phase 1; only the SDK path acted on it.
  // A tool-less App Server turn had no runtime backstop and no deadline at all.

  /** A tool-less turn: shell, apps and web search off, maxToolItems 0. */
  const toolLess = (over: Partial<AgentTurnInput> = {}): AgentTurnInput =>
    baseInput({ allowedTools: [], disallowedTools: ['*'], ...over });

  /** The effective policy a tool-less profile expects back. */
  const readOnly = { sandbox: { type: 'readOnly', networkAccess: false } };

  function budgetAdapter(server: FakeServer): CodexAppServerEngineAdapter {
    return new CodexAppServerEngineAdapter({
      manager: server.asManager(),
      turnStartTimeoutMs: 200,
      cancelStartGraceMs: 50,
      interruptTimeoutMs: 50,
      interruptDrainMs: 100,
    });
  }

  async function collectBudget(server: FakeServer, input: AgentTurnInput): Promise<AgentEngineEvent[]> {
    const events: AgentEngineEvent[] = [];
    for await (const ev of budgetAdapter(server).invoke(input)) events.push(ev);
    return events;
  }

  it.each([
    ['commandExecution', { id: 'i1', type: 'commandExecution', command: 'ls', status: 'inProgress' }],
    ['mcpToolCall', { id: 'i1', type: 'mcpToolCall', server: 's', tool: 't', status: 'inProgress' }],
    ['fileChange', { id: 'i1', type: 'fileChange', changes: [{ path: '/tmp/x' }], status: 'completed' }],
    ['webSearch', { id: 'i1', type: 'webSearch', query: 'q' }],
    ['dynamicToolCall', { id: 'i1', type: 'dynamicToolCall', tool: 't', status: 'inProgress' }],
    ['collabAgentToolCall', { id: 'i1', type: 'collabAgentToolCall', tool: 'spawn', status: 'inProgress' }],
    ['an item type this build does not model', { id: 'i1', type: 'somethingBrandNew' }],
  ])('a tool-less turn that emits %s fails closed', async (_label, item) => {
    const server = scriptedServer({
      effective: readOnly,
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item });
        // The server acknowledges the interrupt.
        setTimeout(() => s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } }), 5);
      },
    });
    const events = await collectBudget(server, toolLess());

    // Interrupted by exact thread + turn, through finding 4's path.
    expect(server.requests.find((r) => r.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'thread-1', turnId: 't1' });
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/authorized no tools, but the model used one/);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    expect(server.quarantined).toEqual([]);
  });

  it.each([
    ['agentMessage', { id: 'i1', type: 'agentMessage', text: 'hello' }],
    ['reasoning', { id: 'i1', type: 'reasoning', summary: ['thinking'], content: [] }],
    ['plan', { id: 'i1', type: 'plan', text: 'a plan' }],
    ['userMessage', { id: 'i1', type: 'userMessage' }],
    ['contextCompaction', { id: 'i1', type: 'contextCompaction' }],
  ])('a tool-less turn is NOT failed by %s', async (_label, item) => {
    const server = scriptedServer({
      effective: readOnly,
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collectBudget(server, toolLess());

    expect(server.requests.some((r) => r.method === 'turn/interrupt')).toBe(false);
    expect((events.filter((e) => e.type === 'result').at(-1) as any).stopReason).toBe('end_turn');
  });

  it('a text-only tool-less turn succeeds normally', async () => {
    const server = scriptedServer({
      effective: readOnly,
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/completed', { threadId: 'thread-1', turnId: 't1', item: { id: 'm1', type: 'agentMessage', text: 'the answer' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collectBudget(server, toolLess());

    expect(events.at(-1)).toMatchObject({ type: 'result', stopReason: 'end_turn', text: 'the answer' });
    expect(server.slotsAcquired).toBe(1);
    expect(server.slotsReleased).toBe(1);
  });

  it('a profile with NO maxToolItems is not policed', async () => {
    // The default workspace-agent profile carries an empty budget; a tool item there
    // is ordinary work, not a violation.
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item: { id: 'i1', type: 'commandExecution', command: 'ls', status: 'inProgress' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collectBudget(server, baseInput());
    expect((events.filter((e) => e.type === 'result').at(-1) as any).stopReason).toBe('end_turn');
  });

  it('the deadline interrupts the exact turn', async () => {
    // The tool-less profile carries a wall-clock deadline; nothing enforced it before.
    const server = scriptedServer({
      effective: readOnly,
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        // Never completes on its own — only the deadline can end this.
      },
    });
    server.handlers['turn/interrupt'] = () => {
      setTimeout(() => server.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } }), 2);
      return {};
    };
    const adapter = new CodexAppServerEngineAdapter({
      manager: server.asManager(), turnDeadlineMs: 40, interruptTimeoutMs: 50, interruptDrainMs: 100,
    });
    const events: AgentEngineEvent[] = [];
    for await (const ev of adapter.invoke(toolLess())) events.push(ev);

    expect(server.requests.find((r) => r.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'thread-1', turnId: 't1' });
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/ran past the \d+ms deadline/);
  });

  it('a policy violation whose interrupt fails escalates to the poison path', async () => {
    const server = scriptedServer({
      effective: readOnly,
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item: { id: 'i1', type: 'commandExecution', command: 'ls', status: 'inProgress' } });
      },
    });
    server.handlers['turn/interrupt'] = () => { throw new Error('interrupt rejected'); };
    const events = await collectBudget(server, toolLess());

    expect(server.quarantined).toHaveLength(1);
    expect(server.quarantined[0].reason).toMatch(/turn\/interrupt failed for turn t1/);
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    // Still exactly one slot, given back once.
    expect(server.slotsAcquired).toBe(1);
    expect(server.slotsReleased).toBe(1);
  });

  it.each([
    ['a normal completion', (s: FakeServer) => {
      s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
      s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
    }],
    ['a failed turn', (s: FakeServer) => {
      s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
      s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'failed', error: { message: 'boom' } } });
    }],
    ['a transport failure', (s: FakeServer) => {
      s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
      s.notify('claudeclaw/transportFailed', { reason: 'child exited' });
    }],
  ])('%s releases the process slot exactly once', async (_label, script) => {
    const server = scriptedServer({ onTurnStart: script });
    await collectBudget(server, baseInput());
    expect(server.slotsAcquired).toBe(1);
    expect(server.slotsReleased).toBe(1);
  });

  it('a refused thread/start still gives the slot back', async () => {
    // The turn never runs, but the slot was taken before the policy check.
    const server = scriptedServer({ effective: { sandbox: { type: 'dangerFullAccess' } } });
    await collectBudget(server, toolLess());
    expect(server.slotsAcquired).toBe(1);
    expect(server.slotsReleased).toBe(1);
  });
});

describe('a budget violation tears down a pending question with the turn', () => {
  // End to end through the REAL manager, for BOTH budget triggers: the backstop ends
  // the turn, which removes the sink, which is what makes finding 8 decline the open
  // question. The findings only compose if a violation goes through the ordinary sink
  // lifecycle rather than some shortcut of its own.

  it.each([
    ['a tool-policy violation', { emitTool: true, turnDeadlineMs: undefined, expected: /authorized no tools/ }],
    ['a deadline', { emitTool: false, turnDeadlineMs: 60, expected: /ran past the 60ms deadline/ }],
  ])('%s declines the question once and ignores a late human answer', async (_label, scenario) => {
    const requests: Array<{ method: string; params: any }> = [];
    let notify!: (n: JsonRpcNotification) => void;
    let serverRequest!: (r: JsonRpcRequest) => Promise<unknown>;
    let questionResponse: Promise<unknown> | null = null;

    const effective = {
      thread: { id: 'thread-1' },
      model: 'gpt-5.5',
      modelProvider: 'openai',
      cwd: CWD,
      runtimeWorkspaceRoots: [CWD],
      instructionSources: [],
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      activePermissionProfile: null,
      reasoningEffort: null,
    };

    const handlers: Record<string, (params: any) => unknown> = {
      'thread/unsubscribe': () => ({ status: 'notLoaded' }),
      'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
      'thread/start': () => effective,
      'turn/interrupt': () => {
        setTimeout(() => notify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } },
        }), 2);
        return {};
      },
      'turn/start': () => {
        notify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } } });
        // The model asks a question, then either reaches for a tool it was never
        // granted or simply runs on past its deadline.
        questionResponse = serverRequest({
          id: 7,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-1', turnId: 't1', itemId: 'i1', autoResolutionMs: null,
            questions: [{ id: 'q1', header: 'Approach', question: 'Which one?', isOther: false, isSecret: false, options: null }],
          },
        }) as Promise<unknown>;
        if (scenario.emitTool) {
          setTimeout(() => notify({
            method: 'item/started',
            params: { threadId: 'thread-1', turnId: 't1', item: { id: 'x1', type: 'commandExecution', command: 'ls', status: 'inProgress' } },
          }), 2);
        }
        // For the deadline case nothing else happens: the turn simply runs on.
        return { turn: { id: 't1', status: 'inProgress' } };
      },
    };

    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      askUserQuestionTimeoutMs: 60_000, // long: only the turn ending may settle it
      createClient: (options) => {
        notify = options.onNotification!;
        serverRequest = options.onServerRequest! as never;
        return {
          start: async () => ({}),
          shutdown: async () => {},
          quarantine: async () => true,
          failProtocol: () => {},
          request: async (method: string, params: unknown) => {
            requests.push({ method, params });
            const handler = handlers[method];
            if (!handler) throw new Error(`test: no handler for ${method}`);
            return handler(params);
          },
        } as never;
      },
    });

    // The human never answers; we keep the resolve handle to try a late one.
    let answerLate!: (v: AskUserQuestionAnswer | null) => void;
    const onAskUserQuestion = (): Promise<AskUserQuestionAnswer | null> =>
      new Promise((resolve) => { answerLate = resolve; });

    const adapter = new CodexAppServerEngineAdapter({
      manager,
      interruptTimeoutMs: 100,
      interruptDrainMs: 200,
      ...(scenario.turnDeadlineMs !== undefined ? { turnDeadlineMs: scenario.turnDeadlineMs } : {}),
    });
    const events: AgentEngineEvent[] = [];
    for await (const ev of adapter.invoke(baseInput({
      allowedTools: [], disallowedTools: ['*'], onAskUserQuestion,
    }))) events.push(ev);

    // The turn was stopped on policy grounds, through the ordinary interrupt path.
    expect(requests.find((r) => r.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'thread-1', turnId: 't1' });
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(scenario.expected);

    // The open question was declined exactly once, without the human ever answering.
    expect(await questionResponse).toEqual({ result: { answers: {} } });

    // A late answer reaches nothing.
    answerLate({ answers: [{ header: 'Approach', question: 'Which one?', selected: ['A'] }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(await questionResponse).toEqual({ result: { answers: {} } });
  });
});

describe('the drain loop does not accumulate listeners or timers', () => {
  // It runs several times a second for the whole turn. A listener left on the caller's
  // signal, or a timer left running, is a leak that grows with the turn's length.

  /** Count abort listeners added to and removed from a real signal. */
  function countingSignal(): { signal: AbortSignal; added: number; removed: number } {
    const controller = new AbortController();
    const counts = { added: 0, removed: 0 };
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    Object.defineProperties(controller.signal, {
      addEventListener: {
        value: (...args: Parameters<AbortSignal['addEventListener']>) => { counts.added += 1; return add(...args); },
      },
      removeEventListener: {
        value: (...args: Parameters<AbortSignal['removeEventListener']>) => { counts.removed += 1; return remove(...args); },
      },
    });
    return {
      signal: controller.signal,
      get added() { return counts.added; },
      get removed() { return counts.removed; },
    };
  }

  /** A server that stays silent long enough to force several poll cycles. */
  function slowServer(quietMs: number): FakeServer {
    return scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        setTimeout(() => s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } }), quietMs);
      },
    });
  }

  it('detaches the abort listener on every poll cycle, not just the last', async () => {
    // 900ms of silence is three or four cycles; before the fix each one left a
    // listener behind for the whole turn.
    const server = slowServer(900);
    const watched = countingSignal();
    const abortController = { signal: watched.signal, abort: () => {} } as unknown as AbortController;

    const events: AgentEngineEvent[] = [];
    for await (const ev of new CodexAppServerEngineAdapter({ manager: server.asManager() })
      .invoke(baseInput({ abortController }))) events.push(ev);

    expect(watched.added).toBeGreaterThan(2); // several cycles really did run
    expect(watched.removed).toBe(watched.added); // and every one detached
    expect((events.filter((e) => e.type === 'result').at(-1) as any).stopReason).toBe('end_turn');
  });

  it('clears the poll timer when a NOTIFICATION wins the wait', async () => {
    // The losing branch: a terminal arrives mid-wait and the 250ms timer must not be
    // left to fire into a turn that has already moved on.
    const createdPollTimers: unknown[] = [];
    const clearedTimers = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((fn: never, ms?: number, ...rest: never[]) => {
      const handle = realSetTimeout(fn, ms, ...rest);
      if (ms === 250) createdPollTimers.push(handle); // the drain loop's poll
      return handle;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle: never) => {
      clearedTimers.add(handle);
      return realClearTimeout(handle);
    }) as typeof globalThis.clearTimeout;

    try {
      // Silent long enough for a poll to start, then a terminal lands mid-wait.
      const server = slowServer(120);
      const events: AgentEngineEvent[] = [];
      for await (const ev of new CodexAppServerEngineAdapter({ manager: server.asManager() })
        .invoke(baseInput())) events.push(ev);

      expect(createdPollTimers.length).toBeGreaterThan(0);
      const leaked = createdPollTimers.filter((handle) => !clearedTimers.has(handle));
      expect(leaked).toEqual([]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

describe('an item with no readable type is not treated as harmless', () => {
  // Every variant of the pinned tagged union carries a string `type`. A payload
  // without one is invalid, and an item we cannot identify is not evidence that
  // nothing happened — so on a tool-less turn it is a violation like any other.

  const toolLessInput = baseInput({ allowedTools: [], disallowedTools: ['*'] });
  const readOnlyPolicy = { sandbox: { type: 'readOnly', networkAccess: false } };

  it.each([
    ['a missing type', { id: 'i1' }],
    ['an empty type', { id: 'i1', type: '' }],
    ['a numeric type', { id: 'i1', type: 7 }],
    ['a null type', { id: 'i1', type: null }],
    ['an object type', { id: 'i1', type: { nested: true } }],
  ])('%s fails a tool-less turn closed', async (_label, item) => {
    const server = scriptedServer({
      effective: readOnlyPolicy,
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item });
        setTimeout(() => s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } }), 5);
      },
    });
    const adapter = new CodexAppServerEngineAdapter({
      manager: server.asManager(), interruptTimeoutMs: 50, interruptDrainMs: 100,
    });
    const events: AgentEngineEvent[] = [];
    for await (const ev of adapter.invoke({ ...toolLessInput })) events.push(ev);

    expect(server.requests.find((r) => r.method === 'turn/interrupt')?.params)
      .toEqual({ threadId: 'thread-1', turnId: 't1' });
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/an item whose type ClaudeClaw could not read/);
  });

  it('still does not disturb a turn that authorized tools', async () => {
    // With no budget to enforce there is nothing to fail; the item is simply unusable
    // for progress reporting, as before.
    const server = scriptedServer({
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', { threadId: 'thread-1', turnId: 't1', item: { id: 'i1' } });
        s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } });
      },
    });
    const events = await collect(server, baseInput());
    expect((events.filter((e) => e.type === 'result').at(-1) as any).stopReason).toBe('end_turn');
    expect(server.requests.some((r) => r.method === 'turn/interrupt')).toBe(false);
  });
});

describe('trusted MCP provenance', () => {
  // Codex gates MCP tools behind approval, App Server denies every approval request
  // (finding 8) and `approvalPolicy` stays "never" — so an authorized dispatch call is
  // cancelled unless its server is pre-approved. The SDK path does this; this one did
  // not. Trust comes from input.trustedMcpServers, never from a name.

  const dispatch = { command: 'node', args: ['dispatch.js'], env: { DISPATCH_ALLOW_HIVE_READ: 'true' } };

  /** A workspace-agent profile carrying the given MCP set. */
  const profileWith = (mcpServers: Record<string, any>) =>
    resolveCodexCapabilityProfile({ mcpServers }, { dangerWriteEnabled: false });

  it('pre-approves a provenance-trusted server on its MAPPED entry', async () => {
    const profile = profileWith({ 'claudeclaw-dispatch': dispatch });
    const config = buildThreadConfig(profile, undefined, ['claudeclaw-dispatch']) as any;

    expect(config.mcp_servers['claudeclaw-dispatch']).toEqual({
      command: 'node',
      args: ['dispatch.js'],
      // Everything already resolved onto the entry survives — the hive-read flag
      // included. The approval mode is added, nothing is replaced.
      env: { DISPATCH_ALLOW_HIVE_READ: 'true' },
      default_tools_approval_mode: 'approve',
    });
  });

  it('does NOT pre-approve the same name without provenance', async () => {
    // A project or user .mcp.json entry calling itself claudeclaw-dispatch inherits
    // nothing — most easily attempted when the real bridge is off and the name is free.
    const profile = profileWith({ 'claudeclaw-dispatch': dispatch });
    const config = buildThreadConfig(profile, undefined) as any;

    expect(config.mcp_servers['claudeclaw-dispatch']).toEqual({
      command: 'node', args: ['dispatch.js'], env: { DISPATCH_ALLOW_HIVE_READ: 'true' },
    });
    expect(config.mcp_servers['claudeclaw-dispatch'].default_tools_approval_mode).toBeUndefined();
  });

  it('does not survive into a LATER invocation', async () => {
    // The provenance boundary as a SEQUENCE, which is where a stored approval would show
    // up. Trust is read from the current invocation and kept nowhere — not on the shared
    // manager, not on a generation, not in a sink — so a launch-environment rotation has
    // nothing to carry over and the turn after a trusted one starts from default gating.
    const profile = profileWith({ 'claudeclaw-dispatch': dispatch });

    const trusted = buildThreadConfig(profile, undefined, ['claudeclaw-dispatch']) as any;
    expect(trusted.mcp_servers['claudeclaw-dispatch'].default_tools_approval_mode).toBe('approve');

    // The next invocation vouches for nothing: same profile, same server, no approval.
    const next = buildThreadConfig(profile, undefined) as any;
    expect(next.mcp_servers['claudeclaw-dispatch'].default_tools_approval_mode).toBeUndefined();

    // And stamping the second table did not reach back into the first one's entry, which
    // is what a shared or cached mapping object would have done.
    expect(trusted.mcp_servers['claudeclaw-dispatch'].default_tools_approval_mode).toBe('approve');
  });

  it('leaves every other server on Codex\'s default gating', async () => {
    const profile = profileWith({
      'claudeclaw-dispatch': dispatch,
      'project-tools': { command: 'npx', args: ['other'] },
    });
    const config = buildThreadConfig(profile, undefined, ['claudeclaw-dispatch']) as any;

    expect(config.mcp_servers['claudeclaw-dispatch'].default_tools_approval_mode).toBe('approve');
    expect(config.mcp_servers['project-tools'].default_tools_approval_mode).toBeUndefined();
  });

  it('a trusted name the PROFILE dropped does not reappear', async () => {
    // The profile is the authority on what the turn may reach. Trust cannot add a
    // server back, only mark one the profile already kept.
    const profile = profileWith({ 'project-tools': { command: 'npx', args: ['other'] } });
    const config = buildThreadConfig(profile, undefined, ['claudeclaw-dispatch']) as any;

    expect(config.mcp_servers['claudeclaw-dispatch']).toBeUndefined();
    expect(Object.keys(config.mcp_servers)).toEqual(['project-tools']);
  });

  it('a TOOL-LESS profile emits no MCP config and no inherited approval', async () => {
    // Consistent with finding 2: mcp_servers is always sent, and an empty table is
    // what replaces whatever a resumed thread was carrying.
    const profile = resolveCodexCapabilityProfile(
      { allowedTools: [], disallowedTools: ['*'], mcpServers: { 'claudeclaw-dispatch': dispatch } },
      { dangerWriteEnabled: false },
    );
    const config = buildThreadConfig(profile, undefined, ['claudeclaw-dispatch']) as any;

    expect(config.mcp_servers).toEqual({});
    expect(JSON.stringify(config)).not.toContain('default_tools_approval_mode');
  });

  it('fails closed when a sanitized-id COLLISION would move the trust', async () => {
    // Sanitizing maps every character outside [A-Za-z0-9_-] to `_`, so
    // `claudeclaw.dispatch` and `claudeclaw dispatch` both become
    // `claudeclaw_dispatch`. The first one mapped wins the id; approving that entry
    // would hand the trusted server's standing to a different one.
    const profile = profileWith({
      'claudeclaw.dispatch': { command: 'npx', args: ['impostor'] },
      'claudeclaw dispatch': dispatch,
    });

    expect(() => buildThreadConfig(profile, undefined, ['claudeclaw dispatch']))
      .toThrow(/is already held by "claudeclaw\.dispatch"/);
  });

  it('does not fail on a collision that has nothing to do with trust', async () => {
    // Two untrusted names colliding is the pre-existing skip-and-warn: one server is
    // missing from the turn, which the MCP authority check already reconciles.
    const profile = profileWith({
      'a.tools': { command: 'npx', args: ['one'] },
      'a tools': { command: 'npx', args: ['two'] },
    });
    const config = buildThreadConfig(profile, undefined, []) as any;
    expect(Object.keys(config.mcp_servers)).toEqual(['a_tools']);
    expect(config.mcp_servers.a_tools.args).toEqual(['one']); // first mapped wins
  });

  it('grants trust to the collision WINNER when that is the trusted one', async () => {
    const profile = profileWith({
      'claudeclaw dispatch': dispatch,
      'claudeclaw.dispatch': { command: 'npx', args: ['impostor'] },
    });
    const config = buildThreadConfig(profile, undefined, ['claudeclaw dispatch']) as any;
    expect(config.mcp_servers['claudeclaw_dispatch']).toMatchObject({
      args: ['dispatch.js'], default_tools_approval_mode: 'approve',
    });
  });

  it('sanitizes the trusted name the same way the table is keyed', async () => {
    const profile = profileWith({ 'claudeclaw dispatch!': dispatch });
    const config = buildThreadConfig(profile, undefined, ['claudeclaw dispatch!']) as any;
    expect(config.mcp_servers['claudeclaw_dispatch_'].default_tools_approval_mode).toBe('approve');
  });
});

describe('a trusted-MCP collision refuses the turn before the prompt is sent', () => {
  it('sends no turn/start, registers no question resolver, and releases its slot once', async () => {
    const server = scriptedServer();
    const events = await collect(server, baseInput({
      mcpServers: {
        'claudeclaw.dispatch': { command: 'npx', args: ['impostor'] },
        'claudeclaw dispatch': { command: 'node', args: ['dispatch.js'] },
      },
      trustedMcpServers: ['claudeclaw dispatch'],
      onAskUserQuestion: async () => null,
    }));

    // Nothing reached the wire at all — not even thread/start.
    expect(server.requests).toEqual([]);
    expect(server.sinks).toEqual([]);
    expect(server.quarantined).toEqual([]);

    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/will not transfer trusted approval/);

    // Finding 9's slot was taken and given back exactly once.
    expect(server.slotsAcquired).toBe(1);
    expect(server.slotsReleased).toBe(1);
  });
});

describe('trusted provenance does not widen anything else', () => {
  it('a trusted-looking server cannot survive a tool-less profile or bypass maxToolItems', async () => {
    // Even if the caller vouches for it, a tool-less profile keeps no MCP at all — and
    // an MCP item on such a turn still stops the exact turn (finding 9).
    const server = scriptedServer({
      effective: { sandbox: { type: 'readOnly', networkAccess: false } },
      onTurnStart: (s) => {
        s.notify('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } });
        s.notify('item/started', {
          threadId: 'thread-1', turnId: 't1',
          item: { id: 'i1', type: 'mcpToolCall', server: 'claudeclaw-dispatch', tool: 'mission_create', status: 'inProgress' },
        });
        setTimeout(() => s.notify('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'interrupted' } }), 5);
      },
    });
    const adapter = new CodexAppServerEngineAdapter({
      manager: server.asManager(), interruptTimeoutMs: 50, interruptDrainMs: 100,
    });
    const events: AgentEngineEvent[] = [];
    for await (const ev of adapter.invoke(baseInput({
      allowedTools: [], disallowedTools: ['*'],
      mcpServers: { 'claudeclaw-dispatch': { command: 'node', args: ['dispatch.js'] } },
      trustedMcpServers: ['claudeclaw-dispatch'],
    }))) events.push(ev);

    const started = server.requests.find((r) => r.method === 'thread/start');
    expect(started?.params.config.mcp_servers).toEqual({});
    const result = events.filter((e) => e.type === 'result').at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/authorized no tools/);
  });

  it('does not weaken finding 8\'s MCP elicitation denial', async () => {
    // Trusted TOOL provenance says nothing about elicitation, which stays denied by
    // the process-scoped server-request handler whatever the turn authorized.
    const client = new FakeManagerClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      createClient: (options) => { client.serverRequest = options.onServerRequest!; return client as never; },
    });
    await manager.ready();

    const response = await client.serverRequest({
      id: 1,
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread-1', turnId: 't1', serverName: 'claudeclaw-dispatch', mode: 'form', message: 'hi' },
    });
    expect(response).toEqual({ result: { action: 'decline', content: null, _meta: null } });
  });
});
