import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ bytes: [] as string[], failEdit: false, enabled: true,
  locked: false, provider: 'openai', queued: [] as unknown[], pending: 1 }));
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
  AGENT_ID: 'main', ALLOWED_CHAT_ID: '7', activeBotToken: '123:fixture',
  get MIDTURN_STEERING_ENABLED() { return fixture.enabled; },
}));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./security.js', async original => ({ ...await original<typeof import('./security.js')>(),
  isLocked: () => fixture.locked, unlock: () => false, touchActivity: () => {}, audit: () => {}, checkKillPhrase: () => false }));
vi.mock('./message-queue.js', () => ({ messageQueue: {
  enqueue: (_id: string, fn: unknown) => { fixture.queued.push(fn); fixture.pending++; },
  queuedFor: () => fixture.pending,
} }));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: () => ({ type: fixture.provider }), defaultModelForProvider: () => 'fixture' }));
vi.mock('./memory-ingest.js', () => ({ setHighImportanceCallback: () => {} }));
import { createBot } from './bot.js';
import { registerChatSteering } from './steering.js';
import { _initTestDatabase, getRecentConversation } from './db.js';

beforeEach(() => { fixture.bytes = []; fixture.queued = []; fixture.pending = 1;
  fixture.enabled = true; fixture.locked = false; fixture.provider = 'openai'; _initTestDatabase(); });

async function send(bot: ReturnType<typeof createBot>, overrides: Record<string, unknown> = {}) {
  await bot.handleUpdate({ update_id: 901, message: { message_id: 901, date: 1,
    chat: { id: 7, type: 'private', first_name: 'User' }, from: { id: 7, is_bot: false, first_name: 'User' },
    text: '/steer Steering fixture update', entities: [{ type: 'bot_command', offset: 0, length: 6 }], ...overrides } } as any);
}

it.each(['accepted', 'uncertain', 'not-delivered'] as const)('routes %s exactly once', async status => {
  const submit = vi.fn(async () => status === 'not-delivered'
    ? { status, reason: 'closed' } as const : { status });
  const remove = registerChatSteering('main', '7', JSON.stringify({ type: 'openai' }))({
    sessionId: 'steering-fixture', turnId: 't1', submit,
  });
  try {
    const bot = createBot();
    await send(bot);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(fixture.queued).toHaveLength(status === 'not-delivered' ? 1 : 0);
    expect(fixture.bytes.join('')).toContain(status === 'accepted' ? 'Update accepted'
      : status === 'uncertain' ? 'Could not confirm' : 'Queued as a follow-up');
    if (status !== 'not-delivered') {
      const count = () => getRecentConversation('7', 100).filter(row => row.content === 'Steering fixture update').length;
      const before = count();
      await send(bot);
      expect(count()).toBe(before);
    }
  } finally { remove(); }
});

it.each(['disabled', 'locked', 'unauthorized', 'group', 'forwarded', 'provider', 'queued', 'command', 'stop', 'via-bot'])(
  'does not steer %s input', async mode => {
    const submit = vi.fn(async () => ({ status: 'accepted' as const }));
    const remove = registerChatSteering('main', '7', JSON.stringify({ type: 'openai' }))({ sessionId: 's', turnId: 't', submit });
    const overrides: Record<string, unknown> = {};
    if (mode === 'disabled') fixture.enabled = false;
    if (mode === 'locked') fixture.locked = true;
    if (mode === 'provider') fixture.provider = 'claude';
    if (mode === 'queued') fixture.pending = 2;
    if (mode === 'unauthorized') overrides.chat = { id: 8, type: 'private' };
    if (mode === 'group') overrides.chat = { id: 7, type: 'group', title: 'group' };
    if (mode === 'forwarded') overrides.forward_origin = { type: 'hidden_user', date: 1, sender_user_name: 'External' };
    if (mode === 'command') { overrides.text = '/todo something'; overrides.entities = [{ type: 'bot_command', offset: 0, length: 5 }]; }
    if (mode === 'stop') { overrides.text = '/stop'; overrides.entities = [{ type: 'bot_command', offset: 0, length: 5 }]; }
    if (mode === 'via-bot') overrides.via_bot = { id: 9, is_bot: true, first_name: 'external' };
    try { await send(createBot(), overrides); expect(submit).not.toHaveBeenCalled(); }
    finally { remove(); }
  },
);

it('keeps ordinary messages queued even when an active adapter supports steering', async () => {
  const submit = vi.fn(async () => ({ status: 'accepted' as const }));
  const remove = registerChatSteering('main', '7', JSON.stringify({ type: 'openai' }))({ sessionId: 's', turnId: 't', submit });
  try {
    await send(createBot(), { text: 'Do this next', entities: [] });
    expect(submit).not.toHaveBeenCalled();
    expect(fixture.queued).toHaveLength(1);
  } finally { remove(); }
});

it('reports unavailable capability without silently queuing the command', async () => {
  await send(createBot());
  expect(fixture.queued).toHaveLength(0);
  expect(fixture.bytes.join('')).toContain('Steering is not available');
});

it('shows usage for an empty steer without starting work', async () => {
  await send(createBot(), { text: '/steer' });
  expect(fixture.queued).toHaveLength(0);
  expect(fixture.bytes.join('')).toContain('Usage: /steer');
});
