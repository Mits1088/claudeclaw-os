import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  applyMissionWorkflowTransition,
  cancelMissionTask,
  cancelMissionWorkflow,
  claimNextMissionTask,
  completeMissionTask,
  createMissionTask,
  createMissionWorkflow,
  deleteMissionTask,
  getMissionOutcome,
  getMissionTask,
  getMissionWorkflow,
  getMissionWorkflowOutcomes,
  getMissionWorkflowTasks,
  maybeReleaseJoinForMission,
  reconcileMissionControl,
  resumeMissionWorkflow,
} from './db.js';
import { actionContinueMission, actionHandbackMission, CliActionError } from './cli-actions.js';

describe('durable mission workflow control plane', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function seedWorkflow(overrides: Partial<Parameters<typeof createMissionWorkflow>[0]> = {}) {
    return createMissionWorkflow({
      id: 'wf-1',
      rootTaskId: 'root-1',
      title: 'Initial research',
      objective: 'Reach a verified answer without expanding authority',
      initialPrompt: 'Research the first question',
      ownerAgent: 'main',
      workerAgent: 'bobbi',
      priority: 5,
      maxDepth: 3,
      maxTasks: 6,
      maxFanout: 2,
      deadlineAt: null,
      ...overrides,
    });
  }

  function finishRoot() {
    expect(claimNextMissionTask('bobbi')?.id).toBe('root-1');
    return completeMissionTask('root-1', 'finding one', 'completed');
  }

  it('atomically persists one outcome and one coordinator wake-up', () => {
    seedWorkflow();
    const first = finishRoot();

    expect(first).toMatchObject({
      changed: true,
      outcomeId: 'outcome:root-1',
      coordinatorTaskId: 'coord:outcome:root-1',
    });
    expect(getMissionWorkflow('wf-1')?.status).toBe('coordinating');
    expect(getMissionOutcome('outcome:root-1')).toMatchObject({
      orchestration_state: 'coordinating',
      orchestration_attempts: 1,
      coordinator_task_id: 'coord:outcome:root-1',
    });
    expect(getMissionTask('coord:outcome:root-1')).toMatchObject({
      role: 'coordinator',
      status: 'queued',
      assigned_agent: 'main',
      workflow_id: 'wf-1',
    });

    const replay = completeMissionTask('root-1', 'different replay', 'completed');
    expect(replay).toMatchObject({ changed: false, coordinatorTaskId: 'coord:outcome:root-1' });
    expect(getMissionWorkflowOutcomes('wf-1')).toHaveLength(1);
    expect(getMissionWorkflowTasks('wf-1').filter((task) => task.role === 'coordinator')).toHaveLength(1);
  });

  it('rejects legacy handback and continuation edges inside a durable workflow', () => {
    seedWorkflow({ ownerAgent: 'bobbi' });
    expect(claimNextMissionTask('bobbi')?.id).toBe('root-1');

    expect(() => actionHandbackMission({
      taskId: 'root-1', report: 'bypass', createdBy: 'bobbi',
    })).toThrowError(CliActionError);
    expect(() => actionContinueMission({
      taskId: 'root-1', prompt: 'bypass', idempotencyKey: 'bypass', maxSteps: 3, createdBy: 'bobbi',
    })).toThrowError(/use the workflow coordinator transition/);
  });

  it('applies one dispatch transition and returns it on a retry with another key', () => {
    seedWorkflow();
    finishRoot();
    const coordinator = claimNextMissionTask('main')!;

    const first = applyMissionWorkflowTransition({
      id: 'transition-1',
      coordinatorTaskId: coordinator.id,
      actor: 'main',
      disposition: 'dispatch',
      idempotencyKey: 'acceptance-repair',
      dispatches: [{
        id: 'repair-1', title: 'Repair', prompt: 'Repair the finding', agent: 'amos', priority: 5,
      }],
    });
    const replay = applyMissionWorkflowTransition({
      id: 'transition-2',
      coordinatorTaskId: coordinator.id,
      actor: 'main',
      disposition: 'complete',
      idempotencyKey: 'different-key',
    });

    expect(first).toMatchObject({ disposition: 'dispatch', duplicate: false, createdTaskIds: ['repair-1'] });
    expect(replay).toMatchObject({ disposition: 'dispatch', duplicate: true, createdTaskIds: ['repair-1'] });
    expect(getMissionWorkflow('wf-1')).toMatchObject({ status: 'active', tasks_created: 2 });
    expect(getMissionWorkflowTasks('wf-1').filter((task) => task.id === 'repair-1')).toHaveLength(1);

    completeMissionTask(coordinator.id, 'dispatched', 'completed');
    expect(getMissionWorkflow('wf-1')?.status).toBe('active');
  });

  it('runs coordinator to specialist to coordinator to specialist to completion', () => {
    seedWorkflow();
    finishRoot();

    const firstCoordinator = claimNextMissionTask('main')!;
    applyMissionWorkflowTransition({
      id: 'transition-first', coordinatorTaskId: firstCoordinator.id, actor: 'main',
      disposition: 'dispatch', idempotencyKey: 'verify',
      dispatches: [{ id: 'verify-1', title: 'Verify', prompt: 'Verify the finding', agent: 'amos', priority: 5 }],
    });
    completeMissionTask(firstCoordinator.id, 'Verification dispatched', 'completed');

    expect(claimNextMissionTask('amos')?.id).toBe('verify-1');
    const verification = completeMissionTask('verify-1', 'verified evidence', 'completed');
    expect(verification.coordinatorTaskId).toBe('coord:outcome:verify-1');

    const secondCoordinator = claimNextMissionTask('main')!;
    expect(secondCoordinator.prompt).toContain('finding one');
    expect(secondCoordinator.prompt).toContain('dispatch: tasks verify-1');
    expect(secondCoordinator.prompt).toContain('verified evidence');
    applyMissionWorkflowTransition({
      id: 'transition-complete', coordinatorTaskId: secondCoordinator.id, actor: 'main',
      disposition: 'complete', idempotencyKey: 'accepted', reason: 'Evidence verified',
    });
    completeMissionTask(secondCoordinator.id, 'Complete', 'completed');

    expect(getMissionWorkflow('wf-1')).toMatchObject({
      status: 'completed',
      tasks_created: 2,
      terminal_reason: 'Evidence verified',
    });
    expect(getMissionWorkflowOutcomes('wf-1')).toHaveLength(2);
  });

  it('blocks a workflow when its coordinator exits without a transition', () => {
    seedWorkflow();
    finishRoot();
    const coordinator = claimNextMissionTask('main')!;

    completeMissionTask(coordinator.id, 'I forgot to decide', 'completed');

    expect(getMissionWorkflow('wf-1')).toMatchObject({
      status: 'blocked',
      terminal_reason: expect.stringContaining('without an accepted transition'),
    });
    expect(getMissionOutcome('outcome:root-1')?.orchestration_state).toBe('blocked');
  });

  it('persists exhaustion instead of queueing work beyond a bound', () => {
    seedWorkflow({ maxDepth: 1, maxTasks: 1 });
    finishRoot();
    const coordinator = claimNextMissionTask('main')!;

    const result = applyMissionWorkflowTransition({
      id: 'transition-bound',
      coordinatorTaskId: coordinator.id,
      actor: 'main',
      disposition: 'dispatch',
      idempotencyKey: 'too-many',
      dispatches: [{ id: 'never', title: 'Never', prompt: 'Nope', agent: 'amos', priority: 5 }],
    });

    expect(result).toMatchObject({ disposition: 'exhausted', workflowStatus: 'exhausted', createdTaskIds: [] });
    expect(getMissionWorkflow('wf-1')?.terminal_reason).toContain('task limit 1');
    expect(getMissionTask('never')).toBeNull();
  });

  it('waits for one human answer and resumes the same workflow', () => {
    seedWorkflow();
    finishRoot();
    const coordinator = claimNextMissionTask('main')!;
    applyMissionWorkflowTransition({
      id: 'transition-wait',
      coordinatorTaskId: coordinator.id,
      actor: 'main',
      disposition: 'wait_for_human',
      idempotencyKey: 'need-choice',
      reason: 'Choose A or B',
    });
    completeMissionTask(coordinator.id, 'Which option?', 'completed');

    expect(getMissionWorkflow('wf-1')?.status).toBe('waiting_human');
    const resumed = resumeMissionWorkflow({
      workflowId: 'wf-1', ownerAgent: 'main', answerTaskId: 'human-1', answer: 'Choose B',
    });
    expect(resumed.coordinatorTaskId).toBe('coord:outcome:human-1');
    expect(getMissionTask(resumed.coordinatorTaskId)?.status).toBe('queued');
    expect(getMissionWorkflow('wf-1')?.status).toBe('coordinating');
  });

  it('releases a bounded workflow gather into one coordinator turn', () => {
    seedWorkflow();
    finishRoot();
    const coordinator = claimNextMissionTask('main')!;
    applyMissionWorkflowTransition({
      id: 'transition-gather',
      coordinatorTaskId: coordinator.id,
      actor: 'main',
      disposition: 'gather',
      idempotencyKey: 'parallel-check',
      dispatches: [
        { id: 'gather-a', title: 'Check A', prompt: 'Check A', agent: 'amos', priority: 5 },
        { id: 'gather-b', title: 'Check B', prompt: 'Check B', agent: 'bobbi', priority: 5 },
      ],
    });
    completeMissionTask(coordinator.id, 'gathered', 'completed');

    expect(claimNextMissionTask('amos')?.id).toBe('gather-a');
    completeMissionTask('gather-a', 'A is good', 'completed');
    maybeReleaseJoinForMission(getMissionTask('gather-a')!);
    expect(getMissionTask('coord-group:transition-gather')?.status).toBe('waiting');

    expect(claimNextMissionTask('bobbi')?.id).toBe('gather-b');
    completeMissionTask('gather-b', 'B is good', 'completed');
    maybeReleaseJoinForMission(getMissionTask('gather-b')!);

    const join = getMissionTask('coord-group:transition-gather');
    expect(join).toMatchObject({ status: 'queued', role: 'coordinator' });
    expect(join?.prompt).toContain('A is good');
    expect(join?.prompt).toContain('B is good');
    expect(join?.source_outcome_id).toBe('outcome:group:wfgrp:transition-gather');
    expect(getMissionWorkflowOutcomes('wf-1').filter((outcome) => outcome.orchestration_state === 'coordinating')).toHaveLength(1);
  });

  it('makes an unrecoverable empty gather visibly blocked during reconciliation', () => {
    createMissionTask(
      'orphan-join', 'Orphan join', 'wait', 'main', 'main', 5,
      null, 'orphan-group', 'join', 'waiting',
    );

    const result = reconcileMissionControl();
    expect(result.blockedJoins).toBe(1);
    expect(getMissionTask('orphan-join')).toMatchObject({
      status: 'blocked',
      error: expect.stringContaining('no child tasks'),
    });
  });

  it('expires a workflow deadline and cancels work that has not started', () => {
    seedWorkflow({ deadlineAt: Math.floor(Date.now() / 1000) - 1 });

    const result = reconcileMissionControl();

    expect(result.expiredWorkflows).toBe(1);
    expect(getMissionWorkflow('wf-1')).toMatchObject({
      status: 'exhausted',
      terminal_reason: expect.stringContaining('deadline reached'),
    });
    expect(getMissionTask('root-1')).toMatchObject({ status: 'cancelled' });
    expect(getMissionOutcome('outcome:root-1')).toMatchObject({
      task_status: 'cancelled',
      orchestration_state: 'blocked',
    });
  });

  it('allows a running task to record its result after cancellation without advancing', () => {
    seedWorkflow();
    expect(claimNextMissionTask('bobbi')?.id).toBe('root-1');
    const cancelled = cancelMissionWorkflow('wf-1', 'main');
    expect(cancelled).toMatchObject({ found: true, alreadyCancelled: false, cancelledTasks: 0 });

    const completion = completeMissionTask('root-1', 'work finished after cancellation', 'completed');

    expect(completion).toMatchObject({ changed: true, coordinatorTaskId: null });
    expect(getMissionWorkflow('wf-1')?.status).toBe('cancelled');
    expect(getMissionOutcome('outcome:root-1')).toMatchObject({
      task_status: 'completed',
      orchestration_state: 'blocked',
    });
    expect(getMissionWorkflowTasks('wf-1').filter((task) => task.role === 'coordinator')).toHaveLength(0);
  });

  it('records direct worker cancellation and wakes the active workflow coordinator', () => {
    seedWorkflow();

    expect(cancelMissionTask('root-1')).toBe(true);

    expect(getMissionOutcome('outcome:root-1')).toMatchObject({
      task_status: 'cancelled',
      orchestration_state: 'coordinating',
      coordinator_task_id: 'coord:outcome:root-1',
    });
    expect(getMissionTask('coord:outcome:root-1')).toMatchObject({
      role: 'coordinator',
      status: 'queued',
    });
  });

  it('records direct worker cancellation after workflow cancellation without waking', () => {
    seedWorkflow();
    expect(claimNextMissionTask('bobbi')?.id).toBe('root-1');
    cancelMissionWorkflow('wf-1', 'main');

    expect(cancelMissionTask('root-1')).toBe(true);

    expect(getMissionOutcome('outcome:root-1')).toMatchObject({
      task_status: 'cancelled',
      orchestration_state: 'blocked',
      terminal_reason: 'Workflow is cancelled',
    });
    expect(getMissionWorkflowTasks('wf-1').filter((task) => task.role === 'coordinator')).toHaveLength(0);
  });

  it('recreates one missing coordinator after a crash-like deletion', () => {
    seedWorkflow();
    finishRoot();
    const coordinatorId = 'coord:outcome:root-1';
    expect(cancelMissionTask(coordinatorId)).toBe(true);
    expect(deleteMissionTask(coordinatorId)).toBe(true);

    const result = reconcileMissionControl();

    expect(result.queuedCoordinators).toBe(1);
    expect(getMissionTask(coordinatorId)).toMatchObject({
      status: 'queued',
      role: 'coordinator',
      source_outcome_id: 'outcome:root-1',
    });
    expect(getMissionOutcome('outcome:root-1')).toMatchObject({
      orchestration_state: 'coordinating',
      coordinator_task_id: coordinatorId,
    });
  });
});
