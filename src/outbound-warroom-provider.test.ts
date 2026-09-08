import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const fixture = vi.hoisted(() => ({ mode: 'success', calls: 0, logs: [] as unknown[], secret: 'alpha\nbeta "quoted" \\ credential' }));
vi.mock('./outbound-policy.js', () => ({
  resolveOutboundPolicy: () => ({ enabled: true, protectedValues: [fixture.secret] }),
  outboundOptionsForSeam: () => ({ enabled: true, protectedValues: [fixture.secret] }),
}));
vi.mock('./logger.js', () => ({ logger: Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => [level, (...args: unknown[]) => fixture.logs.push(args)])) }));
vi.mock('./agent.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('./memory.js', () => ({ buildMemoryContext: async () => ({ contextText: '' }) }));
vi.mock('./memory-ingest.js', () => ({ ingestConversationTurn: async () => {} }));
vi.mock('./active-provider.js', () => ({
  getSelectedProviderConfig: () => ({ type: 'claude', model: 'fixture' }),
  defaultModelForProvider: () => 'fixture',
}));
vi.mock('./agent-engine/index.js', () => ({ EngineFactory: { forProvider: () => ({
  async *invoke() {
    fixture.calls++;
    yield { type: 'progress', progress: { type: 'tool_active', toolCallId: 'progress-fixture', description: 'x'.repeat(1990) + fixture.secret, kind: 'other' } };
    yield { type: 'raw', raw: { type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'raw-fixture', name: 'fixture_tool', input: { query: fixture.secret },
    }] } } };

    yield { type: 'text_delta', delta: fixture.secret.slice(0, 7), accumulatedText: fixture.secret.slice(0, 7) };
    yield { type: 'text_delta', delta: fixture.secret.slice(7), accumulatedText: fixture.secret };
    if (fixture.mode === 'error') throw new Error(fixture.secret);
    if (fixture.mode === 'abort') { yield { type: 'aborted', text: fixture.secret, usage: null }; return; }
    yield { type: 'result', text: fixture.secret, usage: null, stopReason: 'end_turn' };
  },
}) } }));

import { _initTestDatabase, createTextMeeting, getWarRoomTranscript, getRecentConversation, getAuditLog } from './db.js';
import { getChannel } from './warroom-text-events.js';
import { handleTextTurn } from './warroom-text-orchestrator.js';

beforeEach(() => { _initTestDatabase(); fixture.calls = 0; fixture.logs = []; });

it.each(['success', 'abort', 'error'])('captures War Room provider %s through emitted/replayed bytes and persisted rows', async mode => {
  fixture.mode = mode;
  const meetingId = `provider-${mode}`;
  createTextMeeting(meetingId, 'chat');
  const channel = getChannel(meetingId);
  const bytes: string[] = [];
  const unsubscribe = channel.subscribe(entry => bytes.push(JSON.stringify(entry)));
  try {
    const result = await handleTextTurn(meetingId, '@main synthetic response please', randomUUID(), {
      roster: [{ id: 'main', name: 'Main', description: 'fixture' }],
    });
    expect(result.accepted).toBe(true);
    expect(fixture.calls, bytes.join('\n')).toBe(1);
    expect(bytes.join('')).not.toContain('alpha');
    expect(JSON.stringify(fixture.logs)).not.toContain('alpha');
    expect(getAuditLog().filter(row => row.action === 'tool_call')).toHaveLength(2);
    expect(JSON.stringify(getAuditLog())).not.toContain('alpha');
    expect(JSON.stringify(channel.since(0))).not.toContain('alpha');
    expect(JSON.stringify(getWarRoomTranscript(meetingId))).not.toContain('alpha');
    expect(JSON.stringify(getRecentConversation('chat', 10))).not.toContain('alpha');
    if (mode === 'success') {
      expect(getWarRoomTranscript(meetingId).find(row => row.speaker === 'main')?.text).toBe('[REDACTED]');
      expect(bytes.join('')).toContain('[REDACTED]');
    }
  } finally { unsubscribe(); }
});
