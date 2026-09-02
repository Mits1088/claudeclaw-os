import { describe, it, expect, vi } from 'vitest';

import { parsePostedEvent, toWebsocketUrl, MattermostRpcClient } from './mattermost-rpc.js';
import { ownsChannel } from './mattermost-config.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
// A `posted` event as Mattermost actually sends it: data.post is a JSON STRING
// (single-encoded inside the already-parsed outer event).

function postedEvent(post: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    event: 'posted',
    seq: 42,
    data: {
      channel_name: 'town-square',
      channel_type: 'O',
      sender_name: '@alice',
      team_id: 'team_abc',
      post: JSON.stringify({
        id: 'post123',
        user_id: 'user_alice',
        channel_id: 'chan_xyz',
        root_id: '',
        message: 'Hallo Bot',
        type: '',
        ...post,
      }),
      ...extra,
    },
  };
}

describe('parsePostedEvent', () => {
  it('decodes the double-encoded post payload', () => {
    const msg = parsePostedEvent(postedEvent({}));
    expect(msg).not.toBeNull();
    expect(msg).toMatchObject({
      channelId: 'chan_xyz',
      channelName: 'town-square',
      channelType: 'O',
      userId: 'user_alice',
      senderName: '@alice',
      message: 'Hallo Bot',
      postId: 'post123',
      rootId: '',
      teamId: 'team_abc',
    });
  });

  it('extracts the thread root_id for replies', () => {
    const msg = parsePostedEvent(postedEvent({ root_id: 'rootABC' }));
    expect(msg?.rootId).toBe('rootABC');
  });

  it('parses the JSON-encoded mentions array', () => {
    const msg = parsePostedEvent(postedEvent({}, { mentions: JSON.stringify(['bot_id', 'other']) }));
    expect(msg?.mentions).toEqual(['bot_id', 'other']);
  });

  it('defaults mentions to [] when absent or malformed', () => {
    expect(parsePostedEvent(postedEvent({}))!.mentions).toEqual([]);
    expect(parsePostedEvent(postedEvent({}, { mentions: 'not-json' }))!.mentions).toEqual([]);
  });

  it('suppresses the bot\'s own messages (echo) when selfUserId matches', () => {
    const evt = postedEvent({ user_id: 'bot_self' });
    expect(parsePostedEvent(evt, 'bot_self')).toBeNull();
    expect(parsePostedEvent(evt, 'someone_else')).not.toBeNull();
  });

  it('ignores system posts that carry a non-empty type (join/leave/etc.)', () => {
    expect(parsePostedEvent(postedEvent({ type: 'system_join_channel' }))).toBeNull();
  });

  it('extracts file attachments (id, name, extension) from post metadata', () => {
    const msg = parsePostedEvent(postedEvent({
      file_ids: ['f1', 'f2'],
      metadata: { files: [
        { id: 'f1', name: 'sunset.jpg', extension: 'jpg' },
        { id: 'f2', name: 'notes.pdf', extension: 'pdf' },
      ] },
    }));
    expect(msg?.files).toEqual([
      { id: 'f1', name: 'sunset.jpg', extension: 'jpg' },
      { id: 'f2', name: 'notes.pdf', extension: 'pdf' },
    ]);
  });

  it('falls back to file_ids when metadata.files is absent', () => {
    const msg = parsePostedEvent(postedEvent({ file_ids: ['x1'] }));
    expect(msg?.files).toEqual([{ id: 'x1' }]);
  });

  it('defaults files to [] for a text-only post', () => {
    expect(parsePostedEvent(postedEvent({}))?.files).toEqual([]);
  });

  it('returns null for non-posted events', () => {
    expect(parsePostedEvent({ event: 'typing', data: {} })).toBeNull();
    expect(parsePostedEvent({ event: 'hello', data: {} })).toBeNull();
  });

  it('returns null on malformed input', () => {
    expect(parsePostedEvent(null)).toBeNull();
    expect(parsePostedEvent('string')).toBeNull();
    expect(parsePostedEvent({ event: 'posted' })).toBeNull(); // no data
    expect(parsePostedEvent({ event: 'posted', data: { post: '{bad json' } })).toBeNull();
    expect(parsePostedEvent({ event: 'posted', data: { post: JSON.stringify({ channel_id: 'c' }) } })).toBeNull(); // no user_id
  });
});

describe('toWebsocketUrl', () => {
  it('maps https→wss and appends the websocket path', () => {
    expect(toWebsocketUrl('https://chat.example.com')).toBe('wss://chat.example.com/api/v4/websocket');
  });
  it('maps http→ws', () => {
    expect(toWebsocketUrl('http://localhost:8065')).toBe('ws://localhost:8065/api/v4/websocket');
  });
  it('strips trailing slashes', () => {
    expect(toWebsocketUrl('https://chat.example.com/')).toBe('wss://chat.example.com/api/v4/websocket');
  });
});

