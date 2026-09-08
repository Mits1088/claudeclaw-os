import { describe, expect, it } from 'vitest';
import { decideProviderRecovery, toProviderFailure } from './provider-recovery.js';

const claude = { type: 'claude' as const, model: 'claude-opus' };
const openai = { type: 'openai' as const, model: 'gpt-5.6' };

describe('toProviderFailure', () => {
  it('reuses generic classification and defaults execution to unknown', () => {
    expect(toProviderFailure(new Error('429 rate limit exceeded'), openai)).toMatchObject({
      category: 'rate_limit', execution: 'unknown', provider: 'openai', retryAfterMs: 30_000,
    });
  });

  it('separates unsupported-model requests from bare missing backends', () => {
    expect(toProviderFailure(new Error('404 model is not supported for this account'), openai, 'not_started').category).toBe('request');
    expect(toProviderFailure(new Error('404 model gpt-missing does not exist'), openai, 'not_started').category).toBe('request');
    expect(toProviderFailure(new Error('404 backend not found'), openai, 'not_started').category).toBe('unavailable');
  });

  it('preserves supported transport metadata', () => {
    const error = Object.assign(new Error('busy'), { status: 503, retryAfterMs: 12_345 });
    expect(toProviderFailure(error, claude, 'not_started')).toMatchObject({ code: 503, retryAfterMs: 12_345 });
  });
});

describe('decideProviderRecovery', () => {
  const failure = toProviderFailure(new Error('503 unavailable'), claude, 'not_started');

  it('chooses only the next explicitly configured provider with exponential backoff', () => {
    expect(decideProviderRecovery({
      failure, currentProvider: claude, configuredProviders: [claude, openai],
      attempt: 1, maxAttempts: 3, nowMs: 1_000, deadlineAtMs: 100_000,
    })).toEqual({
      action: 'retry', provider: openai, attempt: 2, delayMs: 5_000,
      availableAtMs: 6_000, reason: 'fallback_provider',
    });
  });

  it.each(['started', 'unknown'] as const)('never replays execution certainty %s', (execution) => {
    expect(decideProviderRecovery({
      failure: { ...failure, execution }, currentProvider: claude, configuredProviders: [claude, openai],
      attempt: 1, maxAttempts: 3, nowMs: 0, deadlineAtMs: 100_000,
    })).toEqual({ action: 'reconcile', reason: execution === 'started' ? 'execution_started' : 'execution_unknown' });
  });

  it.each(['auth', 'request', 'unknown'] as const)('never falls back category %s', (category) => {
    expect(decideProviderRecovery({
      failure: { ...failure, category }, currentProvider: claude, configuredProviders: [claude, openai],
      attempt: 1, maxAttempts: 3, nowMs: 0, deadlineAtMs: 100_000,
    })).toEqual({ action: 'fail', reason: 'non_recoverable' });
  });

  it('honors attempt and deadline bounds', () => {
    expect(decideProviderRecovery({
      failure, currentProvider: claude, configuredProviders: [claude],
      attempt: 3, maxAttempts: 3, nowMs: 0, deadlineAtMs: 100_000,
    })).toEqual({ action: 'fail', reason: 'attempts_exhausted' });
    expect(decideProviderRecovery({
      failure, currentProvider: claude, configuredProviders: [claude],
      attempt: 1, maxAttempts: 3, nowMs: 99_000, deadlineAtMs: 100_000,
    })).toEqual({ action: 'fail', reason: 'deadline_exceeded' });
  });
});
