import { describe, expect, it } from 'vitest';
import { canCoordinateMission, parseMissionProviderPolicy } from './mission-provider-policy.js';

describe('explicit mission provider policy', () => {
  it('defaults to bounded retries without inventing fallback authority', () => {
    expect(parseMissionProviderPolicy({})).toMatchObject({ fallbackProviders: [], maxAttempts: 3, maxRuntimeSeconds: 1800 });
  });
  it('requires supported explicit control/fallback providers and finite limits', () => {
    expect(() => parseMissionProviderPolicy({ coordinator_provider: 'openrouter' })).toThrow();
    expect(() => parseMissionProviderPolicy({ fallback: { providers: ['unknown'] } })).toThrow();
    expect(() => parseMissionProviderPolicy({ fallback: { max_attempts: 0 } })).toThrow();
    expect(() => parseMissionProviderPolicy({ fallback: { max_runtime_seconds: Infinity } })).toThrow();
    expect(canCoordinateMission({ type: 'openrouter' })).toBe(false);
    expect(canCoordinateMission({ type: 'openai' })).toBe(true);
  });
  it('keeps explicitly selected model and avoids adding permission bypass', () => {
    const policy = parseMissionProviderPolicy({ fallback: { providers: [{ type: 'openai', model: 'gpt-5.6-sol', thinkingMode: 'medium', dangerouslySkipPermissions: true }] } });
    expect(policy.fallbackProviders[0]).toEqual({ type: 'openai', model: 'gpt-5.6-sol', thinkingMode: 'medium', dangerouslySkipPermissions: false });
  });
});
