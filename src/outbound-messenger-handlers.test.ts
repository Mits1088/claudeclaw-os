import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const fixture = vi.hoisted(() => ({ mode: 'success', calls: 0, voice: false,
  secret: 'alpha\nbeta "quoted" \\ credential', bytes: [] as string[], audit: [] as string[],
  pending: [] as Promise<void>[], signal: null as any, mattermost: null as any }));
vi.mock('./config.js', async original => ({ ...await original<typeof import('./config.js')>(),
  AGENT_ID: 'main', agentCwd: '/nonexistent/fixture', agentSystemPrompt: '',
  agentProvider: { type: 'claude', model: 'fixture' }, agentDefaultModel: 'fixture',
  SMART_ROUTING_ENABLED: false, SHOW_COST_FOOTER: false }));
vi.mock('./signal-config.js', () => ({ SIGNAL_PHONE_NUMBER: '+15550000000',
  SIGNAL_AUTHORIZED_RECIPIENTS: ['+15550000001'], SIGNAL_RPC_HOST: 'unused.invalid', SIGNAL_RPC_PORT: 1 }));
vi.mock('./signal-groups.js', () => ({ shouldHandleInbound: () => true, agentHasGroups: () => false }));
vi.mock('./mattermost-config.js', () => ({ MATTERMOST_URL: 'https://unused.invalid', MATTERMOST_TOKEN: 'synthetic',
  MATTERMOST_OWNER_USER: 'owner', MATTERMOST_TEAM: 'team', MATTERMOST_DEFAULT_AGENT: 'main',
  MATTERMOST_CHANNEL_AGENT_MAP: {}, MATTERMOST_MENTION_ONLY_CHANNELS: [],
  ownsChannel: () => true, assertOwnerConfigured: () => {} }));
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
vi.mock('./message-queue.js', () => ({ messageQueue: { enqueue: (_key: string, task: () => Promise<void>) => fixture.pending.push(task()), queuedFor: () => 0 } }));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: () => ({ type: 'claude', model: 'fixture' }), defaultModelForProvider: () => 'fixture' }));
vi.mock('./voice.js', () => ({ voiceCapabilities: () => ({ tts: fixture.voice, stt: false }),
  synthesizeSpeech: async () => { throw new Error('Synthetic TTS failure'); } }));
