// Contract test suite for the Mission Control HTTP API.
//
// Why this exists: a frontend rewrite is in progress (web/ Vite project,
// rolling out PR-by-PR). The new frontend is built against the documented
// shape of every endpoint. If the backend ever drifts from that shape —
// renames a field, changes nullability, swaps a type — the rewrite breaks
// silently. These tests pin the response shape of every endpoint family
// the new frontend depends on, so any drift fails CI before it ships.
//
// Tests use Hono's `app.request()` so no real port is opened. The DB is
// the in-memory test DB initialized via `_initTestDatabase()`.
//
// Env vars are set by `src/test-env-setup.ts` (vitest setupFiles) so they
// land BEFORE config.ts evaluates at import time.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Provider preflight (src/provider.ts) shells out to `where`/`which` to test
// PATH presence. Contract tests assert HTTP response shape and must not depend
// on which CLIs happen to be installed on the CI host, so stub spawnSync to
// claim every command exists. Other child_process exports pass through so we
// don't break unrelated modules (bot.ts execFile, voice.ts execFile, etc.).
// dashboard.ts uses spawnSync only for `opencode models`; an empty stdout
// there is already a handled real-world case, so the stub is safe.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: vi.fn((_lookup: string, args: string[] = []) => ({
      status: args[0] === 'missing-tool' ? 1 : 0,
      stdout: '',
      stderr: '',
    })),
  };
});

import { _initTestDatabase, getSession, setSession } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import { STORE_DIR, CLAUDECLAW_CONFIG, DEFAULT_OPENAI_MODEL, updateAgentProvider } from './config.js';
import { getSelectedProviderConfig } from './active-provider.js';
import { getMainProviderConfig, setMainProviderConfig } from './provider.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;
const mainConfigPath = path.join(STORE_DIR, 'main-config.json');
let originalMainConfig: string | null = null;

beforeAll(() => {
  originalMainConfig = fs.existsSync(mainConfigPath)
    ? fs.readFileSync(mainConfigPath, 'utf-8')
    : null;
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
  updateAgentProvider(undefined);
});

afterEach(() => {
  if (originalMainConfig === null) {
    try { fs.unlinkSync(mainConfigPath); } catch { /* absent */ }
  } else {
    fs.mkdirSync(path.dirname(mainConfigPath), { recursive: true });
    fs.writeFileSync(mainConfigPath, originalMainConfig, 'utf-8');
  }
});

async function get(path: string) {
  return app.request(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN);
}

async function getNoToken(path: string) {
  return app.request(path);
}

// Tests fetch JSON we only describe shape-wise — typing as `any` keeps the
// assertions readable without forcing the real interfaces into the test file.
async function jsonOf(res: Response): Promise<any> {
  return res.json();
}

