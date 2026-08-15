import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentError } from './errors.js';

// Mock the SDK query function before importing agent
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./config.js', () => ({
  AGENT_MAX_TURNS: 30,
  PROJECT_ROOT: '/tmp/test',
  agentCwd: undefined,
  agentSystemPrompt: undefined,
  ENABLE_ACP: true,
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { emptyTurnReply, isFailedTurn, runAgentWithRetry, type AgentResult } from './agent.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQuery = query as any;
const noop = () => {};
const claudeProvider = { type: 'claude' as const };

/**
 * Create a mock async iterable that yields events then closes.
 */
function mockQueryEvents(events: Array<Record<string, unknown>>) {
  return async function* () {
    for (const ev of events) {
      yield ev;
    }
  };
}

function resultEvent(text: string) {
  return {
    type: 'result',
    result: text,
    subtype: 'result',
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 },
    total_cost_usd: 0.01,
  };
}

describe('runAgentWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns result on first try when no error', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuery.mockReturnValue(mockQueryEvents([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultEvent('Hello!'),
    ])() as any);

    const result = await runAgentWithRetry('hi', undefined, noop, undefined, undefined, undefined, undefined, undefined, undefined, undefined, claudeProvider);
    expect(result.text).toBe('Hello!');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('surfaces context compaction as a durable progress notice', async () => {
    mockQuery.mockReturnValue(mockQueryEvents([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 150000 },
      },
      resultEvent('Compacted and continued'),
    ])());
    const onProgress = vi.fn();

    await runAgentWithRetry(
      'continue',
      undefined,
      noop,
      onProgress,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      claudeProvider,
    );

    expect(onProgress).toHaveBeenCalledWith({
      type: 'task_completed',
      description: 'Context compacted',
      status: 'notice',
      kind: 'compact',
      toolCallId: 'context-compaction',
    });
  });

  it('retries on retryable error and succeeds on second attempt', async () => {
    const retryableError = new AgentError('rate_limit', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 100,
      userMessage: 'Rate limited. Retrying in 30s...',
    });

    let callCount = 0;
    mockQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw retryableError;
      return mockQueryEvents([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        resultEvent('Recovered!'),
      ])();
    });

    const onRetry = vi.fn();
    const result = await runAgentWithRetry(
      'hi', undefined, noop, undefined, undefined, undefined, undefined, onRetry, undefined, undefined, claudeProvider,
    );

    expect(result.text).toBe('Recovered!');
    expect(callCount).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ category: 'rate_limit' }));
  }, 15000);

  it('does not retry non-retryable errors', async () => {
    const authError = new AgentError('auth', {
      shouldRetry: false,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 0,
      userMessage: 'Auth failed',
    });

    mockQuery.mockImplementation(() => { throw authError; });

    await expect(runAgentWithRetry('hi', undefined, noop, undefined, undefined, undefined, undefined, undefined, undefined, undefined, claudeProvider)).rejects.toThrow(AgentError);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('gives up after max retries', async () => {
    const retryableError = new AgentError('subprocess_crash', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 100,
      userMessage: 'Subprocess crashed',
    });

    mockQuery.mockImplementation(() => { throw retryableError; });

    const onRetry = vi.fn();
    await expect(
      runAgentWithRetry('hi', undefined, noop, undefined, undefined, undefined, undefined, onRetry, undefined, undefined, claudeProvider),
    ).rejects.toThrow(AgentError);

    // 1 initial + 2 retries = 3 total calls
    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  }, 30000);

  it('returns aborted result when abort controller is pre-aborted', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    // The SDK returns {aborted: true} when pre-aborted, runAgent returns it directly
    mockQuery.mockReturnValue(mockQueryEvents([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      resultEvent('partial'),
    ])() as any);

    // When abort is signalled before query, runAgent catches and returns aborted
    // We mock this by having query throw the abort-detected error
    mockQuery.mockImplementation(() => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const result = await runAgentWithRetry(
      'hi', undefined, noop, undefined, undefined, abortCtrl, undefined, undefined, undefined, undefined, claudeProvider,
    );
    expect(result.aborted).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('non-AgentError exceptions are classified then thrown', async () => {
    // The SDK throws a TypeError. runAgent wraps it via classifyError into an AgentError.
    mockQuery.mockImplementation(() => { throw new TypeError('unexpected'); });

    await expect(
      runAgentWithRetry('hi', undefined, noop, undefined, undefined, undefined, undefined, undefined, undefined, undefined, claudeProvider),
    ).rejects.toThrow(AgentError);
    // classifyError wraps TypeError into AgentError('unknown') which is not retryable
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('uses fallback model on shouldSwitchModel errors', async () => {
    const overloadedError = new AgentError('overloaded', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: true,
      retryAfterMs: 100,
      userMessage: 'Overloaded',
    });

    let callCount = 0;
    const capturedModels: (string | undefined)[] = [];
    mockQuery.mockImplementation((opts: unknown) => {
      callCount++;
      const options = (opts as Record<string, unknown>)?.options as Record<string, unknown> | undefined;
      capturedModels.push(options?.model as string | undefined);
      if (callCount === 1) throw overloadedError;
      return mockQueryEvents([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        resultEvent('Fallback worked'),
      ])();
    });

    const result = await runAgentWithRetry(
      'hi', undefined, noop, undefined,
      'claude-opus-4-6', undefined, undefined, undefined,
      ['claude-sonnet-4-6', 'claude-haiku-4-5'], undefined, claudeProvider,
    );

    expect(result.text).toBe('Fallback worked');
    expect(capturedModels[0]).toBe('claude-opus-4-6');
    expect(capturedModels[1]).toBe('claude-sonnet-4-6');
  }, 15000);
});

describe('isFailedTurn', () => {
  const base: AgentResult = { text: 'fine', newSessionId: undefined, usage: null };
  const usage = (isError: boolean) => ({
    inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    totalCostUsd: 0, contextWindow: null, lastCallCacheRead: 0, lastCallInputTokens: 0,
    lastCallCacheCreation: 0, didCompact: false, preCompactTokens: null, model: null,
    durationMs: 0, durationApiMs: 0, numTurns: 1, stopReasonDetail: null, isError,
  });

  it('flags usage.isError (Claude SDK error result)', () => {
    expect(isFailedTurn({ ...base, usage: usage(true) })).toBe(true);
  });

  it('flags error stop reasons, including the bare Codex "error"', () => {
    expect(isFailedTurn({ ...base, stopReason: 'error_during_execution' })).toBe(true);
    expect(isFailedTurn({ ...base, stopReason: 'error' })).toBe(true);
  });

  it('passes a healthy result through', () => {
    expect(isFailedTurn(base)).toBe(false);
    expect(isFailedTurn({ ...base, stopReason: 'end_turn', usage: usage(false) })).toBe(false);
  });

  it('keeps emptyTurnReply consistent with the shared predicate', () => {
    expect(emptyTurnReply(base)).toBe('Done.');
    expect(emptyTurnReply({ ...base, stopReason: 'error_during_execution' })).toContain('failed');
  });
});
