// Pins the HTTP status of the agent activate/deactivate routes.
//
// Why this file exists: both routes returned `c.json(result)` — HTTP 200 even
// when `result.ok` was false. `apiPost` in web/src/lib/api.ts only throws on a
// non-2xx status, so the Start button's catch block never fired: it flipped to
// "Starting…", flipped back, and reported nothing while the agent stayed down.
// A failed activation must be a failed HTTP request.
//
// `./agent-create.js` is mocked so the routes can be driven to both outcomes
// without spawning real processes.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Provider preflight shells out to `where`/`which`; claim every command exists
// so status assertions don't depend on the host's installed CLIs.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
});

const state = vi.hoisted(() => ({
  activate: { ok: true } as { ok: boolean; error?: string; pid?: number },
  deactivate: { ok: true } as { ok: boolean; error?: string },
}));

vi.mock('./agent-create.js', async () => {
  const actual = await vi.importActual<typeof import('./agent-create.js')>('./agent-create.js');
  return {
    ...actual,
    activateAgent: vi.fn(() => state.activate),
    deactivateAgent: vi.fn(() => state.deactivate),
  };
});

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

const Q = '?token=test-contract-token';
let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
  state.activate = { ok: true, pid: 4242 };
  state.deactivate = { ok: true };
});

async function post(path: string) {
  return app.request(path + Q, { method: 'POST' });
}

describe('POST /api/agents/:id/activate', () => {
  it('returns 200 when the agent starts', async () => {
    const res = await post('/api/agents/research/activate');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('returns 500 with the reason when activation fails', async () => {
    state.activate = { ok: false, error: 'Build output missing: dist/index.js' };
    const res = await post('/api/agents/research/activate');
    expect(res.status).toBe(500);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/dist\/index\.js/);
  });

  it('still refuses main with a 400', async () => {
    const res = await post('/api/agents/main/activate');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/agents/:id/deactivate', () => {
  it('returns 200 when the agent stops', async () => {
    const res = await post('/api/agents/research/deactivate');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('returns 500 with the reason when deactivation fails', async () => {
    state.deactivate = { ok: false, error: 'kill failed' };
    const res = await post('/api/agents/research/deactivate');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'kill failed' });
  });
});