describe('auth gate', () => {
  it('rejects unauthorized GET without token', async () => {
    const res = await getNoToken('/api/health');
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toMatchObject({ error: 'Unauthorized' });
  });

  it('rejects unauthorized GET with wrong token', async () => {
    const res = await app.request('/api/health?token=wrong');
    expect(res.status).toBe(401);
  });

  it('accepts GET with correct token', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
  });

  it('responds 204 to OPTIONS preflight without token check', async () => {
    const res = await app.request('/api/health', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  // Regression: the SPA shell (`<script src="/assets/...">`) has no
  // token in the URL. If the auth middleware ever gates /assets/* the
  // bundle 401s and the dashboard goes blank — the symptom Mark hit
  // when the dashboard "wouldn't load" after a previous refactor.
  // Static assets must always be reachable without a token.
  it('serves /assets/* without a token (SPA bundle would 401 otherwise)', async () => {
    // Hit a path we know won't exist on disk, just to prove the auth
    // middleware ALLOWS the request through. Whether the file exists is
    // a separate concern handled by the /assets/* handler.
    const res = await app.request('/assets/some-bundle-that-doesnt-exist.js');
    // Acceptable outcomes: 200/204 (file served), 404 (handler ran and
    // didn't find it). NOT acceptable: 401 (middleware blocked it).
    expect(res.status).not.toBe(401);
  });

  it('serves /favicon.svg without a token', async () => {
    const res = await app.request('/favicon.svg');
    expect(res.status).not.toBe(401);
  });

  // Regression: SPA shell paths must be reachable without a token so a
  // hard-refresh of a token-stripped URL still loads the frontend, which
  // can recover the token from sessionStorage. If these 401, the user
  // sees raw JSON {"error":"Unauthorized"} on every refresh — exactly
  // the bug Mark hit. The HTML these serve has no embedded secret; the
  // frontend reads token from query string then falls back to storage.
  // Every client-side wouter route must be in this list.
  for (const path of [
    '/', '/warroom', '/mission', '/scheduled', '/agents',
    '/agents/comms/files', '/chat', '/memories', '/hive', '/usage',
    '/audit', '/settings',
  ]) {
    it(`serves SPA shell at ${path} without a token`, async () => {
      const res = await app.request(path);
      expect(res.status).not.toBe(401);
    });
  }

  // Legacy mode HTML embeds DASHBOARD_TOKEN, so those variants MUST stay
  // gated even though the path is exempt at the middleware. The handler
  // does an inline check.
  it('blocks legacy /warroom?mode=picker without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom?mode=picker');
    expect(res.status).toBe(401);
  });

  it('blocks legacy /warroom?mode=voice without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom?mode=voice');
    expect(res.status).toBe(401);
  });

  it('blocks legacy /warroom/text without a token (HTML embeds token)', async () => {
    const res = await app.request('/warroom/text?meetingId=wr_test');
    expect(res.status).toBe(401);
  });

  // Regression: the CSRF middleware reads its allowed-origin host from
  // the DASHBOARD_URL env var. If it reads from process.env directly
  // (instead of the config helper that also consults the .env file),
  // the production daemon — which doesn't have process.env populated
  // from .env — 403s every cross-origin POST from the Cloudflare tunnel.
  // src/test-env-setup.ts sets DASHBOARD_URL=https://dash.test.example
  // so this test exercises the right code path.
  it('allows POSTs with Origin matching DASHBOARD_URL', async () => {
    const res = await app.request('/api/mission/tasks?token=' + TOKEN, {
      method: 'POST',
      headers: { 'origin': 'https://dash.test.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'csrf test', prompt: 'csrf test' }),
    });
    // 200 (created) or 400 (validation) — anything but 403 means the
    // CSRF middleware let it through, which is what we're testing.
    expect(res.status).not.toBe(403);
  });

  it('blocks POSTs from disallowed origin', async () => {
    const res = await app.request('/api/mission/tasks?token=' + TOKEN, {
      method: 'POST',
      headers: { 'origin': 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'csrf test', prompt: 'csrf test' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/health', () => {
  it('returns the documented shape', async () => {
    const res = await get('/api/health');
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      contextPct: expect.any(Number),
      turns: expect.any(Number),
      compactions: expect.any(Number),
      sessionAge: expect.any(String),
      model: expect.any(String),
      telegramConnected: expect.any(Boolean),
      waConnected: expect.any(Boolean),
      slackConnected: expect.any(Boolean),
      killSwitches: expect.any(Object),
      killSwitchRefusals: expect.any(Object),
      warroom: expect.objectContaining({
        textOpenMeetings: expect.any(Number),
      }),
    });
  });

  it('killSwitches contains all 6 documented flags', async () => {
    const res = await get('/api/health');
    const body = await jsonOf(res);
    expect(body.killSwitches).toMatchObject({
      WARROOM_TEXT_ENABLED: expect.any(Boolean),
      WARROOM_VOICE_ENABLED: expect.any(Boolean),
      LLM_SPAWN_ENABLED: expect.any(Boolean),
      DASHBOARD_MUTATIONS_ENABLED: expect.any(Boolean),
      MISSION_AUTO_ASSIGN_ENABLED: expect.any(Boolean),
      SCHEDULER_ENABLED: expect.any(Boolean),
    });
  });
});

describe('GET /api/info', () => {
  it('returns botName, botUsername, pid, chatId', async () => {
    const res = await get('/api/info');
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      botName: expect.any(String),
      botUsername: expect.any(String),
      pid: expect.any(Number),
    });
    expect('chatId' in body).toBe(true);
  });
});

