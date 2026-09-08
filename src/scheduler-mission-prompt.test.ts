import { describe, expect, it } from 'vitest';

import { missionExecutionPrompt } from './scheduler.js';

describe('missionExecutionPrompt', () => {
  it('supplies the task identity and executable handback command', () => {
    const prompt = missionExecutionPrompt({
      id: 'abc-123',
      title: 'Inspect the logs',
      created_by: 'main',
      assigned_agent: 'amos',
      prompt: 'Find the first failing request.',
      role: 'task',
      continuation_limit: null,
    });

    expect(prompt).toContain('[Mission task: Inspect the logs]');
    expect(prompt).toContain('Task ID: abc-123');
    expect(prompt).toContain('Created by: @main');
    expect(prompt).toContain('mission-cli handback abc-123 "<report>"');
    expect(prompt).toMatch(/\n\nFind the first failing request\.$/);
  });

  it('marks handback missions terminal without offering another handback command', () => {
    const prompt = missionExecutionPrompt({
      id: 'relay-123',
      title: 'Handback: Inspect the logs',
      created_by: 'amos',
      assigned_agent: 'main',
      prompt: 'Relay the report.',
      role: 'handback',
      continuation_limit: null,
    });

    expect(prompt).toContain('This is a terminal handback. Return the report directly');
    expect(prompt).not.toContain('mission-cli handback');
  });

  it('does not advertise an impossible handback on an ordinary self-directed task', () => {
    const prompt = missionExecutionPrompt({
      id: 'self-1', title: 'Continue later', created_by: 'main', assigned_agent: 'main',
      prompt: 'Do one bounded step.', role: 'task', continuation_limit: null,
    });
    expect(prompt).not.toContain('mission-cli handback');
    expect(prompt).toContain('mission_continue tool when available');
    expect(prompt).toContain('mission-cli continue self-1');
    expect(prompt).toContain('--max-steps <N>');
  });

  it('inherits the fixed limit in a continuation prompt', () => {
    const prompt = missionExecutionPrompt({
      id: 'next-1', title: 'Continuation', created_by: 'main', assigned_agent: 'main',
      prompt: 'Do the next step.', role: 'continuation', continuation_limit: 3,
    });
    expect(prompt).toContain('chain limit is 3');
    expect(prompt).toContain('mission_continue tool when available with task_id next-1');
    expect(prompt).not.toContain('--max-steps');
    expect(prompt).not.toContain('mission-cli handback');
  });

  it('makes workflow worker completion scheduler-managed', () => {
    const prompt = missionExecutionPrompt({
      id: 'worker-1', title: 'Research', created_by: 'main', assigned_agent: 'bobbi',
      prompt: 'Find the evidence.', role: 'task', continuation_limit: null, workflow_id: 'wf-1',
    });
    expect(prompt).toContain('worker execution inside durable workflow wf-1');
    expect(prompt).toContain('scheduler persists the outcome and wakes the coordinator');
    expect(prompt).not.toContain('mission-cli handback');
  });

  it('requires one validated transition from a workflow coordinator', () => {
    const prompt = missionExecutionPrompt({
      id: 'coord-1', title: 'Coordinate', created_by: 'main', assigned_agent: 'main',
      prompt: 'Review the durable outcome.', role: 'coordinator', continuation_limit: null, workflow_id: 'wf-1',
    });
    expect(prompt).toContain('Apply exactly one disposition with mission_transition');
    expect(prompt).toContain('Do not create work through the ordinary mission_create');
    expect(prompt).not.toContain('mission-cli handback');
  });
});
