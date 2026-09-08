import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  input: null as Record<string, unknown> | null,
  clearTimeout: vi.fn(),
  waitForAbort: false,
  abortObserved: false,
}));

vi.mock('./agent-engine/index.js', () => ({
  EngineFactory: {
    forProvider: vi.fn(() => ({
      async *invoke(input: Record<string, unknown>) {
        state.input = input;
        if (state.waitForAbort) {
          const signal = (input.abortController as AbortController).signal;
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
            state.abortObserved = true;
            resolve();
          }, { once: true }));
          return;
        }
        yield { type: 'result', text: 'extracted' };
      },
    })),
  },
}));
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({ ANTHROPIC_API_KEY: 'secret' })) }));
vi.mock('./security.js', () => ({ getScrubbedSdkEnv: vi.fn(() => ({ PATH: 'safe' })) }));

import { runIsolatedExtraction } from './isolated-extraction.js';

describe('runIsolatedExtraction', () => {
  beforeEach(() => {
    state.input = null;
    state.waitForAbort = false;
    state.abortObserved = false;
    state.clearTimeout.mockReset();
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(state.clearTimeout as typeof clearTimeout);
  });

  afterEach(() => vi.restoreAllMocks());

  it('runs a fresh one-turn extraction with settings, tools, MCP and dispatch absent', async () => {
    const provider = { type: 'claude' as const };
    await expect(runIsolatedExtraction('untrusted', { provider, model: 'cheap' })).resolves.toBe('extracted');

    expect(state.input).toMatchObject({
      prompt: 'untrusted',
      provider,
      model: 'cheap',
      allowedTools: [],
      disallowedTools: ['*'],
      settingSources: [],
      maxTurns: 1,
      env: { PATH: 'safe' },
    });
    expect(state.input).not.toHaveProperty('sessionId');
    expect(state.input).not.toHaveProperty('mcpServers');
    expect(state.input).not.toHaveProperty('systemPrompt');
  });

  it('always clears its timeout after completion', async () => {
    await runIsolatedExtraction('input', { provider: { type: 'claude' }, timeoutMs: 123 });
    expect(state.clearTimeout).toHaveBeenCalledOnce();
  });

  it('aborts a hung extraction at the deadline and clears the timer', async () => {
    state.waitForAbort = true;
    let fireTimeout!: () => void;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      fireTimeout = callback;
      return 123 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const pending = runIsolatedExtraction('input', { provider: { type: 'claude' }, timeoutMs: 50 });
    await Promise.resolve();
    fireTimeout();

    await expect(pending).resolves.toBe('');
    expect(state.abortObserved).toBe(true);
    expect(state.clearTimeout).toHaveBeenCalledOnce();
  });
});