describe('GET /api/agents', () => {
  it('returns { agents: [] } even when no agents configured', async () => {
    const res = await get('/api/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ agents: expect.any(Array) });
  });

  it('always includes main as first entry when present', async () => {
    const res = await get('/api/agents');
    const body = await jsonOf(res);
    if (body.agents.length > 0) {
      expect(body.agents[0]).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        running: expect.any(Boolean),
      });
    }
  });

  it('omits stranded runtime values the selected model does not support', async () => {
    setMainProviderConfig({
      type: 'claude',
      model: 'claude-opus-5',
      runtimeMode: 'bogus',
      thinkingMode: 'bogus',
    });
    updateAgentProvider(undefined);

    const res = await get('/api/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const main = body.agents.find((agent: any) => agent.id === 'main');
    expect(main).toBeTruthy();
    expect(main.runtimeMode).toBe('');
    expect(main.thinkingMode).toBe('');
    expect(main.provider).not.toHaveProperty('runtimeMode');
    expect(main.provider).not.toHaveProperty('thinkingMode');
  });

  it('reports the effective OpenAI default after its model override is cleared', async () => {
    const original = getMainProviderConfig();
    try {
      setMainProviderConfig({ type: 'openai' });
      updateAgentProvider({ type: 'openai' });

      const res = await get('/api/agents');
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      const main = body.agents.find((agent: any) => agent.id === 'main');
      expect(main).toMatchObject({
        model: DEFAULT_OPENAI_MODEL,
        modelLabel: expect.any(String),
        provider: { type: 'openai', model: DEFAULT_OPENAI_MODEL },
        thinkingMode: '',
      });
    } finally {
      setMainProviderConfig(original);
      updateAgentProvider(undefined);
    }
  });
});

describe('GET /api/tasks (scheduled)', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });
});

describe('GET /api/mission/tasks', () => {
  it('returns { tasks: [] }', async () => {
    const res = await get('/api/mission/tasks');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ tasks: expect.any(Array) });
  });

  it('accepts ?agent and ?status filters', async () => {
    const res = await get('/api/mission/tasks?agent=main&status=queued');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.tasks).toBeInstanceOf(Array);
  });
});

describe('GET /api/mission/history', () => {
  it('returns paginated { tasks, total }', async () => {
    const res = await get('/api/mission/history?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      tasks: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('POST /api/mission/tasks', () => {
  it('rejects missing title with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test prompt' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects missing prompt with 400', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  it('creates task with valid input and returns full task shape', async () => {
    const res = await app.request('/api/mission/tasks' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'contract test', prompt: 'do nothing', priority: 3 }),
    });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.task).toMatchObject({
      id: expect.any(String),
      title: 'contract test',
      prompt: 'do nothing',
      status: 'queued',
      priority: 3,
      created_by: 'dashboard',
      created_at: expect.any(Number),
    });
  });
});

describe('GET /api/mission/tasks/auto-assign-all route ordering', () => {
  // Regression test: this endpoint was shadowed by /:id/auto-assign for
  // months because route registration order was wrong. Lock it in.
  it('returns 200, not 404, when called as a static path', async () => {
    const res = await app.request('/api/mission/tasks/auto-assign-all' + Q, {
      method: 'POST',
    });
    // Must NOT be 404. May be 200 (assigned: 0) or 400 if no agents.
    expect(res.status).not.toBe(404);
  });
});

describe('GET /api/memories', () => {
  it('returns full memory dashboard payload', async () => {
    const res = await get('/api/memories?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.objectContaining({
        total: expect.any(Number),
        pinned: expect.any(Number),
        consolidations: expect.any(Number),
      }),
      fading: expect.any(Array),
      topAccessed: expect.any(Array),
      timeline: expect.any(Array),
      consolidations: expect.any(Array),
    });
  });
});

