import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from './agent-engine/types.js';

const fixture = vi.hoisted(() => ({ mode: 'success', calls: 0, failEdit: false,
  dashboardToken: 'a1'.repeat(32), dashboardUrl: '', owner: '7', locked: false, detectorFailure: false,
  secret: 'alpha\nbeta "quoted" \\ credential', bytes: [] as string[], pending: [] as Promise<void>[],
  narrated: undefined as (() => void) | undefined, resume: undefined as Promise<void> | undefined }));
vi.mock('grammy', async original => {
  const grammy = await original<typeof import('grammy')>();
  return { ...grammy, Bot: class extends grammy.Bot {
    constructor(token: string) {
      super(token, { botInfo: { id: 1, is_bot: true, first_name: 'Fixture', username: 'fixture_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
        allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
      client: { fetch: (async (url: unknown, init: any) => {
        const method = String(url).split('/').at(-1);
        const body = JSON.parse(init.body);
        fixture.bytes.push(JSON.stringify({ method, ...body }));
        if (method === 'editMessageText' && fixture.failEdit) {
          fixture.failEdit = false;
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Synthetic edit failure' }));
        }
        return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage'
          ? { message_id: fixture.bytes.length, chat: { id: 7, type: 'private' }, date: 1, text: body.text } : true }));
      }) as any } });
    }
  } };
});
vi.mock('./config.js', async original => ({ ...await original<typeof import('./config.js')>(),
  AGENT_ID: 'main', get ALLOWED_CHAT_ID() { return fixture.owner; }, activeBotToken: '123:fixture', agentCwd: '/nonexistent/fixture',
  get DASHBOARD_TOKEN() { return fixture.dashboardToken; }, get DASHBOARD_URL() { return fixture.dashboardUrl; }, DASHBOARD_PORT: 3141,
  agentSystemPrompt: '', agentProvider: { type: 'claude', model: 'fixture' }, agentDefaultModel: 'fixture',
  MEMORY_NOTIFY: false, SMART_ROUTING_ENABLED: false, SHOW_COST_FOOTER: false, STREAM_STRATEGY: 'edit' }));
vi.mock('./outbound-policy.js', () => ({
  resolveOutboundPolicy: () => ({ enabled: true, protectedValues: [fixture.secret, fixture.dashboardToken] }),
  outboundOptionsForSeam: () => ({ enabled: true, protectedValues: fixture.detectorFailure
    ? { [Symbol.iterator]() { throw new Error('Synthetic detector failure'); } }
    : [fixture.secret, fixture.dashboardToken] }),
}));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./security.js', async original => ({ ...await original<typeof import('./security.js')>(),
  getScrubbedSdkEnv: () => ({}), isLocked: () => fixture.locked, touchActivity: () => {}, audit: () => {}, checkKillPhrase: () => false }));
vi.mock('./kill-switches.js', () => ({ requireEnabled: () => {} }));
vi.mock('./memory.js', async () => {
  const db = await import('./db.js');
  return { buildMemoryContext: async () => ({ contextText: '', surfacedMemoryIds: [], surfacedMemorySummaries: [] }),
    shouldNudgeMemory: () => false, saveConversationTurn: (chat: string, _input: string, output: string) => db.logConversationTurn(chat, 'assistant', output),
    evaluateMemoryRelevance: async () => {} };
});
vi.mock('./memory-ingest.js', () => ({ setHighImportanceCallback: () => {} }));
vi.mock('./message-queue.js', () => ({ messageQueue: { enqueue: (_key: string, task: () => Promise<void>) => fixture.pending.push(task()),
  queuedFor: () => 0 } }));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: () => ({ type: 'claude', model: 'fixture' }), defaultModelForProvider: () => 'fixture' }));
