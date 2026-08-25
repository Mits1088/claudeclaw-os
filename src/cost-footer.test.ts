import { describe, it, expect } from 'vitest';
import { buildCostFooter } from './cost-footer.js';
import type { UsageInfo } from './agent.js';

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 45000,
    outputTokens: 2100,
    cacheReadInputTokens: 40000,
    cacheCreationInputTokens: 5000,
    totalCostUsd: 0.04,
    costSource: 'provider',
    didCompact: false,
    preCompactTokens: null,
    lastCallCacheRead: 40000,
    lastCallCacheCreation: 5000,
    lastCallInputTokens: 45000,
    contextWindow: 1_000_000,
    model: 'claude-opus-4-8',
    durationMs: 12000,
    durationApiMs: 9000,
    numTurns: 3,
    stopReasonDetail: 'end_turn',
    isError: false,
    ...overrides,
  };
}

describe('buildCostFooter', () => {
  it('returns empty string when mode is off', () => {
    expect(buildCostFooter('off', makeUsage())).toBe('');
  });

  it('returns empty string when usage is null', () => {
    expect(buildCostFooter('compact', null)).toBe('');
  });

  it('compact mode shows model only (no cost)', () => {
    const result = buildCostFooter('compact', makeUsage(), 'claude-opus-4-6');
    expect(result).toContain('Opus 4.6');
    expect(result).not.toContain('$');
    expect(result).not.toContain('45k');
  });

  it('verbose mode shows model + tokens (no cost)', () => {
    const result = buildCostFooter('verbose', makeUsage(), 'claude-opus-4-6');
    expect(result).toContain('Opus 4.6');
    expect(result).toContain('45k in');
    expect(result).toContain('2k out');
    expect(result).not.toContain('$');
  });

  it('cost mode shows model + cost (no tokens)', () => {
    const result = buildCostFooter('cost', makeUsage(), 'claude-opus-4-6');
    expect(result).toContain('Opus 4.6');
    expect(result).toContain('$0.04');
    expect(result).not.toContain('45k in');
  });

  it('full mode shows model + tokens + cost', () => {
    const result = buildCostFooter('full', makeUsage(), 'claude-opus-4-6');
    expect(result).toContain('Opus 4.6');
    expect(result).toContain('45k in');
    expect(result).toContain('2k out');
    expect(result).toContain('$0.04');
  });

  it('formats large token counts with M suffix', () => {
    const result = buildCostFooter('verbose', makeUsage({ inputTokens: 1_200_000 }), 'claude-opus-4-6');
    expect(result).toContain('1.2M in');
  });

  it('formats small token counts without suffix', () => {
    const result = buildCostFooter('verbose', makeUsage({ outputTokens: 500 }), 'claude-opus-4-6');
    expect(result).toContain('500 out');
  });

  it('handles missing model gracefully', () => {
    const result = buildCostFooter('compact', makeUsage());
    expect(result).toContain('unknown');
  });

  it('uses the catalog display label, not the raw id', () => {
    const result = buildCostFooter('compact', makeUsage(), 'claude-sonnet-4-6');
    expect(result).toContain('Sonnet 4.6');
    expect(result).not.toContain('claude-');
  });

  it('labels OpenAI models from the catalog', () => {
    const result = buildCostFooter('compact', makeUsage(), 'gpt-5.6-sol');
    expect(result).toBe('\n\n[GPT-5.6 Sol]');
  });

  it('appends effort when the turn ran with one', () => {
    const result = buildCostFooter('compact', makeUsage(), 'claude-opus-5', 'medium');
    expect(result).toBe('\n\n[Opus 5 · medium]');
  });

  it('appends effort in cost mode too', () => {
    const result = buildCostFooter('cost', makeUsage(), 'gpt-5.6-sol', 'xhigh');
    expect(result).toBe('\n\n[GPT-5.6 Sol · xhigh | $0.04]');
  });

  it('adds a one-turn runtime change notice without hiding the effective effort', () => {
    const result = buildCostFooter(
      'compact',
      makeUsage(),
      'gpt-5.6-sol',
      'medium',
      'reasoning xhigh → medium',
    );
    expect(result).toBe('\n\n[GPT-5.6 Sol · medium | reasoning xhigh → medium]');
  });

  it('omits effort when none is selected', () => {
    const result = buildCostFooter('compact', makeUsage(), 'claude-opus-5');
    expect(result).toBe('\n\n[Opus 5]');
  });

  it('passes an unknown id (e.g. a provider-type fallback) through as-is', () => {
    const result = buildCostFooter('compact', makeUsage(), 'openai');
    expect(result).toContain('openai');
  });
});
