// Transport tests for the App Server client, against a DETERMINISTIC FAKE child.
//
// No account, no real Codex binary, no network: the client's contract is JSONL
// framing, request correlation, notification routing, server-request answering, and
// failure behaviour. A fake child exercises all of it and lets us script the cases a
// real server would only produce by accident (out-of-order responses, malformed
// lines, split chunks, unknown ids).

import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CodexAppServerClient,
  METHOD_NOT_FOUND,
  requestDeliveryOf,
  type CodexAppServerClientOptions,
} from './codex-app-server-client.js';
import type { JsonRpcNotification, JsonRpcRequest } from './codex-app-server-protocol.js';

/**
 * A fake `codex app-server` child. `written` captures the parsed JSONL the client
 * sent; `emit*` pushes bytes back. Nothing is auto-answered — each test scripts the
 * exact server behaviour it wants.
 */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: any[] = [];
  killed = false;
  /** True while the kernel buffer is "full": write() returns false and bytes are HELD. */
  writesBlocked = false;
  private stdinBuffer = '';
  private heldChunks: string[] = [];

  constructor() {
    super();
    // Model real backpressure: while blocked, write() reports false AND the bytes do
    // not arrive until 'drain'. Passing them through anyway would let a client that
    // ignores backpressure still look correct.
    (this.stdin as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
      const text = String(chunk);
      if (this.writesBlocked) {
        this.heldChunks.push(text);
        return false;
      }
      this.consume(text);
      return true;
    };
  }

  private consume(text: string): void {
    this.stdinBuffer += text;
    let at: number;
    while ((at = this.stdinBuffer.indexOf('\n')) >= 0) {
      const line = this.stdinBuffer.slice(0, at);
      this.stdinBuffer = this.stdinBuffer.slice(at + 1);
      if (line.trim()) this.written.push(JSON.parse(line));
    }
  }

  /** Report a full buffer: subsequent writes return false and are withheld. */
  blockWrites(): void {
    this.writesBlocked = true;
  }

  /** Release the buffer: deliver withheld bytes, then emit 'drain' as Node would. */
  releaseWrites(): void {
    this.writesBlocked = false;
    for (const text of this.heldChunks.splice(0)) this.consume(text);
    this.stdin.emit('drain');
  }

  /** Push one complete JSONL message. */
  emitMessage(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  /** Push raw bytes — for split-chunk and malformed-line cases. */
  emitRaw(text: string): void {
    this.stdout.write(text);
  }

  /**
   * When false, kill() does not schedule an exit — the child is "still dying". A real
   * process can linger arbitrarily after SIGTERM, and that window is exactly where a
   * poisoned generation must not look healthy.
   */
  autoExitOnKill = true;

  /** Every signal kill() was called with, in order — SIGTERM arrives as undefined. */
  killSignals: Array<NodeJS.Signals | undefined> = [];
  /** When true, SIGKILL ends the child even though SIGTERM was ignored. */
  exitOnSigkill = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    // A real kill leads to an exit event; emit asynchronously like the OS would.
    if (this.autoExitOnKill || (this.exitOnSigkill && signal === 'SIGKILL')) {
      setImmediate(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    }
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

const CODEX_HOME = '/tmp/claudeclaw-codex-home';

function initializeResult(overrides: Record<string, unknown> = {}) {
  return {
    userAgent: 'codex-cli/0.144.6',
    codexHome: CODEX_HOME,
    platformFamily: 'unix',
    platformOs: 'linux',
    ...overrides,
  };
}

function makeClient(overrides: Partial<CodexAppServerClientOptions> = {}) {
  const child = new FakeChild();
  const notifications: JsonRpcNotification[] = [];
  const client = new CodexAppServerClient({
    env: { CODEX_HOME },
    expectedCodexHome: CODEX_HOME,
    clientVersion: '1.7.1',
    spawnChild: () => child as never,
    onNotification: (n) => notifications.push(n),
    ...overrides,
  });
  return { client, child, notifications };
}

/** Let the client's stream listeners run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Wait until the fake child has received `count` messages. */
async function waitForWrites(child: FakeChild, count: number): Promise<void> {
  for (let i = 0; i < 200 && child.written.length < count; i++) await tick();
}

/** Start a client and complete the handshake with a scripted server. */
async function startedClient(overrides: Partial<CodexAppServerClientOptions> = {}) {
  const ctx = makeClient(overrides);
  const starting = ctx.client.start();
  await waitForWrites(ctx.child, 1);
  ctx.child.emitMessage({ id: ctx.child.written[0].id, result: initializeResult() });
  await starting;
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('initialization handshake', () => {
  it('sends initialize with BOTH required capability fields, then initialized with no params', async () => {
    // The 0.144.6 InitializeCapabilities schema requires experimentalApi AND
    // requestAttestation (neither optional), and the `initialized` notification
    // variant has no `params` member. Getting either wrong is a deserialization
    // failure against the real binary, so it is pinned here.
    const { child } = await startedClient();

    const init = child.written[0];
    expect(init.method).toBe('initialize');
    expect(init.params.capabilities).toEqual({ experimentalApi: true, requestAttestation: false });
    expect(init.params.clientInfo).toEqual({ name: 'claudeclaw', title: 'ClaudeClaw', version: '1.7.1' });

    const initialized = child.written[1];
    expect(initialized).toEqual({ method: 'initialized' });
    expect('params' in initialized).toBe(false);
  });

  it('does not send initialized until the initialize response arrives', async () => {
    const { client, child } = makeClient();
    const starting = client.start();
    await waitForWrites(child, 1);

    expect(child.written).toHaveLength(1); // initialize only
    expect(client.isReady()).toBe(false);

    child.emitMessage({ id: child.written[0].id, result: initializeResult() });
    await starting;
    expect(child.written[1]).toEqual({ method: 'initialized' });
    expect(client.isReady()).toBe(true);
  });

  it('spawns ONE child for concurrent startup callers', async () => {
    let spawns = 0;
    const child = new FakeChild();
    const client = new CodexAppServerClient({
      env: { CODEX_HOME },
      expectedCodexHome: CODEX_HOME,
      clientVersion: '1.7.1',
      spawnChild: () => { spawns++; return child as never; },
    });

    const a = client.start();
    const b = client.start();
    const c = client.start();
    await waitForWrites(child, 1);
    child.emitMessage({ id: child.written[0].id, result: initializeResult() });

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(spawns).toBe(1);
    expect(ra).toEqual(rb);
    expect(rb).toEqual(rc);
    // Exactly one handshake, not three.
    expect(child.written.filter((m) => m.method === 'initialize')).toHaveLength(1);
  });

  it('refuses to run when the child reports a DIFFERENT CODEX_HOME', async () => {
    // Fail closed: a mismatched home means the operator's global config.toml may be
    // in force, with its own MCP servers and sandbox settings.
    const { client, child } = makeClient();
    const starting = client.start();
    await waitForWrites(child, 1);
    child.emitMessage({ id: child.written[0].id, result: initializeResult({ codexHome: '/home/mike/.codex' }) });

    await expect(starting).rejects.toThrow(/reported CODEX_HOME .*refusing to run un-isolated/s);
    expect(child.killed).toBe(true);
    expect(client.isReady()).toBe(false);
  });

  it('rejects an initialize response missing a required field', async () => {
    const { client, child } = makeClient();
    const starting = client.start();
    await waitForWrites(child, 1);
    const { platformOs, ...incomplete } = initializeResult();
    child.emitMessage({ id: child.written[0].id, result: incomplete });

    await expect(starting).rejects.toThrow(/missing required string field\(s\): platformOs/);
  });

  it('stays restartable after a failed start', async () => {
    // A startup failure must not poison the object: a later invocation may succeed
    // once the operator fixes the cause.
    const children: FakeChild[] = [];
    const client = new CodexAppServerClient({
      env: { CODEX_HOME },
      expectedCodexHome: CODEX_HOME,
      clientVersion: '1.7.1',
      spawnChild: () => { const c = new FakeChild(); children.push(c); return c as never; },
    });

    const first = client.start();
    await waitForWrites(children[0], 1);
    children[0].emitMessage({ id: children[0].written[0].id, error: { code: -32000, message: 'not authenticated' } });
    await expect(first).rejects.toThrow(/not authenticated/);

    const second = client.start();
    await waitForWrites(children[1], 1);
    children[1].emitMessage({ id: children[1].written[0].id, result: initializeResult() });
    await expect(second).resolves.toMatchObject({ userAgent: 'codex-cli/0.144.6' });
    expect(children).toHaveLength(2);
  });

  it('rejects non-initialize requests before the handshake completes', async () => {
    const { client } = makeClient();
    await expect(client.request('thread/start', {})).rejects.toThrow(/not running|not ready/);
  });
});

describe('request correlation', () => {
  it('correlates OUT-OF-ORDER responses to the right callers', async () => {
    const { client, child } = await startedClient();
    const a = client.request('thread/start', { one: true });
    const b = client.request('thread/resume', { two: true });
    await waitForWrites(child, 4);

    const [, , reqA, reqB] = child.written;
    // Answer B first.
    child.emitMessage({ id: reqB.id, result: { which: 'b' } });
    child.emitMessage({ id: reqA.id, result: { which: 'a' } });

    expect(await a).toEqual({ which: 'a' });
    expect(await b).toEqual({ which: 'b' });
  });

  it('maps an error response onto a rejection naming the method', async () => {
    const { client, child } = await startedClient();
    const call = client.request('turn/start', {});
    await waitForWrites(child, 3);
    child.emitMessage({ id: child.written[2].id, error: { code: -32602, message: 'no such thread' } });

    await expect(call).rejects.toThrow(/turn\/start failed: no such thread/);
  });

  it('ignores a response with an unknown id instead of killing the transport', async () => {
    // A late response to a timed-out request is expected; tearing down the shared
    // child would punish healthy concurrent turns.
    const { client, child } = await startedClient();
    child.emitMessage({ id: 99999, result: { stray: true } });
    await tick();

    expect(client.isReady()).toBe(true);
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);
    child.emitMessage({ id: child.written[2].id, result: { ok: true } });
    await expect(call).resolves.toEqual({ ok: true });
  });

  it('ignores a DUPLICATE response for an already-settled request', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);
    const id = child.written[2].id;
    child.emitMessage({ id, result: { first: true } });
    child.emitMessage({ id, result: { second: true } });
    await tick();

    expect(await call).toEqual({ first: true });
    expect(client.isReady()).toBe(true);
  });

  it('enforces a request timeout without replaying', async () => {
    vi.useFakeTimers();
    try {
      const { client, child } = makeClient();
      const starting = client.start();
      await vi.advanceTimersByTimeAsync(0);
      child.emitMessage({ id: child.written[0].id, result: initializeResult() });
      await starting;

      const call = client.request('thread/start', {}, 1_000);
      const assertion = expect(call).rejects.toThrow(/'thread\/start' timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;

      // The request was sent exactly once — a timeout does not prove the server
      // skipped it, so the client must never resend on its own.
      expect(child.written.filter((m) => m.method === 'thread/start')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a turn-length request be bounded by the control timeout', async () => {
    // Callers pass an explicit timeout for long operations; the default must not
    // silently cancel an active turn.
    vi.useFakeTimers();
    try {
      const { client, child } = makeClient();
      const starting = client.start();
      await vi.advanceTimersByTimeAsync(0);
      child.emitMessage({ id: child.written[0].id, result: initializeResult() });
      await starting;

      const call = client.request('turn/start', {}, 10 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000); // past the 30s control default
      child.emitMessage({ id: child.written[2].id, result: { done: true } });
      await expect(call).resolves.toEqual({ done: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('JSONL framing', () => {
  it('reassembles a message split across chunks', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);
    const id = child.written[2].id;

    const payload = JSON.stringify({ id, result: { split: true } });
    child.emitRaw(payload.slice(0, 12));
    await tick();
    child.emitRaw(`${payload.slice(12)}\n`);

    await expect(call).resolves.toEqual({ split: true });
    expect(client.isReady()).toBe(true);
  });

  it('handles several messages arriving in ONE chunk', async () => {
    const { client, child, notifications } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);
    const id = child.written[2].id;

    child.emitRaw(
      `${JSON.stringify({ method: 'turn/started', params: { turnId: 't1' } })}\n`
      + `${JSON.stringify({ id, result: { ok: true } })}\n`
      + `${JSON.stringify({ method: 'turn/completed', params: { turnId: 't1' } })}\n`,
    );

    await expect(call).resolves.toEqual({ ok: true });
    expect(notifications.map((n) => n.method)).toEqual(['turn/started', 'turn/completed']);
  });

  it('ignores empty lines', async () => {
    const { client, child, notifications } = await startedClient();
    child.emitRaw('\n\n   \n');
    child.emitMessage({ method: 'turn/started', params: {} });
    await tick();

    expect(notifications).toHaveLength(1);
    expect(client.isReady()).toBe(true);
  });

  it('treats a malformed line as protocol corruption and fails in-flight work', async () => {
    // We can no longer trust that we are seeing every terminal event, so the
    // transport goes unhealthy rather than continuing to guess.
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitRaw('{not json at all\n');
    await expect(call).rejects.toThrow(/malformed JSON on stdout/);
    expect(child.killed).toBe(true);
    await expect(client.request('thread/start', {})).rejects.toThrow(/unhealthy/);
  });

  it('treats an unclassifiable envelope as protocol corruption', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitMessage({ neither: 'id nor method' });
    await expect(call).rejects.toThrow(/matched no legal JSON-RPC envelope/);
  });

  it('does not corrupt stdout handling when stderr is noisy', async () => {
    const { client, child, notifications } = await startedClient();
    child.stderr.write('WARNING: something diagnostic\nmore stderr\n');
    child.emitMessage({ method: 'turn/started', params: { turnId: 't1' } });
    await tick();

    expect(notifications.map((n) => n.method)).toEqual(['turn/started']);
    expect(client.isReady()).toBe(true);
  });
});

describe('notifications and server-initiated requests', () => {
  it('routes notifications to the sink', async () => {
    const seen: string[] = [];
    const { client, child } = await startedClient({ onNotification: (n) => { seen.push(n.method); } });

    child.emitMessage({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 't1' } });
    child.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1' } } });
    await tick();

    expect(seen).toEqual(['thread/compacted', 'turn/completed']);
    expect(client.isReady()).toBe(true);
  });

  it('a THROWING sink poisons the generation instead of being logged and ignored', async () => {
    // The sink layer is what decides a notification is fatal; reaching the catch here
    // means it already has. Reading on left the connection healthy while a terminal
    // event went nowhere, so the turn waiting on it spun until the child died.
    const seen: string[] = [];
    const { client, child } = await startedClient({
      onNotification: (n) => {
        seen.push(n.method);
        if (n.method === 'boom') throw new Error('sink exploded');
      },
    });

    child.emitMessage({ method: 'boom', params: {} });
    child.emitMessage({ method: 'turn/completed', params: { turnId: 't1' } });
    await tick();

    // Nothing after the fault is read: the connection is no longer trustworthy.
    expect(seen).toEqual(['boom']);
    expect(client.isReady()).toBe(false);
    expect(child.killed).toBe(true);
    await expect(client.request('turn/start', {})).rejects.toThrow(/sink exploded|unhealthy|not running/);
  });

  it('answers a server-initiated request with the handler result', async () => {
    const requests: JsonRpcRequest[] = [];
    const { child } = await startedClient({
      onServerRequest: async (req) => {
        requests.push(req);
        return { result: { answers: [] } };
      },
    });

    child.emitMessage({ id: 77, method: 'item/tool/requestUserInput', params: { questions: [] } });
    await waitForWrites(child, 3);

    expect(requests[0].method).toBe('item/tool/requestUserInput');
    expect(child.written[2]).toEqual({ id: 77, result: { answers: [] } });
  });

  it('answers an UNSUPPORTED server request with method-not-found rather than hanging', async () => {
    // Every server request must receive exactly one response; leaving one pending
    // until the server's own timeout stalls the turn.
    const { child } = await startedClient(); // no onServerRequest registered
    child.emitMessage({ id: 5, method: 'attestation/generate', params: {} });
    await waitForWrites(child, 3);

    expect(child.written[2]).toEqual({
      id: 5,
      error: { code: METHOD_NOT_FOUND, message: 'unsupported method: attestation/generate' },
    });
  });

  it('answers with an error when the handler throws', async () => {
    const { child } = await startedClient({
      onServerRequest: async () => { throw new Error('resolver blew up'); },
    });
    child.emitMessage({ id: 8, method: 'item/tool/requestUserInput', params: {} });
    await waitForWrites(child, 3);

    expect(child.written[2].id).toBe(8);
    expect(child.written[2].error.message).toBe('resolver blew up');
  });

  it('distinguishes a server REQUEST from a response (both carry an id)', async () => {
    const { client, child, notifications } = await startedClient({
      onServerRequest: async () => ({ result: {} }),
    });
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);
    const ourId = child.written[2].id;

    // Same id shape, but with a method → a server request, NOT our response.
    child.emitMessage({ id: ourId, method: 'item/tool/requestUserInput', params: {} });
    await waitForWrites(child, 4);
    expect(child.written[3]).toMatchObject({ id: ourId, result: {} });
    expect(notifications).toHaveLength(0);

    // Our request is still outstanding and still resolvable.
    child.emitMessage({ id: ourId, result: { ok: true } });
    await expect(call).resolves.toEqual({ ok: true });
  });
});

describe('process exit', () => {
  it('rejects pending requests once and reports the exit', async () => {
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null; expected: boolean }> = [];
    const { client, child } = await startedClient({ onExit: (info) => exits.push(info) });
    const a = client.request('thread/start', {});
    const b = client.request('turn/start', {});
    await waitForWrites(child, 4);

    child.exit(1, null);

    await expect(a).rejects.toThrow(/exited \(code 1/);
    await expect(b).rejects.toThrow(/exited \(code 1/);
    // expected:false marks this as a crash rather than a deliberate stop — the
    // distinction the manager's restart policy keys on.
    expect(exits).toEqual([{ code: 1, signal: null, expected: false }]);
    expect(client.getState()).toBe('exited');
  });

  it('does not resend or replay anything after an exit', async () => {
    const { client, child } = await startedClient();
    const call = client.request('turn/start', {});
    await waitForWrites(child, 3);
    const before = child.written.length;

    child.exit(null, 'SIGKILL');
    await expect(call).rejects.toThrow(/signal SIGKILL/);
    await tick();

    expect(child.written).toHaveLength(before); // nothing re-sent
    await expect(client.request('turn/start', {})).rejects.toThrow(/not running|unhealthy/);
  });

  it('allows a lazy restart on the next start() after an exit', async () => {
    const children: FakeChild[] = [];
    const client = new CodexAppServerClient({
      env: { CODEX_HOME },
      expectedCodexHome: CODEX_HOME,
      clientVersion: '1.7.1',
      spawnChild: () => { const c = new FakeChild(); children.push(c); return c as never; },
    });

    const first = client.start();
    await waitForWrites(children[0], 1);
    children[0].emitMessage({ id: children[0].written[0].id, result: initializeResult() });
    await first;
    children[0].exit(0);
    await tick();

    const second = client.start();
    await waitForWrites(children[1], 1);
    children[1].emitMessage({ id: children[1].written[0].id, result: initializeResult() });
    await expect(second).resolves.toMatchObject({ codexHome: CODEX_HOME });
    expect(children).toHaveLength(2);
  });
});

describe('generation isolation', () => {
  /** A client whose spawns are recorded, so generations can be driven individually. */
  function multiGenClient(overrides: Partial<CodexAppServerClientOptions> = {}) {
    const children: FakeChild[] = [];
    const exits: Array<{ code: number | null; expected: boolean }> = [];
    const client = new CodexAppServerClient({
      env: { CODEX_HOME },
      expectedCodexHome: CODEX_HOME,
      clientVersion: '1.7.1',
      spawnChild: () => { const c = new FakeChild(); children.push(c); return c as never; },
      onExit: (info) => exits.push({ code: info.code, expected: info.expected }),
      ...overrides,
    });
    return { client, children, exits };
  }

  /** Start and complete the handshake for generation `index` (spawned by start()). */
  async function handshake(client: CodexAppServerClient, children: FakeChild[], index: number): Promise<void> {
    const starting = client.start();
    for (let i = 0; i < 200 && children.length <= index; i++) await tick();
    const child = children[index];
    await waitForWrites(child, 1);
    child.emitMessage({ id: child.written[0].id, result: initializeResult() });
    await starting;
  }

  it('a STALE child exit does not disturb its replacement', async () => {
    // The dying child's exit handler must not clear the healthy replacement's state
    // or reject its in-flight requests.
    const { client, children, exits } = multiGenClient();
    await handshake(client, children, 0);
    children[0].exit(1);
    await tick();

    await handshake(client, children, 1);
    const call = client.request('thread/start', {});
    await waitForWrites(children[1], 3);

    // Now the OLD child emits a second, late exit.
    children[0].exit(9, 'SIGKILL');
    await tick();

    expect(client.isReady()).toBe(true);
    children[1].emitMessage({ id: children[1].written[2].id, result: { survived: true } });
    await expect(call).resolves.toEqual({ survived: true });
    // Only the two real exits were reported; the stale one was dropped.
    expect(exits).toEqual([{ code: 1, expected: false }]);
  });

  it('a late OLD-generation server-request answer is not sent down the new child', async () => {
    // The id space is per-connection: answering generation 1's request through
    // generation 2 would answer whatever unrelated request now holds that id.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, children } = multiGenClient({
      onServerRequest: async () => { await gate; return { result: { late: true } }; },
    });

    await handshake(client, children, 0);
    children[0].emitMessage({ id: 41, method: 'item/tool/requestUserInput', params: {} });
    await tick();

    // Child 1 dies while the handler is still pending; child 2 takes over.
    children[0].exit(1);
    await tick();
    await handshake(client, children, 1);
    const writesBefore = children[1].written.length;

    release!();
    await tick();
    await tick();

    // Nothing extra reached the replacement, and certainly not id 41.
    expect(children[1].written).toHaveLength(writesBefore);
    expect(children[1].written.some((m) => m.id === 41)).toBe(false);
  });

  it('stdout from a stale child cannot resolve a new generation request', async () => {
    const { client, children } = multiGenClient();
    await handshake(client, children, 0);
    children[0].exit(1);
    await tick();
    await handshake(client, children, 1);

    const call = client.request('thread/start', {});
    await waitForWrites(children[1], 3);
    const id = children[1].written[2].id;

    // The dead child emits a response bearing the SAME id.
    children[0].emitMessage({ id, result: { fromGhost: true } });
    await tick();

    const settled = await Promise.race([call.then(() => 'settled'), tick().then(() => 'pending')]);
    expect(settled).toBe('pending');

    children[1].emitMessage({ id, result: { fromLive: true } });
    await expect(call).resolves.toEqual({ fromLive: true });
  });

  it('a crash AFTER a completed shutdown is reported as unexpected', async () => {
    // The shutdown intent must not survive into a later generation, or a genuine
    // crash reads as a deliberate stop and no restart happens.
    const { client, children, exits } = multiGenClient();
    await handshake(client, children, 0);

    const shutting = client.shutdown();
    setImmediate(() => children[0].exit(0));
    await shutting;
    expect(exits).toEqual([{ code: 0, expected: true }]);

    await handshake(client, children, 1);
    children[1].exit(7);
    await tick();

    expect(exits[1]).toEqual({ code: 7, expected: false });
    expect(client.getState()).toBe('exited');
  });

  it('refuses start() while a shutdown is in flight, and allows it afterwards', async () => {
    vi.useFakeTimers();
    try {
      const { client, children } = multiGenClient();
      const starting = client.start();
      await vi.advanceTimersByTimeAsync(0);
      children[0].emitMessage({ id: children[0].written[0].id, result: initializeResult() });
      await starting;

      const shutting = client.shutdown();
      // Racing a spawn against a teardown is how two children end up alive at once.
      await expect(client.start()).rejects.toThrow(/shutting down/);
      await vi.advanceTimersByTimeAsync(10_000);
      await shutting;
      expect(children).toHaveLength(1);

      const restart = client.start();
      await vi.advanceTimersByTimeAsync(0);
      children[1].emitMessage({ id: children[1].written[0].id, result: initializeResult() });
      await expect(restart).resolves.toMatchObject({ codexHome: CODEX_HOME });
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects new requests once shutdown has begun', async () => {
    const { client, children } = multiGenClient();
    await handshake(client, children, 0);
    const shutting = client.shutdown();

    await expect(client.request('thread/start', {})).rejects.toThrow(/shutting down/);
    setImmediate(() => children[0].exit(0));
    await shutting;
  });
});

describe('stdin backpressure', () => {
  it('waits for drain and preserves ORDER when write() reports a full buffer', async () => {
    const { client, child } = await startedClient();
    child.blockWrites();

    const a = client.request('thread/start', { seq: 1 });
    const b = client.request('turn/start', { seq: 2 });
    const c = client.request('turn/interrupt', { seq: 3 });
    await tick();

    // Blocked: the first write was accepted-but-unflushed, the rest are queued.
    expect(child.written).toHaveLength(2); // initialize + initialized only

    child.releaseWrites();
    await waitForWrites(child, 5);

    expect(child.written.slice(2).map((m) => m.params.seq)).toEqual([1, 2, 3]);

    for (const [call, name] of [[a, 'thread/start'], [b, 'turn/start'], [c, 'turn/interrupt']] as const) {
      const req = child.written.find((m) => m.method === name);
      child.emitMessage({ id: req.id, result: { ok: name } });
      await expect(call).resolves.toEqual({ ok: name });
    }
  });

  it('fails a write VISIBLY when the outbound queue is over budget', async () => {
    // Better to reject the caller than to let Node's internal buffer grow until the
    // process dies of memory pressure.
    const { client, child } = await startedClient({ maxQueuedWriteBytes: 200 });
    child.blockWrites();

    const ok = client.request('thread/start', { pad: 'x'.repeat(50) });
    const overflow = client.request('turn/start', { pad: 'y'.repeat(400) });

    await expect(overflow).rejects.toThrow(/outbound queue is full/);
    child.releaseWrites();
    await waitForWrites(child, 3);
    const req = child.written.find((m) => m.method === 'thread/start');
    child.emitMessage({ id: req.id, result: { ok: true } });
    await expect(ok).resolves.toEqual({ ok: true });
  });

  it('does not hang the writer when the child dies while blocked', async () => {
    const { client, child } = await startedClient();
    child.blockWrites();
    const call = client.request('thread/start', {});
    await tick();

    child.exit(1);
    await expect(call).rejects.toThrow(/exited \(code 1/);
    expect(client.getState()).toBe('exited');
  });
});

describe('ambiguous envelopes are protocol corruption', () => {
  const AMBIGUOUS: Array<{ name: string; message: Record<string, unknown> }> = [
    { name: 'id only (no result, no error, no method)', message: { id: 1 } },
    { name: 'both result and error', message: { id: 1, result: {}, error: { code: 1, message: 'x' } } },
    { name: 'request fields plus a result', message: { id: 1, method: 'x/y', result: {} } },
    { name: 'request fields plus an error', message: { id: 1, method: 'x/y', error: { code: 1, message: 'x' } } },
    { name: 'notification plus a result', message: { method: 'x/y', result: {} } },
    { name: 'error body without a message', message: { id: 1, error: { code: 1 } } },
  ];

  for (const { name, message } of AMBIGUOUS) {
    it(`rejects ${name}`, async () => {
      const { client, child } = await startedClient();
      const call = client.request('thread/start', {});
      await waitForWrites(child, 3);
      // Use the real pending id so an id-only envelope would otherwise resolve it
      // with undefined — the exact failure mode being guarded.
      child.emitMessage({ ...message, ...('id' in message ? { id: child.written[2].id } : {}) });

      await expect(call).rejects.toThrow(/matched no legal JSON-RPC envelope/);
      // The transport is now unhealthy: further requests must refuse rather than be
      // sent to a child whose stream we no longer trust.
      await expect(client.request('thread/start', {})).rejects.toThrow(/unhealthy/);
    });
  }

  it('still accepts a legal server request with no params', async () => {
    const { child } = await startedClient({ onServerRequest: async () => ({ result: {} }) });
    child.emitMessage({ id: 3, method: 'item/tool/requestUserInput' });
    await waitForWrites(child, 3);
    expect(child.written[2]).toEqual({ id: 3, result: {} });
  });

  it('still accepts a legal null result', async () => {
    const { client, child } = await startedClient();
    const call = client.request('turn/interrupt', {});
    await waitForWrites(child, 3);
    child.emitMessage({ id: child.written[2].id, result: null });
    await expect(call).resolves.toBeNull();
  });
});

describe('stderr is drained but never logged as content', () => {
  it('does not log stderr text once the handshake has completed', async () => {
    const { logger } = await import('../logger.js');
    const { child } = await startedClient();
    (logger.debug as ReturnType<typeof vi.fn>).mockClear();

    // Codex stderr can echo prompts, tool arguments, and tool output.
    child.stderr.write('apply_patch failed: SECRET_PROMPT_TEXT in /home/mike/notes.txt\n');
    await tick();

    const logged = JSON.stringify((logger.debug as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('SECRET_PROMPT_TEXT');
    expect(logged).not.toContain('notes.txt');
  });

  it('surfaces PRE-handshake stderr in the startup error, where it is config diagnostics', async () => {
    // No turn has run yet, so this cannot contain prompt content — and without it a
    // startup failure is undiagnosable.
    const { client, child } = makeClient();
    const starting = client.start();
    await waitForWrites(child, 1);
    child.stderr.write('ERROR: codex login required\n');
    await tick();
    child.emitMessage({ id: child.written[0].id, error: { code: -32000, message: 'unauthenticated' } });

    await expect(starting).rejects.toThrow(/unauthenticated.*codex login required/s);
  });

  it('REDACTS credentials out of startup stderr before they reach the error', async () => {
    // An auth or config failure is exactly the kind of message that quotes a token.
    // Whitespace normalization is not redaction, so the project's redactor runs first.
    const { client, child } = makeClient();
    const starting = client.start();
    await waitForWrites(child, 1);
    child.stderr.write(
      'ERROR: auth failed for Authorization: Bearer abcdef1234567890abcdef; '
      + 'key sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA; '
      + 'endpoint https://user:s3cretpassword@codex.example.com/v1\n',
    );
    await tick();
    child.emitMessage({ id: child.written[0].id, error: { code: -32000, message: 'unauthenticated' } });

    const err = await starting.then(() => null, (e: Error) => e);
    const message = err?.message ?? '';

    // The diagnostic context survives...
    expect(message).toMatch(/unauthenticated/);
    expect(message).toMatch(/auth failed/);
    // ...but none of the credential material does.
    expect(message).not.toContain('abcdef1234567890abcdef');
    expect(message).not.toContain('sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA');
    expect(message).not.toContain('s3cretpassword');
    expect(message).toContain('<redacted>');
  });
});

describe('single-line byte cap', () => {
  it('rejects a NEWLINE-TERMINATED oversized line before parsing it', async () => {
    // The cap must be applied to every complete line, not only to the unterminated
    // remainder — otherwise an over-budget message that happens to end in \n reaches
    // JSON.parse, which is the very allocation the cap exists to prevent.
    const { client, child } = await startedClient({ maxLineBytes: 512 });
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    const oversized = JSON.stringify({ id: child.written[2].id, result: { pad: 'x'.repeat(2000) } });
    child.emitRaw(`${oversized}\n`);

    await expect(call).rejects.toThrow(/inbound line exceeded 512 bytes/);
    await expect(client.request('thread/start', {})).rejects.toThrow(/unhealthy/);
  });

  it('rejects an oversized line that has NOT yet been terminated', async () => {
    const { client, child } = await startedClient({ maxLineBytes: 512 });
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitRaw('x'.repeat(600)); // no newline at all
    await expect(call).rejects.toThrow(/inbound line exceeded 512 bytes/);
  });

  it('measures BYTES, not characters, so multi-byte content is counted correctly', async () => {
    // '€' is 3 UTF-8 bytes but one JS character; a length-based check would let ~3x
    // the intended payload through.
    const { client, child } = await startedClient({ maxLineBytes: 512 });
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitRaw(`${'€'.repeat(200)}\n`); // 200 chars, 600 bytes
    await expect(call).rejects.toThrow(/inbound line exceeded 512 bytes \(600\)/);
  });

  it('accepts many small complete lines arriving in one large chunk', async () => {
    // Normal traffic: aggregate size over the cap, every individual line under it.
    const { client, child, notifications } = await startedClient({ maxLineBytes: 512 });
    const lines = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ method: 'turn/started', params: { turnId: `t${i}` } })).join('\n');
    child.emitRaw(`${lines}\n`);
    await tick();

    expect(notifications).toHaveLength(40);
    expect(client.isReady()).toBe(true);
  });
});

describe('writer and process faults poison the transport', () => {
  it('a SYNCHRONOUS stdin write failure fails pending work and refuses later requests', async () => {
    // Leaving the transport "healthy" after a failed write means callers wait out a
    // 30s timeout for a response that can never arrive.
    const { client, child } = await startedClient();
    (child.stdin as unknown as { write: () => boolean }).write = () => {
      throw new Error('EPIPE: broken pipe');
    };

    const call = client.request('thread/start', {});
    await expect(call).rejects.toThrow(/stdin write failed: EPIPE/);
    await expect(client.request('turn/start', {})).rejects.toThrow(/unhealthy/);
    expect(child.killed).toBe(true);
  });

  it('an ASYNCHRONOUS stdin error fails pending work', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.stdin.emit('error', new Error('EPIPE: broken pipe'));

    await expect(call).rejects.toThrow(/stdin error: EPIPE/);
    await expect(client.request('turn/start', {})).rejects.toThrow(/unhealthy/);
  });

  it('a child process error marks the transport unhealthy, not merely failed-once', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emit('error', new Error('spawn ENOENT'));

    await expect(call).rejects.toThrow(/process error: spawn ENOENT/);
    // Previously the request rejected but the client still accepted more work.
    await expect(client.request('turn/start', {})).rejects.toThrow(/unhealthy/);
    expect(child.killed).toBe(true);
  });
});

describe('shutdown during initialization', () => {
  it('does not commit ready state when shutdown begins while initialize is in flight', async () => {
    // The handshake spans an await. Without a recheck, the late response sends
    // `initialized`, sets ready, and resolves start() for a connection teardown has
    // already decided to drop.
    const { client, child } = makeClient();
    const starting = client.start();
    await waitForWrites(child, 1);

    const shutting = client.shutdown();
    // The response arrives AFTER shutdown began.
    child.emitMessage({ id: child.written[0].id, result: initializeResult() });

    await expect(starting).rejects.toThrow(/initialization abandoned: shutdown began/);
    expect(client.isReady()).toBe(false);
    // `initialized` must never have been sent.
    expect(child.written.some((m) => m.method === 'initialized')).toBe(false);

    setImmediate(() => child.exit(0));
    await shutting;
    expect(client.getState()).toBe('stopped');
  });
});

describe('a writer fault during the handshake is not overwritten by success', () => {
  it('fails start() when the `initialized` write throws, and retains no stale result', async () => {
    // The initialize REQUEST succeeds; the pipe breaks before the `initialized`
    // notification can be written. The server therefore never sees the handshake
    // complete, so reporting ready would be a lie the manager cannot detect.
    const { client, child } = makeClient();
    let writes = 0;
    const passThrough = (child.stdin as unknown as { write: (c: unknown) => boolean }).write.bind(child.stdin);
    (child.stdin as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown): boolean => {
      writes += 1;
      if (writes === 2) throw new Error('EPIPE: broken pipe'); // the `initialized` write
      return passThrough(chunk);
    };

    const starting = client.start();
    await waitForWrites(child, 1);
    child.emitMessage({ id: child.written[0].id, result: initializeResult() });

    await expect(starting).rejects.toThrow(/initialization abandoned.*stdin write failed: EPIPE/s);
    expect(client.isReady()).toBe(false);
    expect(client.getState()).toBe('failed');
    // No half-completed handshake may be handed to a later caller.
    expect(client.getInitializeResult()).toBeNull();
    expect(child.written.some((m) => m.method === 'initialized')).toBe(false);
  });
});

describe('strict id and error-body handling', () => {
  it('treats a PRESENT but invalid id as corruption, not a notification', async () => {
    // `{"id":null,"method":"x"}` reclassified as a notification would leave the peer
    // waiting forever for a response nobody knows it owes.
    const { client, child, notifications } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitMessage({ id: null, method: 'item/tool/requestUserInput', params: {} });

    await expect(call).rejects.toThrow(/matched no legal JSON-RPC envelope/);
    expect(notifications).toHaveLength(0);
  });

  it('rejects an error response whose code is not numeric', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitMessage({ id: child.written[2].id, error: { code: 'oops', message: 'bad' } });
    await expect(call).rejects.toThrow(/matched no legal JSON-RPC envelope/);
  });

  it('does not coerce a STRING response id onto a numeric pending id', async () => {
    // We only mint numeric ids. Number("3") === 3 would let a foreign or malformed
    // response settle an unrelated request.
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);
    const numericId = child.written[2].id as number;

    child.emitMessage({ id: String(numericId), result: { impostor: true } });
    await tick();

    const settled = await Promise.race([call.then(() => 'settled'), tick().then(() => 'pending')]);
    expect(settled).toBe('pending');
    expect(client.isReady()).toBe(true); // a foreign id is ignored, not fatal

    child.emitMessage({ id: numericId, result: { genuine: true } });
    await expect(call).resolves.toEqual({ genuine: true });
  });
});