describe('MattermostRpcClient.connectWithRetry (boot resilience)', () => {
  it('does not throw when the initial connect fails — schedules a background reconnect instead', async () => {
    // A boot-time outage (Mattermost server unreachable) must NOT kill the
    // process. A bare rpc.connect() rejection propagates to bootMessenger's
    // process.exit(1); connectWithRetry swallows it and hands off to the
    // self-rescheduling backoff loop instead, mirroring Signal's boot path.
    const OrigWS = globalThis.WebSocket;
    let ctorCalls = 0;
    // A WebSocket whose constructor throws → connect() rejects in its ctor
    // try/catch, without ever attaching a socket.
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
      constructor() {
        ctorCalls++;
        throw new Error('server unreachable');
      }
    };
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      await expect(rpc.connectWithRetry()).resolves.toBeUndefined();
      expect(ctorCalls).toBe(1);
      rpc.stop(); // clears the scheduled reconnect so the timer does not leak
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = OrigWS;
    }
  });

  it('resolveUserWithRetry resolves a username via /users/username/{name}', async () => {
    const OrigFetch = globalThis.fetch;
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ id: 'u12345678901234567890123456', username: 'niko' }) };
    }) as unknown as typeof fetch;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      const u = await rpc.resolveUserWithRetry('niko');
      expect(u.id).toBe('u12345678901234567890123456');
      expect(calledUrl).toBe('https://chat.example.com/api/v4/users/username/niko');
    } finally {
      globalThis.fetch = OrigFetch;
    }
  });

  it('resolveUserWithRetry validates a configured 26-char owner id via /users/{id}', async () => {
    const OrigFetch = globalThis.fetch;
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ id: 'a1b2c3d4e5f6g7h8i9j0k1l2m3', username: 'niko' }) };
    }) as unknown as typeof fetch;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      const u = await rpc.resolveUserWithRetry('a1b2c3d4e5f6g7h8i9j0k1l2m3');
      expect(u.username).toBe('niko');
      expect(calledUrl).toBe('https://chat.example.com/api/v4/users/a1b2c3d4e5f6g7h8i9j0k1l2m3');
    } finally {
      globalThis.fetch = OrigFetch;
    }
  });

  it('resolveUserWithRetry fails immediately when the configured owner returns 404', async () => {
    const OrigFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 404, text: async () => 'user not found' };
    }) as unknown as typeof fetch;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      await expect(rpc.resolveUserWithRetry('mistyped-owner')).rejects.toThrow(/404.*user not found/);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = OrigFetch;
    }
  });

  it('resolveUserWithRetry waits out a boot-time outage and retries', async () => {
    vi.useFakeTimers();
    const OrigFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 2) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ id: 'z12345678901234567890123456', username: 'niko' }) };
    }) as unknown as typeof fetch;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      const p = rpc.resolveUserWithRetry('niko');
      await vi.advanceTimersByTimeAsync(2_000); // covers the 1s backoff
      const u = await p;
      expect(u.username).toBe('niko');
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = OrigFetch;
      vi.useRealTimers();
    }
  });

  it('downloadFile GETs the file bytes from /files/{id} with bearer auth', async () => {
    const OrigFetch = globalThis.fetch;
    let calledUrl = '';
    let calledAuth = '';
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      calledUrl = url;
      calledAuth = init.headers.Authorization;
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('IMGDATA').buffer };
    }) as unknown as typeof fetch;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 'tok' });
      const buf = await rpc.downloadFile('file123');
      expect(calledUrl).toBe('https://chat.example.com/api/v4/files/file123');
      expect(calledAuth).toBe('Bearer tok');
      expect(buf.toString()).toBe('IMGDATA');
    } finally {
      globalThis.fetch = OrigFetch;
    }
  });

  it('downloadFile throws on a non-ok response', async () => {
    const OrigFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 404, text: async () => 'not found' })) as unknown as typeof fetch;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://x', token: 't' });
      await expect(rpc.downloadFile('missing')).rejects.toThrow(/404/);
    } finally {
      globalThis.fetch = OrigFetch;
    }
  });

  it('getMeWithRetry waits out a boot-time outage and resolves once the server responds', async () => {
    // getMe() runs FIRST in the bot's start() — before connectWithRetry — and a
    // bare failure re-throws to process.exit(1). getMeWithRetry retries with
    // backoff so a server that is still starting is waited out, not crash-looped.
    vi.useFakeTimers();
    const OrigFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ id: 'bot1', username: 'claudeclaw', is_bot: true }) };
    }) as unknown as typeof fetch;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      const p = rpc.getMeWithRetry();
      await vi.advanceTimersByTimeAsync(5_000); // covers the 1s + 2s backoffs
      const me = await p;
      expect(me.id).toBe('bot1');
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = OrigFetch;
      vi.useRealTimers();
    }
  });
});

