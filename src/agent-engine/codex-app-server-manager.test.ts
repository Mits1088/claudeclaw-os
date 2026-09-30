// Manager: notification routing and per-thread turn serialization.
//
// The routing tests exist because a live end-to-end run caught what unit tests had
// not: `turn/started` and `turn/completed` carry the turn id INSIDE `turn`, with no
// top-level `turnId`. Matching on turnId alone silently dropped every terminal event
// once a sink was bound, so the turn spun until the child exited.

import fs from 'fs';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  AbortError,
  CodexAppServerManager,
  CodexProtocolFault,
  executableIdentity,
  type ManagerOptions,
  type TurnSink,
} from './codex-app-server-manager.js';
import { SERVER_REQUEST_METHODS } from './codex-app-server-protocol.js';
import type { JsonRpcNotification, JsonRpcRequest } from './codex-app-server-protocol.js';

/**
 * Retirement drain grace for these suites.
 *
 * Production waits a minute for the turns already running to finish. A unit test mostly
 * wants the FORCED end of that wait — where a turn that will not drain gets its one
 * explicit transport failure — so the grace is short everywhere except the tests that
 * are specifically about draining successfully.
 */
const TEST_DRAIN_MS = 20;

/** A fake client whose notification hook the manager wires up at construction. */
class FakeClient {
  notify!: (n: JsonRpcNotification) => void;
  /** The server-request handler the manager registers at construction. */
  serverRequest!: (request: JsonRpcRequest) => Promise<
    { result: unknown } | { error: { code: number; message: string; data?: unknown } }
  >;
  /** The manager's exit hook, so a test can fire the exit that follows every teardown. */
  exit: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void = () => {};
  started = 0;
  shutdowns = 0;
  quarantined: string[] = [];
  /** What quarantine() reports: false stands for a child that could not be killed. */
  quarantineResult = true;
  /** Reasons the generation was poisoned, and whether it still looks usable. */
  poisoned: string[] = [];
  healthy = true;
  /**
   * Test knob: a child that ignores the orderly shutdown, so only the forced path gets
   * rid of it. This is the case a rotation must not publish a replacement into.
   */
  lingers = false;
  private childAlive = true;

  /**
   * `trace` records the lifecycle across every client in one test, which is how the
   * ordering that matters — the old child exits BEFORE the replacement is built — can be
   * asserted rather than inferred.
   */
  constructor(private readonly trace: string[] = [], private readonly label = 'child') {
    trace.push(`${label}:built`);
  }

  async start(): Promise<unknown> { this.started += 1; return {}; }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
    if (this.lingers) return;
    this.childAlive = false;
    this.trace.push(`${this.label}:exited`);
  }

  hasLiveChild(): boolean { return this.childAlive; }

  async quarantine(reason: string): Promise<boolean> {
    this.quarantined.push(reason);
    this.healthy = false;
    if (this.quarantineResult) {
      this.childAlive = false;
      this.trace.push(`${this.label}:killed`);
    }
    return this.quarantineResult;
  }

  failProtocol(reason: string): void {
    this.poisoned.push(reason);
    this.healthy = false;
  }
}

/** Wire a fake client into a manager exactly as the real client would be wired. */
function wire(client: FakeClient): NonNullable<ManagerOptions['createClient']> {
  return (options) => {
    client.notify = options.onNotification!;
    client.serverRequest = options.onServerRequest! as never;
    if (options.onExit) client.exit = options.onExit;
    return client as never;
  };
}

function makeManager(): { manager: CodexAppServerManager; client: FakeClient } {
  const client = new FakeClient();
  const manager = new CodexAppServerManager({
    env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
    expectedCodexHome: '/tmp/home',
    clientVersion: '1.7.1',
    rotationDrainMs: TEST_DRAIN_MS,
    createClient: (options) => {
      client.notify = options.onNotification!;
      return client as never;
    },
  });
  return { manager, client };
}

type Recording = TurnSink & { seen: string[]; params: Array<Record<string, unknown> | undefined> };

function recordingSink(threadId: string, turnId: string | null = null): Recording {
  const sink = {
    threadId,
    turnId,
    seen: [] as string[],
    params: [] as Array<Record<string, unknown> | undefined>,
    deliver(n: JsonRpcNotification) {
      this.seen.push(n.method);
      this.params.push(n.params as Record<string, unknown> | undefined);
    },
  };
  return sink as Recording;
}

beforeEach(() => vi.clearAllMocks());

describe('notification routing', () => {
  it('delivers a terminal whose id is NESTED to the sink already bound to that turn', async () => {
    // The regression: turn/completed has no top-level turnId, so a bound sink used to
    // match nothing and the terminal event was dropped.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1');
    manager.addSink(sink);

    client.notify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } } });
    sink.turnId = 't1'; // the adapter binds on turn/started
    client.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } } });

    expect(sink.seen).toEqual(['turn/started', 'turn/completed']);
  });

  it('routes turnId-bearing notifications to the matching sink', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const a = recordingSink('thread-1', 't1');
    const b = recordingSink('thread-2', 't2');
    manager.addSink(a);
    manager.addSink(b);

    client.notify({ method: 'item/started', params: { threadId: 'thread-1', turnId: 't1', item: {} } });
    client.notify({ method: 'item/started', params: { threadId: 'thread-2', turnId: 't2', item: {} } });

    expect(a.seen).toEqual(['item/started']);
    expect(b.seen).toEqual(['item/started']);
  });

  it('BINDS a provisional sink on turn/started, so the items that follow match it', async () => {
    // The sink is registered before turn/start is sent precisely so nothing is lost
    // while the response is in flight. `turn/started` is what claims it for a turn,
    // and the manager does the binding itself — routing must not depend on what a
    // sink chooses to do with the notification.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', null);
    manager.addSink(sink);

    client.notify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } } });
    expect(sink.turnId).toBe('t1');

    client.notify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 't1', delta: 'hi' } });
    expect(sink.seen).toEqual(['turn/started', 'item/agentMessage/delta']);
  });

  it('routes turn/completed by params.turn.id, not by falling back to the thread', async () => {
    // The terminal carries its id INSIDE `turn` and no top-level turnId. Reading only
    // the top-level field made every terminal look thread-scoped, so it landed on
    // whichever sink held the thread rather than on the turn that actually ended.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    client.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } } });
    expect(sink.seen).toEqual(['turn/completed']);
  });

  it('delivers thread/compacted and thread/tokenUsage/updated to the sink bound to their turn', async () => {
    // Their names say thread, their 0.144.6 types say turnId. A second sink on another
    // thread proves the turn id is what places them, not the method name.
    const { manager, client } = makeManager();
    await manager.ready();
    const mine = recordingSink('thread-1', 't1');
    const other = recordingSink('thread-2', 't2');
    manager.addSink(mine);
    manager.addSink(other);

    client.notify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 't1', tokenUsage: {} } });
    client.notify({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 't1' } });

    expect(mine.seen).toEqual(['thread/tokenUsage/updated', 'thread/compacted']);
    expect(other.seen).toEqual([]);
    expect(client.poisoned).toEqual([]);
  });
});

describe('an abandoned turn cannot bleed into another invocation', () => {
  // The uncertain-turn/start case: a turn ClaudeClaw stopped listening to may still be
  // running, and a connection being wound down produces exactly these. They are
  // WELL-FORMED — the only thing wrong with them is that nobody owns the turn — so
  // each is dropped without a thread fallback, and none of them kills the connection.

  it('a late terminal for a retired turn never reaches the invocation that follows it', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const abandoned = recordingSink('thread-1', 't1');
    manager.addSink(abandoned);
    manager.removeSink(abandoned); // its invocation gave up on the turn

    const next = recordingSink('thread-1', null); // a new invocation takes the thread
    manager.addSink(next);
    expect(() => client.notify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } },
    })).not.toThrow();

    expect(next.seen).toEqual([]);
    expect(next.turnId).toBeNull();
    expect(client.poisoned).toEqual([]);
  });

  it('late item and delta notifications for a retired turn are dropped too', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const next = recordingSink('thread-1', 't2');
    manager.addSink(next);

    expect(() => {
      client.notify({ method: 'item/started', params: { threadId: 'thread-1', turnId: 't1', item: {} } });
      client.notify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 't1', delta: 'leak' } });
      client.notify({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 't1', item: {} } });
    }).not.toThrow();

    expect(next.seen).toEqual([]);
    expect(client.poisoned).toEqual([]);
  });

  it('a late turn/started cannot re-bind a sink that already owns a turn', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't2');
    manager.addSink(sink);

    expect(() => client.notify({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } },
    })).not.toThrow();

    expect(sink.turnId).toBe('t2');
    expect(sink.seen).toEqual([]);
    expect(client.poisoned).toEqual([]);
  });

  it('a late compaction or token report for a retired turn is dropped, not reattributed', async () => {
    // Well-formed and turn-scoped: the only thing wrong with it is that the turn it
    // names is gone. It must not fall back to the thread and land on the turn running
    // there now, and it must not take the connection down either.
    const { manager, client } = makeManager();
    await manager.ready();
    const next = recordingSink('thread-1', 't2');
    manager.addSink(next);

    expect(() => {
      client.notify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 't1', tokenUsage: {} } });
      client.notify({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 't1' } });
    }).not.toThrow();

    expect(next.seen).toEqual([]);
    expect(client.poisoned).toEqual([]);
  });

  it('a notification for a thread with NO sink is dropped quietly', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify({
      method: 'turn/completed',
      params: { threadId: 'other-thread', turn: { id: 'tX', status: 'completed' } },
    })).not.toThrow();
    expect(sink.seen).toEqual([]);
    expect(client.poisoned).toEqual([]);
  });
});

