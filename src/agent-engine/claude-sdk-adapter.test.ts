import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';
import type { AgentEngineEvent, AgentTurnInput } from './types.js';

const queryMock = vi.mocked(query);

function turnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    prompt: 'hello',
    provider: { type: 'claude' },
    cwd: '/tmp/agent-cwd',
    ...overrides,
  } as AgentTurnInput;
}

/**
 * Mimics the SDK's bundled CLI resuming a session id that does not exist in
 * the cwd's project directory: the miss is reported only on stderr, then the
 * turn ends as an `error_during_execution` result with no text, and iteration
 * teardown rethrows the error (verified against a live repro of the failure).
 */
function unresumableSessionQuery({ options }: { options: { stderr?: (d: string) => void } }) {
  return (async function* () {
    options.stderr?.('No conversation found with session ID: dead-session-id\n');
    yield { type: 'result', subtype: 'error_during_execution', is_error: true };
    throw new Error(
      'Claude Code returned an error result: No conversation found with session ID: dead-session-id',
    );
  })();
}

function successQuery() {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'fresh-session-id' };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  })();
}

async function collect(events: AsyncIterable<AgentEngineEvent>): Promise<AgentEngineEvent[]> {
  const out: AgentEngineEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('ClaudeSdkEngineAdapter resume recovery', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('reruns the turn on a fresh session when the saved session is not found', async () => {
    queryMock
      .mockImplementationOnce(unresumableSessionQuery as never)
      .mockImplementationOnce(successQuery as never);

    const adapter = new ClaudeSdkEngineAdapter();
    const events = await collect(adapter.invoke(turnInput({ sessionId: 'dead-session-id' })));

    expect(queryMock).toHaveBeenCalledTimes(2);
    const secondOptions = (queryMock.mock.calls[1][0] as { options: { resume?: string } }).options;
    expect(secondOptions.resume).toBeUndefined();

    const sessions = events.filter((e) => e.type === 'session');
    expect(sessions).toEqual([expect.objectContaining({ sessionId: 'fresh-session-id' })]);

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ text: 'ok', stopReason: 'success' });
  });

  it('does not retry when the turn did not request a resume', async () => {
    queryMock.mockImplementationOnce(unresumableSessionQuery as never);

    const adapter = new ClaudeSdkEngineAdapter();
    const events = await collect(adapter.invoke(turnInput()));

    expect(queryMock).toHaveBeenCalledTimes(1);
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      text: null,
      stopReason: 'error_during_execution',
      failure: { provider: 'claude', category: 'unknown', execution: 'started' },
    });
  });

  it('retries at most once and surfaces the second failure as a result', async () => {
    queryMock
      .mockImplementationOnce(unresumableSessionQuery as never)
      .mockImplementationOnce(unresumableSessionQuery as never);

    const adapter = new ClaudeSdkEngineAdapter();
    const events = await collect(adapter.invoke(turnInput({ sessionId: 'dead-session-id' })));

    expect(queryMock).toHaveBeenCalledTimes(2);
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      text: null,
      stopReason: 'error_during_execution',
      failure: { provider: 'claude', category: 'unknown', execution: 'started' },
    });
  });

  it('marks a no-event SDK throw unknown instead of inferring safe replay', async () => {
    queryMock.mockImplementationOnce((async function* () {
      throw new Error('network disconnected before the first event');
    }) as never);

    const adapter = new ClaudeSdkEngineAdapter();
    let caught: unknown;
    try {
      await collect(adapter.invoke(turnInput()));
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      failure: { provider: 'claude', category: 'unavailable', execution: 'unknown' },
    });
  });
});