describe('ownsChannel (multi-process routing by channel ID)', () => {
  const id = (label: string) => label.padEnd(26, '0').slice(0, 26); // 26-char ID fixture
  const map = { [id('support')]: 'comms', [id('ops')]: 'ops', [id('research')]: 'research' };
  const opts = { channelAgentMap: map, defaultAgent: 'main', mentionOnlyChannels: [id('general')] };

  it('routes a mapped channel to exactly its agent', () => {
    expect(ownsChannel(id('support'), 'comms', opts)).toBe(true);
    expect(ownsChannel(id('support'), 'main', opts)).toBe(false);
    expect(ownsChannel(id('ops'), 'ops', opts)).toBe(true);
    expect(ownsChannel(id('ops'), 'comms', opts)).toBe(false);
  });

  it('routes an unmapped channel to the default agent (main)', () => {
    expect(ownsChannel(id('random'), 'main', opts)).toBe(true);
    expect(ownsChannel(id('random'), 'ops', opts)).toBe(false);
  });

  it('routes a mention-only channel to the default agent', () => {
    expect(ownsChannel(id('general'), 'main', opts)).toBe(true);
    expect(ownsChannel(id('general'), 'comms', opts)).toBe(false);
  });

  it('partitions channels disjointly across agents (no double-handling)', () => {
    const channels = [id('support'), id('ops'), id('research'), id('general'), id('misc')];
    const agents = ['main', 'comms', 'ops', 'research'];
    for (const ch of channels) {
      const owners = agents.filter((a) => ownsChannel(ch, a, opts));
      expect(owners).toHaveLength(1); // exactly one process owns each channel
    }
  });
});

describe('MattermostRpcClient reconnect guard (exactly one backoff loop)', () => {
  // A failed WebSocket upgrade fires BOTH 'error' and 'close' on the socket,
  // and connectWithRetry's catch ALSO schedules a reconnect. Without the
  // reconnectTimer guard that stacks two backoff loops — the latent bug the
  // 2026-08 hardening commit fixed. These tests pin that behaviour.

  /** WebSocket mock: records listeners, never connects; the test fires events. */
  function makeFailingWs() {
    return class {
      static instances: unknown[] = [];
      listeners = new Map<string, Array<(ev: unknown) => void>>();
      readyState = 0;
      constructor() {
        (this.constructor as unknown as { instances: unknown[] }).instances.push(this);
      }
      addEventListener(type: string, fn: (ev: unknown) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      fire(type: string) {
        for (const fn of this.listeners.get(type) ?? []) fn({ type });
      }
      send() { /* noop */ }
      close() { /* noop */ }
    };
  }

  it('error-then-close on a failed upgrade schedules exactly ONE reconnect', async () => {
    vi.useFakeTimers();
    const OrigWS = globalThis.WebSocket;
    const Mock = makeFailingWs() as unknown as { new (): unknown; instances: unknown[] };
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = Mock;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      // Start the boot connect, settle its promise via the error event, THEN
      // fire close — the upgrade-failure sequence the guard exists for.
      const booting = rpc.connectWithRetry();
      const first = Mock.instances[0] as { fire: (t: string) => void };
      first.fire('error'); // upgrade rejected → connectWithRetry swallows
      await booting;
      first.fire('close'); // socket torn down right after — must NOT stack a second timer
      expect(Mock.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000); // well past the first backoff
      // Exactly one reconnect attempt (the guard collapsed error+close into one).
      expect(Mock.instances).toHaveLength(2);
      const second = Mock.instances[1] as { fire: (t: string) => void };
      second.fire('error');
      second.fire('close');
      await vi.advanceTimersByTimeAsync(120_000); // past the doubled backoff
      expect(Mock.instances).toHaveLength(3);
      rpc.stop();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = OrigWS;
      vi.useRealTimers();
    }
  });

  it('backoff caps at 30s instead of growing unbounded', async () => {
    vi.useFakeTimers();
    const OrigWS = globalThis.WebSocket;
    // Self-failing WS: every constructed socket fails after a tick, so the
    // reconnect chain runs autonomously and only the TIMING decides how many
    // attempts fit into a window. With the 30s cap the cumulative reconnect
    // times are 1,3,7,15,31,61,91,121s → 8 reconnects within 150s. An
    // unbounded ladder (…16,32,64,128) reaches only 7. That difference pins
    // the cap without reading private fields.
    const Mock = class {
      static instances: unknown[] = [];
      listeners = new Map<string, Array<(ev: unknown) => void>>();
      readyState = 0;
      constructor() {
        (this.constructor as unknown as { instances: unknown[] }).instances.push(this);
        setTimeout(() => {
          for (const fn of this.listeners.get('error') ?? []) fn({ type: 'error' });
          for (const fn of this.listeners.get('close') ?? []) fn({ type: 'close' });
        }, 0);
      }
      addEventListener(type: string, fn: (ev: unknown) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      send() { /* noop */ }
      close() { /* noop */ }
    } as unknown as { new (): unknown; instances: unknown[] };
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = Mock;
    try {
      const rpc = new MattermostRpcClient({ baseUrl: 'https://chat.example.com', token: 't' });
      const booting = rpc.connectWithRetry();
      await vi.advanceTimersByTimeAsync(150_000); // runs the whole self-failing chain
      await booting;
      expect(Mock.instances).toHaveLength(9); // initial + 8 capped reconnects
      rpc.stop();
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = OrigWS;
      vi.useRealTimers();
    }
  });
});
