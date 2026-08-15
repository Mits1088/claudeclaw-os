import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { renderCliIndex } from './cli-reference.js';
import { allDescriptors } from './cli-descriptors.js';
import { readEnvFile } from './env.js';
import type { ProviderConfig } from './provider.js';

/**
 * Append the compact CLI index to an agent's persona so every engine
 * (Claude-SDK via `systemPrompt`, ACP/openrouter via in-band prepend in
 * bot.ts) sees the same one source. Only when a persona is present — we do
 * not fabricate a systemPrompt for no-persona agents. `cli-reference.js` and
 * `cli-descriptors.js` are both leaf modules (type + pure data only), so this
 * import does not create a cycle back through db.ts.
 */
function withCliIndex(persona: string | undefined): string | undefined {
  if (!persona) return persona;
  // Stamp the known-absolute PROJECT_ROOT into the injected index so agents
  // never rediscover the root via `git rev-parse` — scheduled/automation turns
  // run from the agent config dir (a non-repo cwd) and would otherwise anchor
  // to a sibling checkout. See issue #157.
  return persona + '\n\n' + renderCliIndex(allDescriptors, PROJECT_ROOT);
}

const envConfig = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  'ALLOWED_CHAT_ID',
  'GROQ_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'WHATSAPP_ENABLED',
  'SLACK_USER_TOKEN',
  'CONTEXT_LIMIT',
  'DASHBOARD_PORT',
  'DASHBOARD_BIND',
  'DASHBOARD_TOKEN',
  'DASHBOARD_URL',
  'CLAUDECLAW_CONFIG',
  'CLAUDECLAW_OWNER_NAME',
  'DB_ENCRYPTION_KEY',
  'GOOGLE_API_KEY',
  'AGENT_TIMEOUT_MS',
  'AGENT_IDLE_TIMEOUT_MS',
  'AGENT_MAX_RUNTIME_MS',
  'AGENT_MAX_TURNS',
  'SECURITY_PIN_HASH',
  'IDLE_LOCK_MINUTES',
  'EMERGENCY_KILL_PHRASE',
  'MODEL_FALLBACK_CHAIN',
  'SMART_ROUTING_ENABLED',
  'SMART_ROUTING_CHEAP_MODEL',
  'SHOW_COST_FOOTER',
  'MEMORY_NOTIFY',
  'MEMORY_RECALL_MODE',
  'DAILY_COST_BUDGET',
  'HOURLY_TOKEN_BUDGET',
  'MEMORY_NUDGE_INTERVAL_TURNS',
  'MEMORY_NUDGE_INTERVAL_HOURS',
  'EXFILTRATION_GUARD_ENABLED',
  'PROTECTED_ENV_VARS',
  'WARROOM_ENABLED',
  'WARROOM_PORT',
  'STREAM_STRATEGY',
  'ENABLE_ACP',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'CLAUDECLAW_STORE_DIR',
  'DISPATCH_ALLOW_HIVE_READ',
  'CODEX_DANGER_WRITE',
  'CODEX_TRANSPORT',
  'CODEX_APP_SERVER_MAX_CONCURRENT_TURNS',
]);

// ── Multi-agent support ──────────────────────────────────────────────
// These are mutable and overridden by index.ts when --agent is passed.
export let AGENT_ID = 'main';
export let activeBotToken =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export let agentCwd: string | undefined; // undefined = use PROJECT_ROOT
export let agentDefaultModel: string | undefined; // from agent.yaml
export let agentProvider: ProviderConfig | undefined; // from agent.yaml/main-config
export let agentObsidianConfig: { vault: string; folders: string[]; readOnly?: string[] } | undefined;
export let agentSystemPrompt: string | undefined; // loaded from agents/{id}/CLAUDE.md
export let agentMcpAllowlist: string[] | undefined; // from agent.yaml mcp_servers

export function setAgentOverrides(opts: {
  agentId: string;
  botToken: string;
  cwd: string;
  model?: string;
  provider?: ProviderConfig;
  obsidian?: { vault: string; folders: string[]; readOnly?: string[] };
  systemPrompt?: string;
  mcpServers?: string[];
}): void {
  AGENT_ID = opts.agentId;
  activeBotToken = opts.botToken;
  agentCwd = opts.cwd;
  agentDefaultModel = opts.model;
  agentProvider = opts.provider;
  agentObsidianConfig = opts.obsidian;
  agentSystemPrompt = withCliIndex(opts.systemPrompt);
  agentMcpAllowlist = opts.mcpServers;
}

