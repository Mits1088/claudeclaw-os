import { describe, expect, it, vi } from 'vitest';
import { assertWorkerRuntimeContained } from './headless-worker-policy.js';

describe('headless recovery containment', () => {
  it.each(['git push', 'gh pr merge', 'slack-cli post', 'read production store'])('prevents worker execution before %s', (command) => {
    const execute = vi.fn();
    expect(() => {
      assertWorkerRuntimeContained('headless');
      execute(command);
    }).toThrow(/disabled pending isolated worker/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the messenger host path for ordinary missions', () => {
    expect(() => assertWorkerRuntimeContained('messenger')).not.toThrow();
  });
});