vi.mock('./voice.js', () => ({ voiceCapabilities: () => ({ tts: false, stt: false }) }));
vi.mock('./agent-engine/index.js', () => ({ engineSupportsSystemPrompt: () => true, EngineFactory: { forProvider: () => ({
  async *invoke(_input: AgentTurnInput) {
    fixture.calls++;
    if (fixture.mode === 'dashboard-leak') {
      yield { type: 'result', text: `http://localhost:3141/?token=${fixture.dashboardToken}&chatId=7`, usage: null, stopReason: 'end_turn' };
      return;
    }
    if (fixture.mode === 'live-narration') {
      const prefix = 'Checking the configuration.\n';
      yield { type: 'text_delta', delta: prefix + fixture.secret.slice(0, 7), accumulatedText: prefix + fixture.secret.slice(0, 7) };
      yield { type: 'progress', progress: { type: 'tool_active', toolCallId: 'read', description: 'Reading settings', kind: 'read' } };
      fixture.narrated?.();
      await fixture.resume;
      yield { type: 'text_delta', delta: fixture.secret.slice(7), accumulatedText: prefix + fixture.secret };
      yield { type: 'result', text: prefix + fixture.secret, usage: null, stopReason: 'end_turn' };
      return;
    }
    yield { type: 'progress', progress: { type: 'tool_active', toolCallId: 'fixture', description: fixture.secret, kind: 'other' } };
    yield { type: 'text_delta', delta: fixture.secret.slice(0, 7), accumulatedText: fixture.secret.slice(0, 7) };
    yield { type: 'text_delta', delta: fixture.secret.slice(7), accumulatedText: fixture.secret };
    if (fixture.mode === 'error') throw new Error(fixture.secret);
    if (fixture.mode === 'abort') { yield { type: 'aborted', text: fixture.secret, usage: null }; return; }
    yield { type: 'result', text: fixture.secret, usage: null, stopReason: 'end_turn' };
  },
}) } }));

import { createBot } from './bot.js';
import { _initTestDatabase, getRecentConversation } from './db.js';
import { chatEvents } from './state.js';

beforeEach(() => { _initTestDatabase(); fixture.bytes = []; fixture.pending = []; fixture.calls = 0;
  fixture.dashboardToken = 'a1'.repeat(32); fixture.dashboardUrl = ''; fixture.owner = '7'; fixture.locked = false; fixture.detectorFailure = false;
  vi.stubEnv('HOME', '/nonexistent/fixture'); vi.stubEnv('USERPROFILE', '/nonexistent/fixture'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); fixture.narrated = undefined; fixture.resume = undefined; });

it('publishes short safe narration during a paused tool phase, before provider completion', async () => {
  vi.useFakeTimers();
  fixture.mode = 'live-narration'; fixture.failEdit = false;
  const narrated = new Promise<void>(resolve => { fixture.narrated = resolve; });
  let resume!: () => void;
  fixture.resume = new Promise<void>(resolve => { resume = resolve; });
  try {
    const bot = createBot();
    await bot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 1,
      chat: { id: 7, type: 'private', first_name: 'User' }, from: { id: 7, is_bot: false, first_name: 'User' }, text: 'Check settings' } });
    await narrated;
    expect(fixture.bytes.join('')).not.toContain('Checking the configuration');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.bytes.join('')).toContain('Checking the configuration.');
    expect(fixture.bytes.join('')).toContain('Reading settings');
    expect(fixture.bytes.join('')).not.toContain('alpha');
    resume();
    await Promise.all(fixture.pending);
    expect(fixture.bytes.join('')).toContain('[REDACTED]');
    expect(fixture.bytes.join('')).not.toContain('alpha');
  } finally { resume(); await Promise.all(fixture.pending); }
});

it.each(['success', 'edit-fallback', 'abort', 'error'])(
  'captures actual Telegram handler %s from fake provider through API bytes and stored output', async mode => {
    fixture.mode = mode; fixture.failEdit = mode === 'edit-fallback';
    const events: string[] = [];
    const capture = (event: unknown) => events.push(JSON.stringify(event));
    chatEvents.on('chat', capture);
    try {
      const bot = createBot();
      await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1,
        chat: { id: 7, type: 'private', first_name: 'User' }, from: { id: 7, is_bot: false, first_name: 'User' }, text: 'Synthetic request' } });
      await Promise.all(fixture.pending);
      expect(fixture.calls).toBe(1);
      expect(fixture.bytes.join('')).not.toContain('alpha');
      expect(events.join('')).not.toContain('alpha');
      expect(JSON.stringify(getRecentConversation('7', 10))).not.toContain('alpha');
      expect(fixture.bytes.some(body => /sendMessage|editMessageText/.test(body))).toBe(true);
      if (mode === 'success' || mode === 'edit-fallback') {
        expect(fixture.bytes.join('')).toContain('[REDACTED]');
        expect(getRecentConversation('7', 10).some(row => row.content === '[REDACTED]')).toBe(true);
      }
    } finally { chatEvents.off('chat', capture); }
  },
);

