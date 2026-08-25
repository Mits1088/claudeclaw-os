// The environment handed to an anthropic-compatible turn is a security
// boundary, not a convenience. Every test here pins one way the boundary can
// leak: a credential that survives into the subprocess, a base URL that
// redirects a key to the wrong vendor, a stale alias that silently reactivates
// an old key.
//
// The rule these tests encode: the env is an ALLOWLIST. A blocklist was tried
// first and rejected — it left CLAUDECLAW_*, database and cloud variables
// standing, and a turn can run `env` and ship the output to the endpoint as a
// tool result.

import { describe, expect, it } from 'vitest';

import {
  buildCompatEnv,
  COMPAT_API_TIMEOUT_MS,
  COMPAT_CONTEXT_TOKENS,
  CompatConfigError,
  DEFAULT_COMPAT_BASE_URL,
  DEFAULT_COMPAT_FAST_MODEL,
  DEFAULT_COMPAT_MODEL,
  ENV_PASSTHROUGH_ALLOWLIST,
  loadCompatConfig,
  redactSecret,
  resolveCompatApiKey,
  resolveCompatBaseUrl,
} from './anthropic-compat-env.js';

const KEY = 'zai-test-credential-0123456789';

/** Minimal source that resolves cleanly: just the canonical key name. */
function baseSource(extra: Record<string, string | undefined> = {}) {
  return { ANTHROPIC_COMPAT_API_KEY: KEY, ...extra };
}

describe('resolveCompatApiKey', () => {
  it('reads the canonical name', () => {
    expect(resolveCompatApiKey(baseSource())).toBe(KEY);
  });

  it('accepts a documented alias when it is the only one set', () => {
    expect(resolveCompatApiKey({ ZAI_API_KEY: KEY })).toBe(KEY);
    expect(resolveCompatApiKey({ GLM_API_KEY: KEY })).toBe(KEY);
  });

  // A forgotten old value must not quietly win. Two names set is an operator
  // mistake with two different possible intents, so it is an error, never a
  // precedence rule.
  it('refuses when two names are set, even with the same value', () => {
    expect(() => resolveCompatApiKey({ ANTHROPIC_COMPAT_API_KEY: KEY, ZAI_API_KEY: KEY }))
      .toThrow(CompatConfigError);
    expect(() => resolveCompatApiKey({ ZAI_API_KEY: KEY, GLM_API_KEY: 'a-different-value' }))
      .toThrow(/ANTHROPIC_COMPAT_API_KEY/);
  });

  it('refuses a missing or blank key instead of falling back', () => {
    expect(() => resolveCompatApiKey({})).toThrow(CompatConfigError);
    expect(() => resolveCompatApiKey({ ANTHROPIC_COMPAT_API_KEY: '   ' })).toThrow(CompatConfigError);
  });

  // A quoted value produced a hintless HTTP 401 in the field: the quotes travel
  // into the Authorization header and the endpoint just rejects the request.
  it('refuses a quoted value rather than silently unquoting it', () => {
    expect(() => resolveCompatApiKey({ ANTHROPIC_COMPAT_API_KEY: `"${KEY}"` }))
      .toThrow(/quote/i);
  });

  it('refuses a value with a trailing carriage return', () => {
    expect(() => resolveCompatApiKey({ ANTHROPIC_COMPAT_API_KEY: `${KEY}\r` }))
      .toThrow(CompatConfigError);
  });

  it('never puts the key itself into the error message', () => {
    try {
      resolveCompatApiKey({ ANTHROPIC_COMPAT_API_KEY: `"${KEY}"` });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(KEY);
    }
  });
});