describe('a poisoned generation stops looking healthy immediately', () => {
  /** Start a client whose child lingers after kill(), so the dying window is real. */
  async function poisonedClient() {
    const children: FakeChild[] = [];
    const client = new CodexAppServerClient({
      env: { CODEX_HOME },
      expectedCodexHome: CODEX_HOME,
      clientVersion: '1.7.1',
      spawnChild: () => {
        const c = new FakeChild();
        c.autoExitOnKill = false; // lingers, like a real process after SIGTERM
        children.push(c);
        return c as never;
      },
    });
    const starting = client.start();
    for (let i = 0; i < 200 && children.length === 0; i++) await tick();
    await waitForWrites(children[0], 1);
    children[0].emitMessage({ id: children[0].written[0].id, result: initializeResult() });
    await starting;
    return { client, children };
  }

  it('isReady() is false the moment the generation is poisoned, before its exit lands', async () => {
    const { client, children } = await poisonedClient();
    expect(client.isReady()).toBe(true);

    const call = client.request('thread/start', {});
    await waitForWrites(children[0], 3);
    children[0].emitRaw('{not json\n'); // poison

    await expect(call).rejects.toThrow(/malformed JSON/);
    // The child has NOT exited yet — this is the window that used to report ready.
    expect(children[0].killed).toBe(true);
    expect(client.isReady()).toBe(false);
    expect(client.getState()).toBe('failed');
  });

  it('start() does not hand back the stale handshake of a dying generation', async () => {
    const { client, children } = await poisonedClient();
    children[0].emitRaw('{not json\n');
    await tick();

    // Previously this returned the old successful InitializeResponse.
    await expect(client.start()).rejects.toThrow(/generation is failing.*waiting for it to exit/s);
    // And no replacement was spawned while the first child is still alive.
    expect(children).toHaveLength(1);
  });

  it('restarts cleanly once the poisoned child finally exits', async () => {
    const { client, children } = await poisonedClient();
    children[0].emitRaw('{not json\n');
    await tick();
    await expect(client.start()).rejects.toThrow(/waiting for it to exit/);

    children[0].exit(null, 'SIGTERM'); // the lingering child finally goes
    await tick();

    const restart = client.start();
    for (let i = 0; i < 200 && children.length < 2; i++) await tick();
    await waitForWrites(children[1], 1);
    children[1].emitMessage({ id: children[1].written[0].id, result: initializeResult() });

    await expect(restart).resolves.toMatchObject({ codexHome: CODEX_HOME });
    expect(client.isReady()).toBe(true);
    expect(children).toHaveLength(2);
  });

  it('clears queued writes when input is unclassifiable, not just when a write fails', async () => {
    const { client, children } = await poisonedClient();
    const child = children[0];
    child.blockWrites();

    // Two writes while blocked: the FIRST is handed to the stream (which reports a
    // full buffer), the SECOND is still sitting in our queue awaiting 'drain'. Bytes
    // already passed to the pipe cannot be recalled — a real pipe behaves the same —
    // so the queued one is what must be dropped when the generation dies.
    const first = client.request('thread/start', { seq: 1 }).catch(() => 'rejected');
    const second = client.request('turn/start', { seq: 2 }).catch(() => 'rejected');
    await tick();
    const beforePoison = child.written.length;

    child.emitMessage({ neither: 'id nor method' });
    await tick();

    expect(await first).toBe('rejected');
    expect(await second).toBe('rejected');
    expect(client.isReady()).toBe(false);

    child.releaseWrites();
    await tick();

    // Exactly one line escaped — the one already given to the stream. The queued
    // second request was cleared and must not surface for a dead generation.
    expect(child.written.length).toBe(beforePoison + 1);
    expect(child.written.some((m) => m.params?.seq === 2)).toBe(false);
  });
});