describe('a notification we cannot ROUTE is a protocol fault', () => {
  // Not "nobody owns this turn" — that is above. This is identity that is missing or
  // self-contradictory on a method whose 0.144.6 shape guarantees it, which means we
  // can no longer trust that we are seeing every terminal event.

  it('a terminal whose top-level and nested turn ids DISAGREE is fatal', async () => {
    // Two ids naming two different turns. Picking either one can end a turn that is
    // still running, and there is no third option that leaves the connection sound.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turnId: 't1', turn: { id: 't2', status: 'completed' } },
    })).toThrow(/unusable or self-contradictory/);
    expect(sink.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it.each([
    ['no id at all', { threadId: 'thread-1', turn: { status: 'completed' } }],
    ['an empty id', { threadId: 'thread-1', turn: { id: '', status: 'completed' } }],
    ['a turn that is not an object', { threadId: 'thread-1', turn: 'not an object' }],
  ])('a terminal with %s is fatal', async (_label, params) => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify({ method: 'turn/completed', params })).toThrow(CodexProtocolFault);
    expect(sink.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it('a consumed notification whose top-level turnId is present but unusable is fatal', async () => {
    // Reading it as "no turn id" would demote the notification to thread-scoped
    // routing and hand it to whoever holds the thread.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 7, item: {} },
    })).toThrow(CodexProtocolFault);
    expect(sink.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it.each([
    'turn/started',
    'turn/completed',
    'thread/compacted',
    'thread/tokenUsage/updated',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
  ])('%s without the top-level threadId its 0.144.6 shape requires is fatal', async (method) => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify({ method, params: { turn: { id: 't1', status: 'completed' } } }))
      .toThrow(/arrived without the threadId its schema requires/);
    expect(sink.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it.each([
    'turn/started',
    'turn/completed',
    'turn/plan/updated',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
    'thread/compacted',
    'thread/tokenUsage/updated',
  ])('%s without the turn id its 0.144.6 shape requires is fatal', async (method) => {
    // All eight are turn-scoped, the two thread/* ones included. Routing any of them
    // by thread alone is how one turn's output ends up attributed to another.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify({ method, params: { threadId: 'thread-1' } }))
      .toThrow(/arrived without the turn id its schema requires/);
    expect(sink.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it('thread/started is NOT consumed, so its params.thread.id shape is nonfatal', async () => {
    // It identifies its thread as `params.thread.id`, not a top-level threadId, and
    // the adapter does not act on it. Listing it would demand a routing identity it
    // does not have and make every one of them fatal.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify({ method: 'thread/started', params: { thread: { id: 'thread-1' } } })).not.toThrow();
    expect(sink.seen).toEqual([]);
    expect(client.poisoned).toEqual([]);
  });

});

describe('a protocol fault poisons the transport BEFORE it tells anyone', () => {
  /** A fatal payload: turn/completed whose two ids name different turns. */
  const CONTRADICTORY = {
    method: 'turn/completed',
    params: { threadId: 'thread-1', turnId: 't1', turn: { id: 't2', status: 'completed' } },
  };

  it('the generation is already unhealthy when the first sink callback runs', async () => {
    // Otherwise a callback can look at the connection, see `ready`, and start work on
    // a child that is being killed.
    const { manager, client } = makeManager();
    await manager.ready();
    let healthyWhenTold: boolean | null = null;
    manager.addSink({
      threadId: 'thread-1',
      turnId: 't1',
      deliver: () => { healthyWhenTold = client.healthy; },
    });

    expect(() => client.notify(CONTRADICTORY)).toThrow(CodexProtocolFault);

    expect(healthyWhenTold).toBe(false);
    expect(client.poisoned).toHaveLength(1);
  });

  it('a sink registered by a failure callback does not join the round that caused it', async () => {
    // The registry is snapshotted AND cleared before the first callback, so a callback
    // adding a sink cannot extend the iteration it is running inside.
    const { manager, client } = makeManager();
    await manager.ready();
    const latecomer = recordingSink('thread-2', 't2');
    manager.addSink({
      threadId: 'thread-1',
      turnId: 't1',
      deliver: () => { manager.addSink(latecomer); },
    });

    expect(() => client.notify(CONTRADICTORY)).toThrow(CodexProtocolFault);
    expect(latecomer.seen).toEqual([]);
  });

  it('a sink removed by another sink\'s callback is still told', async () => {
    // Snapshot semantics cut both ways: the set of turns to notify is fixed before
    // any of them runs, so one callback cannot silence another.
    const { manager, client } = makeManager();
    await manager.ready();
    const other = recordingSink('thread-2', 't2');
    manager.addSink({
      threadId: 'thread-1',
      turnId: 't1',
      deliver: () => { manager.removeSink(other); },
    });
    manager.addSink(other);

    expect(() => client.notify(CONTRADICTORY)).toThrow(CodexProtocolFault);
    expect(other.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it('tells each sink exactly once even though the fault and the exit both fire', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => client.notify(CONTRADICTORY)).toThrow(CodexProtocolFault);
    await manager.shutdown(); // stands in for the child exit that follows

    expect(sink.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it('a second fault raised from inside a failure callback finds nothing left to tell', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const other = recordingSink('thread-2', 't2');
    manager.addSink({
      threadId: 'thread-1',
      turnId: 't1',
      deliver: () => {
        // Re-entering route() during teardown must not re-notify the snapshot.
        try { client.notify(CONTRADICTORY); } catch { /* expected */ }
      },
    });
    manager.addSink(other);

    expect(() => client.notify(CONTRADICTORY)).toThrow(CodexProtocolFault);
    expect(other.seen).toEqual(['claudeclaw/transportFailed']);
  });
});

describe('notification routing: everything else', () => {
  it('ignores notifications for unknown or removed threads', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);
    manager.removeSink(sink);

    client.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } } });
    client.notify({ method: 'item/started', params: { threadId: 'other', turnId: 'x', item: {} } });
    expect(sink.seen).toEqual([]);
  });

  it('ignores a notification with no threadId instead of guessing', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    client.notify({ method: 'remoteControl/status/changed', params: {} });
    expect(sink.seen).toEqual([]);
  });

  it('a sink that REJECTS a notification fails the connection, and every other sink is told', async () => {
    // The old behaviour logged the exception and read on, so a terminal the sink could
    // not parse simply vanished and its turn waited forever.
    const { manager, client } = makeManager();
    await manager.ready();
    const bad: TurnSink = {
      threadId: 'thread-1',
      turnId: 't1',
      deliver: (n) => { if (n.method !== 'claudeclaw/transportFailed') throw new Error('unknown turn status "weird"'); },
    };
    const good = recordingSink('thread-2', 't2');
    manager.addSink(bad);
    manager.addSink(good);

    expect(() => client.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } } }))
      .toThrow(/could not be consumed: unknown turn status/);

    // Every ACTIVE turn on the connection is told, not just the one that choked.
    expect(good.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it('a sink that throws while being TOLD about the failure does not silence the others', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const alwaysThrows: TurnSink = { threadId: 'thread-1', turnId: 't1', deliver: () => { throw new Error('sink exploded'); } };
    const good = recordingSink('thread-2', 't2');
    manager.addSink(alwaysThrows);
    manager.addSink(good);

    expect(() => client.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } } }))
      .toThrow(CodexProtocolFault);
    expect(good.seen).toEqual(['claudeclaw/transportFailed']);
  });

  it('a well-formed notification we IGNORE stays nonfatal, whatever shape it is in', async () => {
    // Nothing outside CONSUMED_NOTIFICATIONS may take the connection down: a new or
    // unsolicited method turning up is normal traffic, not corruption.
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    expect(() => {
      client.notify({ method: 'remoteControl/status/changed', params: { threadId: 'thread-1', turnId: 99 } });
      client.notify({ method: 'account/rateLimits/updated', params: { threadId: 'thread-1', turn: { id: '' } } });
      client.notify({ method: 'something/new', params: { threadId: 'thread-1', turnId: 'nobody-owns-this' } });
    }).not.toThrow();
    expect(sink.seen).toEqual([]);
  });

  it('tells every sink when the transport dies so no turn hangs', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    const sink = recordingSink('thread-1', 't1');
    manager.addSink(sink);

    // The client reports the child exiting through the manager's onExit hook.
    await manager.shutdown();
    client.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } } });
    expect(sink.seen).not.toContain('turn/completed'); // sinks cleared on shutdown
  });
});

describe('quarantine', () => {
  it('delegates to the live client and reports whether it can be replaced', async () => {
    const { manager, client } = makeManager();
    await manager.ready();

    await expect(manager.quarantine('turn/start outcome unknown')).resolves.toBe(true);
    expect(client.quarantined).toEqual(['turn/start outcome unknown']);

    client.quarantineResult = false; // the child could not be killed
    await expect(manager.quarantine('again')).resolves.toBe(false);
  });

  it('is a no-op before any child exists', async () => {
    const { manager, client } = makeManager();
    await expect(manager.quarantine('nothing running')).resolves.toBe(true);
    expect(client.quarantined).toEqual([]);
  });
});

