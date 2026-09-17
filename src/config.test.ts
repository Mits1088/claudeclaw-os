import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// config.ts resolves STORE_DIR at module load from process.env /
// readEnvFile(). Drive both sources and re-import the module fresh so each
// case sees its own resolution. readEnvFile is mocked to isolate from the
// developer's real .env file.
async function loadConfig(envFile: Record<string, string> = {}) {
  vi.resetModules();
  vi.doMock('./env.js', () => ({
    readEnvFile: (keys: string[]) => Object.fromEntries(Object.entries(envFile).filter(([key]) => keys.includes(key))),
  }));
  return import('./config.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('./env.js');
  vi.resetModules();
});

describe('MIDTURN_STEERING_ENABLED resolution', () => {
  it.each([
    [undefined, undefined, false],
    [undefined, 'true', true],
    [undefined, 'false', false],
    ['true', 'false', true],
    ['false', 'true', false],
    ['', 'true', false],
    ['invalid', 'true', false],
  ])('process=%s file=%s resolves to %s', async (processValue, fileValue, expected) => {
    vi.stubEnv('MIDTURN_STEERING_ENABLED', processValue);
    const c = await loadConfig(fileValue === undefined ? {} : { MIDTURN_STEERING_ENABLED: fileValue });
    expect(c.MIDTURN_STEERING_ENABLED).toBe(expected);
  });
});

describe('STORE_DIR resolution', () => {
  it('defaults to PROJECT_ROOT/store when CLAUDECLAW_STORE_DIR is unset', async () => {
    const c = await loadConfig();
    expect(c.STORE_DIR).toBe(path.resolve(c.PROJECT_ROOT, 'store'));
  });

  it('honours CLAUDECLAW_STORE_DIR from process.env (with ~ expansion)', async () => {
    vi.stubEnv('CLAUDECLAW_STORE_DIR', '~/custom-store');
    const c = await loadConfig();
    expect(c.STORE_DIR).toBe(path.join(os.homedir(), 'custom-store'));
  });

  it('honours an absolute CLAUDECLAW_STORE_DIR from the .env file', async () => {
    const c = await loadConfig({ CLAUDECLAW_STORE_DIR: '/abs/store' });
    expect(c.STORE_DIR).toBe('/abs/store');
  });

  it('prefers process.env over the .env file', async () => {
    vi.stubEnv('CLAUDECLAW_STORE_DIR', '/from/env');
    const c = await loadConfig({ CLAUDECLAW_STORE_DIR: '/from/dotenv' });
    expect(c.STORE_DIR).toBe('/from/env');
  });
});
