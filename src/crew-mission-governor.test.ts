import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  claimNextMissionTask,
  completeMissionTask,
  createMissionTask,
  createMissionWorkflow,
  getMissionTask,
  getMissionWorkflow,
  applyMissionWorkflowTransition,
  getMissionGovernorReservation,
  getMissionGovernorStatus,
  reconcileMissionGovernorUsage,
  bindMissionGovernorReservation,
  authorizeMissionGovernorProvider,
  setMissionGovernorControl,
  getMissionGovernorAudit,
  missionGovernorOperationsEnabled,
  getHiveMindEntries,
  claimMissionWorkflowReport,
  settleMissionWorkflowReport,
  resumeMissionWorkflow,
} from './db.js';
import { parsePositiveInteger } from './config.js';
import { actionSetMissionGovernorControl } from './cli-actions.js';
import {
  setCrewMissionGovernorPolicyForTests,
  setCrewMissionsEnabledForTests,
} from './crew-mission-policy.js';

const strictPolicy = {
  maxActiveWorkflows: 1,
  maxRunningWorkers: 1,
  maxRunningCoordinators: 1,
  maxTurnsPerTask: 3,
  maxRuntimeSeconds: 600,
  turnBudget5h: 12,
  hardStopPercent: 75,
  providerTurnBudget5h: 12,
  warningPercent: 60,
  maxWorkflowDepth: 1,
  maxWorkflowTasks: 2,
  maxWorkflowFanout: 1,
  maxCoordinatorReviews: 2,
};

function createWorkflow(id: string, agent: string): void {
  createMissionWorkflow({
    id, rootTaskId: `${id}-root`, title: id, objective: id,
    initialPrompt: id, ownerAgent: 'main', workerAgent: agent, priority: 5,
    maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null,
  });
}

