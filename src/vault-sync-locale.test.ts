import { describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn((_file, _args, _options, callback) => callback(null, '', '')));
vi.mock('child_process', () => ({ execFile }));
import { pullFF } from './vault-sync.js';

describe('vault Git locale', () => {
  it('pins diagnostics to English while preserving the inherited environment', async () => {
    vi.stubEnv('LC_ALL', 'fr_FR.UTF-8');
    vi.stubEnv('LANGUAGE', 'fr');
    vi.stubEnv('VAULT_GIT_TEST', 'preserved');
    try {
      expect(await pullFF('/fixture')).toEqual({ ok: true });
      expect(execFile).toHaveBeenCalledWith('git', ['pull', '--ff-only'], expect.objectContaining({
        cwd: '/fixture',
        env: expect.objectContaining({ LC_ALL: 'C', LANGUAGE: 'C', VAULT_GIT_TEST: 'preserved' }),
      }), expect.any(Function));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