describe('an unanswerable server request fails the connection', () => {
  it('poisons the generation when the response cannot be enqueued', async () => {
    // App Server blocks on its own request until answered; logging and continuing
    // leaves it waiting forever.
    const { client, child } = await startedClient({
      onServerRequest: async () => ({ result: { ok: true } }),
    });

    // The pipe breaks between the request arriving and our answer being written.
    (child.stdin as unknown as { write: () => boolean }).write = () => {
      throw new Error('EPIPE: broken pipe');
    };
    child.emitMessage({ id: 31, method: 'item/tool/requestUserInput', params: {} });
    await tick();
    await tick();

    expect(client.isReady()).toBe(false);
    await expect(client.request('thread/start', {})).rejects.toThrow(/unhealthy|failing/);
  });
});

describe('present-but-invalid method and non-integer error codes', () => {
  it('rejects {"id":1,"method":null,"result":{}} instead of reading it as a response', async () => {
    // Treating a present non-string method as absent promoted this to a valid
    // response and settled a pending request from an envelope we do not understand.
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitMessage({ id: child.written[2].id, method: null, result: { sneaky: true } });
    await expect(call).rejects.toThrow(/matched no legal JSON-RPC envelope/);
  });

  it('rejects a present non-string method on a notification-shaped message', async () => {
    const { client, child, notifications } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitMessage({ method: 42, params: {} });
    await expect(call).rejects.toThrow(/matched no legal JSON-RPC envelope/);
    expect(notifications).toHaveLength(0);
  });

  it('rejects a non-INTEGER error code', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitMessage({ id: child.written[2].id, error: { code: 1.5, message: 'fractional' } });
    await expect(call).rejects.toThrow(/matched no legal JSON-RPC envelope/);
  });

  it('still accepts a legal negative integer error code', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/start', {});
    await waitForWrites(child, 3);

    child.emitMessage({ id: child.written[2].id, error: { code: -32602, message: 'bad params' } });
    await expect(call).rejects.toThrow(/thread\/start failed: bad params/);
  });
});

