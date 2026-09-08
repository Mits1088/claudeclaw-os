import { beforeEach, expect, it } from 'vitest';
import { _initTestDatabase, ensureWorkerDesiredState, beginWorkerSupervisorEpoch,
  acquireWorkerLease, createMissionWorkflow, claimNextMissionTask, completeMissionTask,
  getMissionTask, failStuckMissionTasks, deferMissionForProvider,
  reconcileMissionGovernorUsage, getMissionGovernorReservation, recordMissionProviderFailure, getMissionProviderRecovery } from './db.js';

const fence = { agentId: 'worker', instanceId: 'instance-1', generation: 1 };
beforeEach(() => {
  _initTestDatabase();
  ensureWorkerDesiredState('worker', 'active');
  beginWorkerSupervisorEpoch('epoch-1', 'build-1');
  acquireWorkerLease({ ...fence, supervisorEpoch: 'epoch-1', runtimeBuildId: 'build-1', pid: 123, processStartedAt: 100 });
  createMissionWorkflow({ id: 'wf', rootTaskId: 'claim', title: 'Claim', objective: 'Synthetic',
    initialPrompt: 'Synthetic', ownerAgent: 'main', workerAgent: 'worker', priority: 5,
    maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
  expect(claimNextMissionTask('worker', fence.instanceId)?.claiming_instance_id).toBe(fence.instanceId);
});

it('rejects omitted, wrong-agent and wrong-instance fences without changing the row', () => {
  for (const candidate of [undefined, { ...fence, generation: undefined },
    { ...fence, agentId: 'other' }, { ...fence, instanceId: 'other' }]) {
    expect(completeMissionTask('claim', 'bad', 'completed', undefined, candidate).changed).toBe(false);
    expect(getMissionTask('claim')).toMatchObject({ status: 'running', result: null });
  }
  expect(completeMissionTask('claim', 'accepted', 'completed', undefined, fence).changed).toBe(true);
  expect(completeMissionTask('claim', 'duplicate', 'completed', undefined, fence).changed).toBe(false);
  expect(getMissionTask('claim')?.result).toBe('accepted');
});

it('rejects a previous attempt from the same still-live worker instance after retry claim', () => {
  const now = Math.floor(Date.now() / 1000);
  const retry = { taskId: 'claim', providerJson: '{}', failureJson: '{}',
    deadlineAt: now + 300, availableAt: now, reason: 'synthetic retry', fence };
  expect(deferMissionForProvider(retry)).toBe(true);
  const next = claimNextMissionTask('worker', fence.instanceId)!;
  expect(next.claim_generation).toBe(2);
  expect(completeMissionTask('claim', 'late result', 'completed', undefined, fence).changed).toBe(false);
  expect(recordMissionProviderFailure('claim', '{"stale":true}', 'late', now + 1, fence)).toBe(false);
  expect(reconcileMissionGovernorUsage('claim', 1, fence)).toBe(false);
  expect(deferMissionForProvider(retry)).toBe(false);
  expect(getMissionTask('claim')).toMatchObject({ status: 'running', claim_generation: 2 });
  expect(getMissionProviderRecovery('claim')?.deadline_at).toBe(now + 300);
  const current = { ...fence, generation: next.claim_generation };
  expect(reconcileMissionGovernorUsage('claim', 1, current)).toBe(true);
  expect(completeMissionTask('claim', 'current result', 'completed', undefined, current).changed).toBe(true);
});

it('rejects a formerly valid instance after supervisor replacement', () => {
  expect(failStuckMissionTasks('worker', 'interrupted')).toBe(0);
  beginWorkerSupervisorEpoch('epoch-2', 'build-2');
  expect(completeMissionTask('claim', 'stale', 'failed', undefined, fence).changed).toBe(false);
  expect(getMissionTask('claim')?.status).toBe('running');
  expect(failStuckMissionTasks('worker', 'interrupted')).toBe(1);
  expect(getMissionTask('claim')).toMatchObject({ status: 'failed', error: 'interrupted' });
});

it('fences usage and provider requeue against the same claim ownership', () => {
  const now = Math.floor(Date.now() / 1000);
  const requeue = { taskId: 'claim', providerJson: '{}', failureJson: '{}',
    deadlineAt: now + 300, availableAt: now + 30, reason: 'synthetic' };
  expect(reconcileMissionGovernorUsage('claim', 1)).toBe(false);
  expect(deferMissionForProvider(requeue)).toBe(false);
  expect(reconcileMissionGovernorUsage('claim', 2, fence)).toBe(true);
  expect(getMissionGovernorReservation('claim')?.charged_turns).toBe(2);
  beginWorkerSupervisorEpoch('epoch-2', 'build-2');
  expect(reconcileMissionGovernorUsage('claim', 1, fence)).toBe(false);
  expect(deferMissionForProvider({ ...requeue, fence })).toBe(false);
  expect(getMissionTask('claim')?.status).toBe('running');
  expect(getMissionGovernorReservation('claim')?.charged_turns).toBe(2);
});


it('rejects stale provider failure metadata without changing an accepted retry deadline', () => {
  const now = Math.floor(Date.now() / 1000);
  expect(recordMissionProviderFailure('claim', '{}', 'unfenced', now + 30)).toBe(false);
  expect(getMissionProviderRecovery('claim')).toBeNull();
  expect(recordMissionProviderFailure('claim', '{}', 'accepted', now + 300, fence)).toBe(true);
  beginWorkerSupervisorEpoch('epoch-2', 'build-2');
  expect(recordMissionProviderFailure('claim', '{"stale":true}', 'stale', now + 1, fence)).toBe(false);
  expect(getMissionProviderRecovery('claim')).toMatchObject({ reason: 'accepted', deadline_at: now + 300, failure_json: '{}' });
});
