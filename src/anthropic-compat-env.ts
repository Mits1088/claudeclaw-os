// Environment for a turn against an anthropic-compatible third-party endpoint.
//
// The `anthropic-compatible` provider adds no new adapter. The Claude SDK
// adapter already spawns the real `claude` binary as a subprocess; this module
// decides what that subprocess is allowed to see. Everything security-relevant
// about the provider lives here:
//
//   * which environment variables survive into the child (an ALLOWLIST),
//   * which endpoint the bearer token may travel to (allowlist + fail closed),
//   * which credential name is authoritative (exactly one, no silent aliases).
//
// Deliberately free of imports from ./config.js so it stays a leaf module:
// the preflight, the adapter and the tests all resolve the same values without
// pulling the configuration graph — and without any chance of the preflight
// checking a different endpoint than the turn then talks to.

import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

/** A configuration error the operator must fix. Never retried, never softened. */
export class CompatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompatConfigError';
  }
}

/** Built-in default endpoint: z.ai's anthropic-compatible surface. */
export const DEFAULT_COMPAT_BASE_URL = 'https://api.z.ai/api/anthropic';

/**
 * The `[1m]` suffix is how Claude Code is told the real context window. Without
 * it the CLI assumes 200k and compacts long before it has to. Measured against
 * the endpoint on 2026-08-20: 225,019 input tokens accepted, HTTP 200.
 */
export const DEFAULT_COMPAT_MODEL = 'glm-5.3[1m]';
/** The small/fast slot (Haiku's place). No 1M context, no suffix. */
export const DEFAULT_COMPAT_FAST_MODEL = 'glm-4.7';

export const COMPAT_CONTEXT_TOKENS = '1000000';
export const COMPAT_API_TIMEOUT_MS = '3000000';

/** The canonical credential name. Everything else is a tolerated alias. */
const CANONICAL_KEY_NAME = 'ZAI_API_KEY';
/**
 * Aliases exist because operators already have these in their .env from running
 * the CLI by hand. They are read, but two names set at once is an ERROR: a
 * forgotten old value must never quietly win a precedence contest.
 */
const KEY_ALIASES = ['ANTHROPIC_COMPAT_API_KEY', 'GLM_API_KEY'] as const;

/**
 * Everything the subprocess is allowed to inherit. A blocklist was tried first
 * and rejected: it left CLAUDECLAW_*, database and cloud variables standing,
 * and a turn can run `env` and hand the output to the endpoint as a tool
 * result. What is not named here does not exist for the child.
 */
export const ENV_PASSTHROUGH_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'IS_SANDBOX',
  // Windows cannot start a process without these.
  'SystemRoot',
  'SYSTEMROOT',
  'USERPROFILE',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  // Corporate TLS interception; without it https fails on some machines.
  'NODE_EXTRA_CA_CERTS',
];

export interface CompatTurnConfig {
  /** Bearer token for the endpoint. Never logged. */
  readonly authToken: string;
  /** Canonicalized, https-only, allowlisted endpoint. */
  readonly baseUrl: string;
  readonly model: string;
  readonly fastModel: string;
  /** Generated, minimal config dir that bounds the subprocess's tool surface. */
  readonly configDir: string;
  /** Fleet dispatch verbs. Off unless explicitly opted in. */
  readonly allowDispatch: boolean;
}

export type CompatEnvSource = Record<string, string | undefined>;

