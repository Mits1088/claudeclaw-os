import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  applyMissionWorkflowTransition,
  cancelMissionTask,
  cancelMissionWorkflow,
  claimNextMissionTask,
  cleanupOldMissionTasks,
  completeMissionTask,
  createMissionWorkflow,
  deleteMissionTask,
  getMissionOutcome,
  getMissionTask,
  getMissionWorkflow,
  getMissionWorkflowOutcomes,
  getMissionWorkflowTasks,
  getMissionWorkflowTransitions,
  maybeReleaseJoinForMission,
  reconcileMissionControl,
  resumeMissionWorkflow,
} from './db.js';

const STRESS_SEED = 0x2685eed;
const CYCLES = 108;
const EPOCH = new Date('2026-09-05T12:00:00.000Z');

type Disposition = Parameters<typeof applyMissionWorkflowTransition>[0]['disposition'];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
  };
}

function idsAreUnique(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

describe(`mission workflow deterministic stress matrix (seed 0x${STRESS_SEED.toString(16)})`, () => {
  afterEach(() => vi.useRealTimers());

  it(`preserves control-plane invariants for ${CYCLES} bounded isolated cycles`, () => {
    vi.useFakeTimers();
    const random = mulberry32(STRESS_SEED);
    const accepted = new Set<string>();
    const scenarioCounts = new Map<string, number>();

    const initialize = (cycle: number, overrides: Partial<Parameters<typeof createMissionWorkflow>[0]> = {}) => {
      vi.setSystemTime(new Date(EPOCH.getTime() + cycle * 60_000));
      _initTestDatabase();
      const suffix = String(cycle).padStart(3, '0');
      const workflowId = `stress-wf-${suffix}`;
      const rootTaskId = `stress-root-${suffix}`;
      createMissionWorkflow({
        id: workflowId,
        rootTaskId,
        title: `Stress cycle ${suffix}`,
        objective: 'Exercise only the durable mission control plane',
        initialPrompt: `Deterministic input ${suffix}`,
        ownerAgent: 'main',
        workerAgent: cycle % 2 === 0 ? 'worker-a' : 'worker-b',
        priority: 5,
        maxDepth: 4,
        maxTasks: 6,
        maxFanout: 2,
        deadlineAt: null,
        ...overrides,
      });
      return { suffix, workflowId, rootTaskId };
    };

    const finish = (taskId: string, agent: string, report: string) => {
      expect(claimNextMissionTask(agent)?.id).toBe(taskId);
      const first = completeMissionTask(taskId, report, 'completed');
      const duplicate = completeMissionTask(taskId, `${report} replay`, 'completed');
      expect(first.changed).toBe(true);
      expect(duplicate.changed).toBe(false);
      return first;
    };

    const assertInvariants = (workflowId: string) => {
      const tasks = getMissionWorkflowTasks(workflowId);
      const outcomes = getMissionWorkflowOutcomes(workflowId);
      const transitions = getMissionWorkflowTransitions(workflowId);
      expect(idsAreUnique(tasks.map(task => task.id))).toBe(true);
      expect(idsAreUnique(outcomes.map(outcome => outcome.id))).toBe(true);
      expect(idsAreUnique(transitions.map(transition => transition.id))).toBe(true);
      expect(idsAreUnique(transitions.map(transition => transition.source_outcome_id))).toBe(true);
      for (const transition of transitions) accepted.add(transition.disposition);
      const workflow = getMissionWorkflow(workflowId)!;
      expect(workflow.tasks_created).toBeLessThanOrEqual(workflow.max_tasks);
      expect(tasks.filter(task => task.role === 'task').length).toBeLessThanOrEqual(workflow.max_tasks);
    };

    const coordinateRoot = (rootTaskId: string, worker: string) => {
      finish(rootTaskId, worker, `evidence:${rootTaskId}`);
      const coordinator = claimNextMissionTask('main');
      expect(coordinator?.role).toBe('coordinator');
      return coordinator!;
    };

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const scenario = cycle % 9;
      const worker = cycle % 2 === 0 ? 'worker-a' : 'worker-b';
      const count = (name: string) => scenarioCounts.set(name, (scenarioCounts.get(name) ?? 0) + 1);

      if (scenario === 0) {
        count('sequential');
        const { suffix, workflowId, rootTaskId } = initialize(cycle);
        const coordinator = coordinateRoot(rootTaskId, worker);
        const disposition: Disposition = (['dispatch', 'continue_self', 'retry'] as const)[Math.floor(cycle / 9) % 3];
        const childId = `sequential-${suffix}`;
        const childAgent = random() < 0.5 ? 'worker-a' : 'worker-b';
        const applied = applyMissionWorkflowTransition({
          id: `transition-sequential-${suffix}`,
          coordinatorTaskId: coordinator.id,
          actor: 'main',
          disposition,
          idempotencyKey: `sequential-${suffix}`,
          dispatches: [{ id: childId, title: 'Sequential child', prompt: 'Check', agent: childAgent, priority: 5 }],
        });
        const replay = applyMissionWorkflowTransition({
          id: `transition-sequential-replay-${suffix}`,
          coordinatorTaskId: coordinator.id,
          actor: 'main',
          disposition: 'complete',
          idempotencyKey: `different-${suffix}`,
        });
        expect(applied).toMatchObject({ duplicate: false, disposition, createdTaskIds: [childId] });
        expect(replay).toMatchObject({ duplicate: true, disposition, createdTaskIds: [childId] });
        completeMissionTask(coordinator.id, 'dispatch accepted', 'completed');
        finish(childId, childAgent, 'child evidence');
        const finalCoordinator = claimNextMissionTask('main')!;
        applyMissionWorkflowTransition({ id: `transition-done-${suffix}`, coordinatorTaskId: finalCoordinator.id, actor: 'main', disposition: 'complete', idempotencyKey: `done-${suffix}` });
        completeMissionTask(finalCoordinator.id, 'accepted', 'completed');
        expect(getMissionWorkflow(workflowId)?.status).toBe('completed');
        assertInvariants(workflowId);
      } else if (scenario === 1) {
        count('gather');
        const { suffix, workflowId, rootTaskId } = initialize(cycle);
        const coordinator = coordinateRoot(rootTaskId, worker);
        const children = [
          { id: `gather-a-${suffix}`, agent: 'worker-a' },
          { id: `gather-b-${suffix}`, agent: 'worker-b' },
        ];
        if (random() < 0.5) children.reverse();
        const transitionId = `transition-gather-${suffix}`;
        const applied = applyMissionWorkflowTransition({
          id: transitionId,
          coordinatorTaskId: coordinator.id,
          actor: 'main',
          disposition: 'gather',
          idempotencyKey: `gather-${suffix}`,
          dispatches: children.map(child => ({ id: child.id, title: child.id, prompt: 'Gather evidence', agent: child.agent, priority: 5 })),
        });
        const replay = applyMissionWorkflowTransition({ id: `replay-${transitionId}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'fail', idempotencyKey: `replay-${suffix}` });
        expect(applied.createdTaskIds).toEqual(children.map(child => child.id));
        expect(replay).toMatchObject({ duplicate: true, disposition: 'gather' });
        completeMissionTask(coordinator.id, 'gather accepted', 'completed');
        const completionOrder = random() < 0.5 ? children : [...children].reverse();
        completionOrder.forEach((child, index) => {
          finish(child.id, child.agent, `gather evidence ${child.id}`);
          maybeReleaseJoinForMission(getMissionTask(child.id)!);
          maybeReleaseJoinForMission(getMissionTask(child.id)!);
          expect(getMissionTask(`coord-group:${transitionId}`)?.status).toBe(index === 0 ? 'waiting' : 'queued');
        });
        const join = claimNextMissionTask('main')!;
        expect(join.id).toBe(`coord-group:${transitionId}`);
        applyMissionWorkflowTransition({ id: `gather-done-${suffix}`, coordinatorTaskId: join.id, actor: 'main', disposition: 'complete', idempotencyKey: `gather-done-${suffix}` });
        completeMissionTask(join.id, 'accepted', 'completed');
        expect(getMissionWorkflowOutcomes(workflowId).filter(outcome => outcome.id.startsWith('outcome:group:'))).toHaveLength(1);
        assertInvariants(workflowId);
      } else if (scenario === 2) {
        count('terminal-dispositions');
        const { suffix, workflowId, rootTaskId } = initialize(cycle);
        const coordinator = coordinateRoot(rootTaskId, worker);
        const disposition = (['complete', 'block', 'fail'] as const)[Math.floor(cycle / 9) % 3];
        const applied = applyMissionWorkflowTransition({ id: `terminal-${suffix}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition, idempotencyKey: `terminal-${suffix}`, reason: disposition });
        const replay = applyMissionWorkflowTransition({ id: `terminal-replay-${suffix}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'dispatch', idempotencyKey: `other-${suffix}`, dispatches: [{ id: `never-${suffix}`, title: 'Never', prompt: 'Never', agent: worker, priority: 5 }] });
        expect(applied.duplicate).toBe(false);
        expect(replay).toMatchObject({ duplicate: true, disposition });
        expect(getMissionTask(`never-${suffix}`)).toBeNull();
        completeMissionTask(coordinator.id, 'terminal accepted', 'completed');
        expect(getMissionWorkflow(workflowId)?.status).toBe(disposition === 'complete' ? 'completed' : disposition === 'block' ? 'blocked' : 'failed');
        assertInvariants(workflowId);
      } else if (scenario === 3) {
        count('cancel');
        const { workflowId, rootTaskId } = initialize(cycle);
        const running = random() < 0.5;
        if (running) expect(claimNextMissionTask(worker)?.id).toBe(rootTaskId);
        const first = cancelMissionWorkflow(workflowId, 'main');
        const second = cancelMissionWorkflow(workflowId, 'main');
        expect(first).toMatchObject({ found: true, alreadyCancelled: false });
        expect(second).toMatchObject({ found: true, alreadyCancelled: true, cancelledTasks: 0 });
        if (running) {
          const completion = completeMissionTask(rootTaskId, 'late result', 'completed');
          expect(completion).toMatchObject({ changed: true, coordinatorTaskId: null });
          expect(completeMissionTask(rootTaskId, 'duplicate late result', 'completed').changed).toBe(false);
          expect(getMissionOutcome(`outcome:${rootTaskId}`)?.orchestration_state).toBe('blocked');
        } else {
          expect(getMissionTask(rootTaskId)?.status).toBe('cancelled');
        }
        expect(reconcileMissionControl()).toMatchObject({ queuedCoordinators: 0, expiredWorkflows: 0 });
        assertInvariants(workflowId);
      } else if (scenario === 4) {
        count('exhaustion');
        const { suffix, workflowId, rootTaskId } = initialize(cycle, { maxDepth: 1, maxTasks: 1, maxFanout: 1 });
        const coordinator = coordinateRoot(rootTaskId, worker);
        const applied = applyMissionWorkflowTransition({ id: `exhaust-${suffix}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'dispatch', idempotencyKey: `exhaust-${suffix}`, dispatches: [{ id: `over-bound-${suffix}`, title: 'Over bound', prompt: 'No', agent: worker, priority: 5 }] });
        const replay = applyMissionWorkflowTransition({ id: `exhaust-replay-${suffix}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'complete', idempotencyKey: `other-${suffix}` });
        expect(applied).toMatchObject({ disposition: 'exhausted', duplicate: false, createdTaskIds: [], workflowStatus: 'exhausted' });
        expect(replay).toMatchObject({ disposition: 'exhausted', duplicate: true, createdTaskIds: [] });
        expect(getMissionTask(`over-bound-${suffix}`)).toBeNull();
        assertInvariants(workflowId);
      } else if (scenario === 5) {
        count('deadline');
        const deadlineAt = Math.floor((EPOCH.getTime() + cycle * 60_000) / 1000) + 1;
        const { workflowId, rootTaskId } = initialize(cycle, { deadlineAt });
        vi.advanceTimersByTime(2_000);
        expect(claimNextMissionTask(worker)).toBeNull();
        expect(reconcileMissionControl()).toMatchObject({ expiredWorkflows: 1 });
        expect(reconcileMissionControl()).toMatchObject({ expiredWorkflows: 0, queuedCoordinators: 0 });
        expect(getMissionWorkflow(workflowId)?.status).toBe('exhausted');
        expect(getMissionTask(rootTaskId)?.status).toBe('cancelled');
        expect(getMissionOutcome(`outcome:${rootTaskId}`)?.orchestration_state).toBe('blocked');
        assertInvariants(workflowId);
      } else if (scenario === 6) {
        count('wait-resume');
        const { suffix, workflowId, rootTaskId } = initialize(cycle);
        const coordinator = coordinateRoot(rootTaskId, worker);
        const waiting = applyMissionWorkflowTransition({ id: `wait-${suffix}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'wait_for_human', idempotencyKey: `wait-${suffix}`, reason: 'Need bounded input' });
        const replay = applyMissionWorkflowTransition({ id: `wait-replay-${suffix}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'complete', idempotencyKey: `wait-other-${suffix}` });
        expect(waiting).toMatchObject({ disposition: 'wait_for_human', duplicate: false });
        expect(replay).toMatchObject({ disposition: 'wait_for_human', duplicate: true });
        completeMissionTask(coordinator.id, 'waiting', 'completed');
        vi.advanceTimersByTime(8 * 86_400_000);
        expect(cleanupOldMissionTasks()).toBe(0);
        expect(getMissionTask(rootTaskId)).not.toBeNull();
        const resumed = resumeMissionWorkflow({ workflowId, ownerAgent: 'main', answerTaskId: `human-${suffix}`, answer: 'Proceed' });
        expect(claimNextMissionTask('main')?.id).toBe(resumed.coordinatorTaskId);
        const resumedCoordinator = getMissionTask(resumed.coordinatorTaskId)!;
        applyMissionWorkflowTransition({ id: `resume-done-${suffix}`, coordinatorTaskId: resumedCoordinator.id, actor: 'main', disposition: 'complete', idempotencyKey: `resume-done-${suffix}` });
        completeMissionTask(resumedCoordinator.id, 'accepted', 'completed');
        expect(getMissionWorkflow(workflowId)?.status).toBe('completed');
        assertInvariants(workflowId);
      } else if (scenario === 7) {
        count('reconciliation');
        const { suffix, workflowId, rootTaskId } = initialize(cycle);
        finish(rootTaskId, worker, 'recoverable evidence');
        const coordinatorId = `coord:outcome:${rootTaskId}`;
        expect(cancelMissionTask(coordinatorId)).toBe(true);
        expect(deleteMissionTask(coordinatorId)).toBe(true);
        expect(reconcileMissionControl()).toMatchObject({ queuedCoordinators: 1 });
        expect(reconcileMissionControl()).toMatchObject({ queuedCoordinators: 0 });
        expect(getMissionWorkflowTasks(workflowId).filter(task => task.id === coordinatorId)).toHaveLength(1);
        expect(claimNextMissionTask('main')?.id).toBe(coordinatorId);
        applyMissionWorkflowTransition({ id: `reconciled-${suffix}`, coordinatorTaskId: coordinatorId, actor: 'main', disposition: 'complete', idempotencyKey: `reconciled-${suffix}` });
        completeMissionTask(coordinatorId, 'accepted', 'completed');
        assertInvariants(workflowId);
      } else {
        count('retention');
        const { suffix, workflowId, rootTaskId } = initialize(cycle);
        const coordinator = coordinateRoot(rootTaskId, worker);
        applyMissionWorkflowTransition({ id: `retained-${suffix}`, coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'complete', idempotencyKey: `retained-${suffix}` });
        completeMissionTask(coordinator.id, 'accepted', 'completed');
        const outcomeCount = getMissionWorkflowOutcomes(workflowId).length;
        const transitionCount = getMissionWorkflowTransitions(workflowId).length;
        vi.advanceTimersByTime(8 * 86_400_000);
        expect(cleanupOldMissionTasks()).toBe(2);
        expect(cleanupOldMissionTasks()).toBe(0);
        expect(getMissionWorkflowTasks(workflowId)).toHaveLength(0);
        expect(getMissionWorkflowOutcomes(workflowId)).toHaveLength(outcomeCount);
        expect(getMissionWorkflowTransitions(workflowId)).toHaveLength(transitionCount);
        assertInvariants(workflowId);
      }
    }

    expect([...scenarioCounts.values()]).toEqual(Array(9).fill(12));
    expect([...accepted].sort()).toEqual([
      'block', 'complete', 'continue_self', 'dispatch', 'exhausted', 'fail', 'gather', 'retry', 'wait_for_human',
    ]);
  });
});
