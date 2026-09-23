// The one seam. `anthropic-compatible` adds no adapter — it reshapes the
// environment of the SAME Claude Code subprocess. These tests pin both sides of
// that: a Claude turn must be untouched, and a compat turn must carry nothing
// from the parent process that the allowlist did not name.
//
// The most important assertion is the one about a caller that passes no `env`:
// without the fallback, such a turn inherits the parent's whole environment —
// including CLAUDE_CODE_OAUTH_TOKEN — and ships it to a third-party vendor.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

// vi.mock is hoisted above every import, so the temp dir has to be created in
// a hoisted block too.
const { storeDir } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return { storeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-compat-store-')) };
});
vi.mock('../config.js', () => ({ STORE_DIR: storeDir }));

// The provider reads .env through this; an empty file keeps the test from
// depending on whatever the developer happens to have configured.
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { resetCompatConfigCache } from '../anthropic-compat-env.js';
import { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';
import type { AgentEngineEvent, AgentTurnInput } from './types.js';

const queryMock = vi.mocked(query);

const KEY_VALUE = 'zai-adapter-test-credential';
const OAUTH = 'sk-ant-oat01-MUST-NOT-TRAVEL';

function successQuery() {
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
  })();
}

async function drain(events: AsyncIterable<AgentEngineEvent>): Promise<AgentEngineEvent[]> {
  const out: AgentEngineEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function turnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    prompt: 'hello',
    provider: { type: 'anthropic-compatible' },
    cwd: '/tmp/agent-cwd',
    ...overrides,
  } as AgentTurnInput;
}

/** The env the SDK was actually called with. */
function passedEnv(): Record<string, string | undefined> | undefined {
  return (queryMock.mock.calls[0]?.[0] as { options?: { env?: Record<string, string | undefined> } })
    ?.options?.env;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(successQuery as never);
  resetCompatConfigCache();
  process.env.ANTHROPIC_COMPAT_API_KEY = KEY_VALUE;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = OAUTH;
  delete process.env.ANTHROPIC_COMPAT_ENABLED;
  delete process.env.ANTHROPIC_COMPAT_BASE_URL;
  delete process.env.ZAI_API_KEY;
  delete process.env.GLM_API_KEY;
});

afterEach(() => {
  for (const k of ['ANTHROPIC_COMPAT_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_COMPAT_ENABLED',
    'ANTHROPIC_COMPAT_BASE_URL', 'ZAI_API_KEY', 'GLM_API_KEY']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  resetCompatConfigCache();
});

describe('claude turn is untouched', () => {
  it('passes the caller env through verbatim', async () => {
    const env = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: OAUTH, AN_UNRELATED_VALUE: 'yes' };
    await drain(new ClaudeSdkEngineAdapter().invoke(turnInput({ provider: { type: 'claude' }, env })));
    expect(passedEnv()).toBe(env);
  });

  it('passes no env at all when the caller passed none', async () => {
    await drain(new ClaudeSdkEngineAdapter().invoke(turnInput({ provider: { type: 'claude' } })));
    expect(passedEnv()).toBeUndefined();
  });
});

describe('anthropic-compatible turn reshapes the environment', () => {
  it('does not expose native Claude steering for compatible endpoints', async () => {
    const registerSteering = vi.fn();
    await drain(new ClaudeSdkEngineAdapter().invoke(turnInput({ registerSteering })));
    expect(registerSteering).not.toHaveBeenCalled();
    expect(queryMock.mock.calls[0][0].options?.extraArgs).toBeUndefined();
    const messages = [];
    for await (const message of queryMock.mock.calls[0][0].prompt as AsyncIterable<unknown>) messages.push(message);
    expect(messages).toHaveLength(1);
  });

  it('authenticates against the endpoint with a bearer token', async () => {
    await drain(new ClaudeSdkEngineAdapter().invoke(turnInput({ env: { PATH: '/usr/bin' } })));
    const env = passedEnv()!;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY_VALUE);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });

  it('bounds the tool surface with a generated config dir under the store', async () => {
    await drain(new ClaudeSdkEngineAdapter().invoke(turnInput({ env: { PATH: '/usr/bin' } })));
    const dir = passedEnv()!.CLAUDE_CONFIG_DIR!;
    expect(dir.startsWith(storeDir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('carries no Anthropic credential from the caller env', async () => {
    await drain(new ClaudeSdkEngineAdapter().invoke(turnInput({
      env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: OAUTH, DASHBOARD_TOKEN: 'SECRET-DASHBOARD' },
    })));
    const env = passedEnv()!;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.DASHBOARD_TOKEN).toBeUndefined();
    expect(Object.values(env).some((v) => typeof v === 'string' && v.includes(OAUTH))).toBe(false);
  });

  // Without the fallback this turn inherits process.env wholesale — the parent
  // process holds CLAUDE_CODE_OAUTH_TOKEN, so the leak is real, not theoretical.
  it('leaks nothing when the caller supplied no env at all', async () => {
    await drain(new ClaudeSdkEngineAdapter().invoke(turnInput()));
    const env = passedEnv()!;
    expect(env).toBeDefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY_VALUE);
    expect(Object.values(env).some((v) => typeof v === 'string' && v.includes(OAUTH))).toBe(false);
  });

  it('honors a per-agent endpoint only when it is allowed', async () => {
    process.env.ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS = 'true';
    process.env.ANTHROPIC_COMPAT_ALLOWED_HOSTS = 'api.moonshot.ai';
    resetCompatConfigCache();
    try {
      await drain(new ClaudeSdkEngineAdapter().invoke(turnInput({
        provider: { type: 'anthropic-compatible', baseUrl: 'https://api.moonshot.ai/anthropic' },
      })));
      expect(passedEnv()!.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    } finally {
      delete process.env.ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS;
      delete process.env.ANTHROPIC_COMPAT_ALLOWED_HOSTS;
      resetCompatConfigCache();
    }
  });
});

describe('a compat turn that must not run does not start', () => {
  // The credential must not be handed to an unvetted host, so the turn has to
  // die BEFORE query() — a turn that starts and then fails has already sent it.
  it('aborts on a disallowed endpoint without calling the SDK', async () => {
    const run = drain(new ClaudeSdkEngineAdapter().invoke(turnInput({
      provider: { type: 'anthropic-compatible', baseUrl: 'https://api.moonshot.ai/anthropic' },
    })));
    await expect(run).rejects.toThrow(/ALLOW_CUSTOM_ENDPOINTS|ALLOWED_HOSTS/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('aborts when no credential is configured', async () => {
    delete process.env.ANTHROPIC_COMPAT_API_KEY;
    resetCompatConfigCache();
    await expect(drain(new ClaudeSdkEngineAdapter().invoke(turnInput())))
      .rejects.toThrow(/ZAI_API_KEY/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  // A kill switch that needs a service restart is worthless in an incident:
  // nine agents run as services here and all of them must stop at once.
  it('refuses new turns the moment the kill switch is set', async () => {
    process.env.ANTHROPIC_COMPAT_ENABLED = 'false';
    await expect(drain(new ClaudeSdkEngineAdapter().invoke(turnInput())))
      .rejects.toThrow(/abgeschaltet|switched off|ANTHROPIC_COMPAT_ENABLED/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('never puts the credential into the abort message', async () => {
    process.env.ANTHROPIC_COMPAT_API_KEY = `"${KEY_VALUE}"`;
    resetCompatConfigCache();
    try {
      await drain(new ClaudeSdkEngineAdapter().invoke(turnInput()));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY_VALUE);
    }
  });
});