describe('resolveCompatBaseUrl', () => {
  it('needs no switch for the built-in default', () => {
    expect(resolveCompatBaseUrl({})).toBe(DEFAULT_COMPAT_BASE_URL);
    expect(resolveCompatBaseUrl({ ANTHROPIC_COMPAT_BASE_URL: DEFAULT_COMPAT_BASE_URL }))
      .toBe(DEFAULT_COMPAT_BASE_URL);
  });

  // Fail closed. Falling back to the default would send a key meant for
  // vendor B to vendor A — the safety path would itself be the leak.
  it('aborts on a foreign host without the switch, and does not fall back', () => {
    expect(() => resolveCompatBaseUrl({ ANTHROPIC_COMPAT_BASE_URL: 'https://api.moonshot.ai/anthropic' }))
      .toThrow(CompatConfigError);
  });

  it('aborts on a foreign host that the switch allows but the list does not', () => {
    expect(() => resolveCompatBaseUrl({
      ANTHROPIC_COMPAT_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
      ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'api.deepseek.com',
    })).toThrow(CompatConfigError);
  });

  it('accepts a foreign host with both the switch and a list entry', () => {
    expect(resolveCompatBaseUrl({
      ANTHROPIC_COMPAT_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
      ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'api.deepseek.com,api.moonshot.ai',
    })).toBe('https://api.moonshot.ai/anthropic');
  });

  // An allowed http:// host would hand the bearer token over in cleartext.
  it('refuses http:// even when the host is allowed', () => {
    expect(() => resolveCompatBaseUrl({
      ANTHROPIC_COMPAT_BASE_URL: 'http://api.moonshot.ai/anthropic',
      ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
      ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'api.moonshot.ai',
    })).toThrow(/https/i);
  });

  it('refuses a URL carrying userinfo', () => {
    expect(() => resolveCompatBaseUrl({
      ANTHROPIC_COMPAT_BASE_URL: 'https://user:secret@api.moonshot.ai/anthropic',
      ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
      ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'api.moonshot.ai',
    })).toThrow(CompatConfigError);
  });

  it('does not leak userinfo into the error message', () => {
    try {
      resolveCompatBaseUrl({
        ANTHROPIC_COMPAT_BASE_URL: 'https://user:secretword123@api.moonshot.ai/anthropic',
        ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
        ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'api.moonshot.ai',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('secretword123');
    }
  });

  // URL and allowlist must be canonicalized by the SAME routine, or a
  // differently-spelled entry walks past the check.
  it('canonicalizes list and URL alike: case, default port, trailing dot', () => {
    const allowed = {
      ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
      ANTHROPIC_COMPAT_ALLOWED_HOSTS: '  API.MoonShot.AI:443 ',
    };
    expect(resolveCompatBaseUrl({ ...allowed, ANTHROPIC_COMPAT_BASE_URL: 'https://api.moonshot.ai/v1' }))
      .toBe('https://api.moonshot.ai/v1');
    expect(resolveCompatBaseUrl({ ...allowed, ANTHROPIC_COMPAT_BASE_URL: 'https://API.MOONSHOT.AI:443/v1' }))
      .toBe('https://api.moonshot.ai/v1');
  });

  // A Unicode homoglyph host must be compared in its ASCII (punycode) form, or
  // "аpi.z.ai" with a Cyrillic а reads as the default and is waved through.
  it('compares punycode, so a homoglyph host is not the default', () => {
    expect(() => resolveCompatBaseUrl({ ANTHROPIC_COMPAT_BASE_URL: 'https://аpi.z.ai/api/anthropic' }))
      .toThrow(CompatConfigError);
  });

  it('refuses a non-standard port unless the list names it', () => {
    expect(() => resolveCompatBaseUrl({
      ANTHROPIC_COMPAT_BASE_URL: 'https://api.moonshot.ai:8443/v1',
      ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
      ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'api.moonshot.ai',
    })).toThrow(CompatConfigError);
    expect(resolveCompatBaseUrl({
      ANTHROPIC_COMPAT_BASE_URL: 'https://api.moonshot.ai:8443/v1',
      ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true',
      ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'api.moonshot.ai:8443',
    })).toBe('https://api.moonshot.ai:8443/v1');
  });

  it('refuses an unparseable URL', () => {
    expect(() => resolveCompatBaseUrl({ ANTHROPIC_COMPAT_BASE_URL: 'not-even-a-url' }))
      .toThrow(CompatConfigError);
  });
});

describe('buildCompatEnv', () => {
  const cfg = loadCompatConfig(baseSource());

  /** A base env pretending to be a fully-loaded parent process. */
  const parent = {
    PATH: '/usr/bin',
    HOME: '/Users/test',
    LANG: 'de_DE.UTF-8',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SECRET-ANTHROPIC',
    ANTHROPIC_API_KEY: 'sk-ant-api03-SECRET-ANTHROPIC',
    ANTHROPIC_AUTH_TOKEN: 'an-inherited-foreign-value',
    DASHBOARD_TOKEN: 'SECRET-DASHBOARD',
    DB_ENCRYPTION_KEY: 'SECRET-DB',
    CLAUDECLAW_STORE_DIR: '/wo/der/store/liegt',
    MATTERMOST_URL: 'https://chat.example.invalid',
    SOME_OTHER_VALUE: 'harmless-but-unknown',
  };

  // Inherited means "the value came from the parent". A name the builder sets
  // itself (ANTHROPIC_AUTH_TOKEN) may collide with a parent name without that
  // being inheritance — what matters is whose value wins.
  it('passes through only what the allowlist names', () => {
    const env = buildCompatEnv(parent, cfg);
    const inherited = Object.keys(env).filter((k) => k in parent && env[k] === parent[k as keyof typeof parent]);
    for (const key of inherited) {
      expect(ENV_PASSTHROUGH_ALLOWLIST).toContain(key);
    }
    expect(inherited).toEqual(expect.arrayContaining(['PATH', 'HOME', 'LANG']));
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/test');
  });

  // The single most important assertion in this file: no Anthropic credential
  // may travel to a third-party endpoint, in any spelling, under any name.
  it('carries no Anthropic credential and no unrelated secret', () => {
    const env = buildCompatEnv(parent, cfg);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DASHBOARD_TOKEN).toBeUndefined();
    expect(env.DB_ENCRYPTION_KEY).toBeUndefined();
    expect(env.CLAUDECLAW_STORE_DIR).toBeUndefined();
    expect(env.MATTERMOST_URL).toBeUndefined();
    expect(env.SOME_OTHER_VALUE).toBeUndefined();

    const values = Object.values(env).filter((v): v is string => typeof v === 'string');
    for (const marker of ['SECRET-ANTHROPIC', 'SECRET-DASHBOARD', 'SECRET-DB', 'an-inherited-foreign-value']) {
      expect(values.some((v) => v.includes(marker))).toBe(false);
    }
  });

  // Bearer, not x-api-key: ANTHROPIC_API_KEY makes the CLI send an x-api-key
  // header. z.ai currently answers both, but the contract we configure is the
  // documented one — and setting API_KEY would additionally risk an Anthropic
  // key path being taken.
  it('authenticates with ANTHROPIC_AUTH_TOKEN and never sets ANTHROPIC_API_KEY', () => {
    const env = buildCompatEnv(parent, cfg);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });

  it('points the subprocess at the resolved endpoint and its own config dir', () => {
    const env = buildCompatEnv(parent, cfg);
    expect(env.ANTHROPIC_BASE_URL).toBe(DEFAULT_COMPAT_BASE_URL);
    expect(env.CLAUDE_CONFIG_DIR).toBe(cfg.configDir);
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy();
  });

  // Without the [1m] suffix on EVERY slot, Claude Code assumes 200k on that
  // slot and compacts far too early.
  it('fills all four model slots, the big ones with the context suffix', () => {
    const env = buildCompatEnv(parent, cfg);
    for (const slot of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'] as const) {
      expect(env[slot]).toBe(DEFAULT_COMPAT_MODEL);
      expect(env[slot]).toContain('[1m]');
    }
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(DEFAULT_COMPAT_FAST_MODEL);
  });

  it('sets context, timeout and the telemetry block', () => {
    const env = buildCompatEnv(parent, cfg);
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(COMPAT_CONTEXT_TOKENS);
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(COMPAT_CONTEXT_TOKENS);
    expect(env.API_TIMEOUT_MS).toBe(COMPAT_API_TIMEOUT_MS);
    // Measured 2026-08-20: without this, a turn against z.ai still contacts
    // api.anthropic.com five times. With it, zero.
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('does not mutate the base env it was handed', () => {
    const snapshot = { ...parent };
    buildCompatEnv(parent, cfg);
    expect(parent).toEqual(snapshot);
  });

  it('works from an empty base — an env-less caller leaks nothing', () => {
    const env = buildCompatEnv({}, cfg);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('loadCompatConfig', () => {
  it('honors model overrides', () => {
    const cfg = loadCompatConfig(baseSource({
      ANTHROPIC_COMPAT_MODEL: 'glm-9[1m]',
      ANTHROPIC_COMPAT_FAST_MODEL: 'glm-9-mini',
    }));
    expect(cfg.model).toBe('glm-9[1m]');
    expect(cfg.fastModel).toBe('glm-9-mini');
  });

  it('is frozen, so preflight and turn cannot drift apart', () => {
    const cfg = loadCompatConfig(baseSource());
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('dispatch stays off unless explicitly opted in', () => {
    expect(loadCompatConfig(baseSource()).allowDispatch).toBe(false);
    expect(loadCompatConfig(baseSource({ ANTHROPIC_COMPAT_ALLOW_DISPATCH: 'true' })).allowDispatch).toBe(true);
  });

  it('propagates a bad base URL as a config error rather than a usable config', () => {
    expect(() => loadCompatConfig(baseSource({ ANTHROPIC_COMPAT_BASE_URL: 'http://api.z.ai/x' })))
      .toThrow(CompatConfigError);
  });
});

describe('redactSecret', () => {
  it('replaces the secret wherever it appears in a message', () => {
    const text = redactSecret(`Call with bearer ${KEY} failed`, [KEY]);
    expect(text).not.toContain(KEY);
    expect(text).toContain('[redacted]');
  });

  it('tolerates empty and undefined secrets without redacting everything', () => {
    expect(redactSecret('an unremarkable message', ['', undefined])).toBe('an unremarkable message');
  });
});
