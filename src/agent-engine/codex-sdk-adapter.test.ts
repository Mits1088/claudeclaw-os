// Unit tests for the native OpenAI (Codex SDK) engine adapter. The SDK is
// fully mocked — these verify the translation layer: thread lifecycle,
// event mapping, persona delivery, env isolation, cost estimation, and the
// failure paths (friendly errors instead of bare 'error' events).

import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require('os');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require('path');
  return {
    ctorOptions: [] as any[],
    startCalls: [] as any[],
    resumeCalls: [] as Array<{ id: string; options: any }>,
    // `signalAbortedAtCall` is captured AT CALL TIME — the signal object mutates
    // later, so it is the only way to prove the adapter handed runStreamed a
    // signal that was already aborted (i.e. the turn never starts).
    runs: [] as Array<{ input: any; turnOptions: any; signalAbortedAtCall: boolean }>,
    // One generator factory per expected runStreamed() call, consumed in order.
    scripts: [] as Array<() => AsyncGenerator<any>>,
    // Real (writable) dir so ensureIsolatedCodexHome's mkdir succeeds; the
    // suite sets OPENAI_API_KEY so no auth.json copy is attempted. configDir is
    // deliberately NOT under projectRoot so the isolated home passes the
    // "outside every writable root" fail-closed check.
    configDir: nodePath.join(nodeOs.tmpdir(), 'claudeclaw-codex-adapter-test'),
    projectRoot: nodePath.join(nodeOs.tmpdir(), 'claudeclaw-codex-proj-root'),
    allowHiveRead: false as boolean,
  };
});

vi.mock('@openai/codex-sdk', () => {
  class FakeThread {
    async runStreamed(input: any, turnOptions: any) {
      state.runs.push({ input, turnOptions, signalAbortedAtCall: turnOptions?.signal?.aborted === true });
      const script = state.scripts.shift();
      if (!script) throw new Error('test error: no script queued for runStreamed');
      return { events: script() };
    }
  }
  class Codex {
    constructor(options: any) { state.ctorOptions.push(options); }
    startThread(options: any) { state.startCalls.push(options); return new FakeThread(); }
    resumeThread(id: string, options: any) { state.resumeCalls.push({ id, options }); return new FakeThread(); }
  }
  return { Codex };
});

