import { describe, expect, it } from 'vitest';

import { missionExecutionPrompt } from './scheduler.js';

describe('missionExecutionPrompt', () => {
  it('supplies the task identity and executable handback command', () => {
    const prompt = missionExecutionPrompt({
      id: 'abc-123',
      title: 'Inspect the logs',
      created_by: 'main',
      prompt: 'Find the first failing request.',
    });

    expect(prompt).toContain('[Mission task: Inspect the logs]');
    expect(prompt).toContain('Task ID: abc-123');
    expect(prompt).toContain('Created by: @main');
    expect(prompt).toContain('mission-cli handback abc-123 "<report>"');
    expect(prompt).toMatch(/\n\nFind the first failing request\.$/);
  });
});
