import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderFailure } from './agent-engine/types.js';
import type { MissionTask } from './db.js';

const mocks = vi.hoisted(() => ({
  claimProviderHealth: vi.fn(),
  recordProviderHealth: vi.fn(),
  getMissionProviderRecovery: vi.fn(),
  getMissionWorkflow: vi.fn(),
  deferMissionForProvider: vi.fn(),
  logToHiveMind: vi.fn(),
  recordMissionProviderFailure: vi.fn(),
  loadMissionProviderPolicy: vi.fn(),
}));

vi.mock('./db.js', () => ({
  claimProviderHealth: mocks.claimProviderHealth,
  recordProviderHealth: mocks.recordProviderHealth,
  getMissionProviderRecovery: mocks.getMissionProviderRecovery,
  getMissionWorkflow: mocks.getMissionWorkflow,
  deferMissionForProvider: mocks.deferMissionForProvider,
  logToHiveMind: mocks.logToHiveMind,
  recordMissionProviderFailure: mocks.recordMissionProviderFailure,
  enqueueMissionSystemReport: vi.fn(),
}));
vi.mock('./mission-provider-policy.js', () => ({
  loadMissionProviderPolicy: mocks.loadMissionProviderPolicy,
  canCoordinateMission: () => true,
}));

import { missionProviderDeadlineDescription, prepareMissionProvider, recoverMissionProvider, settleMissionProviderHealth, type MissionProviderAttempt } from './mission-provider-execution.js';

const mission = {
  id: 'task', assigned_agent: 'worker', role: 'worker', workflow_id: 'workflow',
} as MissionTask;
const policy = {
  fallbackProviders: [{ type: 'openai' as const, model: 'fallback', dangerouslySkipPermissions: false }],
  maxAttempts: 3, maxRuntimeSeconds: 900, cooldownSeconds: 60, retryRateLimit: false,
};

function failure(overrides: Partial<ProviderFailure> = {}): ProviderFailure {
  return { category: 'unavailable', execution: 'not_started', provider: 'claude', message: '503', ...overrides };
}

function attempt(overrides: Partial<MissionProviderAttempt> = {}): MissionProviderAttempt {
  return {
    provider: { type: 'claude', model: 'primary' },
    providers: [{ type: 'claude', model: 'primary' }, ...policy.fallbackProviders],
    policy, attempt: 1, deadlineAt: Math.floor(Date.now() / 1000) + 600, deadlineSource: 'provider_runtime',
    token: 'token', key: 'claude:default', healthTracked: true, ...overrides,
  };
}