vi.mock('../config.js', () => ({
  OPENAI_API_KEY: 'sk-test-openai',
  DEFAULT_OPENAI_MODEL: 'gpt-5.5',
  CLAUDECLAW_CONFIG: state.configDir,
  PROJECT_ROOT: state.projectRoot,
  STORE_DIR: state.projectRoot + '/store',
  DB_ENCRYPTION_KEY: 'test-db-key',
  get DISPATCH_ALLOW_HIVE_READ() { return state.allowHiveRead ?? false; },
  CODEX_DANGER_WRITE: false,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import nodeFs from 'fs';
import nodePath from 'path';

import { CodexSdkEngineAdapter } from './codex-sdk-adapter.js';
import { logger } from '../logger.js';
import type { AgentEngineEvent, AgentTurnInput } from './types.js';

function turnCompleted(usage?: Partial<{ input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number }>) {
  return {
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, ...usage },
  };
}

async function* happyScript() {
  yield { type: 'thread.started', thread_id: 'thread-123' };
  yield { type: 'turn.started' };
  yield { type: 'item.started', item: { id: 'm1', type: 'agent_message', text: '' } };
  yield { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Hel' } };
  yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Hello' } };
  yield turnCompleted();
}

async function collect(input: AgentTurnInput): Promise<AgentEngineEvent[]> {
  const adapter = new CodexSdkEngineAdapter();
  const events: AgentEngineEvent[] = [];
  for await (const ev of adapter.invoke(input)) events.push(ev);
  return events;
}

function baseInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    prompt: 'hi there',
    provider: { type: 'openai' },
    cwd: '/tmp/agent-cwd',
    ...overrides,
  };
}

/**
 * An ALREADY-AUTHORIZED dispatch entry, exactly as the dispatch authorization
 * layer (dispatch-tools.ts) materializes it before the engine is called. The
 * adapter's job is to map it, recognise it for pre-approval, and nothing else —
 * it must never construct one.
 */
const DISPATCH_ENTRY = {
  command: process.execPath,
  args: ['/opt/claudeclaw/dist/dispatch-mcp-server.js'],
  env: { CLAUDECLAW_DISPATCH_AGENT: 'lawrence', CLAUDECLAW_STORE_DIR: '/opt/claudeclaw/store' },
};

beforeEach(() => {
  state.ctorOptions.length = 0;
  state.startCalls.length = 0;
  state.resumeCalls.length = 0;
  state.runs.length = 0;
  state.scripts.length = 0;
  state.allowHiveRead = false;
});

describe('CodexSdkEngineAdapter — happy path', () => {
  it('maps thread/message/usage events onto the engine seam', async () => {
    state.scripts.push(happyScript);
    const events = await collect(baseInput());

    expect(events[0]).toMatchObject({ type: 'session', sessionId: 'thread-123' });

    const deltas = events.filter((e) => e.type === 'text_delta') as any[];
    expect(deltas.map((d) => d.delta)).toEqual(['Hel', 'lo']);
    expect(deltas[1].accumulatedText).toBe('Hello');

    const usage = events.find((e) => e.type === 'usage') as any;
    // inputTokens EXCLUDES the cached portion (Anthropic seam convention):
    // OpenAI's input_tokens=100 includes 40 cached, so inputTokens=60 and
    // inputTokens + cacheReadInputTokens = 100 = the true context size.
    expect(usage.usage.inputTokens).toBe(60);
    expect(usage.usage.cacheReadInputTokens).toBe(40);
    expect(usage.usage.cacheCreationInputTokens).toBe(10);
    expect(usage.usage.lastCallInputTokens).toBe(60);
    expect(usage.usage.lastCallCacheCreation).toBe(10);
    expect(usage.usage.inputTokens + usage.usage.cacheReadInputTokens).toBe(100);
    expect(usage.usage.outputTokens).toBe(20);
    expect(usage.usage.model).toBe('gpt-5.5');
    expect(usage.usage.contextWindow).toBe(272_000);
    // gpt-5.5 rates: (60 uncached × $5 + 40 cached × $0.50 + 20 out × $30) / 1M
    expect(usage.usage.totalCostUsd).toBeCloseTo(0.00092, 8);

    const result = events.at(-1) as any;
    expect(result.type).toBe('result');
    expect(result.text).toBe('Hello');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.totalCostUsd).toBeGreaterThan(0);
  });

  it('starts a new thread with model/cwd/sandbox options and passes the raw prompt', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ model: 'gpt-5.4', allowDangerouslySkipPermissions: true }));

    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]).toMatchObject({
      model: 'gpt-5.4',
      workingDirectory: '/tmp/agent-cwd',
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(state.runs[0].input).toBe('hi there');
  });

  it('locks down to workspace-write when permissions are not skipped', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ allowDangerouslySkipPermissions: false }));
    expect(state.startCalls[0].sandboxMode).toBe('workspace-write');
  });

  it('resumes an existing thread by session id', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ sessionId: 'thread-old' }));
    expect(state.resumeCalls).toHaveLength(1);
    expect(state.resumeCalls[0].id).toBe('thread-old');
    expect(state.startCalls).toHaveLength(0);
  });

  it('separates multiple agent_message items with a blank line', async () => {
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'First.' } };
      yield { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Second.' } };
      yield turnCompleted();
    });
    const events = await collect(baseInput());
    const result = events.at(-1) as any;
    expect(result.text).toBe('First.\n\nSecond.');
  });

  it('maps command/mcp/file/todo items to progress events', async () => {
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      yield { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'git status', aggregated_output: '', status: 'in_progress' } };
      yield { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'git status', aggregated_output: 'ok', exit_code: 0, status: 'completed' } };
      yield { type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: 'bad-cmd', aggregated_output: 'nope', exit_code: 1, status: 'failed' } };
      yield { type: 'item.started', item: { id: 't1', type: 'mcp_tool_call', server: 'obsidian', tool: 'search', arguments: {}, status: 'in_progress' } };
      yield { type: 'item.completed', item: { id: 't1', type: 'mcp_tool_call', server: 'obsidian', tool: 'search', arguments: {}, status: 'completed' } };
      yield { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } };
      yield { type: 'item.updated', item: { id: 'p1', type: 'todo_list', items: [{ text: 'step 1', completed: true }, { text: 'step 2', completed: false }] } };
      yield turnCompleted();
    });
    const events = await collect(baseInput());
    const progress = events.filter((e) => e.type === 'progress').map((e: any) => e.progress);

    expect(progress).toContainEqual(expect.objectContaining({ type: 'tool_active', kind: 'execute', description: 'git status' }));
    // Successful commands are intentionally silent on completion (heartbeat throttle);
    // only a NON-ZERO exit surfaces a task_completed, as an advisory carrying the code.
    expect(progress).not.toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'execute', status: 'completed' }));
    expect(progress).not.toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'execute', status: 'failed' }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'execute', status: 'notice', description: 'bad-cmd · exit 1' }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'tool_active', kind: 'mcp', description: 'obsidian: search' }));
    expect(progress).toContainEqual(expect.objectContaining({ type: 'task_completed', kind: 'edit', locations: [{ path: 'src/a.ts' }] }));
    const plan = progress.find((p: any) => p.type === 'plan');
    expect(plan.planEntries).toEqual([
      { content: 'step 1', status: 'completed' },
      { content: 'step 2', status: 'pending' },
    ]);
  });
});

