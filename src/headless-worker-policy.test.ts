import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertWorkerRuntimeContained } from './headless-worker-policy.js';

afterEach(() => vi.unstubAllEnvs());
describe('native supervisor admission', () => {
  it.each(['git push', 'gh pr merge', 'slack-cli post', 'read production store'])('prevents worker execution before %s', (command) => {
    vi.stubEnv('CLAUDECLAW_WORKER_INSTANCE_ID', '');
    const execute = vi.fn();
    expect(() => {
      assertWorkerRuntimeContained('headless');
      execute(command);
    }).toThrow(/requires admission/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the messenger host path for ordinary missions', () => {
    expect(() => assertWorkerRuntimeContained('messenger')).not.toThrow();
  });
});

it('accepts supervisor launch metadata before the database lease check', () => {
  vi.stubEnv('CLAUDECLAW_WORKER_INSTANCE_ID', 'instance');
  vi.stubEnv('CLAUDECLAW_WORKER_SUPERVISOR_EPOCH', 'epoch');
  vi.stubEnv('CLAUDECLAW_WORKER_BUILD_ID', 'build');
  expect(() => assertWorkerRuntimeContained('headless')).not.toThrow();
});
