// Test seam for the agent-creation provider boundary.
//
// dashboard.contract.test.ts pins HTTP response SHAPE, but it runs the real
// agent-create module, so a creation request dies at bot-token validation long
// before `createAgent` is reached. That leaves the question this file exists to
// answer: what provider config actually arrives at creation?
//
// So `./agent-create.js` is mocked here — `validateBotToken` succeeds and
// `createAgent` is a spy that records its opts. Production token validation is
// untouched; only this suite's module graph is stubbed.
//
// The invariant under test: PRESENT-vs-ABSENT, not truthy-vs-falsy. An absent
// `provider` field means "inherit the default"; anything present must be a
// plain object with a known provider type, or the request is rejected before
// creation is invoked. A truthiness check would let `null` / `false` / `0` /
// `''` through as "omitted" — and normalizeProviderConfig's read-oriented
// fallback would then create the agent on Claude, silently.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Provider preflight shells out to `where`/`which`. Claim every command exists
// so the assertions never depend on which CLIs the host happens to have.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
});

const state = vi.hoisted(() => ({
  createCalls: [] as Array<{ id: string; runtimeMode?: string; lifecycleMode?: string; botToken?: string; provider?: { type?: string; model?: string } }>,
}));

vi.mock('./agent-create.js', async () => {
  const actual = await vi.importActual<typeof import('./agent-create.js')>('./agent-create.js');
  return {
    ...actual,
    // Production bot-token validation is NOT weakened — this stub exists only
    // so a request can reach createAgent inside this suite.
    validateBotToken: vi.fn(async () => ({
      ok: true,
      botInfo: { id: 1, is_bot: true, first_name: 'Fake', username: 'fake_bot' },
    })),
    createAgent: vi.fn(async (opts: { id: string; runtimeMode?: string; lifecycleMode?: string; botToken?: string; provider?: { type?: string; model?: string } }) => {
      state.createCalls.push(opts);
      return {
        agentId: opts.id,
        agentDir: `/tmp/${opts.id}`,
        envKey: 'FAKE_BOT_TOKEN',
        plistPath: null,
        botInfo: { id: 1, is_bot: true, first_name: 'Fake', username: 'fake_bot' },
      };
    }),
  };
});

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';
const Q = '?token=' + TOKEN;

let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
  state.createCalls.length = 0;
  // OpenAI preflight requires either Codex login state or an API key. Keep this
  // provider-boundary suite independent of credentials on the test host.
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** POST a create body VERBATIM — no key is added or dropped on the way in. */
async function create(body: Record<string, unknown>) {
  const res = await app.request('/api/agents/create' + Q, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const BASE = { name: 'Seam Agent', description: 'provider boundary seam', botToken: '123:fake' };

describe('the provider that reaches createAgent()', () => {
  it('accepts a headless worker without a bot token', async () => {
    const res = await create({ name: 'Worker', description: 'mission worker', id: 'seam-headless', runtimeMode: 'headless' });

    expect(res.status).toBe(201);
    expect(state.createCalls[0]).toMatchObject({ runtimeMode: 'headless' });
    expect(state.createCalls[0].botToken).toBeUndefined();
  });

  it('passes an explicit task-scoped lifecycle to headless creation', async () => {
    const res = await create({
      name: 'Temporary Worker',
      description: 'one bounded task tree',
      id: 'seam-task-scoped',
      runtimeMode: 'headless',
      lifecycleMode: 'task-scoped',
    });

    expect(res.status).toBe(201);
    expect(state.createCalls[0]).toMatchObject({ runtimeMode: 'headless', lifecycleMode: 'task-scoped' });
  });

  it('rejects task-scoped lifecycle for messenger creation', async () => {
    const res = await create({ ...BASE, id: 'seam-bad-lifecycle', lifecycleMode: 'task-scoped' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires headless runtime/);
    expect(state.createCalls).toHaveLength(0);
  });

  it('still requires a bot token in messenger mode', async () => {
    const res = await create({ name: 'Messenger', description: 'chat agent', id: 'seam-messenger' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('botToken required');
    expect(state.createCalls).toHaveLength(0);
  });

  it('passes the canonical acp-codex through unchanged', async () => {
    const res = await create({ ...BASE, id: 'seam-acp-codex', provider: { type: 'acp-codex' } });

    expect(res.status).toBe(201);
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0].provider).toEqual({ type: 'acp-codex' });
  });

  it('canonicalizes the legacy codex id before creation sees it', async () => {
    const res = await create({ ...BASE, id: 'seam-legacy', provider: { type: 'codex', model: 'gpt-5.3-codex' } });

    expect(res.status).toBe(201);
    expect(state.createCalls).toHaveLength(1);
    // The pre-rename spelling never reaches creation.
    expect(state.createCalls[0].provider).toEqual({ type: 'acp-codex', model: 'gpt-5.3-codex' });
    expect(state.createCalls[0].provider?.type).not.toBe('codex');
  });

  it('passes the stable native openai provider through unchanged', async () => {
    const res = await create({ ...BASE, id: 'seam-openai', provider: { type: 'openai', model: 'gpt-5.5' } });

    expect(res.status).toBe(201);
    expect(state.createCalls[0].provider).toEqual({ type: 'openai', model: 'gpt-5.5' });
  });

  it('leaves an OMITTED provider omitted so the agent inherits main', async () => {
    const res = await create({ ...BASE, id: 'seam-omitted' });

    expect(res.status).toBe(201);
    expect(state.createCalls).toHaveLength(1);
    expect(state.createCalls[0].provider).toBeUndefined();
  });

  it('does not invent a provider from a legacy top-level model when none is supplied', async () => {
    // `model` alone must not synthesize a provider block — that is main's job.
    const res = await create({ ...BASE, id: 'seam-model-only', model: 'claude-opus-4-8' });

    expect(res.status).toBe(201);
    expect(state.createCalls[0].provider).toBeUndefined();
  });
});

// Each of these is an EXPLICIT value the caller sent, so each must be rejected.
// The falsy ones are the regression this suite guards: under a truthiness check
// they read as "provider omitted" and the agent gets created on Claude.
describe('a malformed provider never reaches createAgent()', () => {
  const MUTATIONS: Array<[label: string, provider: unknown]> = [
    ['null', null],
    ['false', false],
    ['0', 0],
    ['an empty string', ''],
    ['a bare provider-id string', 'openai'],
    ['an array', []],
    ['an empty object', {}],
    ['an object with an unknown type', { type: 'definitely-not-a-provider' }],
    ['an object with a non-string type', { type: 42 }],
    ['an object whose type is the adapter binary name', { type: 'codex-acp' }],
  ];

  for (const [i, [label, provider]] of MUTATIONS.entries()) {
    it(`rejects provider: ${label} with 400 and never invokes creation`, async () => {
      const res = await create({ ...BASE, id: `seam-bad-${i}`, provider });

      expect(res.status).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
      // The whole point: no agent was created, and nothing fell back to Claude.
      expect(state.createCalls).toHaveLength(0);
    });
  }

  it('a rejected create leaves no trace of a Claude fallback in the response', async () => {
    const res = await create({ ...BASE, id: 'seam-no-claude', provider: null });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('claude');
    expect(state.createCalls).toHaveLength(0);
  });
});
