import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import yaml from 'js-yaml';

import {
  compatEnvSource,
  compatProviderEnabled,
  getCompatConfig,
  redactSecret,
} from './anthropic-compat-env.js';
import { CODEX_TRANSPORT, STORE_DIR, DEFAULT_CLAUDE_MODEL, getClaudeclawConfig, PROJECT_ROOT } from './config.js';
import { readEnvFile } from './env.js';

/**
 * Provider identities. Two of these reach the same Codex runtime by different
 * routes, so the names say which route:
 *  - `openai`    — STABLE native provider, drives the Codex runtime directly
 *                  (Codex SDK or App Server, per CODEX_TRANSPORT).
 *  - `acp-codex` — EXPERIMENTAL provider, reaches Codex over ACP via the
 *                  bundled `codex-acp` adapter.
 *
 * `anthropic-compatible` is not a fourth route to a runtime — it is the SAME
 * Claude Code subprocess the `claude` provider drives, pointed at a
 * third-party endpoint that speaks the Anthropic wire protocol. It therefore
 * gets the full Claude Code tool surface, which is the entire point: the
 * alternative (OpenRouter) tells the model it has no tools at all. Its
 * endpoint, credential and tool surface are resolved in
 * src/anthropic-compat-env.ts.
 */
export type ProviderType = 'claude' | 'acp' | 'opencode' | 'gemini' | 'acp-codex' | 'openrouter' | 'openai' | 'anthropic-compatible';

const PROVIDER_TYPES: readonly string[] = ['claude', 'acp', 'opencode', 'gemini', 'acp-codex', 'openrouter', 'openai', 'anthropic-compatible'];

/**
 * Legacy provider identifiers → their current name. The Codex-over-ACP provider
 * was spelled `codex` before the native `openai` provider existed; once both
 * shipped the two names read as interchangeable, so the ACP one became
 * `acp-codex`. Configs saved before the rename (agent.yaml provider blocks,
 * store/main-config.json) still carry the old spelling.
 */
const LEGACY_PROVIDER_TYPES: Readonly<Record<string, ProviderType>> = { codex: 'acp-codex' };

/**
 * Canonicalizes a persisted or inbound provider id, migrating legacy spellings
 * forward. Returns undefined for anything unrecognized so callers can apply
 * their own fallback (saved config → DEFAULT_PROVIDER; API request → 400).
 *
 * THE normalization boundary: every read of persisted provider config and every
 * provider id arriving from the dashboard/API passes through here, so nothing
 * downstream — engine factory, registry, model defaults, UI — ever sees `codex`.
 */
export function normalizeProviderType(value: unknown): ProviderType | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.trim().toLowerCase();
  return LEGACY_PROVIDER_TYPES[lower]
    ?? (PROVIDER_TYPES.includes(lower) ? lower as ProviderType : undefined);
}
export type ProviderRuntimeMode = string;
export type ProviderThinkingMode = string;

export interface ProviderConfig {
  type: ProviderType;
  /** Optional model override. ACP providers receive this via session/set_model when supported. */
  model?: string;
  /** Provider-specific latency/depth preference. Claude maps known values to effort; ACP uses exact config values. */
  runtimeMode?: ProviderRuntimeMode;
  /** Provider-specific thinking preference. Claude maps known values to thinking; ACP uses exact config values. */
  thinkingMode?: ProviderThinkingMode;
  /** Generic ACP command. Built-in ACP presets supply their own commands. */
  command?: string;
  args?: string[];
  /**
   * `anthropic-compatible` only: the endpoint this agent talks to, when it is
   * not the built-in default. NOT validated here — validation belongs at the
   * point of use (resolveCompatBaseUrl), which fails the turn closed rather
   * than falling back, because a fallback would send a key meant for one
   * vendor to another. Stored so an agent can be pinned to an endpoint, and
   * ignored entirely by every other provider type.
   */
  baseUrl?: string;
  /**
   * Opt-in flag to skip permission prompts and let the provider auto-execute tools.
   * When unset, defaults asymmetrically: Claude keeps its existing permissive
   * behavior (it has months of demonstrated good judgment on Telegram chat
   * conversational vs. coding intent), while ACP providers (acp-codex/gemini/
   * opencode) default to false so a casual Telegram message can't trigger a
   * coding session.
   * Resolve via effectiveSkipPermissions() rather than reading this directly.
   */
  dangerouslySkipPermissions?: boolean;
}

