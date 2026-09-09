import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/tmp/test',
  agentCwd: undefined,
  ENABLE_ACP: true,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkEngineAdapter, EngineFactory, getAcpCommand, engineSupportsSystemPrompt } from './agent-engine/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQuery = query as any;

function mockEvents(events: Array<Record<string, unknown>>) {
  return async function* () {
    for (const ev of events) yield ev;
  };
}

async function collect(adapter: ClaudeSdkEngineAdapter, events: Array<Record<string, unknown>>) {
  mockQuery.mockReturnValue(mockEvents(events)());
  const out = [];
    for await (const ev of adapter.invoke({
      prompt: 'hi',
      provider: { type: 'claude' },
      cwd: '/tmp/test',
      sessionId: 'sess-old',
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      thinking: { type: 'disabled' },
      allowedTools: [],
    disallowedTools: ['*'],
    settingSources: [],
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
  })) {
    out.push(ev);
  }
  return out;
}

describe('Agent Provider Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes Claude SDK session, stream, progress, compact, result, and usage events', async () => {
    const adapter = new ClaudeSdkEngineAdapter();
    const events = await collect(adapter, [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } } },
      { type: 'assistant', message: { usage: { input_tokens: 123, cache_read_input_tokens: 456 }, content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 999 } },
      { type: 'result', subtype: 'success', result: 'hello', usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 400 }, total_cost_usd: 0.02, modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200000, maxOutputTokens: 32000 } } },
    ]);

    expect(events.map((ev) => ev.type)).toEqual([
      'session',
      'text_delta',
      'progress',
      'compact',
      'usage',
      'result',
    ]);
    expect(events[0]).toMatchObject({ type: 'session', sessionId: 'sess-1' });
    expect(events[1]).toMatchObject({ type: 'text_delta', delta: 'hel', accumulatedText: 'hel' });
    expect(events[2]).toMatchObject({ type: 'progress', progress: { type: 'tool_active', description: 'Reading file', toolCallId: 'tool-1' } });
    expect(events[3]).toMatchObject({ type: 'compact', preCompactTokens: 999, trigger: 'auto' });
    expect(events[4]).toMatchObject({
      type: 'usage',
      usage: {
        inputTokens: 1000,
        outputTokens: 10,
        cacheReadInputTokens: 400,
        totalCostUsd: 0.02,
        didCompact: true,
        preCompactTokens: 999,
        lastCallCacheRead: 456,
        lastCallInputTokens: 123,
        contextWindow: 200000,
      },
    });
    expect(events[5]).toMatchObject({ type: 'result', text: 'hello', stopReason: 'success' });
  });

  it('accumulates streamed text across messages so the bot never sees a shrinking delta', async () => {
    // Regression: `message_start` used to reset the streaming accumulator, so a
    // turn shaped `text -> tool_use -> more text` restarted `accumulatedText`
    // small on the second message. The bot tracks one monotonic accumulator per
    // turn and dropped that as a negative delta — text only reappeared in the
    // final result. It must now grow monotonically with a paragraph break.
    const adapter = new ClaudeSdkEngineAdapter();
    const events = await collect(adapter, [
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looking.' } } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep' }] } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } } },
      { type: 'result', subtype: 'success', result: 'Done.', usage: {}, total_cost_usd: 0 },
    ]);
    const deltas = events.filter((ev) => ev.type === 'text_delta') as Array<{ accumulatedText: string }>;
    expect(deltas[0].accumulatedText).toBe('Looking.');
    expect(deltas.at(-1)!.accumulatedText).toBe('Looking.\n\nDone.');
  });

  it('assembles full turn text when a turn ends text -> tool_use -> trailing text', async () => {
    // Regression: the SDK `result` field only carries the LAST assistant text
    // block, so a turn shaped `answer -> tool_use -> "Logged to hive mind."`
    // used to truncate to the trailing line. We now join all top-level text.
    const adapter = new ClaudeSdkEngineAdapter();
    const events = await collect(adapter, [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Here is the full answer.' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Logged to hive mind.' }] } },
      { type: 'result', subtype: 'success', result: 'Logged to hive mind.', usage: {}, total_cost_usd: 0 },
    ]);
    const resultEvent = events.find((ev) => ev.type === 'result');
    expect(resultEvent).toMatchObject({ text: 'Here is the full answer.\n\nLogged to hive mind.' });
  });

  it('excludes subagent text (parent_tool_use_id set) from the assembled result', async () => {
    const adapter = new ClaudeSdkEngineAdapter();
    const events = await collect(adapter, [
      { type: 'assistant', parent_tool_use_id: 'tool-9', message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'real answer' }] } },
      { type: 'result', subtype: 'success', result: 'real answer', usage: {}, total_cost_usd: 0 },
    ]);
    const resultEvent = events.find((ev) => ev.type === 'result');
    expect(resultEvent).toMatchObject({ text: 'real answer' });
  });

  it('keeps semantic Claude tool completions and leaves routine reads transient', async () => {
    const events = await collect(new ClaudeSdkEngineAdapter(), [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'edit-1', name: 'Edit' },
            { type: 'tool_use', id: 'read-1', name: 'Read' },
            { type: 'tool_use', id: 'web-1', name: 'WebSearch' },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'edit-1' },
            { type: 'tool_result', tool_use_id: 'read-1' },
            { type: 'tool_result', tool_use_id: 'web-1', is_error: true },
          ],
        },
      },
    ]);

    const progress = events
      .filter((event) => event.type === 'progress')
      .map((event) => event.progress);
    expect(progress).toContainEqual(expect.objectContaining({
      type: 'task_completed',
      description: 'Edited file',
      status: 'completed',
      kind: 'edit',
      toolCallId: 'edit-1',
    }));
    expect(progress).toContainEqual(expect.objectContaining({
      type: 'task_completed',
      description: 'Web search',
      status: 'failed',
      kind: 'search',
      toolCallId: 'web-1',
    }));
    expect(progress).not.toContainEqual(expect.objectContaining({
      type: 'task_completed',
      toolCallId: 'read-1',
    }));
  });

  it('maps Claude subagent progress onto one stable task id', async () => {
    const events = await collect(new ClaudeSdkEngineAdapter(), [
      { type: 'system', subtype: 'task_started', task_id: 'agent-1', description: 'Reviewing code' },
      { type: 'system', subtype: 'task_progress', task_id: 'agent-1', summary: 'Checking tests' },
      { type: 'system', subtype: 'task_notification', task_id: 'agent-1', summary: 'Review complete', status: 'completed' },
    ]);

    expect(events.map((event) => event.type === 'progress' ? event.progress : event)).toEqual([
      expect.objectContaining({
        type: 'task_started',
        description: 'Reviewing code',
        kind: 'subagent',
        toolCallId: 'agent-1',
      }),
      expect.objectContaining({
        type: 'tool_active',
        description: 'Checking tests',
        kind: 'subagent',
        toolCallId: 'agent-1',
      }),
      expect.objectContaining({
        type: 'task_completed',
        description: 'Review complete',
        status: 'completed',
        kind: 'subagent',
        toolCallId: 'agent-1',
      }),
    ]);
  });

  it('passes tool-disabled one-shot options through to Claude SDK', async () => {
    const adapter = new ClaudeSdkEngineAdapter();
    await collect(adapter, [{ type: 'result', result: '{}', usage: {}, total_cost_usd: 0 }]);

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        resume: 'sess-old',
        allowedTools: [],
        disallowedTools: ['*'],
        settingSources: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: 'claude-haiku-4-5-20251001',
        effort: 'low',
        thinking: { type: 'disabled' },
      }),
    }));
  });

  it('passes a persona systemPrompt through as a plain string (no claude_code preset)', async () => {
    const adapter = new ClaudeSdkEngineAdapter();
    mockQuery.mockReturnValue(mockEvents([{ type: 'result', result: '{}', usage: {}, total_cost_usd: 0 }])());
    const out = [];
    for await (const ev of adapter.invoke({
      prompt: 'hi',
      provider: { type: 'claude' },
      cwd: '/tmp/test',
      systemPrompt: 'You are Holden.',
    })) {
      out.push(ev);
    }
    const opts = mockQuery.mock.calls[0][0].options;
    // Plain string, not a { type: 'preset', preset: 'claude_code' } object.
    expect(opts.systemPrompt).toBe('You are Holden.');
  });

  it('omits systemPrompt entirely when no persona is supplied', async () => {
    const adapter = new ClaudeSdkEngineAdapter();
    mockQuery.mockReturnValue(mockEvents([{ type: 'result', result: '{}', usage: {}, total_cost_usd: 0 }])());
    const out = [];
    for await (const ev of adapter.invoke({ prompt: 'hi', provider: { type: 'claude' }, cwd: '/tmp/test' })) {
      out.push(ev);
    }
    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.systemPrompt).toBeUndefined();
  });

  it('appends the resolved runtime identity to Claude systemPrompt', async () => {
    const adapter = new ClaudeSdkEngineAdapter();
    mockQuery.mockReturnValue(mockEvents([{ type: 'result', result: '{}', usage: {}, total_cost_usd: 0 }])());
    for await (const _ of adapter.invoke({
      prompt: 'hi',
      provider: { type: 'claude' },
      cwd: '/tmp/test',
      systemPrompt: 'You are Holden.',
      runtimeIdentity: 'You are currently running on Opus 5 (provider: claude).',
    })) { /* drain */ }
    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts.systemPrompt).toBe('You are Holden.\n\nYou are currently running on Opus 5 (provider: claude).');
  });

  it('reports per-engine system-prompt support (ACP cannot pin one)', () => {
    // config mock sets ENABLE_ACP: true, so the claude/non-claude split applies.
    expect(engineSupportsSystemPrompt({ type: 'claude' })).toBe(true);
    expect(engineSupportsSystemPrompt({ type: 'opencode' })).toBe(false);
    expect(engineSupportsSystemPrompt({ type: 'openrouter' })).toBe(true);
    expect(engineSupportsSystemPrompt(undefined)).toBe(false);
  });

  it('defaults direct engine calls to permission-aware mode', async () => {
    mockQuery.mockReturnValue(mockEvents([
      { type: 'result', subtype: 'success', result: '{}', usage: {}, total_cost_usd: 0 },
    ])());

    const out = [];
    for await (const ev of new ClaudeSdkEngineAdapter().invoke({
      prompt: 'hi',
      provider: { type: 'claude' },
      cwd: '/tmp/test',
    })) {
      out.push(ev);
    }

    const options = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(options.permissionMode).toBe('default');
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
  });

  it('keeps a completed Claude result when the SDK process errors after result', async () => {
    mockQuery.mockReturnValue((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0 }, total_cost_usd: 0 };
      throw new Error('Claude Code process exited with code 1');
    })());

    const events = [];
    for await (const ev of new ClaudeSdkEngineAdapter().invoke({
      prompt: 'hi',
      provider: { type: 'claude' },
      cwd: '/tmp/test',
    })) {
      events.push(ev);
    }

    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'done' });
  });

  it('selects Claude and ACP adapters from provider config', () => {
    expect(EngineFactory.forProvider({ type: 'claude' }).constructor.name).toBe('ClaudeSdkEngineAdapter');
    expect(EngineFactory.forProvider({ type: 'opencode' }).constructor.name).toBe('AcpEngineAdapter');
    expect(EngineFactory.forProvider({ type: 'gemini' }).constructor.name).toBe('AcpEngineAdapter');
    expect(EngineFactory.forProvider({ type: 'acp-codex' }).constructor.name).toBe('AcpEngineAdapter');
    expect(EngineFactory.forProvider({ type: 'acp', command: 'agent' }).constructor.name).toBe('AcpEngineAdapter');
  });

  it('resolves ACP provider commands including built-in presets', () => {
    expect(getAcpCommand({ type: 'opencode' })).toEqual({ command: 'opencode', args: ['acp'] });
    expect(getAcpCommand({ type: 'gemini' })).toEqual({ command: 'gemini', args: ['--acp'] });
    expect(getAcpCommand({ type: 'acp-codex' })).toEqual({ command: 'codex-acp', args: [] });
    expect(getAcpCommand({ type: 'acp', command: 'custom', args: ['--serve'] })).toEqual({ command: 'custom', args: ['--serve'] });
    expect(() => getAcpCommand({ type: 'acp' })).toThrow(/requires a command/);
  });
});