describe('GET /api/memories/list', () => {
  it('returns paginated memory list', async () => {
    const res = await get('/api/memories/list?chatId=test&limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      memories: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/tokens', () => {
  it('returns stats + costTimeline + recentUsage', async () => {
    const res = await get('/api/tokens?chatId=test');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      stats: expect.any(Object),
      costTimeline: expect.any(Array),
      recentUsage: expect.any(Array),
    });
    expect(body.stats).toMatchObject({
      todayInput: expect.any(Number),
      todayOutput: expect.any(Number),
      todayCost: expect.any(Number),
      todayTurns: expect.any(Number),
      allTimeCost: expect.any(Number),
      allTimeTurns: expect.any(Number),
    });
  });
});

describe('GET /api/hive-mind', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/hive-mind');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/audit', () => {
  it('returns { entries, total }', async () => {
    const res = await get('/api/audit?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      entries: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('GET /api/audit/blocked', () => {
  it('returns { entries: [] }', async () => {
    const res = await get('/api/audit/blocked?limit=5');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ entries: expect.any(Array) });
  });
});

describe('GET /api/security/status', () => {
  it('returns 200 with an object', async () => {
    const res = await get('/api/security/status');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toBeInstanceOf(Object);
  });
});

describe('GET /api/chat/history', () => {
  it('defaults missing chatId to the configured dashboard chat', async () => {
    const res = await get('/api/chat/history');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });

  it('returns { turns: [] } with chatId', async () => {
    const res = await get('/api/chat/history?chatId=test&limit=10');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ turns: expect.any(Array) });
  });
});

describe('PATCH /api/agents/:id/model', () => {
  it('rejects missing model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid model with 400', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5' }),
    });
    expect(res.status).toBe(400);
  });

  it('main response includes restartRequired: false', async () => {
    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: true,
      agent: 'main',
      model: 'claude-sonnet-4-6',
      restartRequired: false,
    });
  });

  it('resets the active session when a model actually changes', async () => {
    setMainProviderConfig({ type: 'claude', model: 'claude-opus-4-8' });
    updateAgentProvider({ type: 'claude', model: 'claude-opus-4-8' });
    setSession('model-chat', 'claude:old-thread', 'main');

    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });

    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      changed: true,
      sessionReset: true,
      restartRequired: false,
    });
    expect(getSession('model-chat', 'main')).toBeUndefined();
  });

  it('treats saving the current model as a no-op and preserves the session', async () => {
    setMainProviderConfig({ type: 'claude', model: 'claude-sonnet-4-6' });
    updateAgentProvider({ type: 'claude', model: 'claude-sonnet-4-6' });
    setSession('model-chat', 'claude:current-thread', 'main');

    const res = await app.request('/api/agents/main/model' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });

    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      changed: false,
      sessionReset: false,
      restartRequired: false,
    });
    expect(getSession('model-chat', 'main')).toBe('claude:current-thread');
  });

  it('hot-swaps the active OpenAI model instead of leaving the prior provider config in memory', async () => {
    // Provider selection stores the active config in-process. This reproduces
    // a dashboard provider swap followed by a same-provider model swap.
    const original = getMainProviderConfig();
    setMainProviderConfig({ type: 'openai', model: 'gpt-5.5' });
    updateAgentProvider({ type: 'openai', model: 'gpt-5.5' });
    try {
      const res = await app.request('/api/agents/main/model' + Q, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-terra' }),
      });

      expect(res.status).toBe(200);
      expect(getSelectedProviderConfig()).toMatchObject({
        type: 'openai',
        model: 'gpt-5.6-terra',
      });
    } finally {
      setMainProviderConfig(original);
      updateAgentProvider(undefined);
    }
  });
});

