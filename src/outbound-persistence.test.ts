import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as sanitizer from './outbound-sanitizer.js';
import { _initTestDatabase, createMissionTask, claimNextMissionTask, completeMissionTask,
  getMissionTask, logConversationTurn, getSessionConversation, createScheduledTask,
  updateTaskAfterRun, getAllScheduledTasks, createInterAgentTask, completeInterAgentTask, getInterAgentTasks,
  createMissionWorkflow, getMissionWorkflowOutcomes, applyMissionWorkflowTransition,
  getMissionWorkflowTransitions, claimMissionWorkflowReport, enqueueMissionSystemReport } from './db.js';

const secret = 'sk-ant-api03-CANARYcanaryCANARYcanary01';
beforeEach(() => _initTestDatabase());
afterEach(() => vi.restoreAllMocks());

it('scrubs a previously persisted report before delivery and retains the scrubbed body for retry', () => {
  // Simulate a row from the pre-sanitizer build, without exposing raw DB writes
  // through a production API solely for this test.
  const legacyWrite = vi.spyOn(sanitizer, 'sanitizeOutboundText').mockImplementationOnce(text => text);
  enqueueMissionSystemReport('legacy', 'main', `Earlier report ${secret}`);
  legacyWrite.mockRestore();
  const now = Math.floor(Date.now() / 1000);
  const first = claimMissionWorkflowReport('main', 'first', now)!;
  expect(first.body).toBe('Earlier report [REDACTED]');
  // A no-op delivery sanitizer on the next claim demonstrates persisted repair.
  vi.spyOn(sanitizer, 'sanitizeOutboundText').mockImplementation(text => text);
  expect(claimMissionWorkflowReport('main', 'retry', now + 121)?.body).toBe(first.body);
});

it('stores sanitized mission result and error even when the caller bypasses runAgent', () => {
  createMissionTask('output', 'Output', 'Synthetic test', 'main');
  claimNextMissionTask('main');
  completeMissionTask('output', secret, 'failed', `failure ${secret}`);
  const persisted = getMissionTask('output')!;
  expect(persisted.result).toBe('[REDACTED]');
  expect(persisted.error).toBe('failure [REDACTED]');
});

it('sanitizes assistant conversation rows at insertion', () => {
  logConversationTurn('test', 'assistant', secret, 'session');
  expect(getSessionConversation('session')[0].content).toBe('[REDACTED]');
});


it('sanitizes scheduled results before their 4000-character storage limit', () => {
  createScheduledTask('schedule', 'fixture', '* * * * *', 1);
  updateTaskAfterRun('schedule', 2, 'x'.repeat(3990) + secret, 'failed');
  const row = getAllScheduledTasks()[0];
  expect(row.last_result).toBe('x'.repeat(3990) + '[REDACTED]');
  expect(row.last_status).toBe('failed');
});

it.each(['completed', 'failed'] as const)('sanitizes %s delegation results before storage truncation', status => {
  createInterAgentTask('delegation', 'main', 'fixture', 'chat', 'fixture');
  completeInterAgentTask('delegation', status, 'x'.repeat(1990) + secret);
  const row = getInterAgentTasks()[0];
  expect(row.result).toBe('x'.repeat(1990) + '[REDACTED]');
  expect(row.status).toBe(status);
});

it.each(['completed', 'failed'] as const)('sanitizes %s workflow outcomes, review context, transitions and report rows', status => {
  createMissionWorkflow({ id: 'wf-output', rootTaskId: 'wf-root', title: 'Output',
    objective: `Check ${secret}`, initialPrompt: 'Synthetic only', ownerAgent: 'main',
    workerAgent: 'worker', priority: 5, maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
  claimNextMissionTask('worker');
  completeMissionTask('wf-root', `finding ${secret}`, status, `error ${secret}`);
  expect(JSON.stringify(getMissionWorkflowOutcomes('wf-output'))).not.toContain(secret);
  const coordinator = claimNextMissionTask('main')!;
  // The original objective is input authority and is preserved. The worker's
  // output section must already have been sanitized before prompt reconstruction.
  expect(coordinator.prompt).toContain('finding [REDACTED]');
  applyMissionWorkflowTransition({ id: 'wf-transition', coordinatorTaskId: coordinator.id,
    actor: 'main', disposition: 'complete', idempotencyKey: 'accepted', reason: `accepted ${secret}` });
  const transition = getMissionWorkflowTransitions('wf-output')[0];
  expect(transition.payload_json).toContain('[REDACTED]');
  expect(transition.payload_json).not.toContain(secret);
  const report = claimMissionWorkflowReport('main', 'delivery')!;
  expect(report.body).not.toContain(secret);
  expect(report.body).toContain('accepted [REDACTED]');
});
