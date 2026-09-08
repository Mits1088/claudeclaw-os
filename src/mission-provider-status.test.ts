import { beforeEach, describe, expect, it } from 'vitest';
import {
  _initTestDatabase,
  cancelMissionTask,
  claimNextMissionTask,
  claimProviderHealth,
  createMissionWorkflow,
  deferMissionForProvider,
  recordProviderHealth,
} from './db.js';
import { formatMissionProviderStatuses, missionProviderStatuses } from './mission-provider-status.js';

describe('current mission provider status', () => {
  const now = 1_800_000_000;

  beforeEach(() => {
    _initTestDatabase();
    createMissionWorkflow({
      id: 'wf', rootTaskId: 'root', title: 'Verify', objective: 'Verify', initialPrompt: 'Read only',
      ownerAgent: 'main', workerAgent: 'worker', priority: 5, maxDepth: 2, maxTasks: 3,
      maxFanout: 2, deadlineAt: null,
    });
    claimNextMissionTask('worker');
  });

  function queueRecovery(): void {
    expect(deferMissionForProvider({
      taskId: 'root',
      providerJson: JSON.stringify({ type: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://private.invalid' }),
      failureJson: JSON.stringify({ category: 'unavailable', message: 'secret upstream detail' }),
      deadlineAt: now + 600,
      availableAt: now + 60,
      reason: 'fallback_provider',
    })).toBe(true);
  }

  it('reports the saved recovery provider and its DB-owned open circuit without leaking endpoint or error text', () => {
    queueRecovery();
    const key = 'openai:https://private.invalid:gpt-5.6-sol';
    claimProviderHealth(key, 'one', now);
    recordProviderHealth(key, 'one', now, 120, 'secret first error', 'unavailable');
    claimProviderHealth(key, 'two', now + 1);
    recordProviderHealth(key, 'two', now + 1, 120, 'secret second error', 'unavailable');

    const status = missionProviderStatuses('worker', now);
    expect(status).toEqual([expect.objectContaining({
      taskId: 'root', taskStatus: 'queued', provider: 'openai', model: 'gpt-5.6-sol',
      attempt: 2, retryReason: 'using configured mission fallback', retryAt: now + 60,
      deadlineAt: now + 600, failureCategory: 'unavailable',
      circuit: { state: 'open', failures: 2, retryAt: now + 121 },
    })]);
    expect(JSON.stringify(status)).not.toContain('private.invalid');
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('does not present retained recovery state after the task becomes terminal', () => {
    queueRecovery();
    expect(cancelMissionTask('root')).toBe(true);
    expect(missionProviderStatuses('worker', now)).toEqual([]);
  });

  it('labels mission execution separately and makes trip/probe health explicit', () => {
    queueRecovery();
    const [line] = formatMissionProviderStatuses(missionProviderStatuses('worker', now), now);
    expect(line).toContain('recovery queued in 1m on openai/gpt-5.6-sol');
    expect(line).toContain('deadline in 10m');
    expect(line).toContain('circuit not yet recorded');
  });

  it('reports a claimed retry as running on the saved recovery provider', () => {
    const wallNow = Math.floor(Date.now() / 1000);
    expect(deferMissionForProvider({
      taskId: 'root', providerJson: JSON.stringify({ type: 'claude', model: 'claude-fable-5-1' }),
      failureJson: JSON.stringify({ category: 'rate_limit' }), deadlineAt: wallNow + 600,
      availableAt: wallNow - 1, reason: 'same_provider',
    })).toBe(true);
    expect(claimNextMissionTask('worker')).toMatchObject({ id: 'root', status: 'running' });
    expect(missionProviderStatuses('worker', wallNow)).toEqual([
      expect.objectContaining({ taskStatus: 'running', provider: 'claude', model: 'claude-fable-5-1', retryAt: null }),
    ]);
  });
});