describe('provider selection endpoints', () => {
  it('reports selectable Gemini and Codex model providers', async () => {
    const geminiRes = await get('/api/providers/models?provider=gemini');
    expect(geminiRes.status).toBe(200);
    expect(await jsonOf(geminiRes)).toMatchObject({
      provider: 'gemini',
      defaultModel: expect.any(String),
      selectable: true,
      allowCustom: true,
    });

    const codexRes = await get('/api/providers/models?provider=acp-codex');
    expect(codexRes.status).toBe(200);
    expect(await jsonOf(codexRes)).toMatchObject({
      provider: 'acp-codex',
      defaultModel: expect.any(String),
      selectable: true,
      allowCustom: true,
    });
  });

  // A dashboard tab loaded before the provider rename still asks for `codex`.
  // The endpoint normalizes it and echoes the canonical id back.
  it('normalizes a legacy codex model query to acp-codex', async () => {
    const res = await get('/api/providers/models?provider=codex');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ provider: 'acp-codex', selectable: true });
  });

  it('reports the native OpenAI (Codex) model provider', async () => {
    const res = await get('/api/providers/models?provider=openai');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      provider: 'openai',
      defaultModel: expect.any(String),
      selectable: true,
      allowCustom: true,
    });
  });

  it('reports static reasoning-effort runtime options for openai', async () => {
    const res = await get('/api/providers/runtime-options?provider=openai&model=gpt-5.6-sol');
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      provider: 'openai',
      source: 'static',
      thinkingLabel: 'Reasoning effort',
      modeOptions: [],
      thinkingOptions: expect.arrayContaining([
        expect.objectContaining({ id: '', label: 'Default (medium)' }),
        expect.objectContaining({ id: 'none' }),
        expect.objectContaining({ id: 'max' }),
      ]),
    });
  });

  it('updates main to the openai provider without restart', async () => {
    // The openai preflight passes on either codex-login state or an API key;
    // pin the key so the assertion doesn't depend on the host's ~/.codex.
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-contract-test';
    try {
      const res = await app.request('/api/agents/main/provider' + Q, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: { type: 'openai', model: 'gpt-5.5' } }),
      });
      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toMatchObject({
        ok: true,
        agent: 'main',
        provider: { type: 'openai', model: 'gpt-5.5' },
        restartRequired: false,
      });
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it('resets the active session on a provider change without requiring restart', async () => {
    setMainProviderConfig({ type: 'claude', model: 'claude-sonnet-4-6' });
    updateAgentProvider({ type: 'claude', model: 'claude-sonnet-4-6' });
    setSession('provider-chat', 'claude:old-thread', 'main');

    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-contract-test';
    try {
      const res = await app.request('/api/agents/main/provider' + Q, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: { type: 'openai', model: 'gpt-5.5' } }),
      });

      expect(res.status).toBe(200);
      expect(await jsonOf(res)).toMatchObject({
        changed: true,
        sessionReset: true,
        restartRequired: false,
      });
      expect(getSession('provider-chat', 'main')).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it('does not reset the session for an unchanged provider save', async () => {
    const provider = { type: 'claude' as const, model: 'claude-sonnet-4-6' };
    setMainProviderConfig(provider);
    updateAgentProvider(provider);
    setSession('provider-chat', 'claude:current-thread', 'main');

    const res = await app.request('/api/agents/main/provider' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider }),
    });

    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      changed: false,
      sessionReset: false,
      restartRequired: false,
    });
    expect(getSession('provider-chat', 'main')).toBe('claude:current-thread');
  });

  it('preserves active sessions when effort changes', async () => {
    const provider = { type: 'openai' as const, model: 'gpt-5.6-sol', thinkingMode: 'xhigh' };
    setMainProviderConfig(provider);
    updateAgentProvider(provider);
    setSession('runtime-chat', 'openai:current-thread', 'main');

    const res = await app.request('/api/agents/main/runtime' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinkingMode: 'medium' }),
    });

    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      changed: true,
      newChatRequired: false,
      sessionReset: false,
      restartRequired: false,
    });
    expect(getMainProviderConfig()).toMatchObject({ thinkingMode: 'medium' });
    expect(getSession('runtime-chat', 'main')).toBe('openai:current-thread');
  });

  it('updates main to a built-in ACP provider without restart', async () => {
    const res = await app.request('/api/agents/main/provider' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: { type: 'gemini' } }),
    });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      ok: true,
      agent: 'main',
      provider: { type: 'gemini' },
      restartRequired: false,
    });
  });

  it('updates main provider with a selected model without restart', async () => {
    const res = await app.request('/api/agents/main/provider' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: { type: 'acp-codex', model: 'gpt-5.3-codex' } }),
    });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      ok: true,
      agent: 'main',
      provider: { type: 'acp-codex', model: 'gpt-5.3-codex' },
      restartRequired: false,
    });
  });

  // The API is the write boundary: whatever spelling arrives, what gets
  // persisted and returned is the canonical acp-codex.
  it('normalizes a legacy codex provider write to acp-codex', async () => {
    const res = await app.request('/api/agents/main/provider' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: { type: 'codex', model: 'gpt-5.3-codex' } }),
    });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      ok: true,
      provider: { type: 'acp-codex', model: 'gpt-5.3-codex' },
    });
  });

  it('reports provider-specific runtime options', async () => {
    const claudeRes = await get('/api/providers/runtime-options?provider=claude&model=claude-opus-5');
    expect(claudeRes.status).toBe(200);
    expect(await jsonOf(claudeRes)).toMatchObject({
      provider: 'claude',
      source: 'static',
      modeLabel: 'Effort',
      modeOptions: expect.arrayContaining([expect.objectContaining({ id: 'max' })]),
      thinkingOptions: [],
    });
  });

  it('rejects custom ACP without a command', async () => {
    const res = await app.request('/api/agents/main/provider' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: { type: 'acp' } }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.stringMatching(/command/i) });
  });

  it('validates provider config during agent creation before writing config', async () => {
    const res = await app.request('/api/agents/create' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'provider-create',
        name: 'Provider Create',
        description: 'test agent',
        botToken: '123:fake',
        provider: { type: 'acp' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({ error: expect.stringMatching(/command/i) });
  });

  // ── provider writes fail closed on a bad type ──────────────────────────────
  //
  // normalizeProviderConfig falls back to Claude for an unreadable type. That is
  // right for a TRUSTED persisted read (never brick the install) and wrong for a
  // write: a typo would answer 200 OK and quietly reconfigure the agent to
  // Claude. Both write endpoints therefore validate the inbound type first.

  const patchProvider = (provider: unknown) => app.request('/api/agents/main/provider' + Q, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });

  const createWithProvider = (provider: unknown, id: string) => app.request('/api/agents/create' + Q, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name: 'Provider Guard', description: 'test agent', botToken: '123:fake', provider }),
  });

  const BAD_TYPES: Array<[label: string, provider: unknown]> = [
    ['an unknown type', { type: 'definitely-not-a-provider' }],
    ['the adapter binary name, which is not a provider id', { type: 'codex-acp' }],
    ['a missing type', { model: 'claude-opus-4-8' }],
    ['a non-string type', { type: 42 }],
    ['a null type', { type: null }],
    ['an empty type', { type: '   ' }],
  ];

  for (const [i, [label, provider]] of BAD_TYPES.entries()) {
    it(`PATCH rejects ${label} with 400 instead of silently choosing Claude`, async () => {
      const res = await patchProvider(provider);
      expect(res.status).toBe(400);
      const body = await jsonOf(res);
      expect(body).toMatchObject({ error: expect.any(String) });
      expect(body).not.toHaveProperty('provider');
    });

    it(`POST /api/agents/create rejects ${label} with 400`, async () => {
      const res = await createWithProvider(provider, `guard-bad-${i}`);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toMatchObject({ error: expect.any(String) });
    });
  }

  it('PATCH accepts the canonical acp-codex id', async () => {
    const res = await patchProvider({ type: 'acp-codex' });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, provider: { type: 'acp-codex' } });
  });

  it('PATCH accepts the legacy codex id and canonicalizes it', async () => {
    const res = await patchProvider({ type: 'codex' });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ ok: true, provider: { type: 'acp-codex' } });
  });

  // Successful creation runs the real agent-create module here, so a request
  // never gets past bot-token validation — this file cannot see what provider
  // actually reaches createAgent(). That is proven in
  // dashboard.agent-create-provider.test.ts, which mocks the module and asserts
  // on the recorded opts (canonical / legacy / omitted / never-invoked).
  it('does not reject a well-formed provider on the type gate', async () => {
    for (const [i, type] of ['acp-codex', 'codex', 'openai'].entries()) {
      const res = await createWithProvider({ type }, `guard-ok-${i}`);
      const body = await jsonOf(res) as { error?: string };
      expect(body.error ?? '').not.toMatch(/unknown provider|provider type required|must be an object/i);
    }
  });

  it('a create with NO provider block stays valid — the agent inherits the default', async () => {
    const res = await app.request('/api/agents/create' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'guard-no-provider', name: 'No Provider', description: 'test agent', botToken: '123:fake' }),
    });
    const body = await jsonOf(res) as { error?: string };
    expect(body.error ?? '').not.toMatch(/unknown provider|provider type required|must be an object/i);
  });

  // Falsy-but-explicit provider values are the fail-closed regression: a
  // truthiness check reads them as "omitted" and creates the agent on Claude.
  for (const [i, [label, provider]] of ([
    ['null', null], ['false', false], ['0', 0], ['an empty string', ''],
    ['a bare string', 'openai'], ['an array', []],
  ] as Array<[string, unknown]>).entries()) {
    it(`create rejects an explicit falsy/mis-shaped provider: ${label}`, async () => {
      const res = await createWithProvider(provider, `guard-shape-${i}`);
      expect(res.status).toBe(400);
      expect(await jsonOf(res)).toMatchObject({ error: expect.any(String) });
    });
  }

  it('preflights provider availability during agent creation', async () => {
    const res = await app.request('/api/agents/create' + Q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'provider-missing',
        name: 'Provider Missing',
        description: 'test agent',
        botToken: '123:fake',
        provider: { type: 'acp', command: 'missing-tool' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toMatchObject({
      error: expect.stringContaining('missing-tool'),
      setupHint: expect.any(String),
    });
  });
});