describe('shutdown', () => {
  it('closes stdin and resolves when the child exits', async () => {
    const { client, child } = await startedClient();
    const stdinEnded = new Promise<void>((resolve) => child.stdin.once('finish', () => resolve()));

    const exits: Array<{ expected: boolean }> = [];
    (client as unknown as { options: { onExit?: (i: { expected: boolean }) => void } }).options.onExit =
      (info) => exits.push({ expected: info.expected });

    const shutting = client.shutdown();
    setImmediate(() => child.exit(0));
    await shutting;
    await stdinEnded;

    expect(client.getState()).toBe('stopped');
    expect(exits).toEqual([{ expected: true }]);
  });

  it('terminates a child that outlives its grace period', async () => {
    vi.useFakeTimers();
    try {
      const { client, child } = makeClient();
      const starting = client.start();
      await vi.advanceTimersByTimeAsync(0);
      child.emitMessage({ id: child.written[0].id, result: initializeResult() });
      await starting;

      const shutting = client.shutdown();
      await vi.advanceTimersByTimeAsync(5_000 + 2_000 + 2_000);
      await shutting;

      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is safe to call when nothing is running', async () => {
    const { client } = makeClient();
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(client.getState()).toBe('stopped');
  });
});

describe('a failed request says how far it got', () => {
  // `turn/start` has SIDE EFFECTS, so the caller's recovery turns entirely on this
  // distinction: a request that provably never left the process can be abandoned, but
  // one that may have been carried out can neither be replayed nor forgotten.

  it('a TIMEOUT is unknown: the server may have acted on it', async () => {
    vi.useFakeTimers();
    try {
      const { client, child } = makeClient();
      const starting = client.start();
      await vi.advanceTimersByTimeAsync(0);
      child.emitMessage({ id: child.written[0].id, result: initializeResult() });
      await starting;

      const call = client.request('turn/start', {}, 1_000).catch((err) => err as Error);
      await vi.advanceTimersByTimeAsync(1_001);

      const err = (await call) as Error;
      expect(err.message).toMatch(/timed out after 1000ms/);
      expect(requestDeliveryOf(err)).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ERROR RESPONSE is refused: the server saw it and declined', async () => {
    const { client, child } = await startedClient();
    const call = client.request('thread/resume', {}).catch((err) => err as Error);
    await waitForWrites(child, 3);
    child.emitMessage({ id: child.written[2].id, error: { code: -32000, message: 'no rollout found' } });

    const err = (await call) as Error;
    // The message shape is load-bearing: isStaleThreadError() reads it.
    expect(err.message).toBe('thread/resume failed: no rollout found');
    expect(requestDeliveryOf(err)).toBe('refused');
  });

  it('a pre-flight refusal is not-sent: nothing was ever enqueued', async () => {
    const { client } = makeClient();
    const err = (await client.request('turn/start', {}).catch((e) => e)) as Error;
    expect(err.message).toMatch(/not running/);
    expect(requestDeliveryOf(err)).toBe('not-sent');
  });

  it('an over-budget outbound queue is not-sent: send() throws before queueing', async () => {
    const { client, child } = await startedClient({ maxQueuedWriteBytes: 200 });
    child.blockWrites();

    const held = client.request('thread/start', { pad: 'x'.repeat(50) }).catch((e) => e as Error);
    const overflowed = (await client.request('turn/start', { pad: 'y'.repeat(400) }).catch((e) => e)) as Error;

    expect(overflowed.message).toMatch(/outbound queue is full/);
    expect(requestDeliveryOf(overflowed)).toBe('not-sent');
    child.releaseWrites();
    void held;
  });

  it('a request in flight when the child exits is unknown, not not-sent', async () => {
    // The line may well have been written and acted on before the process died.
    const { client, child } = await startedClient();
    const call = client.request('turn/start', {}).catch((e) => e as Error);
    await waitForWrites(child, 3);

    child.exit(1, null);
    const err = (await call) as Error;
    expect(requestDeliveryOf(err)).toBe('unknown');
  });

  it('anything unrecognized is treated as unknown', () => {
    // Fail closed: an untagged failure at a side-effecting boundary is exactly where
    // assuming "it never happened" is unsafe.
    expect(requestDeliveryOf(new Error('something else'))).toBe('unknown');
    expect(requestDeliveryOf('not even an error')).toBe('unknown');
  });
});

describe('quarantine: discard a connection whose turn may still be running', () => {
  /** A started client whose child lingers after SIGTERM, like a real process can. */
  async function lingeringClient(overrides: Partial<CodexAppServerClientOptions> = {}) {
    const children: FakeChild[] = [];
    const client = new CodexAppServerClient({
      env: { CODEX_HOME },
      expectedCodexHome: CODEX_HOME,
      clientVersion: '1.7.1',
      quarantineExitWaitMs: 20,
      spawnChild: () => {
        const c = new FakeChild();
        c.autoExitOnKill = false;
        children.push(c);
        return c as never;
      },
      ...overrides,
    });
    const starting = client.start();
    for (let i = 0; i < 200 && children.length === 0; i++) await tick();
    await waitForWrites(children[0], 1);
    children[0].emitMessage({ id: children[0].written[0].id, result: initializeResult() });
    await starting;
    return { client, children };
  }

  it('poisons the generation, kills the child and waits for its exit', async () => {
    const { client, child } = await startedClient(); // autoExitOnKill: exits promptly

    const quarantined = await client.quarantine('turn/start outcome unknown');

    expect(quarantined).toBe(true);
    expect(child.killed).toBe(true);
    expect(client.isReady()).toBe(false);
    // The exit was awaited, so the generation is already gone — not merely dying.
    expect(client.getState()).toBe('exited');
  });

  it('rejects the connection\'s other in-flight requests through the same path', async () => {
    const { client, child } = await startedClient();
    const other = client.request('thread/start', {}).catch((e) => e as Error);
    await waitForWrites(child, 3);

    await client.quarantine('turn/start outcome unknown');

    expect(((await other) as Error).message).toMatch(/turn\/start outcome unknown|exited/);
  });

  it('does NOT start a replacement while the quarantined child is still alive', async () => {
    // Two children would both own the pipes, and the dying one may still be running
    // the turn we could not account for.
    const { client, children } = await lingeringClient();

    const quarantined = await client.quarantine('turn/start outcome unknown');

    expect(quarantined).toBe(false); // survived SIGTERM and SIGKILL
    expect(children[0].killSignals).toEqual([undefined, 'SIGKILL']);
    await expect(client.start()).rejects.toThrow(/generation is failing.*waiting for it to exit/s);
    expect(children).toHaveLength(1);
  });

  it('escalates to SIGKILL and reports success when that lands', async () => {
    const { client, children } = await lingeringClient();
    children[0].exitOnSigkill = true;

    await expect(client.quarantine('turn/start outcome unknown')).resolves.toBe(true);
    expect(children[0].killSignals).toEqual([undefined, 'SIGKILL']);
  });

  it('a replacement starts cleanly once the quarantined child has exited', async () => {
    const { client, children } = await lingeringClient();
    children[0].exitOnSigkill = true;
    await client.quarantine('turn/start outcome unknown');

    const restart = client.start();
    for (let i = 0; i < 200 && children.length < 2; i++) await tick();
    await waitForWrites(children[1], 1);
    children[1].emitMessage({ id: children[1].written[0].id, result: initializeResult() });

    await expect(restart).resolves.toMatchObject({ codexHome: CODEX_HOME });
    expect(client.isReady()).toBe(true);
  });

  it('is a no-op when the child is already gone', async () => {
    const { client, child } = await startedClient();
    child.exit(0, null);
    await tick();

    await expect(client.quarantine('turn/start outcome unknown')).resolves.toBe(true);
  });
});

describe('a fatal notification follows the same lifecycle as protocol corruption', () => {
  /** A client whose sink rejects one method, and whose child lingers after SIGTERM. */
  async function faultingClient() {
    const children: FakeChild[] = [];
    const client = new CodexAppServerClient({
      env: { CODEX_HOME },
      expectedCodexHome: CODEX_HOME,
      clientVersion: '1.7.1',
      spawnChild: () => {
        const c = new FakeChild();
        c.autoExitOnKill = false; // lingers, like a real process after SIGTERM
        children.push(c);
        return c as never;
      },
      onNotification: (n) => { if (n.method === 'turn/completed') throw new Error('unknown turn status "weird"'); },
    });
    const starting = client.start();
    for (let i = 0; i < 200 && children.length === 0; i++) await tick();
    await waitForWrites(children[0], 1);
    children[0].emitMessage({ id: children[0].written[0].id, result: initializeResult() });
    await starting;
    return { client, children };
  }

  it('rejects in-flight requests and clears queued writes through the central path', async () => {
    const { client, children } = await faultingClient();
    const child = children[0];
    child.blockWrites();

    const first = client.request('thread/start', { seq: 1 }).catch((e) => e);
    const second = client.request('turn/start', { seq: 2 }).catch((e) => e);
    await tick();
    const beforeFault = child.written.length;

    child.emitMessage({ method: 'turn/completed', params: { turn: { id: 't1', status: 'weird' } } });
    await tick();

    expect(((await first) as Error).message).toMatch(/unknown turn status/);
    expect(((await second) as Error).message).toMatch(/unknown turn status/);
    expect(client.isReady()).toBe(false);
    expect(client.getState()).toBe('failed');

    // Only the line already handed to the pipe escaped; the queued one was dropped.
    child.releaseWrites();
    await tick();
    expect(child.written.length).toBe(beforeFault + 1);
  });

  it('waits for the old child to exit before a replacement starts', async () => {
    const { client, children } = await faultingClient();
    children[0].emitMessage({ method: 'turn/completed', params: { turn: { id: 't1', status: 'weird' } } });
    await tick();

    expect(children[0].killed).toBe(true);
    await expect(client.start()).rejects.toThrow(/generation is failing.*waiting for it to exit/s);
    expect(children).toHaveLength(1);

    children[0].exit(null, 'SIGTERM');
    await tick();

    const restart = client.start();
    for (let i = 0; i < 200 && children.length < 2; i++) await tick();
    await waitForWrites(children[1], 1);
    children[1].emitMessage({ id: children[1].written[0].id, result: initializeResult() });

    await expect(restart).resolves.toMatchObject({ codexHome: CODEX_HOME });
    expect(client.isReady()).toBe(true);
  });
});

describe('failProtocol', () => {
  it('marks the generation unhealthy SYNCHRONOUSLY, before returning to the caller', async () => {
    // The sink layer calls this before it notifies anybody, so that no failure
    // callback can look at the connection, see `ready`, and start work on a child
    // that is being killed. That only holds if the demotion is not deferred.
    const { client, child } = await startedClient();
    expect(client.isReady()).toBe(true);

    client.failProtocol('turn/completed: turn identity is unusable or self-contradictory');

    expect(client.isReady()).toBe(false);
    expect(client.getState()).toBe('failed');
    expect(child.killed).toBe(true);
  });

  it('rejects in-flight requests and is safe to call twice', async () => {
    // The throw that follows it unwinds into handleLine, which fails the generation
    // again — so a second call must be a no-op, not a second round of rejections.
    const { client, child } = await startedClient();
    const inFlight = client.request('thread/start', {}).catch((e) => e);
    await waitForWrites(child, 3);

    client.failProtocol('unknown turn status "weird"');
    client.failProtocol('unknown turn status "weird"');

    expect(((await inFlight) as Error).message).toMatch(/unknown turn status "weird"/);
    expect(client.isReady()).toBe(false);
  });

  it('is a no-op when no child is running', async () => {
    const { client } = makeClient();
    expect(() => client.failProtocol('nothing to poison')).not.toThrow();
  });
});
