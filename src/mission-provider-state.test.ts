import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase, createMissionWorkflow, claimNextMissionTask, deferMissionForProvider, getMissionTask, getMissionProviderRecovery, getMissionWorkflow, cancelMissionWorkflow, claimProviderHealth, recordProviderHealth, resetStuckMissionTasks, getMissionWorkflowOutcomes } from './db.js';

describe('durable bounded provider state', () => {
  beforeEach(() => {
    _initTestDatabase();
    createMissionWorkflow({ id: 'wf', rootTaskId: 'root', title: 'Verify', objective: 'Verify', initialPrompt: 'Read only', ownerAgent: 'main', workerAgent: 'worker', priority: 5, maxDepth: 2, maxTasks: 3, maxFanout: 2, deadlineAt: null });
    claimNextMissionTask('worker');
  });
  const retry = { taskId: 'root', providerJson: '{"type":"claude"}', failureJson: '{"execution":"not_started"}', deadlineAt: 1000, availableAt: 100, reason: 'provider_unavailable' };
  it('records a process-interrupted workflow as a visible outcome without replaying the worker', () => {
    expect(resetStuckMissionTasks('worker')).toBe(1);
    expect(getMissionTask('root')).toMatchObject({ status: 'failed', error: expect.stringContaining('execution unknown') });
    expect(claimNextMissionTask('worker')).toBeNull();
    expect(getMissionWorkflowOutcomes('wf')).toHaveLength(1);
    expect(resetStuckMissionTasks('worker')).toBe(0);
  });
  it('preserves the same task and budgets while queuing a delayed retry', () => {
    expect(deferMissionForProvider(retry)).toBe(true);
    expect(getMissionTask('root')).toMatchObject({ status: 'queued', available_at: 100 });
    expect(getMissionProviderRecovery('root')).toMatchObject({ attempts: 1, deadline_at: 1000 });
    expect(getMissionWorkflow('wf')).toMatchObject({ tasks_created: 1, current_step: 0 });
    expect(deferMissionForProvider(retry)).toBe(false);
  });
  it('cannot revive cancelled work or extend an existing recovery deadline', () => {
    expect(deferMissionForProvider(retry)).toBe(true);
    claimNextMissionTask('worker');
    expect(deferMissionForProvider({ ...retry, deadlineAt: 2000 })).toBe(true);
    expect(getMissionProviderRecovery('root')?.deadline_at).toBe(1000);
    cancelMissionWorkflow('wf', 'main');
    expect(deferMissionForProvider(retry)).toBe(false);
  });
  it('shares a circuit and permits one fenced half-open probe after cooldown', () => {
    claimProviderHealth('openai', 'first', 0);
    expect(recordProviderHealth('openai', 'first', 0, 60, '503')).toBeNull();
    claimProviderHealth('openai', 'second', 1);
    expect(recordProviderHealth('openai', 'second', 1, 60, '503')).toBe('trip');
    expect(claimProviderHealth('openai', 'too-early', 30)).toMatchObject({ allowed: false, retryAt: 61 });
    expect(claimProviderHealth('openai', 'probe', 62)).toMatchObject({ allowed: true, probing: true });
    expect(claimProviderHealth('openai', 'contender', 63).allowed).toBe(false);
    expect(recordProviderHealth('openai', 'stale', 64, 60)).toBeNull();
    expect(recordProviderHealth('openai', 'probe', 65, 60)).toBe('recover');
    expect(claimProviderHealth('openai', 'healthy', 66)).toMatchObject({ allowed: true, probing: false });
  });
  it('rejects late probe failures after a newer probe has recovered the provider', () => {
    claimProviderHealth('openai', 'first', 0);
    recordProviderHealth('openai', 'first', 0, 60, '503');
    claimProviderHealth('openai', 'second', 1);
    recordProviderHealth('openai', 'second', 1, 60, '503');
    claimProviderHealth('openai', 'old-probe', 62);
    claimProviderHealth('openai', 'new-probe', 183);
    expect(recordProviderHealth('openai', 'new-probe', 184, 60)).toBe('recover');
    expect(recordProviderHealth('openai', 'old-probe', 185, 60, 'late error')).toBeNull();
    claimProviderHealth('openai', 'fresh', 186);
    expect(recordProviderHealth('openai', 'fresh', 187, 60, '503')).toBeNull();
    expect(claimProviderHealth('openai', 'still-closed', 188).allowed).toBe(true);
  });

  it('ignores duplicate settlement and expires abandoned attempts without reopening a circuit', () => {
    claimProviderHealth('openai', 'once', 0);
    recordProviderHealth('openai', 'once', 1, 60, '503');
    expect(recordProviderHealth('openai', 'once', 2, 60, 'duplicate')).toBeNull();
    expect(claimProviderHealth('openai', 'abandoned', 3).allowed).toBe(true);
    claimProviderHealth('openai', 'new', 86_405);
    expect(recordProviderHealth('openai', 'abandoned', 86_406, 60, 'stale')).toBeNull();
    expect(claimProviderHealth('openai', 'still-healthy', 86_407).allowed).toBe(true);
  });
});