describe('per-thread turn serialization', () => {
  it('serializes turns on ONE thread in FIFO order', async () => {
    const { manager } = makeManager();
    const order: string[] = [];

    const first = await manager.acquireThreadLock('thread-1');
    const second = manager.acquireThreadLock('thread-1').then((release) => { order.push('second'); return release; });
    const third = manager.acquireThreadLock('thread-1').then((release) => { order.push('third'); return release; });

    order.push('first');
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('runs DIFFERENT threads in parallel', async () => {
    // Missions, war-room agents and independent chats must not queue behind each other.
    const { manager } = makeManager();
    const a = await manager.acquireThreadLock('thread-a');
    const b = await manager.acquireThreadLock('thread-b');
    expect(manager.activeThreadCount()).toBe(2);
    a();
    b();
  });

  it('removes a caller aborted WHILE QUEUED without ever starting its turn', async () => {
    // No request is sent, so there is nothing to interrupt and nothing to replay.
    const { manager } = makeManager();
    const held = await manager.acquireThreadLock('thread-1');
    const abort = new AbortController();
    const queued = manager.acquireThreadLock('thread-1', abort.signal);

    abort.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortError);

    // The lock is still usable by the next caller.
    held();
    const next = await manager.acquireThreadLock('thread-1');
    next();
  });

  it('refuses to queue a caller whose signal is ALREADY aborted', async () => {
    const { manager } = makeManager();
    const abort = new AbortController();
    abort.abort();
    await expect(manager.acquireThreadLock('thread-1', abort.signal)).rejects.toBeInstanceOf(AbortError);
  });

  it('hands the lock to the next waiter when the holder releases', async () => {
    const { manager } = makeManager();
    const first = await manager.acquireThreadLock('thread-1');
    let secondAcquired = false;
    const second = manager.acquireThreadLock('thread-1').then((r) => { secondAcquired = true; return r; });

    expect(secondAcquired).toBe(false);
    first();
    (await second)();
    expect(secondAcquired).toBe(true);
  });
});

describe('one warm child per process', () => {
  it('starts the client once across repeated ready() calls', async () => {
    const { manager, client } = makeManager();
    await manager.ready();
    await manager.ready();
    await manager.ready();
    // start() is idempotent inside the client; the manager must not build a second.
    expect(client.started).toBe(3);
  });

  it('reuses the shared instance for an unchanged launch environment', async () => {
    await CodexAppServerManager.resetShared();
    const options = {
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      createClient: () => new FakeClient() as never,
    };
    const a = await CodexAppServerManager.shared(options);
    const b = await CodexAppServerManager.shared({ ...options });
    expect(b).toBe(a);
    await CodexAppServerManager.resetShared();
  });

  it('replaces the instance when a LAUNCH-CRITICAL value changes', async () => {
    // A running child cannot adopt a new CODEX_HOME or credential, so the alternative
    // to replacing it is running turns under an environment they were not built for.
    await CodexAppServerManager.resetShared();
    const base = {
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      createClient: () => new FakeClient() as never,
    };
    const a = await CodexAppServerManager.shared(base);
    const b = await CodexAppServerManager.shared({ ...base, expectedCodexHome: '/tmp/other', env: { ...base.env, CODEX_HOME: '/tmp/other' } });
    expect(b).not.toBe(a);

    const c = await CodexAppServerManager.shared({ ...base, env: { ...base.env, OPENAI_API_KEY: 'sk-x' } });
    expect(c).not.toBe(b); // the credential is part of the fingerprint

    // And a DIFFERENT key is a different launch environment, not merely the same
    // "api-key mode" again. Tracking presence alone reused a child holding the old one.
    const d = await CodexAppServerManager.shared({ ...base, env: { ...base.env, OPENAI_API_KEY: 'sk-y' } });
    expect(d).not.toBe(c);
    await CodexAppServerManager.resetShared();
  });
});

describe('server-initiated requests', () => {
  // App Server BLOCKS on its own request until something answers, so every path here
  // has to produce exactly one schema-valid response. The shapes are transcribed from
  // the pinned 0.144.6 generated types, not invented.

  /** A manager whose client exposes the handler the client would have been given. */
  function makeAsking(overrides: Partial<ConstructorParameters<typeof CodexAppServerManager>[0]> = {}) {
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      askUserQuestionTimeoutMs: 50,
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
      ...overrides,
    });
    return { manager, client };
  }

  const question = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
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

  function askingSink(threadId: string, turnId: string | null, answer: Record<string, string[]> | null) {
    const sink = recordingSink(threadId, turnId) as Recording & { asked: number };
    sink.asked = 0;
    sink.askUserQuestion = async () => { sink.asked += 1; return answer; };
    return sink;
  }

  it('reaches the resolver of the exact turn and returns its answer', async () => {
    const { manager, client } = makeAsking();
    await manager.ready();
    const mine = askingSink('thread-1', 't1', { q1: ['A'] });
    const other = askingSink('thread-1', 't2', { q1: ['B'] });
    manager.addSink(mine);
    manager.addSink(other);

    const response = await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params: question() });

    expect(response).toEqual({ result: { answers: { q1: { answers: ['A'] } } } });
    expect(mine.asked).toBe(1);
    expect(other.asked).toBe(0);
  });

  it('a question for one turn cannot reach another turn\'s resolver', async () => {
    const { manager, client } = makeAsking();
    await manager.ready();
    const other = askingSink('thread-1', 't2', { q1: ['B'] });
    manager.addSink(other);

    const response = await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params: question() });

    expect(response).toEqual({ result: { answers: {} } });
    expect(other.asked).toBe(0);
  });

  it('a question for a RETIRED turn declines without falling back', async () => {
    const { manager, client } = makeAsking();
    await manager.ready();
    const retired = askingSink('thread-1', 't1', { q1: ['A'] });
    manager.addSink(retired);
    manager.removeSink(retired);
    manager.addSink(askingSink('thread-1', 't9', { q1: ['B'] })); // the thread's new owner

    const response = await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params: question() });
    expect(response).toEqual({ result: { answers: {} } });
    expect(retired.asked).toBe(0);
  });

  it('a turn with NO interactive resolver declines', async () => {
    const { manager, client } = makeAsking();
    await manager.ready();
    manager.addSink(recordingSink('thread-1', 't1')); // no askUserQuestion

    const response = await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params: question() });
    expect(response).toEqual({ result: { answers: {} } });
  });

  it('a resolver that declines, throws, or never answers all produce the same decline', async () => {
    const { manager, client } = makeAsking();
    await manager.ready();

    const declining = askingSink('thread-1', 'a', null);
    const throwing = recordingSink('thread-1', 'b') as Recording;
    throwing.askUserQuestion = async () => { throw new Error('resolver exploded'); };
    const hanging = recordingSink('thread-1', 'c') as Recording;
    hanging.askUserQuestion = () => new Promise(() => {}); // never settles
    manager.addSink(declining);
    manager.addSink(throwing);
    manager.addSink(hanging);

    for (const turnId of ['a', 'b', 'c']) {
      const response = await client.serverRequest({
        id: 1, method: 'item/tool/requestUserInput', params: question({ turnId }),
      });
      expect(response, `turn ${turnId}`).toEqual({ result: { answers: {} } });
    }
  });

  it('honours the server\'s own autoResolutionMs when it is shorter', async () => {
    const { manager, client } = makeAsking({ askUserQuestionTimeoutMs: 10_000 });
    await manager.ready();
    const hanging = recordingSink('thread-1', 't1') as Recording;
    hanging.askUserQuestion = () => new Promise(() => {});
    manager.addSink(hanging);

    const started = Date.now();
    const response = await client.serverRequest({
      id: 1, method: 'item/tool/requestUserInput', params: question({ autoResolutionMs: 30 }),
    });
    expect(response).toEqual({ result: { answers: {} } });
    expect(Date.now() - started).toBeLessThan(5_000); // the server's deadline won
  });

  it('a late answer after the deadline cannot produce a second response', async () => {
    const { manager, client } = makeAsking();
    await manager.ready();
    let late!: (v: Record<string, string[]>) => void;
    const slow = recordingSink('thread-1', 't1') as Recording;
    slow.askUserQuestion = () => new Promise((resolve) => { late = resolve; });
    manager.addSink(slow);

    const response = await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params: question() });
    expect(response).toEqual({ result: { answers: {} } });

    late({ q1: ['A'] }); // arrives after the request was already settled
    await new Promise((r) => setTimeout(r, 10));
    expect(response).toEqual({ result: { answers: {} } }); // unchanged
  });

  it('declines every question once the sinks are gone', async () => {
    // Quarantine and transport failure both clear the registry, so a question that
    // arrives afterwards has nobody to ask.
    const { manager, client } = makeAsking();
    await manager.ready();
    manager.addSink(askingSink('thread-1', 't1', { q1: ['A'] }));
    await manager.shutdown();

    const response = await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params: question() });
    expect(response).toEqual({ result: { answers: {} } });
  });

  it('MALFORMED identity on the method we implement poisons the generation', async () => {
    const { manager, client } = makeAsking();
    await manager.ready();
    const sink = askingSink('thread-1', 't1', { q1: ['A'] });
    manager.addSink(sink);

    const response = await client.serverRequest({
      id: 1, method: 'item/tool/requestUserInput', params: question({ turnId: 7 }),
    });

    expect(client.poisoned).toHaveLength(1);
    expect(client.poisoned[0]).toMatch(/turnId is missing or not a non-empty string/);
    // Every active turn was told, exactly once, and the request still got ONE response.
    expect(sink.seen).toEqual(['claudeclaw/transportFailed']);
    expect(response).toMatchObject({ error: { code: -32000 } });
    expect(sink.asked).toBe(0);
  });

  it.each([
    ['item/commandExecution/requestApproval', { decision: 'decline' }],
    ['item/fileChange/requestApproval', { decision: 'decline' }],
    ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
    ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
    ['applyPatchApproval', { decision: 'denied' }],
    ['execCommandApproval', { decision: 'denied' }],
  ])('%s is denied with the exact pinned shape', async (method, expected) => {
    // approvalPolicy is "never" and the sandbox was verified before the prompt was
    // sent. This callback is not a second way to grant what verification pinned down.
    const { manager, client } = makeAsking();
    await manager.ready();
    manager.addSink(askingSink('thread-1', 't1', { q1: ['A'] }));

    const response = await client.serverRequest({ id: 1, method, params: { threadId: 'thread-1', turnId: 't1' } });
    expect(response).toEqual({ result: expected });
    expect(client.poisoned).toEqual([]);
  });

  it.each([
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
  ])('%s is refused with an actionable error and no credential', async (method) => {
    const { manager, client } = makeAsking();
    await manager.ready();

    const response = await client.serverRequest({ id: 1, method, params: {} }) as any;
    expect(response.error.code).toBe(-32000);
    expect(response.result).toBeUndefined();
    // Nothing that could be mistaken for a token.
    expect(response.error.message).not.toMatch(/token[^s]|Bearer|sk-/i);
    expect(response.error.message.length).toBeGreaterThan(20);
  });

  it('currentTime/read is refused at the application level, not method-not-found', async () => {
    // It is in the pinned union. Saying "no such method" would misreport a decision as
    // a gap.
    const { manager, client } = makeAsking();
    await manager.ready();

    const response = await client.serverRequest({ id: 1, method: 'currentTime/read', params: {} }) as any;
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toMatch(/does not implement currentTime\/read/);
  });

  it.each([
    'something/entirely/new',
    'item/tool/requestUserInputV2',
    'account/somethingElse',
  ])('%s — outside the pinned eleven — gets method-not-found', async (method) => {
    const { manager, client } = makeAsking();
    await manager.ready();

    const response = await client.serverRequest({ id: 1, method, params: {} }) as any;
    expect(response.error.code).toBe(-32601);
    expect(client.poisoned).toEqual([]);
  });

  it('every one of the pinned eleven is classified — none falls through to a default', async () => {
    // The whole point of enumerating them: a variant nobody decided about would get
    // method-not-found, which for an authority-bearing request is a shrug.
    const { manager, client } = makeAsking();
    await manager.ready();
    manager.addSink(askingSink('thread-1', 't1', { q1: ['A'] }));

    for (const method of SERVER_REQUEST_METHODS) {
      const params = method === 'item/tool/requestUserInput' ? question() : { threadId: 'thread-1', turnId: 't1' };
      const response = await client.serverRequest({ id: 1, method, params }) as any;
      expect(response.error?.code, `${method} must not be method-not-found`).not.toBe(-32601);
    }
  });
});

