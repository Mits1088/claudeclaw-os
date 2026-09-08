import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./agent-config.js', () => ({ resolveAgentId: (id: string) => id, knownAgentIds: () => [], loadAgentConfig: () => ({ runtimeMode: 'messenger' }) }));
import { _initTestDatabase, getMissionWorkflows, claimNextMissionTask, createMissionTask } from './db.js';
import { actionCreateMissionWorkflow } from './cli-actions.js';
import { runWithMissionEntryKey } from './mission-entry-key.js';
import { runWithMissionExecutionContext } from './mission-execution-context.js';

describe('idempotent scheduled and mission workflow entry', () => {
  beforeEach(() => _initTestDatabase());
  const input = { objective: 'Find source and quote', prompt: 'Read fixture only', agent: 'worker', createdBy: 'main' };
  it('holds a future workflow root at its availability gate and retains the first bounds on duplicate creation', () => {
    const at = new Date(Date.now() + 60_000).toISOString();
    const first = actionCreateMissionWorkflow({ ...input, at, idempotencyKey: 'future', maxTasks: 3 });
    const replay = actionCreateMissionWorkflow({ ...input, idempotencyKey: 'future', maxTasks: 400 });
    expect(replay.workflow.id).toBe(first.workflow.id);
    expect(replay.workflow.max_tasks).toBe(3);
    expect(claimNextMissionTask('worker')).toBeNull();
    expect(getMissionWorkflows()).toHaveLength(1);
  });
  it('creates at most one root for one recurring job firing, and a new root for the next firing', () => {
    const first = runWithMissionEntryKey('job:daily:123', () => actionCreateMissionWorkflow(input));
    const replay = runWithMissionEntryKey('job:daily:123', () => actionCreateMissionWorkflow({ ...input, idempotencyKey: 'different-model-key' }));
    expect(replay.workflow.id).toBe(first.workflow.id);
    const next = runWithMissionEntryKey('job:daily:456', () => actionCreateMissionWorkflow(input));
    expect(next.workflow.id).not.toBe(first.workflow.id);
    expect(getMissionWorkflows()).toHaveLength(2);
  });
  it('binds a one-time initiating mission to one root despite tool retries with different keys', () => {
    createMissionTask('entry', 'Initiate', 'Create a bounded workflow', 'main', 'main', 5);
    claimNextMissionTask('main');
    runWithMissionExecutionContext({ taskId: 'entry', actor: 'main' }, () => {
      const first = actionCreateMissionWorkflow(input);
      const replay = actionCreateMissionWorkflow({ ...input, idempotencyKey: 'escape' });
      expect(replay.workflow.id).toBe(first.workflow.id);
    });
    expect(getMissionWorkflows()).toHaveLength(1);
  });
});
