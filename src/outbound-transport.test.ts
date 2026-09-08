import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from 'grammy';
import { EventEmitter } from 'node:events';
import { outboundTelegramTransformer, serializeOutboundJson, sanitizePresentation, outboundText } from './outbound-payload.js';
import { SignalRpcClient } from './signal-rpc.js';
import { MattermostRpcClient } from './mattermost-rpc.js';
import { chatEvents, emitChatEvent } from './state.js';
import { MeetingChannel } from './warroom-text-events.js';
import { _initTestDatabase, createTextMeeting, addWarRoomTranscript, getWarRoomTranscript,
  saveWarRoomConversationTurn, getRecentConversation } from './db.js';

const secret = 'synthetic alpha beta credential';
vi.mock('./outbound-policy.js', () => ({
  outboundOptionsForSeam: (seam: string) => ({ seam, enabled: true,
    protectedValues: ['synthetic alpha beta credential'] }),
}));
beforeEach(() => _initTestDatabase());
afterEach(() => vi.unstubAllGlobals());

it.each(['sendMessage', 'editMessageText', 'editMessageCaption'] as const)(
  'captures sanitized Telegram %s payload at the actual Api callback', async (method) => {
    const api = new Api('123:synthetic');
    const bytes: string[] = [];
    api.config.use(async (_prev, _method, payload) => {
      bytes.push(JSON.stringify(payload));
      return { ok: true, result: true } as any;
    });
    api.config.use(outboundTelegramTransformer);
    if (method === 'sendMessage') await api.sendMessage(7, secret);
    else if (method === 'editMessageText') await api.editMessageText(7, 1, secret);
    else await api.editMessageCaption(7, 1, { caption: secret });
    expect(bytes).toHaveLength(1);
    expect(bytes[0]).not.toContain(secret);
    expect(bytes[0]).toContain('[REDACTED]');
    expect(JSON.parse(bytes[0]).chat_id).toBe(7);
  },
);

it('captures Signal newline JSON frames for sends and attachment captions without a socket', async () => {
  const client = new SignalRpcClient({ host: 'unused.invalid', port: 1 });
  const bytes: string[] = [];
  // Replace only the physical socket. Real call framing and response handling run.
  const socket = Object.assign(new EventEmitter(), {
    write: (body: string) => {
      bytes.push(body);
      const { id } = JSON.parse(body);
      queueMicrotask(() => (client as any).onData(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n')));
      return true;
    },
  });
  (client as any).socket = socket;
  await client.send('+15550000000', secret);
  await client.sendWithAttachments('+15550000000', secret, []);
  expect(bytes).toHaveLength(2);
  for (const body of bytes) {
    expect(body.endsWith('\n')).toBe(true);
    expect(JSON.parse(body).params.message).toBe('[REDACTED]');
  }
});

it('sanitizes visible Telegram metadata and dashboard photo URLs without rewriting routing fields', async () => {
  const api = new Api('123:synthetic');
  let captured: any;
  api.config.use(async (_prev, _method, payload) => { captured = payload; return { ok: true, result: true } as any; });
  api.config.use(outboundTelegramTransformer);
  await api.sendMessage(7, 'Safe text', { reply_markup: { inline_keyboard: [[
    { text: secret, url: `https://example.invalid/${encodeURIComponent(secret)}` },
    { text: 'Choose', callback_data: 'question:7:option:1' },
  ]] } });
  const metadata = JSON.stringify(captured);
  expect(metadata).not.toContain('synthetic');
  expect(captured.reply_markup.inline_keyboard[0][1].callback_data).toBe('question:7:option:1');
  expect(captured.chat_id).toBe(7);
  const photo = sanitizePresentation({ type: 'assistant_photo', chatId: '7',
    url: `https://example.invalid/${encodeURIComponent(secret)}`, caption: secret }, 'dashboard.photo');
  expect(JSON.stringify(photo)).not.toContain('synthetic');
  expect(photo.chatId).toBe('7');
});

it('captures Mattermost POST JSON with routing intact and no external fetch', async () => {
  const bytes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    bytes.push(init.body);
    return new Response('{}', { status: 200 });
  }));
  const client = new MattermostRpcClient({ baseUrl: 'https://unused.invalid', token: 'synthetic-auth' });
  await client.postMessage('channel', secret, 'root');
  expect(JSON.parse(bytes[0])).toEqual({ channel_id: 'channel', message: '[REDACTED]', root_id: 'root' });
});

it('captures dashboard event callback JSON including nested progress fields', () => {
  const bytes: string[] = [];
  const capture = (event: unknown) => bytes.push(serializeOutboundJson(event, 'dashboard.sse'));
  chatEvents.on('chat', capture);
  try {
    emitChatEvent({ type: 'progress', chatId: 'chat', description: secret,
      locations: [{ path: secret }], planEntries: [{ content: secret, status: 'pending' }] });
    emitChatEvent({ type: 'error', chatId: 'chat', content: secret });
    emitChatEvent({ type: 'assistant_message', chatId: 'chat', content: secret });
  } finally { chatEvents.off('chat', capture); }
  expect(bytes).toHaveLength(3);
  expect(bytes.join('')).not.toContain(secret);
  expect(bytes.every((body) => body.includes('[REDACTED]'))).toBe(true);
});

it.each(['response', 'error'])('captures the voice JSON %s serializer', (field) => {
  const body = serializeOutboundJson({ response: null, error: null, usage: { input_tokens: 3 }, [field]: secret }, 'voice.json');
  expect(JSON.parse(body)[field]).toBe('[REDACTED]');
  expect(JSON.parse(body).usage.input_tokens).toBe(3);
});

it('captures War Room emitted, replayed, transcript and conversation text', () => {
  createTextMeeting('meeting', 'chat');
  const channel = new MeetingChannel();
  const bytes: string[] = [];
  const unsubscribe = channel.subscribe((entry) => bytes.push(JSON.stringify(entry)));
  channel.emit({ type: 'agent_done', turnId: 'turn', agentId: 'main', role: 'primary', text: secret });
  channel.emit({ type: 'tool_result', turnId: 'turn', agentId: 'main', toolUseId: 'tool', status: 'error', resultPreview: secret });
  channel.emit({ type: 'error', message: secret, recoverable: true });
  unsubscribe();
  addWarRoomTranscript('meeting', 'main', secret);
  saveWarRoomConversationTurn({ chatId: 'chat', agentId: 'main', originalUserText: 'hello',
    agentReply: secret, meetingId: 'meeting', turnId: 'turn' });
  expect(bytes).toHaveLength(3);
  expect(bytes.join('')).not.toContain(secret);
  expect(JSON.stringify(channel.since(0))).not.toContain(secret);
  expect(getWarRoomTranscript('meeting')[0].text).toBe('[REDACTED]');
  expect(getRecentConversation('chat', 10).find((row) => row.role === 'assistant')?.content).toBe('[REDACTED]');
});

it('scans tool content before truncation and keeps progress inputs immutable', () => {
  const input = { description: secret, locations: [{ path: secret }], planEntries: [{ content: secret }] };
  expect(JSON.stringify(sanitizePresentation(input, 'agent.progress'))).not.toContain(secret);
  expect(input.description).toBe(secret);
  expect(outboundText('x'.repeat(230) + secret, 'warroom.tool.result').slice(0, 240)).toBe('x'.repeat(230) + '[REDACTED]');
});