describe('mission provider execution policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadMissionProviderPolicy.mockReturnValue(policy);
    mocks.getMissionProviderRecovery.mockReturnValue(null);
    mocks.getMissionWorkflow.mockReturnValue({ deadline_at: null });
    mocks.claimProviderHealth.mockReturnValue({ allowed: true, retryAt: 0, probing: false });
    mocks.deferMissionForProvider.mockReturnValue(true);
  });

  it('gives a healthy first attempt the configured total runtime budget', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mocks.loadMissionProviderPolicy.mockReturnValue({ ...policy, maxRuntimeSeconds: 1800 });

    const prepared = prepareMissionProvider(mission, { type: 'claude' });

    expect(prepared.kind).toBe('run');
    if (prepared.kind !== 'run') throw new Error('expected provider run');
    expect(prepared.attempt).toMatchObject({
      deadlineAt: Math.floor(Date.now() / 1000) + 1800,
      deadlineSource: 'provider_runtime',
    });
    vi.useRealTimers();
  });

  it('honors an explicit shorter provider runtime limit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mocks.loadMissionProviderPolicy.mockReturnValue({ ...policy, maxRuntimeSeconds: 120 });

    const prepared = prepareMissionProvider(mission, { type: 'claude' });

    expect(prepared.kind).toBe('run');
    if (prepared.kind !== 'run') throw new Error('expected provider run');
    expect(prepared.attempt).toMatchObject({
      deadlineAt: Math.floor(Date.now() / 1000) + 120,
      deadlineSource: 'provider_runtime',
    });
    vi.useRealTimers();
  });

  it('cannot extend a persisted retry deadline after time advances', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const savedDeadline = Math.floor(Date.now() / 1000) + 600;
    mocks.loadMissionProviderPolicy.mockReturnValue({ ...policy, maxRuntimeSeconds: 1800 });
    mocks.getMissionProviderRecovery.mockReturnValue({ attempts: 1, deadline_at: savedDeadline, failure_json: '{}' });
    vi.advanceTimersByTime(300_000);

    const prepared = prepareMissionProvider(mission, { type: 'claude' });

    expect(prepared.kind).toBe('run');
    if (prepared.kind !== 'run') throw new Error('expected provider run');
    expect(prepared.attempt).toMatchObject({ deadlineAt: savedDeadline, deadlineSource: 'persisted_recovery' });
    vi.useRealTimers();
  });

  it('uses an earlier workflow deadline and reports that reason accurately', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const workflowDeadline = Math.floor(Date.now() / 1000) + 90;
    mocks.loadMissionProviderPolicy.mockReturnValue({ ...policy, maxRuntimeSeconds: 1800 });
    mocks.getMissionWorkflow.mockReturnValue({ deadline_at: workflowDeadline });

    const prepared = prepareMissionProvider(mission, { type: 'claude' });

    expect(prepared.kind).toBe('run');
    if (prepared.kind !== 'run') throw new Error('expected provider run');
    expect(prepared.attempt).toMatchObject({ deadlineAt: workflowDeadline, deadlineSource: 'workflow' });
    expect(missionProviderDeadlineDescription(prepared.attempt)).toBe('Workflow deadline reached at 2026-01-01T00:01:30.000Z');
    vi.useRealTimers();
  });

  it('applies current attempt and runtime bounds before claiming provider health', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    mocks.getMissionProviderRecovery.mockReturnValue({ attempts: 3, deadline_at: now + 10_000, failure_json: '{"category":"unavailable"}' });
    expect(prepareMissionProvider(mission, { type: 'claude' })).toEqual({ kind: 'blocked', reason: 'Bounded provider recovery attempts exhausted' });
    expect(mocks.recordMissionProviderFailure).toHaveBeenCalledWith('task', '{"category":"unavailable"}', 'attempts_exhausted', now + 900);
    expect(mocks.claimProviderHealth).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('blocks an expired persisted deadline before claiming provider health', () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.getMissionProviderRecovery.mockReturnValue({ attempts: 1, deadline_at: now, failure_json: '{"category":"unavailable"}' });
    expect(prepareMissionProvider(mission, { type: 'claude' })).toEqual({ kind: 'blocked', reason: 'Bounded provider recovery deadline exhausted' });
    expect(mocks.recordMissionProviderFailure).toHaveBeenCalledWith('task', '{"category":"unavailable"}', 'deadline_exceeded', now);
    expect(mocks.claimProviderHealth).not.toHaveBeenCalled();
  });

  it('persists every non-retry disposition with its typed reason', () => {
    expect(recoverMissionProvider(mission, attempt(), failure({ execution: 'unknown' }))).toBe(false);
    expect(mocks.recordMissionProviderFailure).toHaveBeenCalledWith(
      'task', expect.stringContaining('"execution":"unknown"'), 'execution_unknown', expect.any(Number),
    );

    mocks.recordMissionProviderFailure.mockClear();
    expect(recoverMissionProvider(mission, attempt(), failure({ category: 'rate_limit' }))).toBe(false);
    expect(mocks.recordMissionProviderFailure).toHaveBeenCalledWith(
      'task', expect.stringContaining('"category":"rate_limit"'), 'rate_limit_trigger_disabled', expect.any(Number),
    );
  });

  it('records a retry decision without double-counting its attempt', () => {
    expect(recoverMissionProvider(mission, attempt(), failure())).toBe(true);
    expect(mocks.recordMissionProviderFailure).toHaveBeenCalledWith(
      'task', expect.any(String), 'fallback_provider', expect.any(Number),
    );
    expect(mocks.deferMissionForProvider).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'fallback_provider',
    }));
    expect(mocks.deferMissionForProvider.mock.calls[0][0]).not.toHaveProperty('countAttempt', false);
  });

  it('does not apply another agent rate-limit circuit when the current trigger excludes it', () => {
    mocks.claimProviderHealth.mockReturnValue({
      allowed: false, retryAt: Math.floor(Date.now() / 1000) + 60, probing: false, failureCategory: 'rate_limit',
    });
    const prepared = prepareMissionProvider(mission, { type: 'claude', dangerouslySkipPermissions: true });
    expect(prepared.kind).toBe('run');
    if (prepared.kind !== 'run') throw new Error('expected provider run');
    expect(prepared.attempt.provider).toMatchObject({ type: 'claude', dangerouslySkipPermissions: true });
    expect(prepared.attempt.healthTracked).toBe(false);
    expect(settleMissionProviderHealth(mission, prepared.attempt, failure())).toBeNull();
    expect(mocks.recordProviderHealth).not.toHaveBeenCalled();
  });

  it('records the typed circuit cause for other agents to enforce their trigger', () => {
    mocks.recordProviderHealth.mockReturnValue(null);
    const limited = failure({ category: 'rate_limit', message: '429' });
    expect(settleMissionProviderHealth(mission, attempt({ policy: { ...policy, retryRateLimit: true } }), limited)).toBeNull();
    expect(mocks.recordProviderHealth).toHaveBeenCalledWith(
      'claude:default', 'token', expect.any(Number), 60, '429', 'rate_limit',
    );
  });
  it('does not trip health from a rate limit excluded by the current trigger', () => {
    expect(settleMissionProviderHealth(mission, attempt(), failure({ category: 'rate_limit' }))).toBeNull();
    expect(mocks.recordProviderHealth).not.toHaveBeenCalled();
  });
});
