import { beforeEach, expect, it } from 'vitest';
import {
  _initTestDatabase,
  claimNextMissionTask,
  completeInterAgentTask,
  completeMissionTask,
  createInterAgentTask,
  createMissionTask,
  createScheduledTask,
  getAllScheduledTasks,
  getInterAgentTasks,
  getMissionTask,
  getSessionConversation,
  logConversationTurn,
  updateTaskAfterRun,
} from './db.js';

const secret = 'sk-ant-api03-CANARYcanaryCANARYcanary01';

beforeEach(() => _initTestDatabase());

it('sanitizes ordinary mission result and error at persistence', () => {
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

it('sanitizes scheduled results before their storage limit', () => {
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