describe('avatar endpoints share error shape and status semantics', () => {
  // Twelve-byte canonical PNG header — the avatar PUT handler magic-byte
  // sniffs the first four bytes, so this is enough.
  const PNG_HEADER = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);

  it('GET, PUT, DELETE all return JSON {error} on an invalid id', async () => {
    const get = await app.request('/api/agents/has%20space/avatar' + Q);
    expect(get.status).toBe(400);
    const getBody = await jsonOf(get);
    expect(getBody).toMatchObject({ error: expect.any(String) });

    const put = await app.request('/api/agents/has%20space/avatar' + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: PNG_HEADER,
    });
    expect(put.status).toBe(400);
    expect(await jsonOf(put)).toMatchObject({ error: expect.any(String) });

    const del = await app.request('/api/agents/has%20space/avatar' + Q, { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect(await jsonOf(del)).toMatchObject({ error: expect.any(String) });
  });

  it('GET on an unknown agent returns 404 (not 204)', async () => {
    const res = await app.request('/api/agents/totally_made_up_agent/avatar' + Q);
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toMatchObject({ error: 'agent not found' });
  });

  it('GET on main with no avatar resolved returns 204', async () => {
    // main always "exists" per agentExists; with no bundled or mutable
    // avatar in the test env, the resolver returns null → 204.
    const res = await app.request('/api/agents/main/avatar' + Q);
    expect([200, 204]).toContain(res.status);
    if (res.status === 204) {
      expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/);
    }
  });
});