vi.mock('./agent-engine/index.js', () => ({ engineSupportsSystemPrompt: () => true, EngineFactory: { forProvider: () => ({
  async *invoke() {
    fixture.calls++;
    yield { type: 'progress', progress: { type: 'task_started', toolCallId: 'fixture', description: fixture.secret, kind: 'other' } };
    if (fixture.mode === 'error') throw new Error(fixture.secret);
    if (fixture.mode === 'failed-result') {
      yield { type: 'result', text: null, usage: null, stopReason: 'error', failure: { provider: 'claude', category: 'request', execution: 'not_started', message: 'Synthetic invalid request' } };
      return;
    }
    if (fixture.mode === 'abort') { yield { type: 'aborted', text: fixture.secret, usage: null }; return; }
    yield { type: 'result', text: fixture.secret, usage: null, stopReason: 'end_turn' };
  },
}) } }));
vi.mock('./signal-rpc.js', async original => {
  const rpc = await original<typeof import('./signal-rpc.js')>();
  return { ...rpc, SignalRpcClient: class extends rpc.SignalRpcClient {
    constructor(options: any) {
      super(options); fixture.signal = this;
      (this as any).socket = Object.assign(new EventEmitter(), { write: (body: string) => {
        fixture.bytes.push(body);
        const { id } = JSON.parse(body);
        queueMicrotask(() => (this as any).onData(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n')));
        return true;
      } });
    }
    override async connectWithRetry() {}
    override stop() {}
  } };
});
vi.mock('./mattermost-rpc.js', async original => {
  const rpc = await original<typeof import('./mattermost-rpc.js')>();
  return { ...rpc, MattermostRpcClient: class extends rpc.MattermostRpcClient {
    constructor(options: any) { super(options); fixture.mattermost = this; }
    override async getMeWithRetry() { return { id: 'bot', username: 'bot' }; }
    override async resolveUserWithRetry() { return { id: 'owner', username: 'owner' }; }
    override async getTeamByName() { return { id: 'team', name: 'team', display_name: 'Fixture' }; }
    override async connectWithRetry() {}
    override stop() {}
  } };
});

import { createSignalBot } from './signal-bot.js';
import { createMattermostBot } from './mattermost-bot.js';
import { _initTestDatabase, getRecentConversation } from './db.js';
import { chatEvents } from './state.js';
import { AGENT_TIMEOUT_MS } from './config.js';

beforeEach(() => {
  _initTestDatabase(); fixture.bytes = []; fixture.audit = []; fixture.pending = []; fixture.calls = 0; fixture.voice = false;
  vi.stubEnv('HOME', '/nonexistent/fixture'); vi.stubEnv('USERPROFILE', '/nonexistent/fixture');
  // Capture the bots' append-only outbound audit seam; no real log files.
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'appendFileSync').mockImplementation((_path, body) => { fixture.audit.push(String(body)); });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { fixture.bytes.push(init.body); return new Response('{}'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['signal', 'mattermost'] as const)('captures %s handler success/error/abort and routing at physical transport boundaries', async transport => {
  const bot = transport === 'signal' ? createSignalBot() : createMattermostBot();
  const events: string[] = [];
  const capture = (event: unknown) => events.push(JSON.stringify(event));
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  chatEvents.on('chat', capture);
  try {
    await bot.start();
    for (const mode of ['success', 'error', 'abort', 'failed-result', ...(transport === 'signal' ? ['group', 'voice-fallback'] : [])]) {
      fixture.mode = mode; fixture.calls = 0; fixture.pending = []; fixture.bytes = [];
      if (mode === 'voice-fallback') {
        fixture.voice = true;
        fixture.signal.emit('message', { sourceNumber: '+15550000001', text: '/voice on', attachments: [], isSync: false, timestamp: 1 });
        await Promise.resolve();
      }
      const chat = mode === 'group' ? 'group.Zml4dHVyZQ==' : transport === 'signal' ? '+15550000001' : 'channel';
      if (transport === 'signal') fixture.signal.emit('message', {
        sourceNumber: '+15550000001', text: 'Synthetic request', attachments: [], isSync: false, timestamp: 1,
        ...(mode === 'group' ? { groupId: 'Zml4dHVyZQ==' } : {}),
      });
      else fixture.mattermost.emit('message', { userId: 'owner', channelId: chat, teamId: 'team',
        channelType: 'O', message: 'Synthetic request', postId: 'post', rootId: 'thread', files: [], mentions: [] });
      await Promise.all(fixture.pending);
      expect(fixture.calls, mode).toBe(1);
      expect(fixture.bytes.length, mode).toBeGreaterThan(0);
      expect(fixture.bytes.join(''), mode).not.toContain('alpha');
      expect(fixture.audit.join(''), mode).not.toContain('alpha');
      expect(events.join(''), mode).not.toContain('alpha');
      expect(JSON.stringify(getRecentConversation(chat, 30)), mode).not.toContain('alpha');
      const sent = fixture.bytes.map(body => JSON.parse(body)).filter(body => transport === 'signal' ? body.method === 'send' : body.channel_id);
      expect(sent.length, mode).toBeGreaterThan(0);
      if (mode === 'failed-result') expect(sent.map(body => transport === 'signal' ? body.params.message : body.message)).not.toContain('Done.');
      if (transport === 'mattermost') expect(sent.every(body => body.channel_id === 'channel' && body.root_id === 'thread')).toBe(true);
      if (mode === 'group') expect(sent.every(body => body.params.groupId === 'Zml4dHVyZQ==')).toBe(true);
      if (transport === 'mattermost') {
        timeout.mock.calls.forEach((call, index) => {
          if (call[1] === AGENT_TIMEOUT_MS) expect(clear.mock.calls.some(args => args[0] === timeout.mock.results[index].value), mode).toBe(true);
        });
      }
    }
  } finally { chatEvents.off('chat', capture); await bot.stop(); }
}, 15_000);
