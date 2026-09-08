import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _initTestDatabase, createMissionWorkflow, cancelMissionWorkflow,
  claimMissionWorkflowReport, settleMissionWorkflowReport, getRecentMissionReportContext,
  claimNextMissionTask, completeMissionTask, applyMissionWorkflowTransition, resumeMissionWorkflow,
  enqueueMissionSystemReport } from './db.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); _initTestDatabase(); });
afterEach(() => vi.useRealTimers());

function seed(id: string, owner = 'main', objective = id) {
  createMissionWorkflow({ id, rootTaskId: `${id}-root`, title: id, objective,
    initialPrompt: 'Synthetic only', ownerAgent: owner, workerAgent: 'worker', priority: 5,
    maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
}

it('scopes evidence to its owner, preserves it across delivery and expires bounded recent context', () => {
  seed('owned'); cancelMissionWorkflow('owned', 'main');
  // No reporting tick has run: derive evidence without taking a send lease.
  expect(getRecentMissionReportContext('main')).toContain('Mission cancelled: owned');
  const report = claimMissionWorkflowReport('main', 'delivery')!;
  expect(report.attempts).toBe(1);
  expect(getRecentMissionReportContext('other')).toBe('');
  expect(getRecentMissionReportContext('main')).toContain('Mission cancelled: owned');
  settleMissionWorkflowReport(report.id, 'delivery');
  expect(getRecentMissionReportContext('main')).toContain(report.id);
  vi.advanceTimersByTime(86401_000);
  expect(getRecentMissionReportContext('main')).toBe('');
});

it('does not make an old disposition recent merely because its report is materialized late', () => {
  seed('old'); cancelMissionWorkflow('old', 'main');
  vi.advanceTimersByTime(86401_000);
  expect(getRecentMissionReportContext('main')).toBe('');
  expect(claimMissionWorkflowReport('main', 'late-delivery')?.body).toContain('Mission cancelled: old');
  expect(getRecentMissionReportContext('main')).toBe('');
});

it('limits context to three current reports, scans before truncation and omits system health reports', () => {
  const secret = 'sk-ant-api03-CANARYcanaryCANARYcanary01';
  for (let n = 0; n < 4; n++) {
    seed(`wf-${n}`, 'main', 'x'.repeat(2960) + secret + 'y'.repeat(500));
    cancelMissionWorkflow(`wf-${n}`, 'main');
    const report = claimMissionWorkflowReport('main', `token-${n}`)!;
    settleMissionWorkflowReport(report.id, `token-${n}`);
    vi.advanceTimersByTime(1000);
  }
  enqueueMissionSystemReport('health', 'main', 'Do not inject health chatter');
  const context = getRecentMissionReportContext('main');
  expect(context).not.toContain('wf-0:');
  expect(context).toContain('wf-3:');
  expect(context).toContain('Truncated; inspect');
  expect(context).not.toContain(secret);
  expect(context).not.toContain('Do not inject health chatter');
  expect(context.length).toBeLessThan(10_000);
});

it('does not inject a stale waiting-human report after the workflow resumes', () => {
  seed('waiting'); claimNextMissionTask('worker');
  completeMissionTask('waiting-root', 'Need a decision', 'completed');
  const review = claimNextMissionTask('main')!;
  applyMissionWorkflowTransition({ id: 'wait', coordinatorTaskId: review.id, actor: 'main',
    disposition: 'wait_for_human', idempotencyKey: 'wait', reason: 'Proceed?' });
  completeMissionTask(review.id, 'Proceed?', 'completed');
  claimMissionWorkflowReport('main', 'waiting-delivery');
  expect(getRecentMissionReportContext('main')).toContain('Proceed?');
  resumeMissionWorkflow({ workflowId: 'waiting', ownerAgent: 'main', answerTaskId: 'answer', answer: 'Yes' });
  expect(getRecentMissionReportContext('main')).toBe('');
});