describe('PATCH /api/dashboard/settings standup_config', () => {
  async function patchStandupConfig(value: string) {
    return app.request('/api/dashboard/settings' + Q, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'standup_config', value }),
    });
  }

  it('accepts a well-formed payload', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ id: 'main', enabled: true }, { id: 'comms', enabled: false }],
      maxSpeakers: 5,
    }));
    expect(res.status).toBe(200);
  });

  it('rejects non-JSON value with 400', async () => {
    const res = await patchStandupConfig('not json {');
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/standup_config/);
  });

  it('rejects agents-not-an-array with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({ agents: 'nope', maxSpeakers: 5 }));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/agents must be an array/);
  });

  it('rejects an agent entry without an id with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ enabled: true }],
      maxSpeakers: 5,
    }));
    expect(res.status).toBe(400);
  });

  it('rejects maxSpeakers out of [1, 8] with 400', async () => {
    const res = await patchStandupConfig(JSON.stringify({
      agents: [{ id: 'main', enabled: true }],
      maxSpeakers: 99,
    }));
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/maxSpeakers/);
  });
});

describe('GET /api/warroom/agents', () => {
  it('returns { agents: [...] } with main present', async () => {
    const res = await get('/api/warroom/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.agents).toBeInstanceOf(Array);
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    expect(body.agents[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      description: expect.any(String),
    });
  });
});

describe('display name resolution', () => {
  // Write a main agent.yaml with name: Felix into the sandboxed
  // CLAUDECLAW_CONFIG so the dashboard resolves main's display name
  // from config instead of falling back to the hardcoded 'Main'.
  const mainAgentDir = path.join(CLAUDECLAW_CONFIG, 'agents', 'main');
  const mainAgentYaml = path.join(mainAgentDir, 'agent.yaml');

  beforeAll(() => {
    fs.mkdirSync(mainAgentDir, { recursive: true });
    fs.writeFileSync(
      mainAgentYaml,
      yaml.dump({ name: 'Felix', description: 'Test hub agent' }),
      'utf-8',
    );
  });

  afterAll(() => {
    try { fs.rmSync(mainAgentDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('GET /api/agents returns the configured name for main', async () => {
    const res = await get('/api/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const main = body.agents.find((a: { id: string }) => a.id === 'main');
    expect(main).toBeDefined();
    expect(main.name).toBe('Felix');
  });

  it('GET /api/warroom/agents returns the configured name for main', async () => {
    const res = await get('/api/warroom/agents');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const main = body.agents.find((a: { id: string }) => a.id === 'main');
    expect(main).toBeDefined();
    expect(main.name).toBe('Felix');
  });
});

describe('PUT /api/agents/:id/files/agent-yaml — rename + uniqueness guard', () => {
  const agentsRoot = path.join(CLAUDECLAW_CONFIG, 'agents');
  const rakaYaml = path.join(agentsRoot, 'raka', 'agent.yaml');

  beforeEach(() => {
    for (const [id, name] of [['raka', 'Raka'], ['nova', 'Nova']] as const) {
      const dir = path.join(agentsRoot, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'agent.yaml'),
        yaml.dump({ name, description: `${name} agent`, telegram_bot_token_env: `${id.toUpperCase()}_BOT_TOKEN` }),
        'utf-8',
      );
    }
  });

  afterEach(() => {
    for (const id of ['raka', 'nova']) {
      try { fs.rmSync(path.join(agentsRoot, id), { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  function putYaml(id: string, obj: Record<string, unknown>) {
    return app.request(`/api/agents/${id}/files/agent-yaml` + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: yaml.dump(obj) }),
    });
  }

  it('appends the outgoing display name to aliases on rename', async () => {
    const res = await putYaml('raka', {
      name: 'Rex',
      description: 'Raka agent',
      telegram_bot_token_env: 'RAKA_BOT_TOKEN',
    });
    expect(res.status).toBe(200);

    const onDisk = yaml.load(fs.readFileSync(rakaYaml, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.name).toBe('Rex');
    expect(onDisk.aliases).toContain('Raka');
  });

  it('rejects a rename that collides with another agent, writing nothing', async () => {
    const res = await putYaml('raka', {
      name: 'Nova', // collides with agent "nova"
      description: 'Raka agent',
      telegram_bot_token_env: 'RAKA_BOT_TOKEN',
    });
    expect(res.status).toBe(409);

    // File on disk is unchanged — still Raka, no alias appended.
    const onDisk = yaml.load(fs.readFileSync(rakaYaml, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.name).toBe('Raka');
    expect(onDisk.aliases).toBeUndefined();
  });

  it('rejects an alias that collides with another agent', async () => {
    const res = await putYaml('raka', {
      name: 'Raka',
      description: 'Raka agent',
      telegram_bot_token_env: 'RAKA_BOT_TOKEN',
      aliases: ['nova'], // collides with agent "nova"
    });
    expect(res.status).toBe(409);
  });
});

describe('main agent file editor is de-special-cased (normalized shape)', () => {
  const mainDir = path.join(CLAUDECLAW_CONFIG, 'agents', 'main');
  const mainYaml = path.join(mainDir, 'agent.yaml');
  const mainClaudeMd = path.join(mainDir, 'CLAUDE.md');
  const legacyPersona = path.join(CLAUDECLAW_CONFIG, 'CLAUDE.md');

  beforeEach(() => {
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(
      mainYaml,
      yaml.dump({ name: 'Holden', description: 'Hub agent', telegram_bot_token_env: 'TELEGRAM_BOT_TOKEN' }),
      'utf-8',
    );
    try { fs.unlinkSync(legacyPersona); } catch { /* absent */ }
  });

  afterEach(() => {
    try { fs.rmSync(mainDir, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.unlinkSync(legacyPersona); } catch { /* absent */ }
  });

  it('GET /api/agents/main/files exposes an editable Config tab reading agents/main/agent.yaml', async () => {
    const res = await get('/api/agents/main/files');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.config_editable).toBe(true);
    expect(body.agent_yaml).toContain('name: Holden');
  });

  it('PUT persona for main writes agents/main/CLAUDE.md, not CLAUDECLAW_CONFIG/CLAUDE.md', async () => {
    const res = await app.request('/api/agents/main/files/claudemd' + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# Holden persona\nBe helpful.' }),
    });
    expect(res.status).toBe(200);
    expect(fs.existsSync(mainClaudeMd)).toBe(true);
    expect(fs.readFileSync(mainClaudeMd, 'utf-8')).toContain('Holden persona');
    // The dead legacy path is NOT written.
    expect(fs.existsSync(legacyPersona)).toBe(false);
  });

  it('PUT agent.yaml for main succeeds (no "edit .env directly" rejection)', async () => {
    const res = await app.request('/api/agents/main/files/agent-yaml' + Q, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: yaml.dump({ name: 'Holden', description: 'Updated hub', telegram_bot_token_env: 'TELEGRAM_BOT_TOKEN' }),
      }),
    });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(mainYaml, 'utf-8')).toContain('Updated hub');
  });
});

describe('GET /api/warroom/pin', () => {
  it('returns { ok, agent, mode }', async () => {
    const res = await get('/api/warroom/pin');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      ok: expect.any(Boolean),
      mode: expect.any(String),
    });
  });
});

describe('GET /api/meet/sessions', () => {
  it('returns { ok, active, recent }', async () => {
    const res = await get('/api/meet/sessions');
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toMatchObject({
      active: expect.any(Array),
      recent: expect.any(Array),
    });
  });
});

describe('Cache-Control on /api/*', () => {
  it('every API response carries Cache-Control: no-store', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('Security headers on /', () => {
  it('Referrer-Policy: no-referrer is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('X-Frame-Options: DENY is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('X-Content-Type-Options: nosniff is set', async () => {
    const res = await get('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