describe('Crew Mission governor admission', () => {
  beforeEach(() => {
    _initTestDatabase();
    setCrewMissionsEnabledForTests(true);
    setCrewMissionGovernorPolicyForTests(strictPolicy);
  });

  afterEach(() => {
    setCrewMissionGovernorPolicyForTests(undefined);
    setCrewMissionsEnabledForTests(undefined);
  });

  it('uses conservative positive defaults for invalid configuration', () => {
    expect(parsePositiveInteger(undefined, 1)).toBe(1);
    expect(parsePositiveInteger('0', 1)).toBe(1);
    expect(parsePositiveInteger('-2', 1)).toBe(1);
    expect(parsePositiveInteger('3', 1)).toBe(3);
  });

  it('atomically rejects a second active workflow', () => {
    createWorkflow('wf-one', 'worker-a');
    expect(() => createWorkflow('wf-two', 'worker-b'))
      .toThrow('Crew Mission governor allows 1 active workflow(s)');
  });

  it('rejects caller bounds above the host governor', () => {
    expect(() => createMissionWorkflow({
      id: 'too-wide', rootTaskId: 'too-wide-root', title: 'wide', objective: 'wide',
      initialPrompt: 'wide', ownerAgent: 'main', workerAgent: 'worker-a', priority: 5,
      maxDepth: 2, maxTasks: 2, maxFanout: 1, deadlineAt: null,
    })).toThrow('exceeds host governor workflow bounds');
  });

  it('retains the active-workflow slot while waiting for human input and resumes within it', () => {
    createWorkflow('wf-waiting', 'worker-a');
    claimNextMissionTask('worker-a');
    completeMissionTask('wf-waiting-root', 'Need a decision', 'completed');
    const coordinator = claimNextMissionTask('main')!;
    applyMissionWorkflowTransition({ id: 'wait', coordinatorTaskId: coordinator.id,
      actor: 'main', disposition: 'wait_for_human', idempotencyKey: 'wait', reason: 'Proceed?' });
    completeMissionTask(coordinator.id, 'Proceed?', 'completed');
    expect(getMissionWorkflow('wf-waiting')?.status).toBe('waiting_human');
    expect(() => createWorkflow('wf-second', 'worker-b'))
      .toThrow('Crew Mission governor allows 1 active workflow(s)');
    const resumed = resumeMissionWorkflow({ workflowId: 'wf-waiting', ownerAgent: 'main',
      answerTaskId: 'answer', answer: 'Proceed' });
    expect(claimNextMissionTask('main')?.id).toBe(resumed.coordinatorTaskId);
  });

  it('exhausts before exceeding the coordinator review ceiling', () => {
    setCrewMissionGovernorPolicyForTests({ ...strictPolicy, maxCoordinatorReviews: 1 });
    createWorkflow('wf-reviews', 'worker-a');
    expect(claimNextMissionTask('worker-a')?.id).toBe('wf-reviews-root');
    const first = completeMissionTask('wf-reviews-root', 'first', 'completed');
    const coordinator = claimNextMissionTask('main');
    expect(coordinator?.id).toBe(first.coordinatorTaskId);
    const transition = applyMissionWorkflowTransition({
      id: 'transition-review', coordinatorTaskId: coordinator!.id, actor: 'main',
      disposition: 'dispatch', idempotencyKey: 'review-next',
      dispatches: [{ id: 'review-worker-two', title: 'two', prompt: 'two', agent: 'worker-a', priority: 5 }],
    });
    expect(transition.createdTaskIds).toEqual([]);
    expect(claimNextMissionTask('worker-a')).toBeNull();
    expect(getMissionWorkflow('wf-reviews')).toMatchObject({
      status: 'exhausted', terminal_reason: expect.stringContaining('no follow-up can be assessed'),
    });
  });

  it('returns findings instead of launching a follow-up without budget for its review', () => {
    createWorkflow('wf-assessment', 'worker-a');
    claimNextMissionTask('worker-a');
    completeMissionTask('wf-assessment-root', 'Verified first finding', 'completed');
    const coordinator = claimNextMissionTask('main')!;
    const request = {
      id: 'assessment-next', coordinatorTaskId: coordinator.id, actor: 'main',
      disposition: 'dispatch' as const, idempotencyKey: 'next',
      dispatches: [{ id: 'cannot-afford', title: 'Follow-up', prompt: 'More research', agent: 'worker-a', priority: 5 }],
    };
    const transition = applyMissionWorkflowTransition(request);
    expect(transition).toMatchObject({ disposition: 'exhausted', createdTaskIds: [],
      reason: expect.stringContaining('6 turns required, 3 remaining') });
    completeMissionTask(coordinator.id, 'stopped at the host budget', 'completed');
    expect(getMissionTask('cannot-afford')).toBeNull();
    expect(getMissionGovernorStatus().usedTurns).toBe(6);
    expect(applyMissionWorkflowTransition(request).duplicate).toBe(true);
    const report = claimMissionWorkflowReport('main', 'first')!;
    expect(report.body).toContain('Mission exhausted');
    expect(report.body).toContain('Verified first finding');
    expect(report.body).toContain('no follow-up was dispatched');
    settleMissionWorkflowReport(report.id, 'first');
    expect(claimMissionWorkflowReport('main', 'duplicate')).toBeNull();
  });

  it('completes one follow-up and its final assessment when the configured budget covers all four turns', () => {
    // Explicit operator-sized fixture, not a change to the conservative defaults.
    setCrewMissionGovernorPolicyForTests({ ...strictPolicy, turnBudget5h: 16, providerTurnBudget5h: 16 });
    createWorkflow('wf-followup', 'worker-a');
    claimNextMissionTask('worker-a');
    completeMissionTask('wf-followup-root', 'First finding', 'completed');
    const firstReview = claimNextMissionTask('main')!;
    applyMissionWorkflowTransition({ id: 'followup-next', coordinatorTaskId: firstReview.id, actor: 'main',
      disposition: 'dispatch', idempotencyKey: 'next',
      dispatches: [{ id: 'followup-worker', title: 'Follow-up', prompt: 'Verify finding', agent: 'worker-a', priority: 5 }] });
    completeMissionTask(firstReview.id, 'follow-up assigned', 'completed');
    expect(claimNextMissionTask('worker-a')?.id).toBe('followup-worker');
    completeMissionTask('followup-worker', 'Final verified finding', 'completed');
    const finalReview = claimNextMissionTask('main')!;
    expect(finalReview.role).toBe('coordinator');
    applyMissionWorkflowTransition({ id: 'followup-done', coordinatorTaskId: finalReview.id, actor: 'main',
      disposition: 'complete', idempotencyKey: 'done' });
    completeMissionTask(finalReview.id, 'accepted', 'completed');
    expect(getMissionWorkflow('wf-followup')?.status).toBe('completed');
    expect(getMissionGovernorStatus()).toMatchObject({ usedTurns: 12, hardAllowanceTurns: 12, activeReservations: 0 });
    expect(claimMissionWorkflowReport('main', 'final')?.body).toContain('Final verified finding');
  });

  it('allows one workflow worker globally while ordinary Missions continue', () => {
    createWorkflow('wf-one', 'worker-a');
    expect(claimNextMissionTask('worker-a')?.id).toBe('wf-one-root');

    createMissionTask(
      'workflow-extra', 'Extra', 'wait', 'worker-b', 'main', 5,
      null, null, 'task', 'queued', null, null, 'wf-one', 1,
    );
    createMissionTask('ordinary', 'Ordinary', 'run', 'worker-b', 'main', 1);

    expect(claimNextMissionTask('worker-b')?.id).toBe('ordinary');
    expect(getMissionTask('workflow-extra')?.status).toBe('queued');

    completeMissionTask('ordinary', 'done', 'completed');
    completeMissionTask('wf-one-root', 'done', 'completed');
    expect(claimNextMissionTask('worker-b')?.id).toBe('workflow-extra');
  });

  it('reserves before execution and charges missing usage conservatively', () => {
    createWorkflow('wf-budget', 'worker-a');
    expect(claimNextMissionTask('worker-a')?.id).toBe('wf-budget-root');
    expect(getMissionGovernorReservation('wf-budget-root')).toMatchObject({
      state: 'active', reserved_turns: 3, charged_turns: null,
    });
    completeMissionTask('wf-budget-root', 'done', 'completed');
    expect(getMissionGovernorReservation('wf-budget-root')).toMatchObject({
      state: 'released', charged_turns: 3,
    });
  });

  it('parks workflow work at the five-hour hard stop without blocking ordinary Missions', () => {
    createWorkflow('wf-budget', 'worker-a');
    for (const id of ['wf-budget-root', 'budget-two', 'budget-three']) {
      if (id !== 'wf-budget-root') {
        createMissionTask(id, id, id, 'worker-a', 'main', 5, null, null, 'task', 'queued', null, null, 'wf-budget', 1);
      }
      expect(claimNextMissionTask('worker-a')?.id).toBe(id);
      completeMissionTask(id, 'done', 'completed');
    }
    createMissionTask('budget-four', 'four', 'four', 'worker-a', 'main', 5, null, null, 'task', 'queued', null, null, 'wf-budget', 1);
    createMissionTask('ordinary-budget', 'ordinary', 'ordinary', 'worker-a', 'main', 1);
    expect(claimNextMissionTask('worker-a')?.id).toBe('ordinary-budget');
    expect(getMissionTask('budget-four')?.status).toBe('queued');
    const status = getMissionGovernorStatus();
    expect(status.budgetState).toBe('hard_stop');
    expect(status.parkedWorkflowTasks).toBeGreaterThan(0);
    expect(getMissionGovernorAudit().map(entry => entry.action)).toEqual(
      expect.arrayContaining(['budget_warning', 'budget_hard_stop']),
    );
    expect(getHiveMindEntries(10).filter(entry => entry.chat_id === 'mission-governor')).toHaveLength(2);
  });

  it('reconciles reported usage before release', () => {
    createWorkflow('wf-reconcile', 'worker-a');
    expect(claimNextMissionTask('worker-a')?.id).toBe('wf-reconcile-root');
    expect(bindMissionGovernorReservation('wf-reconcile-root', 'openai', 'gpt-6-astra')).toBe(true);
    expect(reconcileMissionGovernorUsage('wf-reconcile-root', {
      turns: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50,
      cacheCreationTokens: 5, costUsd: 0.12, durationMs: 900,
    })).toBe(true);
    completeMissionTask('wf-reconcile-root', 'done', 'completed');
    expect(getMissionGovernorReservation('wf-reconcile-root')?.charged_turns).toBe(1);
    expect(getMissionGovernorStatus()).toMatchObject({
      budgetTurns: 12,
      hardAllowanceTurns: 9,
      usedTurns: 1,
      remainingTurns: 8,
      activeReservations: 0,
      providerUsage: [{ provider: 'openai', model: 'gpt-6-astra', turns: 1, activeReservations: 0 }],
      warningAtTurns: 7,
      budgetState: 'normal',
      totals: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 5, costUsd: 0.12, durationMs: 900 },
    });
  });

  it('parks a task when its selected provider budget is exhausted', () => {
    setCrewMissionGovernorPolicyForTests({ ...strictPolicy, providerTurnBudget5h: 4 });
    const now = Math.floor(Date.now() / 1000);
    createWorkflow('wf-provider', 'worker-a');
    expect(claimNextMissionTask('worker-a')?.id).toBe('wf-provider-root');
    expect(authorizeMissionGovernorProvider('wf-provider-root', 'openai', 'gpt-6-astra', now).allowed).toBe(true);
    completeMissionTask('wf-provider-root', 'done', 'completed');

    createMissionTask('provider-two', 'two', 'two', 'worker-a', 'main', 5, null, null, 'task', 'queued', null, null, 'wf-provider', 1);
    expect(claimNextMissionTask('worker-a')?.id).toBe('provider-two');
    const denied = authorizeMissionGovernorProvider('provider-two', 'openai', 'gpt-6-astra', now + 100);
    expect(denied).toMatchObject({ allowed: false, reason: 'Crew Mission openai five-hour budget exhausted' });
    expect(getMissionTask('provider-two')).toMatchObject({ status: 'queued', error: denied.reason, available_at: denied.retryAt });
    expect(getMissionGovernorReservation('provider-two')).toMatchObject({ state: 'released', charged_turns: 0 });
  });

  it('audits operator control changes and expires enablement', () => {
    setMissionGovernorControl({ enabled: false, actor: 'main', reason: 'incident freeze', now: 1_000 });
    expect(missionGovernorOperationsEnabled(1_001)).toBe(false);
    setMissionGovernorControl({ enabled: true, actor: 'main', reason: 'bounded test', expiresAt: 1_600, now: 1_100 });
    expect(missionGovernorOperationsEnabled(1_599)).toBe(true);
    expect(missionGovernorOperationsEnabled(1_600)).toBe(false);
    expect(getMissionGovernorAudit()).toMatchObject([
      { action: 'enable', actor: 'main', reason: 'bounded test', previous_enabled: 0, new_enabled: 1, expires_at: 1_600 },
      { action: 'disable', actor: 'main', reason: 'incident freeze', new_enabled: 0 },
    ]);
  });

  it('restricts control changes to main and requires an operator reason', () => {
    expect(() => actionSetMissionGovernorControl({ enabled: true, reason: '', createdBy: 'main' }))
      .toThrow('A reason is required');
    expect(() => actionSetMissionGovernorControl({ enabled: true, reason: 'try', createdBy: 'worker-a' }))
      .toThrow('Only the main operator');
    expect(() => actionSetMissionGovernorControl({ enabled: true, reason: 'test', durationMinutes: 1441, createdBy: 'main' }))
      .toThrow('--for-minutes');
  });
});
