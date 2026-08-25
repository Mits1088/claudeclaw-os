// A War Room turn on the anthropic-compatible provider must not enter the
// totals as money.
//
// The leak this guards is subtle: the Claude SDK attaches `raw` to every event
// it emits, so the orchestrator's raw branch — not its normalized one — is what
// a war-room turn actually reached. That branch read `raw.total_cost_usd`, which
// for a GLM turn is Anthropic list pricing applied to a third-party model
// (measured 2026-08-20: $0.0219 for a two-word "PONG"), and persisted it with no
// `costSource`, which the column defaults to 'provider'.
//
// These assertions run against a real SQLite database rather than a mocked
// saveTokenUsage: the property under test is what ends up in the row, and a
// mock cannot get that wrong.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/tmp/test-warroom-cost',
  CLAUDECLAW_CONFIG: '/tmp/test-warroom-cost/config',
  CLAUDECLAW_OWNER_NAME: 'Michael',
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
  STORE_DIR: '/tmp/test-warroom-cost/store',
  DB_ENCRYPTION_KEY: '0'.repeat(64),
  MEMORY_RECALL_MODE_ENV: undefined,
}));

vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('./memory.js', () => ({ buildMemoryContext: vi.fn(async () => '') }));
vi.mock('./memory-ingest.js', () => ({ ingestConversationTurn: vi.fn(async () => undefined) }));
vi.mock('./agent-config.js', () => ({
  resolveAgentDir: (id: string) => `/tmp/test-warroom-cost/agents/${id}`,
  resolveAgentClaudeMd: () => null,
  loadAgentConfig: () => ({ name: 'stub', description: '', botToken: '', botTokenEnv: '' }),
  listAllAgents: () => [],
  resolveAgentDisplayName: (id: string) => id,
}));
vi.mock('./security.js', () => ({ getScrubbedSdkEnv: () => ({}) }));

const { warRoomUsageRecord } = await import('./warroom-text-orchestrator.js');
const { saveTokenUsage, getAgentTokenStats, _initTestDatabase } = await import('./db.js');
import type { AgentEngineEvent, AgentEngineUsage } from './agent-engine/types.js';

function usage(overrides: Partial<AgentEngineUsage> = {}): AgentEngineUsage {
  return {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0.0219,
    costSource: 'provider',
    didCompact: false,
    preCompactTokens: null,
    lastCallCacheRead: 0,
    lastCallCacheCreation: 0,
    lastCallInputTokens: 1000,
    contextWindow: 1_000_000,
    model: 'glm-5.3[1m]',
    durationMs: 1,
    durationApiMs: 1,
    numTurns: 1,
    stopReasonDetail: null,
    isError: false,
    ...overrides,
  };
}

/**
 * A result event shaped the way the Claude SDK adapter really emits it: the raw
 * SDK object is always present, alongside whatever the adapter normalized.
 */
function resultEvent(u: AgentEngineUsage | null): AgentEngineEvent {
  return {
    type: 'result',
    text: 'PONG',
    usage: u,
    stopReason: 'success',
    raw: {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0219,
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

/**
 * Runs the event through the orchestrator's persistence decision and the real
 * `saveTokenUsage`, then reports what the surfaces that spend this number see.
 *
 * The row is read back through the public aggregates rather than a raw SELECT:
 * they carry the `cost_source = 'provider'` filter that decides whether a stored
 * figure counts as money, so a leak shows up as a changed total — which is the
 * failure the maintainer asked to be made impossible.
 */
function persist(ev: AgentEngineEvent): { cost: number; turns: number; costSource?: string } {
  const rec = warRoomUsageRecord(ev);
  expect(rec).not.toBeNull();
  saveTokenUsage(
    'warroom-chat', undefined,
    rec!.inputTokens, rec!.outputTokens, rec!.cacheRead, rec!.contextTokens,
    rec!.costUsd, rec!.didCompact, 'main', rec!.contextWindow, rec!.cacheCreation,
    rec!.telemetry,
  );
  const stats = getAgentTokenStats('main');
  return { cost: stats.allTimeCost, turns: stats.todayTurns, costSource: rec!.telemetry.costSource };
}

describe('war room usage persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores a compatible-provider turn as unpriced, though the raw event claims $0.0219', () => {
    const row = persist(resultEvent(usage({ totalCostUsd: 0, costSource: 'unknown' })));
    expect(row.costSource).toBe('unknown');
    expect(row.cost).toBe(0);
    // The turn itself is still recorded — only its price is withheld.
    expect(row.turns).toBe(1);
  });

  it('the raw figure the old path would have stored is genuinely different', () => {
    // Without this the test above could pass on an event that carries no price
    // at all, proving nothing. 0.0219 is what a raw-first read yields.
    const ev = resultEvent(usage({ totalCostUsd: 0, costSource: 'unknown' }));
    const raw = (ev as { raw: { total_cost_usd: number } }).raw;
    expect(raw.total_cost_usd).toBeCloseTo(0.0219, 6);
    expect(persist(ev).cost).not.toBeCloseTo(raw.total_cost_usd, 6);
  });

  it('still stores a real Claude turn as provider money', () => {
    const row = persist(resultEvent(usage()));
    expect(row.costSource).toBe('provider');
    expect(row.cost).toBeCloseTo(0.0219, 6);
  });

  it('falls back to the raw fields only when the adapter normalized nothing', () => {
    const row = persist(resultEvent(null));
    expect(row.cost).toBeCloseTo(0.0219, 6);
    // Nothing but a Claude-shaped SDK result carries these fields, and the
    // runtime priced it — so the column default 'provider' is correct here.
    expect(row.costSource).toBeUndefined();
  });

  it('reports nothing at all for an event without usage in either shape', () => {
    expect(warRoomUsageRecord({ type: 'result', text: 'x', usage: null, raw: { type: 'result' } })).toBeNull();
  });
});