describe('a pending question dies with its turn', () => {
  // App Server blocks on the request. A question left open after its turn has gone
  // holds the connection AND leaves a live prompt whose answer would be delivered to
  // a turn that no longer exists.

  function pendingSetup() {
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      askUserQuestionTimeoutMs: 60_000, // long: the sink lifecycle must settle it, not the clock
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
    });
    let answer!: (v: Record<string, string[]> | null) => void;
    const sink = recordingSink('thread-1', 't1') as Recording;
    sink.askUserQuestion = () => new Promise((resolve) => { answer = resolve; });
    return { manager, client, sink, late: (v: Record<string, string[]>) => answer(v) };
  }

  const params = {
    threadId: 'thread-1', turnId: 't1', itemId: 'item-1', autoResolutionMs: null,
    questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: false, isSecret: false, options: null }],
  };

  it.each([
    ['the turn completes or is interrupted', (m: CodexAppServerManager, s: Recording) => { m.removeSink(s); }],
    ['the transport fails', (m: CodexAppServerManager, _s: Recording, c: FakeClient) => {
      c.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'x', turn: { id: 'y', status: 'completed' } } });
    }],
    ['the manager shuts down', (m: CodexAppServerManager) => { void m.shutdown(); }],
  ])('settles immediately when %s, and a late answer has no effect', async (_label, kill) => {
    const { manager, client, sink, late } = pendingSetup();
    await manager.ready();
    manager.addSink(sink);

    const pending = client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params });
    await new Promise((r) => setImmediate(r)); // the resolver is now waiting

    try { kill(manager, sink, client); } catch { /* the transport case throws a fault */ }

    // Settled at once — not after the 60s ceiling.
    const response = await pending;
    expect(response).toEqual({ result: { answers: {} } });

    late({ q1: ['A'] }); // the human finally taps
    await new Promise((r) => setTimeout(r, 10));
    expect(response).toEqual({ result: { answers: {} } }); // still the decline
  });

  it('a second question on a DIFFERENT turn is untouched when the first turn goes', async () => {
    const { manager, client, sink } = pendingSetup();
    await manager.ready();
    const other = recordingSink('thread-2', 't2') as Recording;
    other.askUserQuestion = async () => ({ q1: ['B'] });
    manager.addSink(sink);
    manager.addSink(other);

    const first = client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params });
    await new Promise((r) => setImmediate(r));
    manager.removeSink(sink);
    expect(await first).toEqual({ result: { answers: {} } });

    const second = await client.serverRequest({
      id: 2,
      method: 'item/tool/requestUserInput',
      params: { ...params, threadId: 'thread-2', turnId: 't2' },
    });
    expect(second).toEqual({ result: { answers: { q1: { answers: ['B'] } } } });
  });
});

describe('the server\'s own question deadline is honoured exactly', () => {
  // Reading a non-positive autoResolutionMs as "no deadline" did the opposite of what
  // the server asked: it held the question open for the full ceiling precisely when
  // the server meant to resolve it at once.

  function deadlineSetup(ceilingMs: number) {
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      askUserQuestionTimeoutMs: ceilingMs,
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
    });
    const sink = recordingSink('thread-1', 't1') as Recording;
    // Never answers: only a deadline can settle this.
    sink.askUserQuestion = () => new Promise(() => {});
    return { manager, client, sink };
  }

  const withDeadline = (autoResolutionMs: number | null): Record<string, unknown> => ({
    threadId: 'thread-1', turnId: 't1', itemId: 'item-1', autoResolutionMs,
    questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: false, isSecret: false, options: null }],
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a very large negative', -60_000],
  ])('declines at once for %s, rather than waiting out the ceiling', async (_label, autoResolutionMs) => {
    // The ceiling is ten minutes here; anything but an immediate decline means the
    // server's deadline was ignored.
    const { manager, client, sink } = deadlineSetup(10 * 60_000);
    await manager.ready();
    manager.addSink(sink);

    const started = Date.now();
    const response = await client.serverRequest({
      id: 1, method: 'item/tool/requestUserInput', params: withDeadline(autoResolutionMs),
    });

    expect(response).toEqual({ result: { answers: {} } });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still uses the ceiling when the server states no deadline', async () => {
    const { manager, client, sink } = deadlineSetup(40);
    await manager.ready();
    manager.addSink(sink);

    const started = Date.now();
    const response = await client.serverRequest({
      id: 1, method: 'item/tool/requestUserInput', params: withDeadline(null),
    });

    expect(response).toEqual({ result: { answers: {} } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30); // it waited
  });

  it('the shorter of the two wins in both directions', async () => {
    const { manager, client, sink } = deadlineSetup(30);
    await manager.ready();
    manager.addSink(sink);

    // Server deadline far longer than the ceiling: the ceiling caps it.
    const started = Date.now();
    await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params: withDeadline(10 * 60_000) });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('a settled question tells the resolver side to stop', () => {
  // Settling the App Server response is not enough on its own: the losing half of the
  // resolver race would stay pending, holding its listeners, until a human eventually
  // answered a question nobody is listening to.

  function signalSetup() {
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      askUserQuestionTimeoutMs: 60_000, // long: only the lifecycle may settle this
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
    });
    const seen: { signal?: AbortSignal; settled?: boolean } = {};
    const sink = recordingSink('thread-1', 't1') as Recording;
    // Mirrors what the adapter wrapper does: wait for an answer OR the signal.
    sink.askUserQuestion = (_request, signal) => {
      seen.signal = signal;
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => { seen.settled = true; resolve(null); }, { once: true });
      });
    };
    return { manager, client, sink, seen };
  }

  const params = {
    threadId: 'thread-1', turnId: 't1', itemId: 'item-1', autoResolutionMs: null,
    questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: false, isSecret: false, options: null }],
  };

  it.each([
    ['sink removal', (m: CodexAppServerManager, s: Recording) => { m.removeSink(s); }],
    ['a transport failure', (_m: CodexAppServerManager, _s: Recording, c: FakeClient) => {
      c.notify({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'x', turn: { id: 'y', status: 'completed' } } });
    }],
    ['shutdown', (m: CodexAppServerManager) => { void m.shutdown(); }],
  ])('aborts the question signal on %s, with no human answer', async (_label, kill) => {
    const { manager, client, sink, seen } = signalSetup();
    await manager.ready();
    manager.addSink(sink);

    const pending = client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params });
    await new Promise((r) => setImmediate(r));
    expect(seen.signal!.aborted).toBe(false);

    try { kill(manager, sink, client); } catch { /* the transport case throws a fault */ }

    expect(await pending).toEqual({ result: { answers: {} } });
    expect(seen.signal!.aborted).toBe(true);
    expect(seen.settled).toBe(true);
  });

  it('aborts the signal on the DEADLINE too', async () => {
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      askUserQuestionTimeoutMs: 20,
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
    });
    await manager.ready();
    let captured!: AbortSignal;
    const sink = recordingSink('thread-1', 't1') as Recording;
    sink.askUserQuestion = (_r, signal) => { captured = signal; return new Promise(() => {}); };
    manager.addSink(sink);

    await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params });
    expect(captured.aborted).toBe(true);
  });

  it('aborts the signal even when the human answers first', async () => {
    // "Another outcome wins" includes the ordinary one: the question is over either
    // way, and anything the resolver attached should come down.
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
    });
    await manager.ready();
    let captured!: AbortSignal;
    const sink = recordingSink('thread-1', 't1') as Recording;
    sink.askUserQuestion = async (_r, signal) => { captured = signal; return { q1: ['A'] }; };
    manager.addSink(sink);

    const response = await client.serverRequest({ id: 1, method: 'item/tool/requestUserInput', params });
    expect(response).toEqual({ result: { answers: { q1: { answers: ['A'] } } } });
    expect(captured.aborted).toBe(true);
  });
});