/** Update just the system prompt (CLAUDE.md content). Used by the
 *  dashboard's agent-files PUT endpoint after editing main's CLAUDE.md
 *  so the next NEW session in the bot picks up the change without
 *  requiring a process restart. Sub-agents don't need this — the SDK
 *  re-reads CLAUDE.md from cwd via settingSources on every turn. */
export function updateAgentSystemPrompt(next: string | undefined): void {
  agentSystemPrompt = withCliIndex(next);
}

/** Update just the active provider for the running process. Dashboard
 * provider changes persist to disk separately; this keeps main hot-switches
 * honest without rebuilding the full agent override object. */
export function updateAgentProvider(next: ProviderConfig | undefined): void {
  agentProvider = next;
  // A provider block supersedes any legacy top-level `model:` loaded at
  // boot — persisting removes it from agent.yaml, so drop the stale
  // in-memory copy too (it outranks provider.model in the query path).
  agentDefaultModel = undefined;
}

export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';

// Only respond to this Telegram chat ID. Set this after getting your ID via /chatid.
export const ALLOWED_CHAT_ID =
  process.env.ALLOWED_CHAT_ID || envConfig.ALLOWED_CHAT_ID || '';

export const WHATSAPP_ENABLED =
  (process.env.WHATSAPP_ENABLED || envConfig.WHATSAPP_ENABLED || '').toLowerCase() === 'true';

export const SLACK_USER_TOKEN =
  process.env.SLACK_USER_TOKEN || envConfig.SLACK_USER_TOKEN || '';

// Voice — read via readEnvFile, not process.env
export const GROQ_API_KEY = envConfig.GROQ_API_KEY ?? '';
export const ELEVENLABS_API_KEY = envConfig.ELEVENLABS_API_KEY ?? '';
export const ELEVENLABS_VOICE_ID = envConfig.ELEVENLABS_VOICE_ID ?? '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PROJECT_ROOT is the claudeclaw/ directory — where CLAUDE.md lives.
// The SDK uses this as cwd, which causes Claude Code to load our CLAUDE.md
// and all global skills from ~/.claude/skills/ via settingSources.
export const PROJECT_ROOT = path.resolve(__dirname, '..');

// STORE_DIR holds the SQLite database, PID locks and avatars. Defaults to
// PROJECT_ROOT/store. Set CLAUDECLAW_STORE_DIR (env or .env) to point at an
// external store directory — e.g. to run several builds against one shared
// database. ~/... is expanded. (expandHome is hoisted, defined just below.)
const rawStoreDir =
  process.env.CLAUDECLAW_STORE_DIR || envConfig.CLAUDECLAW_STORE_DIR || '';
export const STORE_DIR = rawStoreDir
  ? expandHome(rawStoreDir)
  : path.resolve(PROJECT_ROOT, 'store');

// War Room IPC scratch (roster + pin files shared with the Python voice
// stack). Kept repo-relative under store/ — deliberately NOT under STORE_DIR's
// optional CLAUDECLAW_STORE_DIR relocation — so the Node and Python sides
// resolve the exact same absolute path without sharing the relocation logic.
// Replaces the old hardcoded /tmp/, which on Windows resolved to the drive
// root (D:\tmp). Mirrored in warroom/config.py.
export const WARROOM_TMP_DIR = path.resolve(PROJECT_ROOT, 'store', 'tmp');

// ── External config directory ────────────────────────────────────────
// Personal config files (CLAUDE.md, agent.yaml, agent CLAUDE.md) can live
// outside the repo in CLAUDECLAW_CONFIG (default ~/.claudeclaw) so they
// never get committed. The repo ships only .example template files.

