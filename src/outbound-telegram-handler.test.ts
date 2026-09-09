import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from './agent-engine/types.js';

const fixture = vi.hoisted(() => ({ mode: 'success', calls: 0, failEdit: false,
  secret: 'alpha\nbeta "quoted" \\ credential', bytes: [] as string[], pending: [] as Promise<void>[] }));
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
  AGENT_ID: 'main', ALLOWED_CHAT_ID: '7', activeBotToken: '123:fixture', agentCwd: '/nonexistent/fixture',
  agentSystemPrompt: '', agentProvider: { type: 'claude', model: 'fixture' }, agentDefaultModel: 'fixture',
  MEMORY_NOTIFY: false, SMART_ROUTING_ENABLED: false, SHOW_COST_FOOTER: false, STREAM_STRATEGY: 'edit' }));
vi.mock('./outbound-policy.js', () => ({
  resolveOutboundPolicy: () => ({ enabled: true, protectedValues: [fixture.secret] }),
  outboundOptionsForSeam: () => ({ enabled: true, protectedValues: [fixture.secret] }),
}));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./security.js', async original => ({ ...await original<typeof import('./security.js')>(),
  getScrubbedSdkEnv: () => ({}), isLocked: () => false, touchActivity: () => {}, audit: () => {}, checkKillPhrase: () => false }));
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
  vi.stubEnv('HOME', '/nonexistent/fixture'); vi.stubEnv('USERPROFILE', '/nonexistent/fixture'); });
afterEach(() => vi.unstubAllEnvs());

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