describe('process-wide turn slots', () => {
  // Per-thread locking bounds one conversation; this bounds the PROCESS. One warm
  // child serves every thread, so without a ceiling a burst of unrelated missions,
  // war-room agents and chats all reach it at once.

  function cappedManager(maxConcurrentTurns: number) {
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      maxConcurrentTurns,
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
    });
    return { manager, client };
  }

  it('lets unrelated threads run up to the limit and holds the rest', async () => {
    const { manager } = cappedManager(2);

    const first = await manager.acquireTurnSlot();
    const second = await manager.acquireTurnSlot();
    expect(manager.activeTurnCount()).toBe(2);

    let thirdIn = false;
    const third = manager.acquireTurnSlot().then((release) => { thirdIn = true; return release; });
    await new Promise((r) => setImmediate(r));
    expect(thirdIn).toBe(false);
    expect(manager.queuedTurnCount()).toBe(1);

    first();
    expect(await third).toBeTypeOf('function');
    expect(thirdIn).toBe(true);
    expect(manager.activeTurnCount()).toBe(2); // ownership transferred, not re-counted

    second();
    (await third)();
    expect(manager.activeTurnCount()).toBe(0);
  });

  it('hands slots out in FIFO order', async () => {
    const { manager } = cappedManager(1);
    const order: string[] = [];
    const held = await manager.acquireTurnSlot();

    const a = manager.acquireTurnSlot().then((r) => { order.push('a'); return r; });
    const b = manager.acquireTurnSlot().then((r) => { order.push('b'); return r; });

    held();
    (await a)();
    (await b)();
    expect(order).toEqual(['a', 'b']);
  });

  it('a caller cancelled WHILE QUEUED leaks nothing', async () => {
    const { manager } = cappedManager(1);
    const held = await manager.acquireTurnSlot();
    const abort = new AbortController();
    const queued = manager.acquireTurnSlot(abort.signal);

    abort.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortError);
    expect(manager.queuedTurnCount()).toBe(0);

    // The slot is still the holder's, and the next caller gets it once released.
    expect(manager.activeTurnCount()).toBe(1);
    held();
    expect(manager.activeTurnCount()).toBe(0);
    const next = await manager.acquireTurnSlot();
    next();
  });

  it('refuses a caller whose signal is ALREADY aborted, taking nothing', async () => {
    const { manager } = cappedManager(2);
    const abort = new AbortController();
    abort.abort();
    await expect(manager.acquireTurnSlot(abort.signal)).rejects.toBeInstanceOf(AbortError);
    expect(manager.activeTurnCount()).toBe(0);
  });

  it('releasing twice frees only one slot', async () => {
    // A terminal path can run more than once; the count must not drift below zero and
    // let an extra turn through.
    const { manager } = cappedManager(1);
    const release = await manager.acquireTurnSlot();
    release();
    release();
    expect(manager.activeTurnCount()).toBe(0);

    const a = await manager.acquireTurnSlot();
    let secondIn = false;
    void manager.acquireTurnSlot().then(() => { secondIn = true; });
    await new Promise((r) => setImmediate(r));
    expect(secondIn).toBe(false); // still capped at one
    a();
  });

  it('a queued caller is NOT a routable question resolver', async () => {
    // Waiting for a slot must not make an invocation visible to server-request
    // routing: the sink is registered at the pre-turn/start point, after the
    // invocation has the authority to run.
    const { manager, client } = cappedManager(1);
    await manager.ready();

    const running = recordingSink('thread-1', 't1') as Recording;
    running.askUserQuestion = async () => ({ q1: ['A'] });
    manager.addSink(running);
    const held = await manager.acquireTurnSlot();

    // A second invocation queues for a slot and registers nothing.
    const queued = manager.acquireTurnSlot();
    await new Promise((r) => setImmediate(r));

    // A question for the queued turn finds no resolver and declines...
    const forQueued = await client.serverRequest({
      id: 1,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-2', turnId: 't2', itemId: 'i', autoResolutionMs: null,
        questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: false, isSecret: false, options: null }],
      },
    });
    expect(forQueued).toEqual({ result: { answers: {} } });

    // ...while the RUNNING turn's routing is untouched.
    const forRunning = await client.serverRequest({
      id: 2,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 't1', itemId: 'i', autoResolutionMs: null,
        questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: false, isSecret: false, options: null }],
      },
    });
    expect(forRunning).toEqual({ result: { answers: { q1: { answers: ['A'] } } } });

    held();
    (await queued)();
  });
});