/** Expand ~/... to an absolute path. */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve the external config directory *at call time*.
 *
 * Reads process.env.CLAUDECLAW_CONFIG freshly on each call so a caller that
 * chooses a config dir mid-run (e.g. the setup wizard's prompt) can set the
 * env var and have subsequent writes honor it. The exported CLAUDECLAW_CONFIG
 * const below snapshots this at import for the long-running runtime, where the
 * path is fixed before any module loads. Persistence code (see provider.ts)
 * must call this function, not the const, so it never writes to a stale default.
 */
export function getClaudeclawConfig(): string {
  const raw =
    process.env.CLAUDECLAW_CONFIG || envConfig.CLAUDECLAW_CONFIG || '~/.claudeclaw';
  return expandHome(raw);
}

/**
 * Absolute path to the external config directory, snapshotted at import.
 * Defaults to ~/.claudeclaw. Set CLAUDECLAW_CONFIG in .env or environment to override.
 * For writes that may run before the path is finalized, use getClaudeclawConfig().
 */
export const CLAUDECLAW_CONFIG = getClaudeclawConfig();

/** Deterministic owner label for shared surfaces such as War Room transcripts. */
export const CLAUDECLAW_OWNER_NAME =
  (process.env.CLAUDECLAW_OWNER_NAME || envConfig.CLAUDECLAW_OWNER_NAME || 'User').trim() || 'User';

// Telegram limits
export const MAX_MESSAGE_LENGTH = 4096;

// How often to refresh the typing indicator while Claude is thinking (ms).
// Telegram's typing action expires after ~5s, so 4s keeps it continuous.
export const TYPING_REFRESH_MS = 4000;

// Maximum time (ms) an agent query can run before being auto-aborted.
// Safety net for truly stuck commands (e.g. recursive `find /`).
// Default: 15 minutes. Use /stop in Telegram to manually kill a running query.
// Previously 5 min, which caused mid-execution timeouts on bulk API work
// (posting YouTube comments, sending multiple messages) leading to duplicate posts.
export function parseTimeoutMs(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647 milliseconds`);
  }
  return value;
}

export const AGENT_TIMEOUT_MS = parseTimeoutMs(
  'AGENT_TIMEOUT_MS', process.env.AGENT_TIMEOUT_MS || envConfig.AGENT_TIMEOUT_MS || '900000',
);
export const AGENT_IDLE_TIMEOUT_MS = parseTimeoutMs(
  'AGENT_IDLE_TIMEOUT_MS', process.env.AGENT_IDLE_TIMEOUT_MS || envConfig.AGENT_IDLE_TIMEOUT_MS || String(AGENT_TIMEOUT_MS),
);
export const AGENT_MAX_RUNTIME_MS = parseTimeoutMs(
  'AGENT_MAX_RUNTIME_MS', process.env.AGENT_MAX_RUNTIME_MS || envConfig.AGENT_MAX_RUNTIME_MS || '3600000',
);

// Maximum number of agentic turns (tool-use rounds) per query.
// Prevents runaway loops when external services fail (e.g. stale cookies causing
// 40+ sequential Bash retries). 0 = unlimited (SDK default).
// Default: 30 turns, which is generous for complex skills but stops spirals.
export const AGENT_MAX_TURNS = parseInt(
  process.env.AGENT_MAX_TURNS || envConfig.AGENT_MAX_TURNS || '30',
  10,
);

// Fallback context-window limit (tokens). The context gauge and warnings now
// prefer the active model's REAL window as reported by the SDK per turn
// (Opus 4.8 = 1M, Sonnet 4.6 = 200k). This value is only used when the engine
// doesn't report one — e.g. ACP providers, or rows from before the upgrade.
// Override via CONTEXT_LIMIT in .env to change that fallback.
export const CONTEXT_LIMIT = parseInt(
  process.env.CONTEXT_LIMIT || envConfig.CONTEXT_LIMIT || '1000000',
  10,
);

// Dashboard — web UI for monitoring ClaudeClaw state
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || envConfig.DASHBOARD_PORT || '3141',
  10,
);
export const DASHBOARD_BIND =
  process.env.DASHBOARD_BIND || envConfig.DASHBOARD_BIND || '127.0.0.1';
export const DASHBOARD_TOKEN =
  process.env.DASHBOARD_TOKEN || envConfig.DASHBOARD_TOKEN || '';
export const DASHBOARD_URL =
  process.env.DASHBOARD_URL || envConfig.DASHBOARD_URL || '';

// Database encryption key (SQLCipher). Required for encrypted database access.
export const DB_ENCRYPTION_KEY =
  process.env.DB_ENCRYPTION_KEY || envConfig.DB_ENCRYPTION_KEY || '';

// Google API key for Gemini (memory extraction + consolidation)
export const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || envConfig.GOOGLE_API_KEY || '';

// OpenRouter API key — for the native OpenRouter provider engine.
// Get at https://openrouter.ai/keys. ClaudeClaw uses this only when the
// active provider is type: 'openrouter'.
export const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || envConfig.OPENROUTER_API_KEY || '';

// Default OpenRouter model when none is configured/selected. Single source of
// truth shared by the adapter, the dashboard model list, the setup wizard, and
// the Sidebar quick-switch. Override via OPENROUTER_MODEL in .env so a new
// default lands on restart without a code change.
export const DEFAULT_OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || envConfig.OPENROUTER_MODEL || 'z-ai/glm-4.5-air:free';

// OpenAI API key — for the native OpenAI (Codex SDK) provider engine.
// OPTIONAL: the Codex runtime prefers ChatGPT-subscription auth from
// `codex login` (~/.codex/auth.json); set this only for API-key billing.
export const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || envConfig.OPENAI_API_KEY || '';

// Default OpenAI model for the native Codex SDK engine when none is
// configured/selected. Override via OPENAI_MODEL in .env so a new default
// lands on restart without a code change.
export const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_MODEL || envConfig.OPENAI_MODEL || 'gpt-5.5';

// Streaming strategy for progressive Telegram updates. Provider-agnostic: this
// governs streaming for every adapter (Claude, Codex, Gemini, ...), not just one.
//
// 'global-throttle' (default): edits a placeholder message with streamed text and
//   in-progress status, rate-limited to ~24 edits/min per chat to respect Telegram
//   limits. The budget is shared per chat, so text and progress never compete.
// 'off': no streaming, wait for the full response.
//
// A third option, 'single-agent-only', used to be advertised here. It was never
// implemented — the only check anywhere is `!== 'off'`, and no multi-agent
// detection exists in the streaming path — so it behaved identically to
// 'global-throttle'. It is removed rather than left as a promise the code does not
// keep; an existing `.env` still carrying it keeps working (see the normalization
// below) and simply gets the behaviour it always had.
export type StreamStrategy = 'global-throttle' | 'off';
// Normalized rather than cast: the only real axis is on/off, so anything that is
// not an explicit 'off' means on. A cast would let a typo ('of', 'false') silently
// pick a value outside the union and read as valid downstream.
export const STREAM_STRATEGY: StreamStrategy =
  (process.env.STREAM_STRATEGY || envConfig.STREAM_STRATEGY || 'global-throttle').trim() === 'off'
    ? 'off'
    : 'global-throttle';

// ── Security ─────────────────────────────────────────────────────────
// PIN lock: SHA-256 hash of your PIN. Generate: node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PIN').digest('hex'))"
export const SECURITY_PIN_HASH =
  process.env.SECURITY_PIN_HASH || envConfig.SECURITY_PIN_HASH || '';

// Auto-lock after N minutes of inactivity. 0 = disabled. Only active when PIN is set.
export const IDLE_LOCK_MINUTES = parseInt(
  process.env.IDLE_LOCK_MINUTES || envConfig.IDLE_LOCK_MINUTES || '0',
  10,
);

// Emergency kill phrase. Sending this to any bot immediately stops all agents and exits.
export const EMERGENCY_KILL_PHRASE =
  process.env.EMERGENCY_KILL_PHRASE || envConfig.EMERGENCY_KILL_PHRASE || '';

// ── Hermes-inspired enhancements ────────────────────────────────────

// Model fallback chain: comma-separated model IDs. When the primary model
// fails with an overloaded/billing error, try the next model in the chain.
// Example: "claude-sonnet-4-6,claude-haiku-4-5"
export const MODEL_FALLBACK_CHAIN = (
  process.env.MODEL_FALLBACK_CHAIN || envConfig.MODEL_FALLBACK_CHAIN || ''
).split(',').map((s) => s.trim()).filter(Boolean);

// Smart model routing: route simple messages to a cheap model.
// Defaults to false to preserve existing behavior. Opt in via .env.
export const SMART_ROUTING_ENABLED =
  (process.env.SMART_ROUTING_ENABLED || envConfig.SMART_ROUTING_ENABLED || 'false').toLowerCase() === 'true';
export const SMART_ROUTING_CHEAP_MODEL =
  process.env.SMART_ROUTING_CHEAP_MODEL || envConfig.SMART_ROUTING_CHEAP_MODEL || 'claude-haiku-4-5';

// ── Claude model selection ──────────────────────────────────────────
// The /model opus|sonnet|haiku Telegram shortcuts and the fresh-install
// default all resolve through these. Defaults track the current Claude
// lineup; override any of them in .env so a new model release is picked
// up on the next restart WITHOUT a code change or a new release.
// Example: CLAUDE_MODEL_OPUS=claude-opus-4-9
export const CLAUDE_MODEL_OPUS =
  process.env.CLAUDE_MODEL_OPUS || envConfig.CLAUDE_MODEL_OPUS || 'claude-opus-4-8';
export const CLAUDE_MODEL_SONNET =
  process.env.CLAUDE_MODEL_SONNET || envConfig.CLAUDE_MODEL_SONNET || 'claude-sonnet-4-6';
export const CLAUDE_MODEL_HAIKU =
  process.env.CLAUDE_MODEL_HAIKU || envConfig.CLAUDE_MODEL_HAIKU || 'claude-haiku-4-5';
// Default Claude model when no provider/agent model is configured (e.g. fresh installs).
// Falls back to the Opus alias above so it tracks the same single source of truth.
export const DEFAULT_CLAUDE_MODEL =
  process.env.DEFAULT_CLAUDE_MODEL || envConfig.DEFAULT_CLAUDE_MODEL || CLAUDE_MODEL_OPUS;

// Cost footer on every response.
// compact = model only, verbose = model + tokens, cost = model + $, full = everything
export type CostFooterMode = 'off' | 'compact' | 'verbose' | 'cost' | 'full';
export const SHOW_COST_FOOTER: CostFooterMode =
  (process.env.SHOW_COST_FOOTER || envConfig.SHOW_COST_FOOTER || 'compact') as CostFooterMode;

// Memory notifications: send Telegram message when high-importance memories are created.
// Default: 'on'. Set to 'off', 'false', or '0' to disable.
export const MEMORY_NOTIFY: boolean = !['off', 'false', '0'].includes(
  (process.env.MEMORY_NOTIFY || envConfig.MEMORY_NOTIFY || 'on').toLowerCase(),
);

// Memory recall mode SEED for installs upgrading past PR #96 (per-agent isolation).
// PR #96 made recall strictly per-agent ('isolated') for everyone — the right default
// for new installs. An existing multi-agent install that wants the pre-#96 behaviour
// (recall draws from every agent on the chat) can set MEMORY_RECALL_MODE=shared once in
// .env and be done, instead of running a sqlite command after every upgrade.
// This ONLY seeds the default: the live dashboard toggle (/keep-shared, stored in
// dashboard_settings) always wins when it has been set explicitly. Anything other than
// 'shared' (including unset) resolves to 'isolated'.
export const MEMORY_RECALL_MODE_ENV: 'isolated' | 'shared' =
  (process.env.MEMORY_RECALL_MODE || envConfig.MEMORY_RECALL_MODE || '').toLowerCase() === 'shared'
    ? 'shared'
    : 'isolated';

// Daily cost budget in USD. Warns at 80%. Set to 0 to disable (default).
// Only useful for API/pay-per-use users. Subscription users should leave off.
export const DAILY_COST_BUDGET = parseFloat(
  process.env.DAILY_COST_BUDGET || envConfig.DAILY_COST_BUDGET || '0',
);

// Hourly token budget. Warns at 80%. Set to 0 to disable (default).
export const HOURLY_TOKEN_BUDGET = parseInt(
  process.env.HOURLY_TOKEN_BUDGET || envConfig.HOURLY_TOKEN_BUDGET || '0',
  10,
);

// Memory nudge intervals
export const MEMORY_NUDGE_INTERVAL_TURNS = parseInt(
  process.env.MEMORY_NUDGE_INTERVAL_TURNS || envConfig.MEMORY_NUDGE_INTERVAL_TURNS || '10',
  10,
);
export const MEMORY_NUDGE_INTERVAL_HOURS = parseInt(
  process.env.MEMORY_NUDGE_INTERVAL_HOURS || envConfig.MEMORY_NUDGE_INTERVAL_HOURS || '2',
  10,
);

// Secret exfiltration guard
export const EXFILTRATION_GUARD_ENABLED =
  (process.env.EXFILTRATION_GUARD_ENABLED || envConfig.EXFILTRATION_GUARD_ENABLED || 'true').toLowerCase() === 'true';
export const PROTECTED_ENV_VARS = (
  process.env.PROTECTED_ENV_VARS || envConfig.PROTECTED_ENV_VARS ||
  'ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,DB_ENCRYPTION_KEY,TELEGRAM_BOT_TOKEN,SLACK_USER_TOKEN,GROQ_API_KEY,ELEVENLABS_API_KEY,GOOGLE_API_KEY,OPENAI_API_KEY'
).split(',').map((s) => s.trim()).filter(Boolean);

// ── Provider Selection (BETA) ───────────────────────────────────────
// Gates the alternate provider (ACP / OpenCode / Gemini / Codex) UI and
// runtime. When false, the dashboard hides the provider picker and the
// engine forces Claude regardless of what's saved in agent.yaml or
// main-config.json. Existing installs without this var see no change.
// Opt-in for the EXPERIMENTAL provider tier only (the ACP family: acp-codex,
// Gemini, OpenCode, OpenRouter, custom ACP). The STABLE tier — Claude and
// native OpenAI (Codex SDK) — is not gated by this and is always available.
// See src/provider-registry.ts for the single enablement source of truth.
export const ENABLE_ACP =
  (process.env.ENABLE_ACP || envConfig.ENABLE_ACP || 'false').toLowerCase() === 'true';

// ── Dispatch bridge (out-of-process / non-Claude providers) ─────────
// hive_read returns SHARED cross-agent memory; on a non-Claude provider that
// content egresses to the vendor. The out-of-process dispatch bridge
// (dispatch-mcp-server.ts) therefore WITHHOLDS hive_read by default. This is a
// per-deployment data-governance decision, independent of model behavior — flip
// it on to let non-Claude agents read the hive. hive_log and the
// mission/schedule verbs are unaffected (always available on the bridge).
export const DISPATCH_ALLOW_HIVE_READ =
  (process.env.DISPATCH_ALLOW_HIVE_READ || envConfig.DISPATCH_ALLOW_HIVE_READ || 'false').toLowerCase() === 'true';

// ── Codex write access (danger-full-access opt-in) ──────────────────
// On the current native Windows host, Codex exec applies read-only instead of the
// requested `-s workspace-write` ("rejected by user approval settings"), so the
// safe middle sandbox is effectively unavailable there — only read-only or
// danger-full-access are honored. When this is set, a Codex/openai turn that would
// otherwise resolve to workspace-write instead resolves to 'danger-full-access',
// which `-s danger-full-access` DOES honor (verified writing on this host).
// Default OFF: this drops the OS sandbox + network confinement (parity with
// Claude's bypassPermissions posture), so enable ONLY for trusted-operator
// agents, never for untrusted-input/public bots.
export const CODEX_DANGER_WRITE =
  (process.env.CODEX_DANGER_WRITE || envConfig.CODEX_DANGER_WRITE || 'false').toLowerCase() === 'true';

// ── Codex runtime transport (Codex SDK vs App Server) ───────────────
// How the STABLE native `openai` provider reaches the Codex runtime.
// 'sdk' (default) drives `codex exec` once per turn via @openai/codex-sdk.
// 'app-server' keeps ONE warm `codex app-server` child per agent process and
// verifies the effective sandbox/approval policy before every turn — the
// visibility the SDK path cannot provide. The SDK stays the default until the
// App Server path has soaked; it remains the documented rollback after that.
// Unrelated to the experimental `acp-codex` provider, which reaches Codex
// through the codex-acp ACP adapter instead.
export const CODEX_TRANSPORT =
  (process.env.CODEX_TRANSPORT || envConfig.CODEX_TRANSPORT || 'sdk').toLowerCase() === 'app-server'
    ? 'app-server'
    : 'sdk';

// Maximum concurrent native OpenAI turns per agent process. Turns on the SAME
// thread always serialize regardless; this bounds unrelated threads.
export const CODEX_APP_SERVER_MAX_CONCURRENT_TURNS = Math.max(
  1,
  parseInt(process.env.CODEX_APP_SERVER_MAX_CONCURRENT_TURNS || envConfig.CODEX_APP_SERVER_MAX_CONCURRENT_TURNS || '8', 10) || 8,
);

// ── War Room (voice meeting via Pipecat WebSocket) ──────────────────
export const WARROOM_ENABLED =
  (process.env.WARROOM_ENABLED || envConfig.WARROOM_ENABLED || 'false').toLowerCase() === 'true';
export const WARROOM_PORT = parseInt(
  process.env.WARROOM_PORT || envConfig.WARROOM_PORT || '7860',
  10,
);