describe('CodexSdkEngineAdapter — configuration', () => {
  it('passes the API key and strips Anthropic credentials from the subprocess env', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({
      env: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        HOME: '/home/u',
        UNDEFINED_VALUE: undefined,
      },
    }));

    const opts = state.ctorOptions[0];
    expect(opts.apiKey).toBe('sk-test-openai');
    expect(opts.env.PATH).toBe('/usr/bin');
    expect(opts.env.HOME).toBe('/home/u');
    expect(opts.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(opts.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(opts.env).not.toHaveProperty('UNDEFINED_VALUE');
  });

  it('pins CODEX_HOME to an isolated dir (outside cwd) so the user\'s ~/.codex/config.toml never loads', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ env: { PATH: '/usr/bin' } }));
    const codexHome = state.ctorOptions[0].env.CODEX_HOME as string;
    expect(codexHome).toBe(nodePath.join(nodeFs.realpathSync(state.configDir), 'codex-home'));
  });

  it('removes a stale subscription credential from the isolated home (API-key mode)', async () => {
    // This suite runs with OPENAI_API_KEY set, so every turn is API-key mode: a credential
    // mirrored in by an earlier subscription turn is exactly what must not stay readable.
    // Proves the shared codex-home helper is wired into this path — the App Server adapter
    // had no credential preparation at all before it was extracted.
    const home = nodePath.join(state.configDir, 'codex-home');
    nodeFs.mkdirSync(home, { recursive: true });
    const stale = nodePath.join(home, 'auth.json');
    nodeFs.writeFileSync(stale, JSON.stringify({ tokens: { access_token: 'stale-subscription-token' } }));

    state.scripts.push(happyScript);
    await collect(baseInput());
    expect(nodeFs.existsSync(stale)).toBe(false);
  });

  it('delivers a small persona via developer_instructions config', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ systemPrompt: 'You are Crow, the ops agent.' }));
    expect(state.ctorOptions[0].config.developer_instructions).toBe('You are Crow, the ops agent.');
    expect(state.runs[0].input).toBe('hi there'); // not prepended in-band
  });

  it('delivers the current runtime identity through developer_instructions', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ runtimeIdentity: 'You are currently running on GPT-5.6 Luna (provider: openai).' }));
    expect(state.ctorOptions[0].config.developer_instructions).toBe(
      'You are currently running on GPT-5.6 Luna (provider: openai).',
    );
  });

  it('keeps runtime identity current on resumed oversized-persona turns', async () => {
    const bigPersona = 'P'.repeat(9000);
    const sol = 'You are currently running on GPT-5.6 Sol (provider: openai).';
    const luna = 'You are currently running on GPT-5.6 Luna (provider: openai).';
    state.scripts.push(happyScript);
    await collect(baseInput({ systemPrompt: bigPersona, runtimeIdentity: sol }));
    expect(state.ctorOptions[0].config.developer_instructions).toBe(sol);
    expect(state.runs[0].input).toContain(bigPersona);

    state.scripts.push(happyScript);
    await collect(baseInput({ systemPrompt: bigPersona, runtimeIdentity: luna, sessionId: 'thread-123' }));
    expect(state.ctorOptions[1].config.developer_instructions).toBe(luna);
    expect(state.runs[1].input).toBe('hi there');
  });

  it('delivers an oversized persona in-band on the first turn only', async () => {
    const bigPersona = 'P'.repeat(9000);
    state.scripts.push(happyScript);
    await collect(baseInput({ systemPrompt: bigPersona }));
    expect(state.ctorOptions[0].config?.developer_instructions).toBeUndefined();
    expect(state.runs[0].input).toContain(bigPersona);
    expect(state.runs[0].input).toContain('hi there');

    // Resumed turn: persona already lives in the thread transcript.
    state.scripts.push(happyScript);
    await collect(baseInput({ systemPrompt: bigPersona, sessionId: 'thread-123' }));
    expect(state.runs[1].input).toBe('hi there');
  });

  it('maps MCP servers, skipping SSE and header-bearing HTTP servers', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({
      mcpServers: {
        'files.local': { command: 'mcp-files', args: ['--root', '.'], env: { KEY: 'v' } },
        remote: { type: 'http', url: 'https://mcp.example.com' },
        legacy: { type: 'sse', url: 'https://sse.example.com' },
        authy: { type: 'http', url: 'https://auth.example.com', headers: { Authorization: 'Bearer x' } },
      },
    }));
    const mcp = state.ctorOptions[0].config.mcp_servers;
    expect(mcp.files_local).toEqual({ command: 'mcp-files', args: ['--root', '.'], env: { KEY: 'v' } });
    expect(mcp.remote).toEqual({ url: 'https://mcp.example.com' });
    expect(mcp).not.toHaveProperty('legacy');
    expect(mcp).not.toHaveProperty('authy');
  });

  // ── Phase 0: the adapter is a CONSUMER of authorization, never a source ────
  //
  // The adapter used to build and inject the `claudeclaw-dispatch` stdio server
  // itself, on every native OpenAI turn, after caller tool policy had already
  // been resolved — so a deny-all turn still received state-changing mission /
  // schedule / hive tools. Dispatch is now materialized by the shared
  // authorization layer (dispatch-tools.ts) BEFORE invoke(), and these tests
  // pin the adapter to consuming that set.

  it('never adds an MCP server that is absent from input.mcpServers', async () => {
    const prevAgent = process.env.CLAUDECLAW_AGENT_ID;
    process.env.CLAUDECLAW_AGENT_ID = 'lawrence';
    try {
      state.scripts.push(happyScript);
      await collect(baseInput()); // no mcpServers supplied
      const mcp = state.ctorOptions[0].config.mcp_servers;
      expect(mcp).toBeUndefined();

      // ...and with an authorized set, exactly that set arrives — nothing extra.
      state.scripts.push(happyScript);
      await collect(baseInput({ mcpServers: { files: { command: 'mcp-files' } } }));
      expect(Object.keys(state.ctorOptions[1].config.mcp_servers)).toEqual(['files']);
    } finally {
      if (prevAgent === undefined) delete process.env.CLAUDECLAW_AGENT_ID; else process.env.CLAUDECLAW_AGENT_ID = prevAgent;
    }
  });

  it('maps an AUTHORIZED dispatch entry through like any other stdio server', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ mcpServers: { 'claudeclaw-dispatch': DISPATCH_ENTRY } }));
    const entry = state.ctorOptions[0].config.mcp_servers['claudeclaw-dispatch'];
    expect(entry.command).toBe(DISPATCH_ENTRY.command);
    expect(entry.args[0]).toMatch(/dispatch-mcp-server\.js$/);
    expect(entry.env.CLAUDECLAW_DISPATCH_AGENT).toBe('lawrence');
  });

  it('keeps approvalPolicy never and pre-approves ONLY servers with trusted provenance', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({
      mcpServers: {
        'claudeclaw-dispatch': DISPATCH_ENTRY,
        remote: { type: 'http', url: 'https://mcp.example.com' },
      },
      trustedMcpServers: ['claudeclaw-dispatch'],
    }));
    expect(state.startCalls[0].approvalPolicy).toBe('never');
    const mcp = state.ctorOptions[0].config.mcp_servers;
    // the vouched-for dispatch server is trusted (no approval responder exists in
    // exec mode, so an approval-required call would resolve to Cancel)...
    expect(mcp['claudeclaw-dispatch'].default_tools_approval_mode).toBe('approve');
    // ...but no other server is granted that trust.
    expect(mcp.remote.default_tools_approval_mode).toBeUndefined();
  });

  it('fails closed before starting Codex when a sanitized-id collision would transfer trust', async () => {
    const events = await collect(baseInput({
      mcpServers: {
        'project tools': {
          command: 'untrusted-server',
          env: { PRIVATE_TOKEN: 'must-not-appear-in-diagnostics' },
        },
        'project.tools': { command: 'trusted-server' },
      },
      trustedMcpServers: ['project.tools'],
    }));

    expect(state.ctorOptions).toHaveLength(0);
    expect(state.startCalls).toHaveLength(0);
    expect(state.runs).toHaveLength(0);
    const result = events.at(-1) as any;
    expect(result).toMatchObject({ type: 'result', stopReason: 'error' });
    expect(result.text).toContain('will not transfer trusted approval');
    expect(result.text).toContain('project_tools');
    expect(result.text).not.toContain('must-not-appear-in-diagnostics');
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('must-not-appear-in-diagnostics');
  });

  it('pre-approves the collision winner when that original server is trusted', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({
      mcpServers: {
        'project.tools': { command: 'trusted-server' },
        'project tools': { command: 'skipped-untrusted-server' },
      },
      trustedMcpServers: ['project.tools'],
    }));

    const mcp = state.ctorOptions[0].config.mcp_servers;
    expect(Object.keys(mcp)).toEqual(['project_tools']);
    expect(mcp.project_tools).toMatchObject({
      command: 'trusted-server',
      default_tools_approval_mode: 'approve',
    });
  });

  it('does NOT pre-approve a server that merely CLAIMS the dispatch name', async () => {
    // Trust is provenance, not a string match. A project/user `.mcp.json` entry
    // named `claudeclaw-dispatch` (easiest to sneak in while the real bridge is
    // switched off) must not inherit auto-approval.
    state.scripts.push(happyScript);
    await collect(baseInput({
      mcpServers: { 'claudeclaw-dispatch': { command: 'evil-server' } },
      // no trustedMcpServers — the authorization layer vouched for nothing
    }));
    const mcp = state.ctorOptions[0].config.mcp_servers;
    expect(mcp['claudeclaw-dispatch'].command).toBe('evil-server');
    expect(mcp['claudeclaw-dispatch'].default_tools_approval_mode).toBeUndefined();
  });

  it('ignores trusted provenance for a server the profile narrowed away', async () => {
    // A tool-less turn keeps no MCP at all, so there is nothing to pre-approve
    // even if the caller vouched for an entry.
    state.scripts.push(happyScript);
    await collect(baseInput({
      disallowedTools: ['*'],
      mcpServers: { 'claudeclaw-dispatch': DISPATCH_ENTRY },
      trustedMcpServers: ['claudeclaw-dispatch'],
    }));
    expect(state.ctorOptions[0].config.mcp_servers).toBeUndefined();
  });

  it('does not pre-approve any server when the caller authorized none', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ mcpServers: { remote: { type: 'http', url: 'https://mcp.example.com' } } }));
    const mcp = state.ctorOptions[0].config.mcp_servers;
    expect(mcp).not.toHaveProperty('claudeclaw-dispatch');
    expect(mcp.remote.default_tools_approval_mode).toBeUndefined();
  });

  it('tool-less: disables shell + web search, requests read-only, and emits no mcp_servers', async () => {
    // The real memory-ingest / warmup / routing call shape.
    state.scripts.push(happyScript);
    await collect(baseInput({
      allowedTools: [],
      disallowedTools: ['*'],
      allowDangerouslySkipPermissions: true, // must NOT promote the turn
      maxTurns: 1,
      // even an authorized set is narrowed away on a tool-less turn
      mcpServers: { 'claudeclaw-dispatch': DISPATCH_ENTRY, files: { command: 'mcp-files' } },
    }));
    const cfg = state.ctorOptions[0].config;
    // Both gates: the shell, and the HOST-OWNED apps server. `mcp_servers` being
    // absent covers only ClaudeClaw-provided servers — `features.apps = false` is
    // what removes the account's `codex_apps` inventory.
    expect(cfg.features).toEqual({ shell_tool: false, apps: false });
    expect(cfg.web_search).toBe('disabled');
    expect(cfg.mcp_servers).toBeUndefined();
    expect(state.startCalls[0].sandboxMode).toBe('read-only');
    expect(state.startCalls[0].networkAccessEnabled).toBe(false);
    expect(state.startCalls[0].webSearchEnabled).toBe(false);
  });

  it('read-only-research: keeps the shell but still disables host-owned apps', async () => {
    // An untrusted-input research or voice turn needs shell for repository reads,
    // but must not be able to enumerate the operator's account connectors.
    state.scripts.push(happyScript);
    await collect(baseInput({ allowedTools: ['Read', 'Grep', 'Glob'] }));
    const cfg = state.ctorOptions[0].config;
    expect(cfg.features).toEqual({ apps: false });
    expect(cfg.features.shell_tool).toBeUndefined();
    // This allow-list omits WebSearch, so web search is off via config too.
    expect(cfg.web_search).toBe('disabled');
    expect(state.startCalls[0].sandboxMode).toBe('read-only'); // sandbox is the boundary
  });

  it('trusted turns keep host-owned apps and set no feature gates', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput()); // workspace-agent
    expect(state.ctorOptions[0].config.features).toBeUndefined();
    expect(state.ctorOptions[0].config.web_search).toBeUndefined();

    state.scripts.push(happyScript);
    await collect(baseInput({ allowDangerouslySkipPermissions: true })); // full-trust
    expect(state.ctorOptions[1].config.features).toBeUndefined();
  });

  it('disables web search via config on a trusted turn that denies it', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ disallowedTools: ['WebSearch'] }));
    const cfg = state.ctorOptions[0].config;
    expect(cfg.web_search).toBe('disabled');
    expect(cfg.features).toBeUndefined(); // shell and host apps stay for a trusted turn
  });

  it('fails a tool-less turn CLOSED if the runtime starts a tool anyway', async () => {
    // Defence in depth for `features.shell_tool = false`: if a pinned Codex
    // version stops honouring it, a tool-less turn must stop, not continue with
    // capabilities the caller never authorized.
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      yield { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'cat /etc/passwd', aggregated_output: '', status: 'in_progress' } };
      yield turnCompleted();
    });
    const events = await collect(baseInput({ allowedTools: [], disallowedTools: ['*'] }));

    const result = events.at(-1) as any;
    expect(result.type).toBe('result');
    expect(result.stopReason).toBe('error');
    expect(result.text).toMatch(/authorized with no tools/i);
    // The tool item itself is never surfaced as progress — the turn stops first.
    expect(events.filter((e) => e.type === 'progress')).toHaveLength(0);
    // Not reported as a user cancellation.
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
  });

  it('maps thinkingMode and effort to modelReasoningEffort', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ thinkingMode: 'xhigh' }));
    expect(state.startCalls[0].modelReasoningEffort).toBe('xhigh');

    state.scripts.push(happyScript);
    await collect(baseInput({ model: 'gpt-5.6-sol', effort: 'max' }));
    expect(state.startCalls[1].modelReasoningEffort).toBe('max');

    state.scripts.push(happyScript);
    await collect(baseInput());
    expect(state.startCalls[2].modelReasoningEffort).toBeUndefined();
  });

  it('treats thinkingMode "auto" as no reasoning override (model default)', async () => {
    // The dashboard's default OpenAI thinking option is 'auto'; it must not
    // pin an effort — the model keeps its own default (medium).
    state.scripts.push(happyScript);
    await collect(baseInput({ thinkingMode: 'auto' }));
    expect(state.startCalls[0].modelReasoningEffort).toBeUndefined();
  });

  it('"auto" wins over a runtimeMode-derived effort (no override leaks through)', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ thinkingMode: 'auto', effort: 'high' }));
    expect(state.startCalls[0].modelReasoningEffort).toBeUndefined();
  });

  it('normalizes an unsupported "minimal" effort away (model default)', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ thinkingMode: 'minimal' }));
    expect(state.startCalls[0].modelReasoningEffort).toBeUndefined();
  });

  it('does not send the unsupported none effort to GPT-6 Astra', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ model: 'gpt-6-astra', thinkingMode: 'none' }));
    expect(state.startCalls[0].modelReasoningEffort).toBeUndefined();
  });

  it('hardens config: disables AGENTS.md auto-load, scrubs key vars from shell, top-level allow_login_shell, pins provider, network off', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput()); // default: not full-access → workspace-write
    const cfg = state.ctorOptions[0].config;
    expect(cfg.project_doc_max_bytes).toBe(0);
    expect(cfg.shell_environment_policy.exclude).toEqual(expect.arrayContaining(['CODEX_API_KEY', 'OPENAI_API_KEY']));
    expect(cfg.shell_environment_policy.ignore_default_excludes).toBe(false);
    // allow_login_shell is a TOP-LEVEL key, not nested under shell_environment_policy.
    expect(cfg.allow_login_shell).toBe(false);
    expect(cfg.shell_environment_policy.allow_login_shell).toBeUndefined();
    expect(cfg.model_provider).toBe('openai');
    expect(state.startCalls[0].networkAccessEnabled).toBe(false);
  });

  it('passes the caller-authorized MCP set through regardless of sandbox mode', async () => {
    // MCP authorization is the caller's job; a read-only turn with an
    // explicitly-allowlisted MCP server keeps it (war-room mcp: allowlist case).
    const mcp = { files: { command: 'mcp-files' } };
    state.scripts.push(happyScript);
    await collect(baseInput({ allowedTools: ['Read', 'Grep', 'Glob'], mcpServers: mcp }));
    expect(state.ctorOptions[0].config.mcp_servers).toBeDefined();
    state.scripts.push(happyScript);
    await collect(baseInput({ allowedTools: ['Read', 'Bash'], mcpServers: mcp }));
    expect(state.ctorOptions[1].config.mcp_servers).toBeDefined();
  });

  it('allows network in explicit full-access mode', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ allowDangerouslySkipPermissions: true }));
    expect(state.startCalls[0].sandboxMode).toBe('danger-full-access');
    expect(state.startCalls[0].networkAccessEnabled).toBeUndefined();
  });

  it('disables web search when the tool policy disallows WebSearch', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ disallowedTools: ['WebSearch'] }));
    expect(state.startCalls[0].webSearchEnabled).toBe(false);

    state.scripts.push(happyScript);
    await collect(baseInput());
    expect(state.startCalls[1].webSearchEnabled).toBe(true);
  });

  it('maps a deny-all tool-less turn (memory-ingest shape) to read-only, no web search', async () => {
    // memory-ingest / warroom classifier: skip-perms true but tools banned.
    state.scripts.push(happyScript);
    await collect(baseInput({
      allowDangerouslySkipPermissions: true,
      allowedTools: [],
      disallowedTools: ['*'],
      maxTurns: 1,
    }));
    expect(state.startCalls[0].sandboxMode).toBe('read-only');
    expect(state.startCalls[0].webSearchEnabled).toBe(false);
  });

  it('maps a read-only chat allow-list ({Read,Grep,Glob}) to read-only sandbox', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ allowedTools: ['Read', 'Grep', 'Glob'] }));
    expect(state.startCalls[0].sandboxMode).toBe('read-only');
    expect(state.startCalls[0].webSearchEnabled).toBe(false);
  });

  it('derives the sandbox from the TOOL POLICY, not permissionMode (war-room ops fix)', async () => {
    // A war-room ops agent: permissionMode 'default' but an allow-list that
    // grants Bash. Must NOT be pinned read-only — the granted mutating tools
    // require workspace-write.
    state.scripts.push(happyScript);
    await collect(baseInput({ permissionMode: 'default', allowedTools: ['Read', 'Grep', 'Bash', 'Skill'] }));
    expect(state.startCalls[0].sandboxMode).toBe('workspace-write');
  });

  it('a read-only allow-list yields read-only even under permissionMode "default" (voice fix)', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ permissionMode: 'default', allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'] }));
    expect(state.startCalls[0].sandboxMode).toBe('read-only');
  });

  it('allows an allow-list that includes write/exec tools to use workspace-write', async () => {
    state.scripts.push(happyScript);
    await collect(baseInput({ allowedTools: ['Read', 'Bash', 'Write'] }));
    expect(state.startCalls[0].sandboxMode).toBe('workspace-write');
  });
});

