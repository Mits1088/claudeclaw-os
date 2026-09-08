import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _initTestDatabase, createMissionWorkflow, cancelMissionWorkflow, claimMissionWorkflowReport, settleMissionWorkflowReport, getMissionWorkflow, claimNextMissionTask, completeMissionTask, applyMissionWorkflowTransition } from './db.js';
import { deliverMissionWorkflowReport } from './mission-reporting.js';

describe('durable workflow disposition delivery', () => {
  beforeEach(() => {
    _initTestDatabase();
    createMissionWorkflow({ id: 'wf', rootTaskId: 'root', title: 'Evidence', objective: 'Verify evidence', initialPrompt: 'Read only', ownerAgent: 'main', workerAgent: 'worker', priority: 5, maxDepth: 2, maxTasks: 3, maxFanout: 2, deadlineAt: null });
  });

  it('derives a missing report after cancellation without dispatching another model turn', () => {
    expect(claimMissionWorkflowReport('main', 'early', 100)).toBeNull();
    cancelMissionWorkflow('wf', 'main');
    const report = claimMissionWorkflowReport('main', 'lease-1', 100)!;
    expect(report.body).toContain('Mission cancelled');
    expect(claimMissionWorkflowReport('main', 'lease-2', 101)).toBeNull();
    expect(settleMissionWorkflowReport(report.id, 'wrong', undefined, 102)).toBe(false);
    expect(settleMissionWorkflowReport(report.id, 'lease-1', undefined, 102)).toBe(true);
    expect(claimMissionWorkflowReport('main', 'lease-3', 300)).toBeNull();
  });

  it('recovers an interrupted sender lease with the same visible report identity', () => {
    cancelMissionWorkflow('wf', 'main');
    const first = claimMissionWorkflowReport('main', 'lost-process', 100)!;
    expect(claimMissionWorkflowReport('worker', 'wrong-owner', 500)).toBeNull();
    const recovered = claimMissionWorkflowReport('main', 'new-process', 221)!;
    expect(recovered.id).toBe(first.id);
    expect(recovered.attempts).toBe(2);
    expect(settleMissionWorkflowReport(first.id, 'lost-process', undefined, 222)).toBe(false);
  });

  it('reports the accepted durable finding when a coordinator omits a completion reason', () => {
    claimNextMissionTask('worker');
    completeMissionTask('root', 'Primary source verified: version 1.10.0.', 'completed');
    const coordinator = claimNextMissionTask('main')!;
    applyMissionWorkflowTransition({ id: 'accept-edge', coordinatorTaskId: coordinator.id, actor: 'main', idempotencyKey: 'accept', disposition: 'complete' });
    const report = claimMissionWorkflowReport('main', 'lease')!;
    expect(report.body).toContain('Primary source verified: version 1.10.0.');
  });

  it('preserves the disposition and schedules delivery retry after a send failure', async () => {
    cancelMissionWorkflow('wf', 'main');
    await deliverMissionWorkflowReport('main', vi.fn().mockRejectedValue(new Error('network disconnected')));
    expect(getMissionWorkflow('wf')?.status).toBe('cancelled');
    const retry = claimMissionWorkflowReport('main', 'retry', Math.floor(Date.now() / 1000) + 61)!;
    expect(retry.last_error).toBe('network disconnected');
    expect(retry.attempts).toBe(2);
  });
});