async function dashboardCommand(bot = createBot(), chatId = 7, group = false): Promise<void> {
  await bot.handleUpdate({ update_id: 3, message: { message_id: 3, date: 1,
    chat: group ? { id: chatId, type: 'group', title: 'Group' } : { id: chatId, type: 'private', first_name: 'User' },
    from: { id: chatId, is_bot: false, first_name: 'User' }, text: '/dashboard',
    entities: [{ type: 'bot_command', offset: 0, length: 10 }] } });
}

function dashboardMessage() {
  return fixture.bytes.map(body => JSON.parse(body)).find(body => body.method === 'sendMessage'
    && (body.text?.startsWith('Click the button to copy Dashboard Link')
      || (body.text?.startsWith('Dashboard') && body.text.includes('?token='))));
}

it('delivers a complete local dashboard link and copy button only for the explicit command', async () => {
  const bot = createBot();
  await dashboardCommand(bot);
  const link = `http://localhost:3141/?token=${fixture.dashboardToken}&chatId=7`;
  const message = dashboardMessage();
  expect(message.text).toBe('Click the button to copy Dashboard Link to the clipboard.  Paste into browser to launch.');
  expect(message.reply_markup.inline_keyboard).toEqual([[{ text: 'Dashboard Link', copy_text: { text: link } }]]);
  expect(message.link_preview_options).toEqual({ is_disabled: true });
  expect(fixture.calls).toBe(0);
  expect(JSON.stringify(getRecentConversation('7', 10))).not.toContain(fixture.dashboardToken);

  // Repeating the same URL cannot opt into delivery.
  fixture.bytes = [];
  await bot.api.sendMessage(7, link, { reply_markup: { inline_keyboard: [[
    { text: 'Copy', copy_text: { text: link } }, { text: 'Open', url: link },
  ]] } });
  expect(fixture.bytes.join('')).not.toContain(fixture.dashboardToken);
  expect(fixture.bytes.join('')).toContain('[REDACTED]');
});

it('retains the public Open Dashboard button and also provides the copyable link', async () => {
  fixture.dashboardUrl = 'https://dashboard.example/nested/';
  await dashboardCommand();
  const message = dashboardMessage();
  const link = `https://dashboard.example/nested/?token=${fixture.dashboardToken}&chatId=7`;
  expect(message.text).toBe('Click the button to copy Dashboard Link to the clipboard.  Paste into browser to launch.');
  expect(message.reply_markup.inline_keyboard).toEqual([[
    { text: 'Open Dashboard', url: link }, { text: 'Dashboard Link', copy_text: { text: link } },
  ]]);
});

it.each(['http://localhost:3141', 'http://127.0.0.1:3141', 'http://127.0.0.2:3141', 'http://[::1]:3141', 'http://desktop.localhost:3141'])(
  'uses a copy button without an invalid URL button for %s', async base => {
    fixture.dashboardUrl = base;
    await dashboardCommand();
    const message = dashboardMessage();
    expect(message.text).not.toContain(fixture.dashboardToken);
    expect(message.reply_markup.inline_keyboard.flat()).toHaveLength(1);
    expect(message.reply_markup.inline_keyboard[0][0].copy_text.text).toContain(fixture.dashboardToken);
  },
);

it('keeps long local URLs complete without exceeding Telegram copy button limits', async () => {
  fixture.dashboardUrl = `http://localhost:3141/${'path/'.repeat(45)}`;
  await dashboardCommand();
  const message = dashboardMessage();
  expect(message.text).toContain(fixture.dashboardToken);
  expect(message.text).toContain(fixture.dashboardUrl);
  expect(message.reply_markup).toBeUndefined();
});