// DEFAULT_CLAUDE_MODEL is resolved from env/config (see config.ts) so model
// upgrades land via .env + restart, not a code change. Re-exported here to keep
// the historical import path (./provider.js) stable for existing call sites.
export { DEFAULT_CLAUDE_MODEL };
export const DEFAULT_PROVIDER: ProviderConfig = { type: 'claude', model: DEFAULT_CLAUDE_MODEL };
export const DEFAULT_CODEX_MODEL = 'gpt-6-sol';

export function normalizeProviderConfig(input: unknown, legacyModel?: string): ProviderConfig {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const type = normalizeProviderType(raw.type);

  if (type) {
    const cfg: ProviderConfig = { type };
    if (typeof raw.model === 'string' && raw.model.trim()) cfg.model = raw.model.trim();
    if (typeof raw.runtimeMode === 'string' && raw.runtimeMode.trim()) cfg.runtimeMode = raw.runtimeMode.trim();
    if (typeof raw.thinkingMode === 'string' && raw.thinkingMode.trim()) cfg.thinkingMode = raw.thinkingMode.trim();
    if (typeof raw.command === 'string' && raw.command.trim()) cfg.command = raw.command.trim();
    if (Array.isArray(raw.args)) cfg.args = raw.args.filter((v): v is string => typeof v === 'string');
    // Only the provider that has an endpoint may carry one: a `baseUrl` on a
    // Claude or Codex block is meaningless config that would survive a later
    // type switch and quietly become live.
    if (type === 'anthropic-compatible' && typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) {
      cfg.baseUrl = raw.baseUrl.trim();
    }
    if (typeof raw.dangerouslySkipPermissions === 'boolean') cfg.dangerouslySkipPermissions = raw.dangerouslySkipPermissions;
    return cfg;
  }

  if (legacyModel?.startsWith('claude-')) {
    return { type: 'claude', model: legacyModel };
  }

  return { ...DEFAULT_PROVIDER };
}

export function providerToYaml(provider: ProviderConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = { type: provider.type };
  if (provider.model) raw.model = provider.model;
  if (provider.runtimeMode) raw.runtimeMode = provider.runtimeMode;
  if (provider.thinkingMode) raw.thinkingMode = provider.thinkingMode;
  if (provider.type === 'acp') {
    if (provider.command) raw.command = provider.command;
    if (provider.args) raw.args = provider.args;
  }
  if (provider.type === 'anthropic-compatible' && provider.baseUrl) raw.baseUrl = provider.baseUrl;
  if (provider.dangerouslySkipPermissions === true) raw.dangerouslySkipPermissions = true;
  return raw;
}

/**
 * Asymmetric default: Claude keeps full tool access (load-bearing for
 * notify.sh, scheduling, mission tasks, memory queries, Obsidian, file
 * sending). ACP providers (acp-codex/gemini/opencode) start locked down because
 * they have no track record on the conversational Telegram path and have
 * demonstrated a tendency to interpret casual prompts as coding tasks.
 * Set provider.dangerouslySkipPermissions explicitly to override.
 */
export function effectiveSkipPermissions(provider: ProviderConfig): boolean {
  return provider.dangerouslySkipPermissions ?? provider.type === 'claude';
}

function mainConfigPath(): string {
  return path.join(STORE_DIR, 'main-config.json');
}

