import { describe, it, expect, vi, beforeEach } from 'vitest';
import { completeInterAgentTask } from './db.js';

// Routing regression: a delegation whose runAgent call comes back aborted
// (timeout) or as a failed turn (stopReason error / usage.isError) must be
// recorded as 'failed' and thrown to the caller — never completed with the
// error text as the result. runAgent is mocked: the system under test is the
// routing, not the engine.

const state = vi.hoisted(() => ({
  agentResult: { text: 'ok', usage: null } as Record<string, unknown>,
}));

vi.mock('./agent.js', () => ({
  // Mirrors the real predicate (unit-tested in agent.test.ts); importing the
  // actual module here would pull the whole engine tree under partial mocks.
  isFailedTurn: (r: { usage?: { isError?: boolean } | null; stopReason?: string }) =>
    r.usage?.isError === true || r.stopReason?.startsWith('error') === true,
  runAgent: vi.fn(async () => state.agentResult),
}));

vi.mock('./agent-config.js', () => ({
  resolveAgentId: (id: string) => id,
  listAgentIds: () => ['worker'],
  resolveAgentClaudeMd: () => null,
  loadAgentConfig: (id: string) => ({
    id,
    name: 'Worker',
    description: 'test worker',
    model: undefined,
    mcpServers: undefined,
    provider: undefined,
  }),
}));

vi.mock('./db.js', () => ({
  createInterAgentTask: vi.fn(),
  completeInterAgentTask: vi.fn(),
  logToHiveMind: vi.fn(),
}));

vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(async () => ({ contextText: '' })),
}));

vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/tmp/test',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { delegateToAgent, refreshAgentRegistry } from './orchestrator.js';

describe('delegateToAgent failure routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshAgentRegistry();
  });

  it('fails the task and throws when the run comes back errored', async () => {
    state.agentResult = { text: null, usage: null, stopReason: 'error_during_execution' };

    await expect(delegateToAgent('worker', 'do the thing', 'chat-1', 'main'))
      .rejects.toThrow('Agent run failed (error_during_execution)');
    expect(vi.mocked(completeInterAgentTask)).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      expect.stringContaining('Agent run failed'),
    );
    expect(vi.mocked(completeInterAgentTask)).not.toHaveBeenCalledWith(
      expect.anything(),
      'completed',
      expect.anything(),
    );
  });

  it('preserves Codex provider diagnostics when an errored run carries text', async () => {
    state.agentResult = {
      text: 'model exploded while applying the authorized tool policy',
      usage: null,
      stopReason: 'error',
    };

    await expect(delegateToAgent('worker', 'do the thing', 'chat-1', 'main'))
      .rejects.toThrow('Agent run failed (error): model exploded while applying the authorized tool policy');
    expect(vi.mocked(completeInterAgentTask)).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      expect.stringContaining('model exploded while applying the authorized tool policy'),
    );
  });

  it('fails the task and throws when the run was aborted (timeout)', async () => {
    state.agentResult = { text: null, usage: null, aborted: true };

    await expect(delegateToAgent('worker', 'do the thing', 'chat-1', 'main'))
      .rejects.toThrow(/timed out/);
    expect(vi.mocked(completeInterAgentTask)).toHaveBeenCalledWith(
      expect.anything(),
      'failed',
      expect.stringContaining('timed out'),
    );
  });

  it('still completes a healthy run', async () => {
    state.agentResult = { text: 'done deal', usage: null };

    const result = await delegateToAgent('worker', 'do the thing', 'chat-1', 'main');
    expect(result.text).toBe('done deal');
    expect(vi.mocked(completeInterAgentTask)).toHaveBeenCalledWith(expect.anything(), 'completed', 'done deal');
  });
});
