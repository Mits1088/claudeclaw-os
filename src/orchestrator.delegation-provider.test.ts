import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression for G1: delegateToAgent must hand runAgent the TARGET agent's
// provider (agentConfig.provider), not the caller's/main's selected provider.
// Before the fix it passed getSelectedProviderConfig() (main's provider), which
// silently runs the target's model id on the wrong engine once a second
// provider ships.

const runAgentMock = vi.fn(async (..._args: unknown[]) => ({ text: 'ok', usage: null }));

vi.mock('./agent.js', () => ({
  isFailedTurn: () => false,
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

// Distinct provider objects so identity, not shape, proves which one was used.
const TARGET_PROVIDER = { type: 'openai' as const, label: 'target-openai' };
const MAIN_PROVIDER = { type: 'claude' as const, label: 'main-claude' };

vi.mock('./agent-config.js', () => ({
  resolveAgentId: (id: string) => id,
  listAgentIds: () => ['worker'],
  resolveAgentClaudeMd: () => null,
  loadAgentConfig: (id: string) => ({
    id,
    name: 'Worker',
    description: 'test worker',
    model: 'gpt-5.6-sol',
    mcpServers: undefined,
    provider: TARGET_PROVIDER,
  }),
}));

// If the fix ever regresses, the old code path resolves the provider through
// active-provider -> this selected/main provider, which is NOT TARGET_PROVIDER.
vi.mock('./active-provider.js', () => ({
  getSelectedProviderConfig: () => MAIN_PROVIDER,
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

// runAgent positional signature — the provider is the 9th argument (index 8).
const PROVIDER_ARG_INDEX = 8;

describe('delegateToAgent cross-provider routing (G1)', () => {
  beforeEach(() => {
    runAgentMock.mockClear();
    refreshAgentRegistry();
  });

  it('passes the target agent provider to runAgent, not the caller/main provider', async () => {
    await delegateToAgent('worker', 'do the thing', 'chat-1', 'main');

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const providerArg = runAgentMock.mock.calls[0][PROVIDER_ARG_INDEX];
    expect(providerArg).toBe(TARGET_PROVIDER);
    expect(providerArg).not.toBe(MAIN_PROVIDER);
  });
});
