import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { CLAUDECLAW_CONFIG, PROJECT_ROOT, STORE_DIR, WARROOM_TMP_DIR } from './config.js';
import { readEnvFile } from './env.js';
import {
  ProviderConfig,
  readProviderFromYaml,
  writeProviderToYaml,
} from './provider.js';

export const DEFAULT_MAIN_DESCRIPTION = 'Primary ClaudeClaw bot';

/** Capitalize first letter of a string. Used as fallback display name. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve display name for an agent. Reads from agent.yaml `name` field,
 * falls back to capitalized id (e.g. "main" -> "Main"). Never throws.
 */
export function resolveAgentDisplayName(agentId: string): string {
  try {
    const cfg = loadAgentConfig(agentId);
    return cfg.name || capitalize(agentId);
  } catch {
    return capitalize(agentId);
  }
}

function mainConfigPath(): string {
  return path.join(STORE_DIR, 'main-config.json');
}

// Shared roster path. Written by Node on startup and any time the agent
// roster changes (new agent, deleted agent). Read by the Python Pipecat
// voice stack so new agents propagate into voice War Room without a
// full bot restart.
export const WARROOM_ROSTER_PATH = path.join(WARROOM_TMP_DIR, 'warroom-agents.json');

/** Single source of truth for "is this string a syntactically valid
 *  agent id?". Lifted out of the various inline copies in the dashboard
 *  HTTP layer so the avatar / chat / agent-files handlers all share one
 *  definition. Lower-case alphanumerics plus `_` and `-`; `i` flag is
 *  kept for backwards compatibility with the historical regex. */
export const AGENT_ID_RE = /^[a-z0-9_-]+$/i;

/** Cheap "does this agent exist on disk?" check. `main` always exists
 *  (it's the root process); any other id needs an `agent.yaml` next to
 *  resolveAgentDir(id). Returns false for syntactically invalid ids so
 *  callers can use this as the only existence check they need. */
export function agentExists(agentId: string): boolean {
  if (!AGENT_ID_RE.test(agentId)) return false;
  if (agentId === 'main') return true;
  try {
    const dir = resolveAgentDir(agentId);
    return fs.existsSync(path.join(dir, 'agent.yaml'));
  } catch {
    return false;
  }
}

export type AgentRuntimeMode = 'messenger' | 'headless';
export type AgentLifecycleMode = 'persistent' | 'task-scoped';

export interface AgentConfig {
  name: string;
  description: string;
  botTokenEnv: string;
  botToken: string;
  /** Process surface for this agent. Headless workers run the scheduler and
   *  mission queue without creating a Telegram/Signal transport. */
  runtimeMode: AgentRuntimeMode;
  /** Durable identity policy for headless workers. Persistent workers remain
   *  available until explicitly stopped. Task-scoped workers drain after
   *  their first unit of work and deactivate once no related work remains.
   *  Existing configs default to persistent. */
  lifecycleMode: AgentLifecycleMode;
  /** When false, the agent runs automation-only: it never polls Telegram
   *  for incoming updates (no getUpdates), only sending outbound messages
   *  (scheduler results, alerts). Lets a non-interactive agent share one
   *  bot token with an interactive agent without a getUpdates 409 conflict.
   *  Defaults to true (full interactive polling). */
  interactive: boolean;
  /** Append-only list of prior display names retained across renames, so
   *  historical references keep resolving to this canonical id (see
   *  resolveAgentId). Empty when the agent has never been renamed. */
  aliases: string[];
  model?: string;
  provider: ProviderConfig;
  mcpServers?: string[];
  /** Per-agent war-room tool allowlist. Tokens are SDK tool names
   *  ("Bash", "Write") or "mcp:<name>" entries to opt an MCP server in.
   *  Overrides the defaults in warroom-tool-policy.ts. Unset = use
   *  defaults. */
  warroomTools?: string[];
  obsidian?: {
    vault: string;
    folders: string[];
    readOnly?: string[];
  };
  /** Pika voice id used when this agent joins a video meeting. Falls back
   *  to the Pika preset English_radiant_girl if unset. */
  meetVoiceId?: string;
  /** Display name shown in the meeting ("Your Agent wants to join"). Falls
   *  back to the agent's name or id with first letter capitalized. */
  meetBotName?: string;
}