/** Replaces every occurrence of a secret in a message. Use before any log. */
export function redactSecret(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function isTrue(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Resolves the credential.
 *
 * Fails rather than guesses in all four ambiguous cases: nothing set, blank,
 * two names set, or a value that carries shell quoting or a stray CR. The last
 * one is not pedantry — a quoted value produced a hintless HTTP 401 in the
 * field, because the quotes travel into the Authorization header.
 */
export function resolveCompatApiKey(src: CompatEnvSource): string {
  const present = [CANONICAL_KEY_NAME, ...KEY_ALIASES]
    .filter((name) => (src[name] ?? '').trim().length > 0);

  if (present.length === 0) {
    throw new CompatConfigError(
      `${CANONICAL_KEY_NAME} is not set. The anthropic-compatible provider cannot start without a credential.`,
    );
  }
  if (present.length > 1) {
    throw new CompatConfigError(
      `Several credential names are set (${present.join(', ')}). Exactly one is allowed, ` +
      `preferably ${CANONICAL_KEY_NAME}. A forgotten old value must not quietly win.`,
    );
  }

  const name = present[0];
  const raw = src[name] as string;

  if (raw !== raw.trim()) {
    throw new CompatConfigError(
      `${name} has leading/trailing whitespace or a trailing carriage return. ` +
      `That produces a hintless HTTP 401 — clean the value up in .env.`,
    );
  }
  if (/^["'].*["']$/.test(raw)) {
    throw new CompatConfigError(
      `${name} is wrapped in quotes. The quote characters travel into the Authorization header ` +
      `and produce a hintless HTTP 401 — store the value unquoted.`,
    );
  }
  return raw;
}

/**
 * Canonical form of a host for comparison: ASCII (punycode) hostname, lowercase,
 * default port removed, trailing dot removed. URL and allowlist entries pass
 * through the SAME routine — otherwise a differently-spelled list entry, or a
 * Unicode homoglyph in the URL, walks straight past the check.
 */
function canonicalHost(hostname: string, port: string): string {
  let host = hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  return port && port !== '443' ? `${host}:${port}` : host;
}

/** Same canonicalization for an allowlist entry, which has no URL to parse. */
function canonicalAllowlistEntry(entry: string): string | undefined {
  const raw = entry.trim();
  if (!raw) return undefined;
  try {
    // Parsing through URL gets punycode conversion and port normalization for
    // free, and is the only way the entry is normalized identically to the URL.
    const u = new URL(`https://${raw.replace(/^https?:\/\//i, '')}`);
    if (u.pathname !== '/' && u.pathname !== '') return undefined;
    return canonicalHost(u.hostname, u.port);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the endpoint.
 *
 * The built-in default needs nothing. Any other URL needs BOTH the switch and
 * an allowlist entry. A URL that fails any check ABORTS the turn — there is
 * deliberately no fallback to the default, because falling back would send a
 * key meant for vendor B to vendor A. The safety path must not be the leak.
 */
export function resolveCompatBaseUrl(src: CompatEnvSource, override?: string): string {
  const raw = (override ?? src.ANTHROPIC_COMPAT_BASE_URL ?? '').trim();
  if (!raw) return DEFAULT_COMPAT_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CompatConfigError(
      'ANTHROPIC_COMPAT_BASE_URL is not a valid URL. A full https address is expected.',
    );
  }

  // An allowed http:// host would hand the bearer token over in cleartext.
  if (url.protocol !== 'https:') {
    throw new CompatConfigError(
      `ANTHROPIC_COMPAT_BASE_URL must use https (found: ${url.protocol.replace(':', '')}). ` +
      `Over http the bearer token travels in cleartext.`,
    );
  }
  if (url.username || url.password) {
    throw new CompatConfigError(
      'ANTHROPIC_COMPAT_BASE_URL contains userinfo (user:pass@), which is not allowed.',
    );
  }

  const canonical = canonicalHost(url.hostname, url.port);
  const defaultUrl = new URL(DEFAULT_COMPAT_BASE_URL);
  const canonicalDefault = canonicalHost(defaultUrl.hostname, defaultUrl.port);

  if (canonical !== canonicalDefault) {
    if (!isTrue(src.ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS)) {
      throw new CompatConfigError(
        `Endpoint ${canonical} is not the built-in default. A third-party endpoint needs ` +
        `ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS=true and an entry in ANTHROPIC_COMPAT_ALLOWED_HOSTS. ` +
        `The turn is aborted; there is deliberately no fallback to the default.`,
      );
    }
    const allowed = new Set(
      (src.ANTHROPIC_COMPAT_ALLOWED_HOSTS ?? '')
        .split(',')
        .map(canonicalAllowlistEntry)
        .filter((v): v is string => !!v),
    );
    if (!allowed.has(canonical)) {
      throw new CompatConfigError(
        `Endpoint ${canonical} is not listed in ANTHROPIC_COMPAT_ALLOWED_HOSTS. The turn is ` +
        `aborted so the credential does not travel to an unapproved host.`,
      );
    }
  }

  // Canonical string form: lowercase host, default port dropped, no trailing slash.
  const pathPart = url.pathname.replace(/\/+$/, '');
  return `https://${canonical}${pathPart}${url.search}`;
}

/**
 * Default location of the generated config dir when the caller names none.
 * Derived from the source env rather than ./config.js so this module stays a
 * leaf; the adapter passes the STORE_DIR-based path explicitly.
 */
function defaultConfigDir(src: CompatEnvSource): string {
  const store = (src.CLAUDECLAW_STORE_DIR ?? '').trim();
  const root = store || path.join(src.HOME?.trim() || os.homedir(), '.claudeclaw');
  return path.join(root, 'compat-config');
}

/**
 * Loads the whole provider configuration once, frozen.
 *
 * Frozen and loaded in one place on purpose: `checkProviderAvailability` and
 * the turn itself must use the SAME instance, or the preflight validates one
 * endpoint while the turn talks to another.
 */
export function loadCompatConfig(
  src: CompatEnvSource,
  configDir?: string,
  baseUrlOverride?: string,
): CompatTurnConfig {
  return Object.freeze({
    authToken: resolveCompatApiKey(src),
    baseUrl: resolveCompatBaseUrl(src, baseUrlOverride),
    model: (src.ANTHROPIC_COMPAT_MODEL ?? '').trim() || DEFAULT_COMPAT_MODEL,
    fastModel: (src.ANTHROPIC_COMPAT_FAST_MODEL ?? '').trim() || DEFAULT_COMPAT_FAST_MODEL,
    configDir: configDir?.trim() || defaultConfigDir(src),
    allowDispatch: isTrue(src.ANTHROPIC_COMPAT_ALLOW_DISPATCH),
  });
}

/** Same config, different generated config dir. Used per turn, per agent allowlist. */
export function withConfigDir(cfg: CompatTurnConfig, configDir: string): CompatTurnConfig {
  return Object.freeze({ ...cfg, configDir });
}

/** Every name this provider reads. Kept here so .env parsing has one list. */
const COMPAT_ENV_KEYS = [
  CANONICAL_KEY_NAME,
  ...KEY_ALIASES,
  'ANTHROPIC_COMPAT_BASE_URL',
  'ANTHROPIC_COMPAT_MODEL',
  'ANTHROPIC_COMPAT_FAST_MODEL',
  'ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS',
  'ANTHROPIC_COMPAT_ALLOWED_HOSTS',
  'ANTHROPIC_COMPAT_ALLOW_DISPATCH',
  'ANTHROPIC_COMPAT_ENABLED',
  'CLAUDECLAW_STORE_DIR',
] as const;

/**
 * The values this provider is configured from: process env first (so a
 * `pm2 restart --update-env` wins), .env file second. Read fresh so the kill
 * switch below takes effect without a service restart.
 */
export function compatEnvSource(): CompatEnvSource {
  const fromFile = readEnvFile([...COMPAT_ENV_KEYS]);
  const src: CompatEnvSource = { ...fromFile };
  for (const key of COMPAT_ENV_KEYS) {
    const live = process.env[key];
    if (live !== undefined && live !== '') src[key] = live;
  }
  src.HOME = process.env.HOME;
  return src;
}

/**
 * Runtime kill switch, checked before every turn.
 *
 * Deliberately NOT cached: a switch that only takes effect at the next service
 * restart is worthless during an incident. Nine agents run as launchd services
 * here; flipping this must stop new turns on all of them immediately.
 * Absent → enabled, so an install that never sets it behaves normally.
 */
export function compatProviderEnabled(src: CompatEnvSource = compatEnvSource()): boolean {
  const raw = (src.ANTHROPIC_COMPAT_ENABLED ?? '').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

/**
 * Config cache, keyed by the endpoint override.
 *
 * ONE instance per (override, configDir) pair, so `checkProviderAvailability`
 * and the turn that follows it cannot validate one endpoint and then talk to
 * another. Keyed rather than a single slot because an agent may pin its own
 * baseUrl in agent.yaml.
 */
const configCache = new Map<string, CompatTurnConfig>();

export function getCompatConfig(baseUrlOverride?: string, configDir?: string): CompatTurnConfig {
  const key = `${baseUrlOverride ?? ''} ${configDir ?? ''}`;
  const cached = configCache.get(key);
  if (cached) return cached;
  const cfg = loadCompatConfig(compatEnvSource(), configDir, baseUrlOverride);
  configCache.set(key, cfg);
  return cfg;
}

/** Test seam, and the way an operator's .env edit takes effect on reload. */
export function resetCompatConfigCache(): void {
  configCache.clear();
}

/**
 * The configured model name alone.
 *
 * Separate from loadCompatConfig because model resolution must never throw:
 * `defaultModelForProvider` runs on display paths (status, dashboard, runtime
 * identity) where a missing credential is a thing to REPORT, not a crash.
 */
export function compatModelName(src: CompatEnvSource = compatEnvSource()): string {
  return (src.ANTHROPIC_COMPAT_MODEL ?? '').trim() || DEFAULT_COMPAT_MODEL;
}

/**
 * Whether fleet dispatch (mission / schedule / hive) may reach a compat turn.
 *
 * Off by default and read without touching the credential, so the dispatch
 * authorization layer can ask this on a turn that has no key configured
 * without the question itself throwing.
 */
export function compatDispatchAllowed(src: CompatEnvSource = compatEnvSource()): boolean {
  return isTrue(src.ANTHROPIC_COMPAT_ALLOW_DISPATCH);
}

/**
 * Builds the environment for one turn.
 *
 * The allowlist loop is the whole point: an Anthropic credential cannot slip
 * through here in any spelling or under any name, because nothing is copied
 * that was not explicitly named. The `base` argument is only ever a source of
 * process-level plumbing (PATH, HOME, locale) — never of credentials.
 */
export function buildCompatEnv(
  base: CompatEnvSource,
  cfg: CompatTurnConfig,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_PASSTHROUGH_ALLOWLIST) {
    if (base[key] !== undefined) env[key] = base[key];
  }

  env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  // Bearer, not x-api-key. ANTHROPIC_API_KEY makes the CLI send an x-api-key
  // header; it is deliberately never set here, so no Anthropic key path exists.
  env.ANTHROPIC_AUTH_TOKEN = cfg.authToken;
  // The generated, minimal config dir. Measured 2026-08-20: without it the
  // subprocess loads the global configuration — 24 MCP servers and 273 tools,
  // including CRM, mailboxes and four SSH hosts. With it: exactly the servers
  // the agent's allowlist names.
  env.CLAUDE_CONFIG_DIR = cfg.configDir;

  env.ANTHROPIC_MODEL = cfg.model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = cfg.model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = cfg.model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = cfg.fastModel;

  env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = COMPAT_CONTEXT_TOKENS;
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = COMPAT_CONTEXT_TOKENS;
  env.API_TIMEOUT_MS = COMPAT_API_TIMEOUT_MS;
  // Measured 2026-08-20 through a logging proxy: without this a turn against
  // z.ai still opens five connections to api.anthropic.com. With it, none.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}
