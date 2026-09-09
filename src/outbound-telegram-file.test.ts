import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from './agent-engine/types.js';

// Same fixture bot as outbound-telegram-handler.test.ts, but the captured
// requests keep their content-type and multipart bodies, so the test sees what
// grammY actually put on the wire for a file send.
const fixture = vi.hoisted(() => ({
  secret: 'alpha\nbeta "quoted" \\ credential',
  filePath: '', fileBytes: 'fixture document bytes 0123456789',
  requests: [] as { method: string; contentType: string; body: string }[],
  pending: [] as Promise<void>[],
}));
vi.mock('grammy', async original => {
  const grammy = await original<typeof import('grammy')>();
  return { ...grammy, Bot: class extends grammy.Bot {
    constructor(token: string) {
      super(token, { botInfo: { id: 1, is_bot: true, first_name: 'Fixture', username: 'fixture_bot',
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
        allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
      client: { fetch: (async (url: unknown, init: any) => {
        const method = String(url).split('/').at(-1) ?? '';
        const contentType = String(init.headers?.['content-type'] ?? '');
        let body: string;
        if (typeof init.body === 'string') body = init.body;
        else {
          const chunks: Buffer[] = [];
          for await (const chunk of init.body as Readable) chunks.push(Buffer.from(chunk));
          body = Buffer.concat(chunks).toString('utf8');
        }
        fixture.requests.push({ method, contentType, body });
        const result = method === 'sendMessage'
          ? { message_id: fixture.requests.length, chat: { id: 7, type: 'private' }, date: 1, text: JSON.parse(body).text }
          : method === 'sendDocument'
            ? { message_id: fixture.requests.length, chat: { id: 7, type: 'private' }, date: 1,
              document: { file_id: 'fixture', file_unique_id: 'fixture' } }
            : true;
        return new Response(JSON.stringify({ ok: true, result }));
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
    const text = `Here is the file [SEND_FILE:${fixture.filePath}|weekly report]`;
    yield { type: 'result', text, usage: null, stopReason: 'end_turn' };
  },
}) } }));

import { createBot } from './bot.js';
import { _initTestDatabase } from './db.js';

let tmpDir: string;
beforeEach(() => {
  _initTestDatabase(); fixture.requests = []; fixture.pending = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-outbound-file-'));
  fixture.filePath = path.join(tmpDir, 'report.md');
  fs.writeFileSync(fixture.filePath, fixture.fileBytes);
  vi.stubEnv('HOME', '/nonexistent/fixture'); vi.stubEnv('USERPROFILE', '/nonexistent/fixture');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

it('sends a [SEND_FILE] attachment through the Telegram API as a multipart upload', async () => {
  const bot = createBot();
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1,
    chat: { id: 7, type: 'private', first_name: 'User' }, from: { id: 7, is_bot: false, first_name: 'User' }, text: 'Send me the report' } });
  await Promise.all(fixture.pending);

  const upload = fixture.requests.find(request => request.method === 'sendDocument');
  expect(upload, 'sendDocument request').toBeDefined();
  // grammY only uploads an InputFile when the instance survives the outbound
  // transformer; a rebuilt plain object would arrive here as a JSON body.
  expect(upload!.contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(upload!.body).toContain('name="document"');
  expect(upload!.body).toContain('filename=report.md');
  expect(upload!.body).toContain(fixture.fileBytes);
  expect(upload!.body).toContain('name="caption"');
  expect(upload!.body).toContain('weekly report');
  // No error reply reached the chat.
  expect(fixture.requests.map(request => request.body).join('')).not.toContain('Failed to send file');
});