/**
 * Resolve the directory for a given agent, checking CLAUDECLAW_CONFIG first,
 * then falling back to PROJECT_ROOT/agents/<id>.
 */
export function resolveAgentDir(agentId: string): string {
  const externalDir = path.join(CLAUDECLAW_CONFIG, 'agents', agentId);
  if (fs.existsSync(path.join(externalDir, 'agent.yaml'))) {
    return externalDir;
  }
  return path.join(PROJECT_ROOT, 'agents', agentId);
}

export function resolveInstructionMd(dir: string): string | null {
  const claudePath = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(claudePath)) return claudePath;
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) return agentsPath;
  return null;
}

export function ensureAgentsMdSymlink(dir: string): boolean {
  const claudePath = path.join(dir, 'CLAUDE.md');
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(claudePath) || fs.existsSync(agentsPath)) return false;

  try {
    // Primary: a relative symlink so AGENTS.md always tracks CLAUDE.md and can
    // never drift out of sync.
    fs.symlinkSync('CLAUDE.md', agentsPath);
    return true;
  } catch {
    // Fallback: on platforms/accounts that can't create symlinks (notably
    // stock Windows without Developer Mode, where symlinkSync throws EPERM),
    // write a real copy so Codex/ACP loaders that read AGENTS.md by name still
    // get the instructions instead of nothing.
    try {
      fs.copyFileSync(claudePath, agentsPath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Resolve the instruction file path for a given agent, checking CLAUDECLAW_CONFIG
 * first, then falling back to PROJECT_ROOT/agents/<id>. CLAUDE.md remains the
 * canonical file for ClaudeClaw, while AGENTS.md is accepted for Codex-style
 * instruction loaders or symlinked setups.
 */
export function resolveAgentClaudeMd(agentId: string): string | null {
  return resolveInstructionMd(path.join(CLAUDECLAW_CONFIG, 'agents', agentId))
    ?? resolveInstructionMd(path.join(PROJECT_ROOT, 'agents', agentId));
}

export function loadAgentConfig(agentId: string): AgentConfig {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent config not found: ${configPath}`);
  }

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

  const name = raw['name'] as string;
  const description = (raw['description'] as string) ?? '';
  const runtimeRaw = raw['runtime'] as Record<string, unknown> | undefined;
  const configuredRuntimeMode = runtimeRaw?.['mode'];
  if (configuredRuntimeMode !== undefined && configuredRuntimeMode !== 'messenger' && configuredRuntimeMode !== 'headless') {
    throw new Error(`Agent config ${configPath} has invalid runtime.mode '${String(configuredRuntimeMode)}'`);
  }
  const runtimeMode: AgentRuntimeMode = configuredRuntimeMode === 'headless' ? 'headless' : 'messenger';
  const lifecycleRaw = raw['lifecycle'] as Record<string, unknown> | undefined;
  const configuredLifecycleMode = lifecycleRaw?.['mode'];
  if (configuredLifecycleMode !== undefined && configuredLifecycleMode !== 'persistent' && configuredLifecycleMode !== 'task-scoped') {
    throw new Error(`Agent config ${configPath} has invalid lifecycle.mode '${String(configuredLifecycleMode)}'`);
  }
  const lifecycleMode: AgentLifecycleMode = configuredLifecycleMode === 'task-scoped' ? 'task-scoped' : 'persistent';
  if (runtimeMode !== 'headless' && lifecycleMode === 'task-scoped') {
    throw new Error(`Agent config ${configPath} can use lifecycle.mode 'task-scoped' only with runtime.mode 'headless'`);
  }
  const botTokenEnv = (raw['telegram_bot_token_env'] as string) || (agentId === 'main' ? 'TELEGRAM_BOT_TOKEN' : '');
  const model = raw['model'] as string | undefined;
  // interactive defaults to true; set `interactive: false` for automation-only
  // agents that must not poll Telegram (e.g. a scheduler agent sharing a token).
  const interactive = raw['interactive'] === false ? false : true;
  const provider = readProviderFromYaml(raw);

  if (!name) {
    throw new Error(`Agent config ${configPath} must have 'name'`);
  }

  // Transport preflight owns credential requirements. Config is also loaded by
  // non-Telegram transports and by agent listing/delegation consumers.
  let botToken = '';
  if (botTokenEnv) {
    const env = readEnvFile([botTokenEnv]);
    botToken = process.env[botTokenEnv] || env[botTokenEnv] || '';
  }

  let obsidian: AgentConfig['obsidian'];
  const obsRaw = raw['obsidian'] as Record<string, unknown> | undefined;
  if (obsRaw) {
    const vault = obsRaw['vault'] as string;
    if (vault && !fs.existsSync(vault)) {
      // eslint-disable-next-line no-console
      console.warn(`[${agentId}] WARNING: Obsidian vault path does not exist: ${vault}`);
      console.warn(`[${agentId}] Update obsidian.vault in agent.yaml to your local vault path.`);
    }
    obsidian = {
      vault,
      folders: (obsRaw['folders'] as string[]) ?? [],
      readOnly: (obsRaw['read_only'] as string[]) ?? [],
    };
  }

  const mcpServers = raw['mcp_servers'] as string[] | undefined;
  // War-room tool policy override. If present in agent.yaml, this list
  // overrides the per-agent default in warroom-tool-policy.ts. Tokens
  // can be SDK tool names ("Bash", "Write") or "mcp:<name>" to opt that
  // MCP server into the war-room session.
  const warroomTools = raw['warroom_tools'] as string[] | undefined;
  const meetVoiceId = typeof raw['meet_voice_id'] === 'string' ? (raw['meet_voice_id'] as string) : undefined;
  const meetBotName = typeof raw['meet_bot_name'] === 'string' ? (raw['meet_bot_name'] as string) : undefined;
  const aliases = Array.isArray(raw['aliases'])
    ? (raw['aliases'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  return {
    name,
    description,
    botTokenEnv,
    botToken,
    runtimeMode,
    lifecycleMode,
    interactive,
    aliases,
    model,
    provider,
    mcpServers,
    warroomTools,
    obsidian,
    meetVoiceId,
    meetBotName,
  };
}

/** Update the model field in an agent's agent.yaml file. */
export function setAgentModel(agentId: string, model: string): void {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  raw['model'] = model;
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

/** Update the provider field in an agent's agent.yaml file. */
export function setAgentProvider(agentId: string, provider: ProviderConfig): void {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  writeProviderToYaml(raw, provider);
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

/** Update the description field in an agent's agent.yaml file. */
export function setAgentDescription(agentId: string, description: string): void {
  const trimmed = description.trim();
  if (!trimmed) throw new Error('description cannot be empty');

  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  raw['description'] = trimmed;
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

/**
 * Load the description for the main bot (persisted, editable). `main` is
 * normalized to the standard per-agent shape, so its description lives in
 * agents/main/agent.yaml like every other agent. Falls back to the legacy
 * store/main-config.json (pre-backfill installs), then the hardcoded default.
 */
export function getMainDescription(): string {
  try {
    const cfg = loadAgentConfig('main');
    if (cfg.description && cfg.description.trim()) return cfg.description.trim();
  } catch {
    // No / broken agents/main/agent.yaml — fall through to the legacy path.
  }
  const configPath = mainConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { description?: string };
      const desc = (raw.description ?? '').trim();
      if (desc) return desc;
    }
  } catch {
    // Corrupt legacy json — ignore.
  }
  return DEFAULT_MAIN_DESCRIPTION;
}

/**
 * Persist a description for the main bot. Writes agents/main/agent.yaml (the
 * normalized location) when it exists so it is the single source of truth;
 * falls back to the legacy store/main-config.json only on a pre-backfill
 * install that has no main agent.yaml yet.
 */
export function setMainDescription(description: string): void {
  const trimmed = description.trim();
  if (!trimmed) throw new Error('description cannot be empty');

  const yamlPath = path.join(resolveAgentDir('main'), 'agent.yaml');
  if (fs.existsSync(yamlPath)) {
    setAgentDescription('main', trimmed);
    return;
  }

  // Legacy fallback: no main agent.yaml yet (backfill hasn't run).
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  const configPath = mainConfigPath();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>; } catch { raw = {}; }
  }
  raw['description'] = trimmed;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}
/**
 * The PID file a running agent writes, and that status checks read back.
 *
 * `main` is the root ClaudeClaw process rather than a spawned child, so it has
 * always used store/claudeclaw.pid while sub-agents use store/agent-<id>.pid.
 * Both halves of that rule live here on purpose: while the writer (messenger)
 * and the readers each spelled it out for themselves, only the writer knew
 * about main, and every reader looked for an agent-main.pid nothing creates.
 */
export function agentPidFile(agentId: string): string {
  return path.join(STORE_DIR, agentId === 'main' ? 'claudeclaw.pid' : `agent-${agentId}.pid`);
}

/** List all configured agent IDs (directories under agents/ with agent.yaml).
 *  Scans both CLAUDECLAW_CONFIG/agents/ and PROJECT_ROOT/agents/, deduplicating.
 */
export function listAgentIds(): string[] {
  const ids = new Set<string>();

  for (const baseDir of [
    path.join(CLAUDECLAW_CONFIG, 'agents'),
    path.join(PROJECT_ROOT, 'agents'),
  ]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const d of fs.readdirSync(baseDir)) {
      if (d.startsWith('_')) continue;
      const yamlPath = path.join(baseDir, d, 'agent.yaml');
      if (fs.existsSync(yamlPath)) ids.add(d);
    }
  }

  return [...ids];
}

/**
 * Read the append-only alias list for an agent from its `agent.yaml`.
 * Aliases are prior display names retained on rename so historical references
 * (`--agent naomi` after Naomi→Nova) keep resolving to the same canonical id.
 * Returns [] when the agent has no aliases, no yaml, or an unreadable/malformed
 * yaml — never throws.
 */
export function getAgentAliases(agentId: string): string[] {
  try {
    const configPath = path.join(resolveAgentDir(agentId), 'agent.yaml');
    if (!fs.existsSync(configPath)) return [];
    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown> | null;
    const aliases = raw?.['aliases'];
    if (!Array.isArray(aliases)) return [];
    return aliases.filter((a): a is string => typeof a === 'string');
  } catch {
    return [];
  }
}

/**
 * Resolve any user- or agent-supplied agent reference to its canonical id.
 *
 * Agents are LLMs that only ever see display names, so a reference by the name
 * an agent sees (`--agent holden` when the canonical id is `main`) must map back
 * to the id every routing/write path actually stores — otherwise the row
 * dead-letters (no poller's `WHERE assigned_agent = ?` ever matches). This is
 * that single display-name → id resolver.
 *
 * Accepts a canonical id, a current display name, or a historical alias, in that
 * precedence order (id > name > alias). Case- and whitespace-insensitive.
 *
 * Returns null for unknown / empty / non-string input; **never throws** — callers
 * decide how to handle a miss (CLI errors and exits, dashboard returns 4xx,
 * internal callers fall back to prior behavior). Reads the same `agent.yaml`
 * source `agentExists` / `resolveAgentDisplayName` already use: no new registry
 * table, no second source of truth.
 */
export function resolveAgentId(input: string): string | null {
  if (typeof input !== 'string') return null;
  const norm = input.trim().toLowerCase();
  if (!norm) return null;

  // Canonical id set. `main` always counts as a valid id even before its
  // agent.yaml has been backfilled (agentExists('main') is likewise always
  // true), so a legacy install still routes to it.
  const ids = new Set(listAgentIds());
  ids.add('main');

  // 1. canonical id — checked across all agents before any name, so the
  //    documented id > name > alias precedence holds even if a display name or
  //    alias were to collide with another agent's id.
  if (ids.has(norm)) return norm;

  // 2. current display name
  for (const id of ids) {
    if (resolveAgentDisplayName(id).toLowerCase() === norm) return id;
  }

  // 3. historical alias
  for (const id of ids) {
    for (const alias of getAgentAliases(id)) {
      if (alias.trim().toLowerCase() === norm) return id;
    }
  }

  return null;
}

/**
 * The known canonical agent ids, `main` first then the rest sorted. Used to
 * build self-diagnosing "unknown agent" errors (`known: main, amos, naomi, …`)
 * across the CLIs and dashboard so a bad `--agent` names its alternatives
 * instead of failing silently.
 */
export function knownAgentIds(): string[] {
  const ids = new Set(listAgentIds());
  ids.add('main');
  const rest = [...ids].filter((id) => id !== 'main').sort();
  return ['main', ...rest];
}

/** What an identity value collided with: the owning agent + which namespace. */
export interface AgentIdentityCollision {
  agentId: string;
  kind: 'id' | 'name' | 'alias';
  value: string;
}

/**
 * Does a proposed identity value (a new id, display name, or alias) collide,
 * case-insensitively, with any existing agent's canonical id, display name, or
 * alias? Returns the collision (owning agent + namespace + matched value) or
 * null if the value is free.
 *
 * This backs the create-time / rename uniqueness guard: keeping the id, name,
 * and alias namespaces from ever overlapping means resolveAgentId's
 * id > name > alias precedence is only ever a belt-and-suspenders tiebreak, not
 * a load-bearing rule. Pass `ignoreAgentId` to exclude the agent being renamed
 * (so keeping its own name is not treated as a self-collision).
 */
export function findAgentIdentityCollision(
  value: string,
  opts: { ignoreAgentId?: string } = {},
): AgentIdentityCollision | null {
  const norm = value.trim().toLowerCase();
  if (!norm) return null;

  const ids = new Set(listAgentIds());
  ids.add('main');

  for (const id of ids) {
    if (opts.ignoreAgentId && id === opts.ignoreAgentId) continue;
    if (id.toLowerCase() === norm) return { agentId: id, kind: 'id', value: id };
    const name = resolveAgentDisplayName(id);
    if (name.toLowerCase() === norm) return { agentId: id, kind: 'name', value: name };
    for (const alias of getAgentAliases(id)) {
      if (alias.trim().toLowerCase() === norm) return { agentId: id, kind: 'alias', value: alias };
    }
  }

  return null;
}

/**
 * Resolve which agent is the primary (the one that owns user-facing,
 * install-wide notifications so they aren't sent N times by N agents).
 *
 * Resolution order:
 *   1. The agent whose agent.yaml has `primary: true`.
 *   2. 'main', if it exists (legacy default).
 *   3. The first agent id, sorted, as a deterministic fallback.
 *
 * Returns null only when no agents are configured at all.
 */
export function resolvePrimaryAgentId(): string | null {
  const ids = listAgentIds();
  if (ids.length === 0) return null;

  for (const id of ids) {
    try {
      const configPath = path.join(resolveAgentDir(id), 'agent.yaml');
      if (!fs.existsSync(configPath)) continue;
      const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (raw && raw['primary'] === true) return id;
    } catch {
      // Unreadable yaml — skip, fall through to the defaults below.
    }
  }

  if (ids.includes('main')) return 'main';
  return [...ids].sort()[0];
}

/** Return the capabilities (name + description) for a specific agent. */
export function getAgentCapabilities(
  agentId: string,
): { name: string; description: string } | null {
  try {
    const config = loadAgentConfig(agentId);
    return { name: config.name, description: config.description };
  } catch {
    return null;
  }
}

/**
 * List all configured agents with their descriptions.
 * Unlike `listAgentIds()`, this returns richer metadata and silently
 * skips agents whose config fails to load (e.g. missing token).
 */
export function listAllAgents(): Array<{
  id: string;
  name: string;
  description: string;
  model?: string;
  provider: ProviderConfig;
}> {
  const ids = listAgentIds();
  const result: Array<{
    id: string;
    name: string;
    description: string;
    model?: string;
    provider: ProviderConfig;
  }> = [];

  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      result.push({
        id,
        name: config.name,
        description: config.description,
        model: config.model,
        provider: config.provider,
      });
    } catch {
      // Skip agents with broken config
    }
  }

  return result;
}

/**
 * Write the current agent roster to the path the Python Pipecat voice
 * stack reads from. Call this:
 *   - On main-bot startup (index.ts does this already)
 *   - After creating or deleting an agent (agent-create flow)
 *   - Before /warroom/text turns (orchestrator does this cheaply too)
 *
 * The file is read-only metadata: id, name, description. The voice
 * server kills + respawns its subprocess when this changes if callers
 * want the new roster to take effect immediately.
 */
export function refreshWarRoomRoster(): void {
  try {
    const ids = ['main', ...listAgentIds().filter((id) => id !== 'main')];
    const roster = ids.map((id) => {
      try {
        const cfg = loadAgentConfig(id);
        return { id, name: cfg.name || capitalize(id), description: cfg.description || '' };
      } catch {
        return { id, name: capitalize(id), description: '' };
      }
    });
    fs.mkdirSync(WARROOM_TMP_DIR, { recursive: true });
    fs.writeFileSync(WARROOM_ROSTER_PATH, JSON.stringify(roster, null, 2));
  } catch {
    // Non-fatal. Voice stack falls back to the built-in default roster
    // if the file is missing.
  }
}