it('encodes the configured token as one query parameter', async () => {
  fixture.dashboardToken = 'dashboard & token+#/?';
  await dashboardCommand();
  const url = dashboardMessage().reply_markup.inline_keyboard[0][0].copy_text.text;
  const parsed = new URL(url);
  expect(parsed.searchParams.get('token')).toBe(fixture.dashboardToken);
  expect([...parsed.searchParams.keys()]).toEqual(['token', 'chatId']);
});

it.each(['unauthorized', 'locked', 'unconfigured owner', 'group'])(
  'does not disclose dashboard credentials for %s', async scenario => {
    fixture.locked = scenario === 'locked';
    if (scenario === 'unconfigured owner') fixture.owner = '';
    await dashboardCommand(createBot(), scenario === 'unauthorized' ? 8 : 7, scenario === 'group');
    expect(dashboardMessage()).toBeUndefined();
    expect(fixture.bytes.join('')).not.toContain(fixture.dashboardToken);
    expect(fixture.calls).toBe(0);
  },
);

it('keeps unrelated secrets redacted even inside an authorized dashboard reply', async () => {
  const unrelatedSecret = 'b2'.repeat(32);
  fixture.dashboardUrl = `https://dashboard.example/${unrelatedSecret}`;
  await dashboardCommand();
  expect(dashboardMessage().reply_markup.inline_keyboard[0].find((button: any) => button.copy_text).copy_text.text).toContain(fixture.dashboardToken);
  expect(fixture.bytes.join('')).not.toContain(unrelatedSecret);
  expect(fixture.bytes.join('')).toContain('[REDACTED]');
});

it('continues to redact dashboard links in generated output and conversation storage', async () => {
  const bot = createBot();
  await dashboardCommand(bot);
  fixture.bytes = [];
  fixture.mode = 'dashboard-leak';
  await bot.handleUpdate({ update_id: 4, message: { message_id: 4, date: 1,
    chat: { id: 7, type: 'private', first_name: 'User' },
    from: { id: 7, is_bot: false, first_name: 'User' }, text: 'Synthetic request' } });
  await Promise.all(fixture.pending);
  expect(fixture.calls).toBe(1);
  expect(fixture.bytes.join('')).not.toContain(fixture.dashboardToken);
  expect(JSON.stringify(getRecentConversation('7', 10))).not.toContain(fixture.dashboardToken);
  expect(fixture.bytes.join('')).toContain('[REDACTED]');
});

it('does not exempt concurrent ordinary messages or a replayed dashboard payload', async () => {
  const bot = createBot();
  let captured: Parameters<typeof bot.api.raw.sendMessage>[0] | undefined;
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === 'sendMessage' && 'text' in payload && payload.text?.startsWith('Click the button to copy Dashboard Link')) {
      captured = payload as NonNullable<typeof captured>;
    }
    return prev(method, payload, signal);
  });
  const link = `http://localhost:3141/?token=${fixture.dashboardToken}&chatId=7`;
  await Promise.all([dashboardCommand(bot), bot.api.sendMessage(7, `Ordinary ${link}`)]);
  const ordinary = fixture.bytes.map(body => JSON.parse(body)).find(body => body.text?.startsWith('Ordinary'));
  expect(ordinary.text).not.toContain(fixture.dashboardToken);
  expect(dashboardMessage().reply_markup.inline_keyboard[0].find((button: any) => button.copy_text).copy_text.text).toContain(fixture.dashboardToken);
  expect(captured).toBeDefined();

  fixture.bytes = [];
  await bot.api.raw.sendMessage(captured!);
  expect(fixture.bytes.join('')).not.toContain(fixture.dashboardToken);
});

it('withholds even an authorized dashboard token if the detector fails', async () => {
  fixture.detectorFailure = true;
  await dashboardCommand();
  expect(fixture.bytes.join('')).not.toContain(fixture.dashboardToken);
  expect(fixture.bytes.join('')).toContain('[output withheld: sanitizer error]');
});
