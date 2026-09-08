import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMissionWorkflow, getMissionWorkflowOutcomes, claimMissionWorkflowReport } from './db.js';
import { _initTestDatabase, createMissionWorkflow, claimNextMissionTask, completeMissionTask, cleanupOldMissionTasks, applyMissionWorkflowTransition, getMissionTask, resumeMissionWorkflow, maybeReleaseJoinForMission, createMissionTask, deleteMissionTask } from './db.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T00:00:00Z')); _initTestDatabase(); });
afterEach(() => vi.useRealTimers());
function seed(deadlineAt: number | null = null) {
  createMissionWorkflow({ id: 'review-wf', rootTaskId: 'review-root', title: 'Review', objective: 'Verify', initialPrompt: 'Verify', ownerAgent: 'main', workerAgent: 'bobbi', priority: 5, maxDepth: 3, maxTasks: 6, maxFanout: 2, deadlineAt });
}
it('retains a source task needed by a queued durable coordinator beyond ordinary retention', () => {
  seed();
  claimNextMissionTask('bobbi');
  completeMissionTask('review-root', 'evidence', 'completed');
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  cleanupOldMissionTasks();
  const coordinator = claimNextMissionTask('main')!;
  expect(() => applyMissionWorkflowTransition({ id: 'review-transition', coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'complete', idempotencyKey: 'accept' })).not.toThrow();
});
it('does not claim workflow work after its deadline even before the next reconciliation tick', () => {
  seed(Math.floor(Date.now() / 1000) + 1);
  vi.setSystemTime(new Date('2026-09-01T00:00:02Z'));
  expect(claimNextMissionTask('bobbi')).toBeNull();
  expect(getMissionTask('review-root')?.status).not.toBe('running');
});

function coordinate(disposition: 'complete' | 'wait_for_human' | 'gather') {
  claimNextMissionTask('bobbi');
  completeMissionTask('review-root', 'evidence', 'completed');
  const coordinator = claimNextMissionTask('main')!;
  applyMissionWorkflowTransition({
    id: 'review-transition', coordinatorTaskId: coordinator.id, actor: 'main',
    disposition, idempotencyKey: 'decision',
    dispatches: disposition === 'gather' ? [
      { id: 'child-a', title: 'A', prompt: 'Check A', agent: 'bobbi', priority: 5 },
      { id: 'child-b', title: 'B', prompt: 'Check B', agent: 'amos', priority: 5 },
    ] : undefined,
  });
  completeMissionTask(coordinator.id, 'decision recorded', 'completed');
}

it('retains workflow history while waiting for a human and resumes after seven days', () => {
  seed();
  coordinate('wait_for_human');
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  expect(cleanupOldMissionTasks()).toBe(0);
  expect(getMissionTask('review-root')).not.toBeNull();
  const resumed = resumeMissionWorkflow({ workflowId: 'review-wf', ownerAgent: 'main', answerTaskId: 'answer', answer: 'Proceed' });
  expect(claimNextMissionTask('main')?.id).toBe(resumed.coordinatorTaskId);
});

it('retains an early gather result until the remaining worker finishes', () => {
  seed();
  coordinate('gather');
  claimNextMissionTask('bobbi');
  completeMissionTask('child-a', 'early evidence', 'completed');
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  expect(cleanupOldMissionTasks()).toBe(0);
  claimNextMissionTask('amos');
  completeMissionTask('child-b', 'late evidence', 'completed');
  maybeReleaseJoinForMission(getMissionTask('child-b')!);
  const joined = claimNextMissionTask('main')!;
  expect(joined.prompt).toContain('early evidence');
  expect(joined.prompt).toContain('late evidence');
});

it('still cleans up terminal workflows and ordinary missions', () => {
  seed();
  coordinate('complete');
  createMissionTask('ordinary', 'Ordinary', 'Check', 'bobbi', 'main', 5);
  claimNextMissionTask('bobbi');
  completeMissionTask('ordinary', 'done', 'completed');
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  expect(cleanupOldMissionTasks()).toBe(3);
  expect(getMissionTask('review-root')).toBeNull();
  expect(getMissionTask('ordinary')).toBeNull();
});

it('can accept a durable outcome after its source task was manually deleted', () => {
  seed();
  claimNextMissionTask('bobbi');
  completeMissionTask('review-root', 'evidence', 'completed');
  expect(deleteMissionTask('review-root')).toBe(true);
  const coordinator = claimNextMissionTask('main')!;
  expect(applyMissionWorkflowTransition({ id: 'accept', coordinatorTaskId: coordinator.id, actor: 'main', disposition: 'complete', idempotencyKey: 'accept' }).workflowStatus).toBe('completed');
});

it('skips expired work and can still claim an ordinary mission for the same agent', () => {
  seed(Math.floor(Date.now() / 1000) + 1);
  createMissionTask('ordinary', 'Ordinary', 'Check', 'bobbi', 'main', 1);
  vi.setSystemTime(new Date('2026-09-01T00:00:02Z'));
  expect(claimNextMissionTask('bobbi')?.id).toBe('ordinary');
});

it('treats blocked workflows as terminal while preserving outcome and report evidence after pruning', () => {
  seed();
  claimNextMissionTask('bobbi');
  completeMissionTask('review-root', 'retained evidence', 'completed');
  const coordinator = claimNextMissionTask('main')!;
  completeMissionTask(coordinator.id, null, 'failed', 'Review cannot proceed');
  expect(getMissionWorkflow('review-wf')?.status).toBe('blocked');
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  expect(cleanupOldMissionTasks()).toBe(2);
  expect(getMissionTask('review-root')).toBeNull();
  expect(getMissionWorkflowOutcomes('review-wf')[0]?.report).toBe('retained evidence');
  expect(() => resumeMissionWorkflow({ workflowId: 'review-wf', ownerAgent: 'main', answerTaskId: 'answer', answer: 'Proceed' })).toThrow('not waiting for human input');
  expect(claimNextMissionTask('main')).toBeNull();
  expect(claimMissionWorkflowReport('main', 'review-token')?.body).toContain('Review cannot proceed');
});
