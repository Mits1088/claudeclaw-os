import { describe, expect, it } from 'vitest';

import { missionExecutionPrompt } from './scheduler.js';

describe('missionExecutionPrompt', () => {
  it('supplies the task identity and executable handback command', () => {
    const prompt = missionExecutionPrompt({
      id: 'abc-123',
      title: 'Inspect the logs',
      created_by: 'main',
      prompt: 'Find the first failing request.',
      role: 'task',
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
      prompt: 'Relay the report.',
      role: 'handback',
    });

    expect(prompt).toContain('This is a terminal handback. Return the report directly');
    expect(prompt).not.toContain('mission-cli handback');
  });
});