function readMainConfig(): Record<string, unknown> {
  try {
    const configPath = mainConfigPath();
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeMainConfig(raw: Record<string, unknown>): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(mainConfigPath(), JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

// ── Main provider persistence ─────────────────────────────────────────
// Main persists its provider/model in agents/main/agent.yaml — the SAME
// provider block sub-agents use (setAgentProvider) — so there is one
// persistence story for every agent. Historically main persisted to
// store/main-config.json instead, and the `model:` field in main's
// agent.yaml was dead config that index.ts never read. Reads migrate the
// legacy main-config.json provider into agent.yaml once (creating the
// file if it doesn't exist), then agent.yaml is the single source.

function externalMainAgentYamlPath(): string {
  return path.join(getClaudeclawConfig(), 'agents', 'main', 'agent.yaml');
}

// Reads honor a pre-existing legacy file in PROJECT_ROOT (from installs
// created before this fallback was fixed, or a manually placed file) so
// nothing already-written silently stops being read. Writes never target
// PROJECT_ROOT — see writeMainAgentYaml below.
function mainAgentYamlPath(): string {
  const externalPath = externalMainAgentYamlPath();
  if (fs.existsSync(externalPath)) return externalPath;
  return path.join(PROJECT_ROOT, 'agents', 'main', 'agent.yaml');
}

function readMainAgentYaml(): Record<string, unknown> | undefined {
  try {
    const p = mainAgentYamlPath();
    if (!fs.existsSync(p)) return undefined;
    return (yaml.load(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>) ?? {};
  } catch {
    return undefined;
  }
}

function writeMainAgentYaml(raw: Record<string, unknown>): void {
  // Always target the external config dir, fresh file or not — that's
  // where agent yamls live on a configured install, and it's what keeps
  // this out of the repo/install checkout (agents/*/agent.yaml is
  // gitignored on purpose; see config.ts's CLAUDECLAW_CONFIG comment).
  // A write also migrates any legacy PROJECT_ROOT file forward, since the
  // next read call will find the external file first.
  const p = externalMainAgentYamlPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

// Minimal main agent.yaml written for a truly fresh install. Mirrors what
// step 6b of the setup wizard produces (scripts/setup.ts). Deliberately
// carries NO provider/model block: main's provider defaults are resolved
// from env/config (DEFAULT_CLAUDE_MODEL) until something explicitly sets a
// provider, so baking one here would pin a model and defeat env-driven
// model upgrades.
const MINIMAL_MAIN_AGENT_YAML = [
  '# Main agent configuration',
  'name: Main',
  '',
  '# The main agent uses TELEGRAM_BOT_TOKEN from .env (no override needed).',
  '# telegram_bot_token_env: TELEGRAM_BOT_TOKEN',
  '',
  '# The provider/model are persisted here once set (dashboard picker or',
  '# /model). Until then main uses the env/config default.',
  '',
].join('\n');

/**
 * Idempotently ensure main's external config exists on boot, independent of
 * whether the interactive setup wizard was ever run.
 *
 * The setup wizard's step 6b is the ONLY thing that historically created
 * CLAUDECLAW_CONFIG/agents/main/agent.yaml. Headless/VPS deploys (clone,
 * npm install, hand-written .env, pm2/systemd) skip the wizard, so the file
 * never existed — leaving reads and (pre-#147) writes to fall through to
 * PROJECT_ROOT, the exact virgin state behind the config-poisoning class of
 * bugs (see issue #146/#148). Making the runtime bootstrap its own config
 * removes that coupling: the invariant becomes "the process created the
 * file," not "a human ran the wizard."
 *
 * Ordering preserves #147's self-heal:
 *  - External file already present → nothing to do.
 *  - A legacy PROJECT_ROOT/agents/main/agent.yaml exists (pre-#147 install) →
 *    copy it forward VERBATIM so its provider (if any) and name are
 *    preserved and it stops being the read source. Copying rather than
 *    writing a stub avoids shadowing a legacy provider with an empty file.
 *  - Truly virgin → write the minimal, provider-less template.
 *
 * Safe to call unconditionally on every main-process boot.
 */
export function ensureMainAgentConfig(): void {
  const external = externalMainAgentYamlPath();
  fs.mkdirSync(path.dirname(external), { recursive: true });
  if (fs.existsSync(external)) return;

  const legacyRoot = path.join(PROJECT_ROOT, 'agents', 'main', 'agent.yaml');
  if (fs.existsSync(legacyRoot)) {
    try {
      const raw = fs.readFileSync(legacyRoot, 'utf-8');
      fs.writeFileSync(external, raw, 'utf-8');
      return;
    } catch { /* unreadable legacy file — fall through to the minimal template */ }
  }

  fs.writeFileSync(external, MINIMAL_MAIN_AGENT_YAML, 'utf-8');
}

export function getMainProviderConfig(): ProviderConfig {
  const agentYaml = readMainAgentYaml();

  // agent.yaml provider block wins — it's the unified persistence.
  if (agentYaml && agentYaml.provider !== undefined) {
    return normalizeProviderConfig(agentYaml.provider);
  }

  // Legacy main-config.json provider: migrate it into agent.yaml once so
  // future reads and writes converge on one file. Reads before the first
  // dashboard write also converge here.
  const legacy = readMainConfig();
  if (legacy.provider !== undefined || typeof legacy.model === 'string') {
    const provider = normalizeProviderConfig(legacy.provider, typeof legacy.model === 'string' ? legacy.model : undefined);
    try {
      setMainProviderConfig(provider);
    } catch { /* read-only fs: keep serving the legacy value */ }
    return provider;
  }

  // Legacy dead `model:` field in agent.yaml (never read by index.ts for
  // main historically) — honor it now that agent.yaml is authoritative.
  if (agentYaml && typeof agentYaml.model === 'string' && agentYaml.model.startsWith('claude-')) {
    return { type: 'claude', model: agentYaml.model };
  }

  return { ...DEFAULT_PROVIDER };
}

export function setMainProviderConfig(provider: ProviderConfig): void {
  const raw = readMainAgentYaml() ?? { name: 'Main' };
  if (typeof raw.name !== 'string' || !raw.name) raw.name = 'Main';
  writeProviderToYaml(raw, provider); // sets provider block, removes legacy model:
  writeMainAgentYaml(raw);

  // Clean the superseded provider/model keys out of main-config.json so
  // there's no second, stale copy to confuse anyone. Other keys
  // (description etc.) stay.
  const legacy = readMainConfig();
  if (legacy.provider !== undefined || legacy.model !== undefined) {
    delete legacy.provider;
    delete legacy.model;
    writeMainConfig(legacy);
  }
}

export function getProviderDisplay(provider: ProviderConfig): string {
  const suffix = [
    provider.model,
    provider.runtimeMode,
    provider.thinkingMode && provider.thinkingMode !== 'auto' ? `thinking ${provider.thinkingMode}` : undefined,
  ].filter(Boolean).join(', ');
  if (provider.type === 'claude') return `Claude${suffix ? ` (${suffix})` : ''}`;
  if (provider.type === 'opencode') return `OpenCode${suffix ? ` (${suffix})` : ' (model from OpenCode config)'}`;
  if (provider.type === 'gemini') return `Gemini CLI${suffix ? ` (${suffix})` : ' (ACP)'}`;
  if (provider.type === 'acp-codex') return `Codex${suffix ? ` (${suffix})` : ' (codex-acp adapter)'}`;
  if (provider.type === 'openrouter') return `OpenRouter${suffix ? ` (${suffix})` : ' (no model selected)'}`;
  if (provider.type === 'openai') return `OpenAI${suffix ? ` (${suffix})` : ' (native Codex)'}`;
  if (provider.type === 'anthropic-compatible') {
    // Naming the endpoint is the point of this line: two agents can run the
    // same provider type against different vendors, and "which endpoint is my
    // data going to" must be answerable from the status line alone. No pinned
    // baseUrl means the built-in default — z.ai — so the label names the
    // vendor users configured; a pinned baseUrl replaces it with the host.
    if (provider.baseUrl) {
      return `Anthropic-compatible (${[suffix, provider.baseUrl].filter(Boolean).join(', ')})`;
    }
    return `Z.ai (GLM)${suffix ? ` (${suffix})` : ''}`;
  }
  return `ACP (${provider.command ?? 'custom command'}${provider.args?.length ? ` ${provider.args.join(' ')}` : ''}${suffix ? `; ${suffix}` : ''})`;
}

/**
 * Session-id prefixes `type` answers to on READ, canonical first.
 *
 * Sessions are stored namespaced as `<providerType>:<id>`, so renaming a
 * provider would orphan every thread already saved under its old id. Derived
 * from LEGACY_PROVIDER_TYPES rather than hardcoded, so a future rename gets
 * resumability for free — and, critically, the legacy prefix is offered ONLY to
 * the type that legacy id migrated to: `codex:` resolves for `acp-codex` and for
 * nothing else, so native `openai` can never adopt a Codex-over-ACP thread.
 *
 * Read-only by design. Writes always use the canonical type
 * (`encodeProviderSession`), so legacy prefixes decay as threads roll over.
 */
function acceptedSessionPrefixes(type: ProviderType): string[] {
  const legacy = Object.entries(LEGACY_PROVIDER_TYPES)
    .filter(([, current]) => current === type)
    .map(([old]) => `${old}:`);
  return [`${type}:`, ...legacy];
}

export function sessionBelongsToProvider(sessionId: string | undefined, provider: ProviderConfig): boolean {
  if (!sessionId) return false;
  if (!sessionId.includes(':')) return provider.type === 'claude';
  return acceptedSessionPrefixes(provider.type).some((prefix) => sessionId.startsWith(prefix));
}

export function encodeProviderSession(provider: ProviderConfig, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return `${provider.type}:${sessionId}`;
}

export function decodeProviderSession(provider: ProviderConfig, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  for (const prefix of acceptedSessionPrefixes(provider.type)) {
    if (sessionId.startsWith(prefix)) return sessionId.slice(prefix.length);
  }
  if (!sessionId.includes(':') && provider.type === 'claude') return sessionId;
  return undefined;
}

export function readProviderFromYaml(raw: Record<string, unknown>): ProviderConfig {
  const legacyModel = typeof raw.model === 'string' ? raw.model : undefined;
  return normalizeProviderConfig(raw.provider, legacyModel);
}

export function writeProviderToYaml(raw: Record<string, unknown>, provider: ProviderConfig): Record<string, unknown> {
  raw.provider = providerToYaml(provider);
  delete raw.model;
  return raw;
}

export function parseYamlProvider(filePath: string): ProviderConfig {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return readProviderFromYaml(raw);
}

export interface ProviderAvailability {
  ok: boolean;
  /** Human-readable description of the problem. Present when ok is false. */
  error?: string;
  /** Shell command the user can copy-paste to install the missing CLI. */
  installCommand?: string;
  /** What to do after installing (e.g. authenticate). */
  setupHint?: string;
  /** Upstream documentation URL for further reading. */
  docsUrl?: string;
}

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(lookup, [command], { stdio: 'pipe', windowsHide: true }).status === 0;
}

/**
 * Checks whether the CLI required by the given provider is on PATH for the
 * ClaudeClaw service. Returns structured availability info so callers (wizard,
 * dashboard preflight, status command) can show actionable install hints
 * instead of generic spawn ENOENT errors.
 *
 * Authentication is intentionally not checked here — providers manage their
 * own credentials and a CLI that is installed but unauthenticated is still
 * "available". Auth failures surface later with provider-specific messages
 * from src/errors.ts.
 */
export function checkProviderAvailability(provider: ProviderConfig): ProviderAvailability {
  switch (provider.type) {
    case 'claude': {
      // The claude-agent-sdk bundles its own Claude Code runtime and resolves it
      // internally — it does NOT require a standalone `claude` binary on PATH.
      // Daemon deployments (launchd/systemd/docker) typically run with a minimal
      // PATH that does not include the dir where a globally-installed CLI lives,
      // so gating the claude provider on `which claude` produced false
      // "Claude Code CLI not found on PATH" 400s when switching providers from
      // the dashboard — even though agent turns run fine. Treat the claude
      // provider as available whenever the SDK package resolves; fall back to the
      // PATH check (and its install hint) only when the SDK itself is absent.
      try {
        createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
        return { ok: true };
      } catch { /* SDK not resolvable — fall through to the PATH-based check */ }
      if (!commandExists('claude')) {
        return {
          ok: false,
          error: 'Claude Code SDK not installed and `claude` CLI not found on PATH.',
          installCommand: 'npm install',
          setupHint: 'Run `npm install` to pull the bundled claude-agent-sdk, then `claude login` (free/Pro/Max) or set ANTHROPIC_API_KEY in .env for pay-per-token billing.',
          docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
        };
      }
      return { ok: true };
    }
    case 'opencode':
      if (!commandExists('opencode')) {
        return {
          ok: false,
          error: 'OpenCode CLI not found on PATH.',
          installCommand: 'npm install -g opencode-ai',
          setupHint: 'Run `opencode auth login` to add provider credentials (OpenAI, Anthropic, GLM, Qwen, DeepSeek, etc.).',
          docsUrl: 'https://opencode.ai/docs',
        };
      }
      return { ok: true };
    case 'gemini':
      if (!commandExists('gemini')) {
        return {
          ok: false,
          error: 'Gemini CLI not found on PATH.',
          installCommand: 'npm install -g @google/gemini-cli',
          setupHint: 'Run `gemini` once after install to authenticate with your Google account.',
          docsUrl: 'https://github.com/google-gemini/gemini-cli',
        };
      }
      return { ok: true };
    case 'acp-codex':
      if (!commandExists('codex')) {
        return {
          ok: false,
          error: 'Codex CLI not found on PATH (required by the bundled codex-acp adapter).',
          installCommand: 'npm install -g @openai/codex',
          setupHint: 'Run `codex` once after install to authenticate with your OpenAI account.',
          docsUrl: 'https://github.com/openai/codex',
        };
      }
      return { ok: true };
    case 'acp': {
      if (!provider.command?.trim()) {
        return { ok: false, error: 'Custom ACP provider requires a command.' };
      }
      if (!commandExists(provider.command)) {
        return {
          ok: false,
          error: `Custom ACP command "${provider.command}" not found on PATH.`,
          setupHint: 'Install and authenticate the provider, then make sure the command is on PATH for the ClaudeClaw service. Restart with `pm2 restart claudeclaw --update-env` to refresh PATH if you just installed it.',
        };
      }
      return { ok: true };
    }
    case 'openai': {
      // Native Codex provider. App Server is the contained opt-in while its Windows
      // cancellation gate remains open; the SDK stays installed as the default rollback.
      // Auth comes from either
      // `codex login` state (~/.codex/auth.json, ChatGPT subscription) or an
      // OPENAI_API_KEY for API billing.
      const req = createRequire(import.meta.url);
      const transportPackage = CODEX_TRANSPORT === 'app-server' ? '@openai/codex' : '@openai/codex-sdk';
      const transportResolutionTarget = CODEX_TRANSPORT === 'app-server'
        ? '@openai/codex/package.json'
        : '@openai/codex-sdk';
      const runtimeMissing = {
        ok: false as const,
        error: `${transportPackage} is not installed.`,
        installCommand: 'npm install',
        setupHint: 'Run `npm install` to restore the pinned Codex runtime, then authenticate with `codex login` or set OPENAI_API_KEY in .env.',
        docsUrl: 'https://github.com/openai/codex',
      };
      try {
        req.resolve(transportResolutionTarget);
      } catch (err) {
        // The SDK is ESM-only (no `require` condition in its exports map), so
        // require.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED even when the
        // package IS installed — the exports map was found and parsed, which
        // is proof of presence. Only a genuine module-not-found is a failure.
        if ((err as NodeJS.ErrnoException)?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') return runtimeMissing;
      }
      // The JS SDK is a thin wrapper around a platform-specific native binary
      // shipped as an OPTIONAL dependency (@openai/codex-<platform>-<arch>). If
      // optional deps were skipped or the arch is unsupported, the SDK resolves
      // but every turn fails with "unable to locate binaries". Preflight the
      // platform package so setup rejects OpenAI now rather than at first turn.
      const platformPkgs: Record<string, string> = {
        'win32-x64': '@openai/codex-win32-x64', 'win32-arm64': '@openai/codex-win32-arm64',
        'darwin-x64': '@openai/codex-darwin-x64', 'darwin-arm64': '@openai/codex-darwin-arm64',
        'linux-x64': '@openai/codex-linux-x64', 'linux-arm64': '@openai/codex-linux-arm64',
      };
      const platformPkg = platformPkgs[`${process.platform}-${process.arch}`];
      if (!platformPkg) {
        return {
          ok: false,
          error: `The native Codex runtime does not ship a binary for this platform/architecture (${process.platform}/${process.arch}).`,
          setupHint: 'Use the Claude provider on this host, or run ClaudeClaw on a supported platform (win32/darwin/linux on x64/arm64).',
          docsUrl: 'https://github.com/openai/codex',
        };
      }
      try {
        req.resolve(`${platformPkg}/package.json`);
      } catch {
        return {
          ok: false,
          error: `The native Codex runtime for this platform (${platformPkg}) is not installed.`,
          installCommand: 'npm install --include=optional',
          setupHint: 'Reinstall dependencies including optional packages so the platform-specific Codex binary is present.',
          docsUrl: 'https://github.com/openai/codex',
        };
      }
      const transportHint = CODEX_TRANSPORT === 'app-server'
        ? 'Transport: App Server; effective sandbox and approval policy are verified before every turn.'
        : 'Transport: SDK rollback; effective sandbox policy is not observable.';
      const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
      if (CODEX_TRANSPORT === 'app-server' && process.platform === 'win32') {
        // Setup is approved in the operator home, then mirrored into ClaudeClaw's
        // isolated home at launch. The service itself may inherit that isolated
        // CODEX_HOME, so never use it as proof of operator setup here.
        const sandboxSourceHome = path.join(os.homedir(), '.codex');
        const marker = path.join(sandboxSourceHome, '.sandbox', 'setup_marker.json');
        const users = path.join(sandboxSourceHome, '.sandbox-secrets', 'sandbox_users.json');
        if (!fs.existsSync(marker) || !fs.existsSync(users)) {
          return {
            ok: false,
            error: 'The elevated Codex Windows sandbox is not configured.',
            setupHint: 'Run `codex` once from an elevated terminal, complete Windows sandbox setup, then restart ClaudeClaw.',
            docsUrl: 'https://developers.openai.com/codex/windows',
          };
        }
      }
      // An API key is definitive (must be a non-empty string).
      const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
      if (nonEmpty(process.env.OPENAI_API_KEY)) return { ok: true, setupHint: transportHint };
      if (nonEmpty(readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY)) return { ok: true, setupHint: transportHint };
      // Otherwise require a parseable auth.json with a genuinely non-empty
      // token — a bare {}, {"tokens":{}}, or empty-string field must NOT read as
      // authenticated (the turn would then fail at call time). We don't shell
      // out to `codex login status` here: preflight must stay fast and
      // non-blocking, and a stale-but-present token still surfaces an actionable
      // auth error at call time via the adapter.
      const authPath = path.join(codexHome, 'auth.json');
      if (fs.existsSync(authPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
          const tokens = (raw.tokens && typeof raw.tokens === 'object') ? raw.tokens as Record<string, unknown> : undefined;
          const hasApiKey = nonEmpty(raw.OPENAI_API_KEY);
          const hasChatgptToken = !!tokens && (nonEmpty(tokens.access_token) || nonEmpty(tokens.id_token) || nonEmpty(tokens.refresh_token));
          const hasTopLevelToken = nonEmpty(raw.access_token) || nonEmpty(raw.id_token) || nonEmpty(raw.refresh_token);
          if (hasApiKey || hasChatgptToken || hasTopLevelToken) return { ok: true, setupHint: transportHint };
        } catch { /* unreadable/malformed → treat as unauthenticated */ }
      }
      return {
        ok: false,
        error: 'Codex is not authenticated (no valid ~/.codex/auth.json) and OPENAI_API_KEY is not set.',
        installCommand: 'npm install -g @openai/codex',
        setupHint: 'Run `codex login` to sign in with your ChatGPT account (recommended), or add OPENAI_API_KEY=sk-... to .env and restart with `pm2 restart claudeclaw --update-env`.',
        docsUrl: 'https://github.com/openai/codex/blob/main/docs/authentication.md',
      };
    }
    case 'anthropic-compatible': {
      // Resolves the SAME frozen instance the turn will use, so preflight can
      // never validate one endpoint while the turn talks to another. Both the
      // credential and the endpoint are checked here; both fail closed.
      try {
        const cfg = getCompatConfig(provider.baseUrl);
        if (!compatProviderEnabled()) {
          return {
            ok: false,
            error: 'The anthropic-compatible provider is switched off (ANTHROPIC_COMPAT_ENABLED=false).',
            setupHint: 'Remove ANTHROPIC_COMPAT_ENABLED from .env, or set it to true, to accept turns again.',
          };
        }
        return { ok: true, setupHint: `Endpoint: ${cfg.baseUrl}` };
      } catch (err) {
        return {
          ok: false,
          // The message is authored in anthropic-compat-env.ts and never
          // contains the credential; redactSecret is belt-and-braces for a
          // future message that interpolates something unexpected.
          error: redactSecret(err instanceof Error ? err.message : String(err), [
            compatEnvSource().ANTHROPIC_COMPAT_API_KEY,
            compatEnvSource().ZAI_API_KEY,
            compatEnvSource().GLM_API_KEY,
          ]),
          setupHint: 'Open Provider Setup to configure Z.ai, or set ZAI_API_KEY in .env and restart the service. Existing ANTHROPIC_COMPAT_API_KEY remains supported; use only one key name.',
          docsUrl: 'https://docs.claude.com/en/docs/claude-code/llm-gateway',
        };
      }
    }
    case 'openrouter': {
      // OpenRouter has no CLI — just check the env var is present.
      // Read directly from process.env first (set by PM2 --update-env) with a
      // fallback to the .env file via readEnvFile (same quote/comment handling
      // used everywhere else) so the dashboard preflight matches runtime.
      const fromProcess = process.env.OPENROUTER_API_KEY?.trim();
      if (fromProcess) return { ok: true };
      if (readEnvFile(['OPENROUTER_API_KEY']).OPENROUTER_API_KEY) return { ok: true };
      return {
        ok: false,
        error: 'OPENROUTER_API_KEY is not set.',
        setupHint: 'Open Provider Setup to save your OpenRouter key, or set OPENROUTER_API_KEY in the server configuration. Get a key from https://openrouter.ai/keys.',
        docsUrl: 'https://openrouter.ai/docs',
      };
    }
    default:
      return { ok: true };
  }
}