describe('CodexSdkEngineAdapter — failure paths', () => {
  it('surfaces turn.failed as text_delta + result (never a bare error event)', async () => {
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      yield { type: 'turn.failed', error: { message: 'stream disconnected' } };
    });
    const events = await collect(baseInput());
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const result = events.at(-1) as any;
    expect(result.type).toBe('result');
    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('stream disconnected');
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });

  it('aborts the turn when a credential cannot be prepared, keeping its own message', async () => {
    // Fail CLOSED, which is a change: this used to log a warning and run the turn anyway,
    // leaving it able to read the very credential API-key mode exists to keep away from it.
    // The message passes through unwrapped — "check that directory is writable" is the wrong
    // advice for a single unremovable file.
    const home = nodePath.join(state.configDir, 'codex-home');
    nodeFs.mkdirSync(home, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(home, 'auth.json'), '{}');

    const rmSync = vi.spyOn(nodeFs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    try {
      const events = await collect(baseInput());
      const result = events.at(-1) as any;
      expect(result.stopReason).toBe('error');
      expect(result.text).toContain('will not start a Codex turn that could still read it');
      expect(result.text).not.toContain('Check that directory is writable');
      // No thread was started: the SDK never saw the turn.
      expect(state.startCalls).toHaveLength(0);
    } finally {
      rmSync.mockRestore();
    }
  });

  it('gives an actionable message on auth failures', async () => {
    state.scripts.push(async function* () {
      yield { type: 'error', message: '401 Unauthorized' };
    });
    const events = await collect(baseInput());
    const result = events.at(-1) as any;
    expect(result.text).toMatch(/codex login|OPENAI_API_KEY/);
  });

  it('explains a staged ChatGPT model rollout without dumping the upstream JSON', async () => {
    state.scripts.push(async function* () {
      yield {
        type: 'error',
        message: '{"error":{"message":"The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account."}}',
      };
    });
    const events = await collect(baseInput({ model: 'gpt-6-astra' }));
    const result = events.at(-1) as any;
    expect(result.text).toMatch(/not enabled.*ChatGPT Codex account/i);
    expect(result.text).toMatch(/API key/);
    expect(result.text).not.toContain('{"error"');
  });

  it('falls back to a fresh thread when resume hits a stale session', async () => {
    state.scripts.push(async function* () {
      yield { type: 'error', message: 'session not found: thread-old' };
    });
    state.scripts.push(happyScript);

    const events = await collect(baseInput({ sessionId: 'thread-old' }));
    expect(state.resumeCalls).toHaveLength(1);
    expect(state.startCalls).toHaveLength(1);
    const result = events.at(-1) as any;
    expect(result.text).toBe('Hello');
    expect(result.stopReason).toBe('end_turn');
    // The fresh thread announces its new id so the caller re-encodes it.
    expect(events.some((e) => e.type === 'session' && (e as any).sessionId === 'thread-123')).toBe(true);
  });

  it('recognizes the CLI\'s real "no rollout found" resume error and retries fresh', async () => {
    state.scripts.push(async function* () {
      yield { type: 'error', message: 'thread/resume failed: no rollout found for thread id thread-old' };
    });
    state.scripts.push(happyScript);
    const events = await collect(baseInput({ sessionId: 'thread-old' }));
    expect(state.startCalls).toHaveLength(1); // fell back to a fresh thread
    expect((events.at(-1) as any).stopReason).toBe('end_turn');
  });

  it('keeps the FIRST (specific) error when generic follow-ups arrive', async () => {
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      yield { type: 'error', message: '401 Unauthorized: invalid credentials' };
      yield { type: 'error', message: 'stream disconnected' };
      yield { type: 'turn.failed', error: { message: 'exited with code 1' } };
    });
    const events = await collect(baseInput());
    const result = events.at(-1) as any;
    expect(result.stopReason).toBe('error');
    // friendlyCodexError maps the preserved 401 to the auth remedy.
    expect(result.text).toMatch(/codex login|OPENAI_API_KEY/);
  });

  it('preserves the structured turn.failed message when the SDK then throws its exit wrapper', async () => {
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      yield { type: 'turn.failed', error: { message: '401 Unauthorized' } };
      throw new Error('Codex Exec exited with code 1'); // generic SDK wrapper
    });
    const events = await collect(baseInput());
    const result = events.at(-1) as any;
    expect(result.stopReason).toBe('error');
    // The specific 401 (not the generic exit message) drives the remedy.
    expect(result.text).toMatch(/codex login|OPENAI_API_KEY/);
  });

  it('does NOT fail a turn that emitted a provisional error but then completed', async () => {
    // Defensive: a mid-stream error notification the CLI recovers from must not
    // latch — turn.completed is authoritative.
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      yield { type: 'error', message: 'transient upstream blip' };
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Recovered answer' } };
      yield turnCompleted();
    });
    const events = await collect(baseInput());
    const result = events.at(-1) as any;
    expect(result.type).toBe('result');
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('Recovered answer');
  });

  it('does not retry a stale session after output has streamed', async () => {
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 'thread-old' };
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'partial' } };
      yield { type: 'error', message: 'session not found mid-flight' };
    });
    const events = await collect(baseInput({ sessionId: 'thread-old' }));
    expect(state.startCalls).toHaveLength(0); // no second attempt
    const result = events.at(-1) as any;
    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('partial');
  });

  it('emits aborted when the signal fires mid-stream', async () => {
    const abortController = new AbortController();
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't-abort' };
      abortController.abort();
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'late' } };
      yield turnCompleted();
    });
    const events = await collect(baseInput({ abortController }));
    const aborted = events.at(-1) as any;
    expect(aborted.type).toBe('aborted');
    expect(aborted.sessionId).toBe('t-abort');
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  it('never starts a turn when the caller signal is ALREADY aborted', async () => {
    // The adapter chains an internal policy AbortController onto the caller's
    // signal. An already-aborted signal never fires 'abort', so the chained
    // controller must COPY that state rather than subscribe — otherwise a
    // pre-aborted invocation hands the SDK a live signal and a Codex turn starts
    // before the first event is ever observed.
    const abortController = new AbortController();
    abortController.abort();
    state.scripts.push(happyScript);

    const events = await collect(baseInput({ abortController }));

    expect(state.runs[0].signalAbortedAtCall).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect((events.at(-1) as any).type).toBe('aborted');
  });

  it('relays a mid-stream caller abort to the signal it handed the SDK', async () => {
    const abortController = new AbortController();
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't-relay' };
      abortController.abort();
      yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'late' } };
    });
    await collect(baseInput({ abortController }));
    // Not aborted when the turn started, but the caller's abort reached it.
    expect(state.runs[0].signalAbortedAtCall).toBe(false);
    expect(state.runs[0].turnOptions.signal.aborted).toBe(true);
  });

  it('treats a thrown AbortError as aborted, not an error', async () => {
    const abortController = new AbortController();
    state.scripts.push(async function* () {
      yield { type: 'thread.started', thread_id: 't' };
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    abortController.abort();
    const events = await collect(baseInput({ abortController }));
    expect((events.at(-1) as any).type).toBe('aborted');
  });
});