describe('shutdown retires the semaphore', () => {
  // A waiter that outlives its manager is worse than a rejected one: the next active
  // holder to finish hands it ownership, and the turn then calls ready() on a manager
  // nobody is using — starting a child on a connection nothing is managing.

  function cappedManager(maxConcurrentTurns: number) {
    const client = new FakeClient();
    const manager = new CodexAppServerManager({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      maxConcurrentTurns,
      createClient: (options) => {
        client.notify = options.onNotification!;
        client.serverRequest = options.onServerRequest!;
        return client as never;
      },
    });
    return { manager, client };
  }

  it('rejects every queued waiter when the manager shuts down', async () => {
    const { manager } = cappedManager(1);
    const held = await manager.acquireTurnSlot();
    const first = manager.acquireTurnSlot();
    const second = manager.acquireTurnSlot();
    await new Promise((r) => setImmediate(r));
    expect(manager.queuedTurnCount()).toBe(2);

    // The queue is retired synchronously, but the shutdown then DRAINS the turn `held` is
    // still running, so the rejections are observed before that grace elapses: a rejection
    // nobody is watching across a macrotask boundary is reported as unhandled, which is
    // noise rather than a finding.
    const retired = manager.shutdown();
    await expect(first).rejects.toThrow(/shut down while this turn was queued/);
    await expect(second).rejects.toThrow(/shut down while this turn was queued/);
    expect(manager.queuedTurnCount()).toBe(0);
    held();
    await retired;
  });

  it('refuses new acquisitions after shutdown', async () => {
    const { manager } = cappedManager(4);
    await manager.shutdown();
    await expect(manager.acquireTurnSlot()).rejects.toThrow(/manager is shut down; not starting a new turn/);
    expect(manager.activeTurnCount()).toBe(0);
  });

  it('a release AFTER shutdown decrements without handing ownership on', async () => {
    const { manager } = cappedManager(1);
    const held = await manager.acquireTurnSlot();
    const queued = manager.acquireTurnSlot();
    await new Promise((r) => setImmediate(r));

    const retired = manager.shutdown();
    await expect(queued).rejects.toThrow(/queued for a slot/);

    // The in-flight turn finishes afterwards — which is what the drain was waiting for.
    // Nothing may be resurrected by it.
    held();
    await retired;
    expect(manager.activeTurnCount()).toBe(0);
    expect(manager.queuedTurnCount()).toBe(0);
    await expect(manager.acquireTurnSlot()).rejects.toThrow(/shut down/);
  });

  it('REPLACING the shared manager retires the old one\'s waiters without leaking a slot', async () => {
    // A launch-critical env change swaps the singleton. The outgoing manager's queue must
    // not keep handing out slots for a child that is being torn down — and the holder
    // that is still running must not have its slot double-released on the way out.
    await CodexAppServerManager.resetShared();
    const base = {
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      maxConcurrentTurns: 1,
      createClient: () => new FakeClient() as never,
    };
    const first = await CodexAppServerManager.shared(base);
    const held = await first.acquireTurnSlot();
    const queued = first.acquireTurnSlot();
    await new Promise((r) => setImmediate(r));
    expect(first.queuedTurnCount()).toBe(1);

    const rotation = CodexAppServerManager.shared({
      ...base,
      expectedCodexHome: '/tmp/other',
      env: { ...base.env, CODEX_HOME: '/tmp/other' },
    });

    // The queued caller holds nothing, so there is nothing to drain for it: it is woken
    // at once with a terminal failure rather than handed ownership later.
    await expect(queued).rejects.toThrow(/shut down while this turn was queued/);
    expect(first.queuedTurnCount()).toBe(0);

    // The holder finishes and gives its slot back. Twice, because a terminal path can run
    // more than once and one slot must still only be freed once.
    held();
    held();
    expect(first.activeTurnCount()).toBe(0);

    const second = await rotation;
    expect(second).not.toBe(first);
    // The replacement has its own, untouched budget...
    const fresh = await second.acquireTurnSlot();
    expect(second.activeTurnCount()).toBe(1);
    fresh();
    // ...and the retired manager admits nothing more, whatever its queue once held.
    await expect(first.acquireTurnSlot()).rejects.toThrow(/shut down/);
    await CodexAppServerManager.resetShared();
  });

  it('shutdown is idempotent', async () => {
    const { manager } = cappedManager(1);
    await manager.shutdown();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

describe('the launch fingerprint', () => {
  // What the fingerprint covers decides when a child is reused. It used to track the
  // isolated home, PATH, whether an API key was PRESENT, and two CA variables — so a
  // rotated credential, a new proxy, a changed endpoint or an upgraded executable all
  // reused a child launched under the old ones. Every name below was read out of the
  // pinned 0.144.6 binary rather than remembered.

  const base = (over: Partial<ManagerOptions> = {}): ManagerOptions => ({
    env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
    expectedCodexHome: '/tmp/home',
    clientVersion: '1.7.1',
    rotationDrainMs: TEST_DRAIN_MS,
    ...over,
  });

  const withEnv = (extra: Record<string, string>): ManagerOptions =>
    base({ env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home', ...extra } });

  it('is a pure, non-secret digest of its inputs', () => {
    const options = withEnv({ OPENAI_API_KEY: 'sk-live-abcdefghijklmnop' });
    const first = CodexAppServerManager.fingerprintOf(options);
    expect(CodexAppServerManager.fingerprintOf(options)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    // Nothing recognisable from the credential survives into the digest.
    expect(first).not.toContain('sk-live');
    expect(first).not.toContain('abcdefghijklmnop');
  });

  it('changes when an API key ROTATES, not merely when one appears', () => {
    // The old fingerprint hashed the string 'api-key', so swapping one key for another
    // was invisible and the warm child kept using the credential that had been revoked.
    const none = CodexAppServerManager.fingerprintOf(base());
    const oldKey = CodexAppServerManager.fingerprintOf(withEnv({ OPENAI_API_KEY: 'sk-old' }));
    const newKey = CodexAppServerManager.fingerprintOf(withEnv({ OPENAI_API_KEY: 'sk-new' }));

    expect(oldKey).not.toBe(none);
    expect(newKey).not.toBe(oldKey);
    expect(newKey).not.toContain('sk-new');
  });

  it('rotates when the prepared Windows sandbox setup changes', () => {
    const before = CodexAppServerManager.fingerprintOf(base({ sandboxIdentity: 'elevated:one' }));
    const after = CodexAppServerManager.fingerprintOf(base({ sandboxIdentity: 'elevated:two' }));
    expect(after).not.toBe(before);
  });

  it('reads an empty credential as no credential', () => {
    // Absent and empty authenticate the same nothing, so they must not read as two
    // different launch environments and rotate the process between them.
    expect(CodexAppServerManager.fingerprintOf(withEnv({ OPENAI_API_KEY: '' })))
      .toBe(CodexAppServerManager.fingerprintOf(base()));
  });

  it('cannot be collapsed by a field boundary', () => {
    // Two DIFFERENT launch environments whose fields concatenate identically under a
    // single-separator join ('x' + ' ' + 'y z' === 'x y' + ' ' + 'z'). That ambiguity is
    // why the old material was NUL-joined; JSON over an ordered structure removes it
    // without a control character, because every field is delimited and every value
    // escaped.
    const left = base({ expectedCodexHome: 'x', env: { CODEX_HOME: 'x', PATH: 'y z' } });
    const right = base({ expectedCodexHome: 'x y', env: { CODEX_HOME: 'x y', PATH: 'z' } });
    expect(CodexAppServerManager.fingerprintOf(left)).not.toBe(CodexAppServerManager.fingerprintOf(right));
  });

  it('is built from source that carries no literal NUL byte', () => {
    // The reason the rewrite happened at all: a NUL in the material made git and grep
    // treat the whole manager as a binary file.
    const source = fs.readFileSync(new URL('./codex-app-server-manager.ts', import.meta.url), 'utf8');
    expect(source.includes(String.fromCharCode(0))).toBe(false);
  });

  it.each([
    ['the isolated codex home', base({ expectedCodexHome: '/tmp/other', env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/other' } })],
    ['PATH, which decides what the sandboxed shell can run', withEnv({ PATH: '/opt/bin' })],
    ['the HTTPS proxy', withEnv({ HTTPS_PROXY: 'http://proxy.corp:8080' })],
    ['the lowercase HTTP proxy', withEnv({ http_proxy: 'http://proxy.corp:8080' })],
    ['the proxy bypass list', withEnv({ NO_PROXY: 'localhost' })],
    ['the API endpoint', withEnv({ CODEX_URL: 'https://gateway.corp.test' })],
    ['the organization', withEnv({ OPENAI_ORGANIZATION: 'org-two' })],
    ['the managed package root', withEnv({ CODEX_MANAGED_PACKAGE_ROOT: '/opt/codex' })],
    ['the client version sent in the handshake', base({ clientVersion: '1.7.2' })],
  ])('rotates on a change to %s', (_label, changed) => {
    expect(CodexAppServerManager.fingerprintOf(changed)).not.toBe(CodexAppServerManager.fingerprintOf(base()));
  });

  // The CA lookup SEQUENCE, in the order the pinned 0.144.6 binary consults it. A partial
  // list is worse than useless: the first name that resolves decides which roots the child
  // trusts, so a bundle swapped in through an omitted entry left the warm child trusting
  // the old roots. Only the first four of these were covered before.
  it.each([
    'CODEX_CA_CERTIFICATE',
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'NODE_EXTRA_CA_CERTS',
    'GIT_SSL_CAINFO',
    'PIP_CERT',
    'BUNDLE_SSL_CA_CERT',
    'npm_config_cafile',
    'NPM_CONFIG_CAFILE',
    'SSL_CERT_DIR',
  ])('rotates when CA trust moves via %s', (name) => {
    expect(CodexAppServerManager.fingerprintOf(withEnv({ [name]: '/etc/ssl/corp-roots.pem' })))
      .not.toBe(CodexAppServerManager.fingerprintOf(base()));
  });

  // Every credential the pinned binary reads. Each must ROTATE the process when its value
  // changes and leave nothing recoverable in the digest — the two halves of "hash secret
  // material, never store it".
  it.each([
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CODEX_REFRESH_TOKEN',
    'CODEX_CONNECTORS_TOKEN',
    'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ])('hashes %s, and rotates when its VALUE changes', (name) => {
    const none = CodexAppServerManager.fingerprintOf(base());
    const first = CodexAppServerManager.fingerprintOf(withEnv({ [name]: 'secret-value-one' }));
    const second = CodexAppServerManager.fingerprintOf(withEnv({ [name]: 'secret-value-two' }));

    expect(first).not.toBe(none);
    expect(second).not.toBe(first); // presence alone is not enough
    expect(first).not.toContain('secret-value');
    expect(second).not.toContain('secret-value');
  });

  it('keeps each credential and CA slot distinct from the others', () => {
    // One digest per key rather than one over the lot, so the same value arriving under a
    // different name is a different launch environment — an API key moved from
    // OPENAI_API_KEY to CODEX_API_KEY authenticates through a different path.
    const asOpenAi = CodexAppServerManager.fingerprintOf(withEnv({ OPENAI_API_KEY: 'same-value' }));
    const asCodex = CodexAppServerManager.fingerprintOf(withEnv({ CODEX_API_KEY: 'same-value' }));
    expect(asCodex).not.toBe(asOpenAi);

    const asCurl = CodexAppServerManager.fingerprintOf(withEnv({ CURL_CA_BUNDLE: '/ca.pem' }));
    const asPip = CodexAppServerManager.fingerprintOf(withEnv({ PIP_CERT: '/ca.pem' }));
    expect(asPip).not.toBe(asCurl);
  });

  it.each([
    ['file-backed auth appearing', base({ authIdentity: 'file:abc' })],
    ['a file-backed credential ROTATING', base({ authIdentity: 'file:def' })],
    ['a switch to API-key auth', base({ authIdentity: 'api-key:' })],
    ['a logout, leaving the platform credential store', base({ authIdentity: 'delegated:' })],
  ])('rotates on %s', (_label, changed) => {
    // The identity is a mode plus a digest, produced by detectCodexAuth. A running child
    // cannot adopt a new login, so each of these is a different launch environment.
    expect(CodexAppServerManager.fingerprintOf(changed)).not.toBe(CodexAppServerManager.fingerprintOf(base()));
    // And the digest carries no credential, so neither does the fingerprint.
    expect(CodexAppServerManager.fingerprintOf(changed)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('treats an absent authIdentity as one state, not as a wildcard', () => {
    // A caller that does not manage file-backed credentials (every test manager, and any
    // future embedder) must still get a stable fingerprint rather than one that rotates.
    expect(CodexAppServerManager.fingerprintOf(base())).toBe(CodexAppServerManager.fingerprintOf(base()));
    expect(CodexAppServerManager.fingerprintOf(base({ authIdentity: '' })))
      .toBe(CodexAppServerManager.fingerprintOf(base()));
  });

  it.each([
    ['the process-wide concurrency ceiling', base({ maxConcurrentTurns: 3 })],
    ['the credential preparation hook itself', base({ prepareLaunch: () => {} })],
    ['the interactive question deadline', base({ askUserQuestionTimeoutMs: 5 })],
    ['the retirement drain grace', base({ rotationDrainMs: 5_000 })],
    ['child log verbosity', withEnv({ RUST_LOG: 'debug' })],
    ['the sandbox marker codex sets for its OWN children', withEnv({ CODEX_SANDBOX: 'seatbelt' })],
    ['an unrelated inherited variable', withEnv({ TERM: 'xterm-256color' })],
  ])('does NOT rotate on a change to %s', (_label, unchanged) => {
    // A restart costs every turn in flight a drain. It is spent on inputs the child reads
    // at LAUNCH and nothing else — never on per-turn settings, which travel in protocol
    // requests, and never on values that cannot make a running child wrong.
    expect(CodexAppServerManager.fingerprintOf(unchanged)).toBe(CodexAppServerManager.fingerprintOf(base()));
  });

  it('finds launch variables under the casing Windows reports them in', () => {
    // Windows environment blocks are case-insensitive and Node reports the OS's own
    // casing, so a plain object copied out of process.env there holds `Path`. Reading
    // `env.PATH` off it returned undefined, which made PATH invisible to the fingerprint
    // on the platform ClaudeClaw runs on.
    const windows = base({ env: { Path: '/usr/bin', CODEX_HOME: '/tmp/home' } });
    expect(CodexAppServerManager.fingerprintOf(windows)).toBe(CodexAppServerManager.fingerprintOf(base()));

    const moved = base({ env: { Path: '/opt/bin', CODEX_HOME: '/tmp/home' } });
    expect(CodexAppServerManager.fingerprintOf(moved)).not.toBe(CodexAppServerManager.fingerprintOf(windows));
  });

  it('covers the executable with REAL resolved values, so an in-place upgrade cannot be missed', () => {
    // An in-place `@openai/codex` upgrade under a running ClaudeClaw swaps the protocol
    // baseline the schema check ran against, and an environment-only fingerprint cannot
    // see it. What makes the executable field worth anything is that these are resolved
    // values rather than a constant fallback — a fallback would hash the same before and
    // after an upgrade and the child would never rotate.
    const identity = executableIdentity();
    expect(identity.launcher).toMatch(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    expect(identity.codexVersion).toBe('0.159.2'); // the pin the schema check ran against
    expect(identity.launcherBytes).toBeGreaterThan(0);
    expect(identity.node).toBe(process.execPath);
    expect(identity.error).toBeUndefined();

    // And it is stable between calls, so an unchanged install reuses the warm child.
    expect(CodexAppServerManager.fingerprintOf(base())).toBe(CodexAppServerManager.fingerprintOf(base()));
  });

  it('takes nothing from outside the launch inputs', () => {
    // Finding 10's boundary, at the fingerprint: trusted MCP provenance is
    // invocation-scoped and has no home in ManagerOptions. Even smuggled in as an extra
    // field it cannot move the digest, because the digest is built from a fixed, ordered
    // list of launch inputs rather than from whatever the options object happens to hold.
    const smuggled = {
      ...base(),
      ...({ trustedMcpServers: ['claudeclaw-dispatch'], default_tools_approval_mode: 'approve' } as object),
    } as ManagerOptions;
    expect(CodexAppServerManager.fingerprintOf(smuggled)).toBe(CodexAppServerManager.fingerprintOf(base()));
  });
});

describe('launch-environment rotation', () => {
  // `shared()` used to fire `void current.shutdown()` and publish the replacement in the
  // same tick. Two children were alive at once, the old one's active turns were dropped
  // with no terminal at all, and two callers arriving together each started a rotation.
  //
  // A rotation is now a transition that is AWAITED — drain, one explicit terminal for
  // whatever will not drain, the child's observed exit, and only then the replacement.

  /** Fresh clients per rotation, in the order the manager actually builds them. */
  function fleet() {
    const trace: string[] = [];
    const clients: FakeClient[] = [];
    const options = (over: Partial<ManagerOptions> = {}): ManagerOptions => ({
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/home' },
      expectedCodexHome: '/tmp/home',
      clientVersion: '1.7.1',
      rotationDrainMs: TEST_DRAIN_MS,
      createClient: (opts) => {
        const client = new FakeClient(trace, `child${clients.length + 1}`);
        clients.push(client);
        return wire(client)(opts);
      },
      ...over,
    });
    /** The same launch environment with one launch-critical value moved. */
    const rotated = (over: Partial<ManagerOptions> = {}): ManagerOptions => options({
      expectedCodexHome: '/tmp/other',
      env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/other' },
      ...over,
    });
    return { trace, clients, options, rotated };
  }

  afterEach(() => CodexAppServerManager.resetShared());

  it('does not build the replacement child until the old one has exited', async () => {
    const { trace, options, rotated } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();

    const second = await CodexAppServerManager.shared(rotated());
    expect(second).not.toBe(first);
    await second.ready();

    // The ordering, asserted rather than inferred: the old child's exit strictly precedes
    // the construction of its replacement. Two children serving one shared slot is the
    // failure the whole transition exists to prevent.
    expect(trace).toEqual(['child1:built', 'child1:exited', 'child2:built']);
  });

  it('forces a child that ignores the orderly shutdown, then publishes', async () => {
    const { trace, clients, options, rotated } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();
    clients[0].lingers = true; // survives stdin.end() and SIGTERM

    const second = await CodexAppServerManager.shared(rotated());
    expect(second).not.toBe(first);
    expect(clients[0].quarantined).toHaveLength(1);
    // Killed, not merely asked — and still before the replacement exists.
    await second.ready();
    expect(trace).toEqual(['child1:built', 'child1:killed', 'child2:built']);
  });

  it('refuses to run a replacement beside a child it could not terminate', async () => {
    const { clients, options, rotated } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();
    clients[0].lingers = true;
    clients[0].quarantineResult = false; // outlives even SIGKILL

    const target = rotated();
    await expect(CodexAppServerManager.shared(target)).rejects.toThrow(/could not be terminated/);
    // Deterministic on repeat: the slot stays retired and every later caller gets the
    // same refusal rather than a second child.
    await expect(CodexAppServerManager.shared(target)).rejects.toThrow(/could not be terminated/);
    expect(clients).toHaveLength(1);

    // The teardown ran ONCE — draining twice or asking the child to stop twice is neither
    // idempotent nor useful — while the KILL was retried, because a slot wedged forever by
    // one unlucky SIGKILL is worse than trying again.
    expect(clients[0].shutdowns).toBe(1);
    expect(clients[0].quarantined).toHaveLength(2);

    // Which is what makes the refusal fail-closed rather than permanent: once the child
    // finally dies, the slot rotates normally.
    clients[0].quarantineResult = true;
    const replacement = await CodexAppServerManager.shared(target);
    expect(replacement).not.toBe(first);
    await replacement.ready();
    expect(clients).toHaveLength(2);
  });

  it('a RESET does not release the slot for a child it could not terminate', async () => {
    // The reset path used to clear `current` before confirming the exit, which was the one
    // way round the no-overlap guarantee. A child that outlived SIGKILL left an EMPTY
    // slot, so the next shared() saw nothing published, took the fresh-start path, and
    // spawned a second child beside the one still running.
    const { clients, options } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();
    clients[0].lingers = true;
    clients[0].quarantineResult = false;

    await expect(CodexAppServerManager.resetShared()).rejects.toThrow(/could not be terminated/);

    // The retired manager is still published, so the request that follows fails closed
    // exactly as a rotation would. `ready()` is chained deliberately: if the slot HAD been
    // released, this is the call that would put a second child beside the first, so the
    // client count below is what actually proves the overlap cannot happen.
    const overlapping = CodexAppServerManager.shared(options()).then((m) => m.ready());
    await expect(overlapping).rejects.toThrow(/could not be terminated/);
    expect(clients).toHaveLength(1);

    // Recoverable, once the child is actually gone.
    clients[0].quarantineResult = true;
    await CodexAppServerManager.resetShared();
    const replacement = await CodexAppServerManager.shared(options());
    expect(replacement).not.toBe(first);
    await replacement.ready();
    expect(clients).toHaveLength(2);
  });

  it('lets an ACTIVE turn finish on the old generation instead of killing or stranding it', async () => {
    // The headline case. A credential rotates while a turn is mid-flight: the turn keeps
    // running on the child it started on, hears nothing about the transition, and the
    // replacement is not published until it is done.
    const { options, rotated } = fleet();
    const grace = { rotationDrainMs: 5_000 };
    const first = await CodexAppServerManager.shared(options(grace));
    await first.ready();

    const sink = recordingSink('thread-1', 't1');
    const release = await first.acquireTurnSlot();
    first.addSink(sink);

    let published: CodexAppServerManager | null = null;
    const rotation = CodexAppServerManager.shared(rotated(grace)).then((m) => { published = m; return m; });
    await new Promise((r) => setTimeout(r, 60));

    // Still draining: nothing published, and the turn has not been told anything.
    expect(published).toBeNull();
    expect(sink.seen).toEqual([]);

    // The turn ends normally, exactly as it would have without a rotation.
    first.removeSink(sink);
    release();

    const second = await rotation;
    expect(second).not.toBe(first);
    expect(sink.seen).toEqual([]); // never received a transport failure
  });

  it('gives every sink that will NOT drain exactly one transport failure', async () => {
    const { clients, options, rotated } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();

    const a = recordingSink('thread-1', 't1');
    const b = recordingSink('thread-2', 't2');
    const release = await first.acquireTurnSlot();
    first.addSink(a);
    first.addSink(b);

    const second = await CodexAppServerManager.shared(rotated());
    expect(second).not.toBe(first);
    expect(a.seen).toEqual(['claudeclaw/transportFailed']);
    expect(b.seen).toEqual(['claudeclaw/transportFailed']);

    // The child's exit follows every teardown. It must not deliver a SECOND terminal to a
    // turn that has already been told — the registry was snapshotted and cleared.
    clients[0].exit({ code: 0, signal: null, expected: true });
    expect(a.seen).toEqual(['claudeclaw/transportFailed']);
    expect(b.seen).toEqual(['claudeclaw/transportFailed']);
    release();
  });

  it('never builds a second child for a turn the transition overtook', async () => {
    // A turn that holds a process slot but has not reached its thread yet either finishes
    // on the old healthy generation or is told, once, that the connection is gone. There
    // is no third path where it silently spawns a child of its own, and nothing here
    // replays it onto the replacement.
    const { clients, options, rotated } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();
    const release = await first.acquireTurnSlot(); // a slot, no sink yet

    const rotation = CodexAppServerManager.shared(rotated());
    await new Promise((r) => setTimeout(r, 60)); // past the drain grace

    await expect(first.ready()).rejects.toThrow(/shut down; not starting a new child/);
    release();

    const second = await rotation;
    expect(second).not.toBe(first);
    // The replacement has never heard of it, and only ever had one child of its own.
    expect(second.activeTurnCount()).toBe(0);
    expect(second.queuedTurnCount()).toBe(0);
    expect(clients).toHaveLength(1);
  });

  it('converges concurrent callers on ONE rotation and ONE replacement', async () => {
    const { clients, options, rotated } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();

    const target = rotated();
    const [a, b, c] = await Promise.all([
      CodexAppServerManager.shared(target),
      CodexAppServerManager.shared(target),
      CodexAppServerManager.shared(target),
    ]);

    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).not.toBe(first);
    // The outgoing generation was torn down once, not three times...
    expect(clients[0].shutdowns).toBe(1);
    // ...and exactly two children existed over the whole test.
    await a.ready();
    expect(clients).toHaveLength(2);
  });

  it('is deterministic across repeated retirement and repeated requests', async () => {
    const { clients, options } = fleet();
    const first = await CodexAppServerManager.shared(options());
    await first.ready();

    await first.shutdown();
    await first.shutdown();
    await expect(first.shutdown()).resolves.toBeUndefined();
    expect(clients[0].shutdowns).toBe(1);

    // A retired instance never satisfies a request, even for the fingerprint it carries:
    // its semaphore is closed and its child is gone.
    const again = await CodexAppServerManager.shared(options());
    expect(again).not.toBe(first);
    expect(await CodexAppServerManager.shared(options())).toBe(again);
  });

  it('prepares credentials only AFTER the outgoing child has exited', async () => {
    // The ordering finding 6 turns on. The isolated home is shared by every generation, so
    // mirroring or removing a credential while the outgoing child is alive would change the
    // credentials underneath turns still running on it. The hook therefore fires from the
    // replacement's first ready(), which shared() reaches only once the old child is gone.
    const { trace, options, rotated } = fleet();
    const first = await CodexAppServerManager.shared(
      options({ authIdentity: 'file:old', prepareLaunch: () => trace.push('auth:old') }),
    );
    await first.ready();

    const second = await CodexAppServerManager.shared(
      rotated({ authIdentity: 'file:new', prepareLaunch: () => trace.push('auth:new') }),
    );
    // Published, but nothing has touched the home yet: no child has been built.
    expect(trace).toEqual(['auth:old', 'child1:built', 'child1:exited']);

    await second.ready();
    expect(trace).toEqual(['auth:old', 'child1:built', 'child1:exited', 'auth:new', 'child2:built']);
  });

  it('prepares once per child, however many turns ask for one', async () => {
    // Concurrent callers observing the same auth state converge on one manager, and that
    // manager mutates the home exactly once — never one copy per turn.
    const { clients, options } = fleet();
    let prepared = 0;
    const opts = () => options({ authIdentity: 'file:same', prepareLaunch: () => { prepared += 1; } });

    const [a, b, c] = await Promise.all([
      CodexAppServerManager.shared(opts()),
      CodexAppServerManager.shared(opts()),
      CodexAppServerManager.shared(opts()),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(prepared).toBe(0); // nothing prepared before a child is needed

    await Promise.all([a.ready(), b.ready(), c.ready()]);
    expect(prepared).toBe(1);
    expect(clients).toHaveLength(1);
  });

  it('does not mutate credentials for a child it could not terminate', async () => {
    // An unkillable outgoing child means the old generation is still reading the isolated
    // home. Preparing the replacement's credentials would change them underneath it, so the
    // refusal has to come first.
    const { clients, options, rotated } = fleet();
    let prepared = 0;
    const first = await CodexAppServerManager.shared(options({ authIdentity: 'file:old' }));
    await first.ready();
    clients[0].lingers = true;
    clients[0].quarantineResult = false;

    const target = rotated({ authIdentity: 'file:new', prepareLaunch: () => { prepared += 1; } });
    await expect(CodexAppServerManager.shared(target)).rejects.toThrow(/could not be terminated/);
    expect(prepared).toBe(0);
    expect(clients).toHaveLength(1);

    // Once the child is gone the rotation completes and the credentials are prepared then,
    // and only then.
    clients[0].quarantineResult = true;
    const second = await CodexAppServerManager.shared(target);
    expect(prepared).toBe(0);
    await second.ready();
    expect(prepared).toBe(1);
  });

  it('builds no child when credential preparation fails, and retries on the next turn', async () => {
    // Fail closed: a turn must not run against a home whose credentials could not be put
    // into the state the published fingerprint claims.
    const { clients, options } = fleet();
    let attempts = 0;
    const manager = await CodexAppServerManager.shared(options({
      authIdentity: 'file:one',
      prepareLaunch: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Could not install the Codex credential at /tmp/x (EACCES).');
      },
    }));

    await expect(manager.ready()).rejects.toThrow(/Could not install the Codex credential/);
    expect(clients).toHaveLength(0); // no child, so no turn ran under the wrong credentials

    // The manager is not poisoned by it: the next invocation tries again.
    await manager.ready();
    expect(attempts).toBe(2);
    expect(clients).toHaveLength(1);
  });

  it('settles a question pending on the old generation and routes no late answer to the replacement', async () => {
    // Finding 8 through a rotation: the resolver belongs to one sink on one generation.
    // It is settled by that sink's lifecycle, and neither it nor a late human answer may
    // reach the replacement.
    const { clients, options, rotated } = fleet();
    const ask = { askUserQuestionTimeoutMs: 60_000 }; // long: only the lifecycle may settle it
    const first = await CodexAppServerManager.shared(options(ask));
    await first.ready();

    let answer!: (v: Record<string, string[]> | null) => void;
    let signal!: AbortSignal;
    const sink = recordingSink('thread-1', 't1') as Recording;
    sink.askUserQuestion = (_request, lifecycle) => {
      signal = lifecycle;
      return new Promise((resolve) => { answer = resolve; });
    };
    const release = await first.acquireTurnSlot();
    first.addSink(sink);

    const params = {
      threadId: 'thread-1', turnId: 't1', itemId: 'item-1', autoResolutionMs: null,
      questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: false, isSecret: false, options: null }],
    };
    const pending = clients[0].serverRequest({ id: 1, method: 'item/tool/requestUserInput', params });
    await new Promise((r) => setImmediate(r));
    expect(signal.aborted).toBe(false);

    const second = await CodexAppServerManager.shared(rotated(ask));

    // Settled on the old generation by the retirement, not by the 60s ceiling.
    expect(await pending).toEqual({ result: { answers: {} } });
    expect(signal.aborted).toBe(true);

    // The human finally taps. There is nothing left listening.
    answer({ q1: ['A'] });
    await new Promise((r) => setTimeout(r, 10));
    expect(await pending).toEqual({ result: { answers: {} } });
    release();

    // And the replacement holds no resolver for that turn: sinks never cross generations.
    await second.ready();
    const onReplacement = await clients[1].serverRequest({ id: 2, method: 'item/tool/requestUserInput', params });
    expect(onReplacement).toEqual({ result: { answers: {} } });
  });
});
