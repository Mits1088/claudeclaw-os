/**
 * Shared native-Codex capability policy — the single translation from resolved
 * CALLER INTENT onto Codex-native controls (sandbox, shell, web search, network,
 * MCP). Both native OpenAI transports consume it: the Codex SDK adapter today,
 * the App Server adapter next (which additionally VERIFIES the effective policy
 * Codex reports back before starting a turn).
 *
 * Why a profile layer at all: Claude tool names are not a Codex security
 * boundary. Omitting `Bash` from a Claude allow-list does not disable Codex's
 * shell — Codex brings its own toolset and gates it on sandbox + feature config,
 * not on our tool names. So an allow/deny list must be translated into explicit
 * Codex-native controls rather than assumed to carry over.
 *
 * This module is a PURE LEAF: it resolves policy and returns data. It spawns
 * nothing, reads no MCP definitions it wasn't handed, and — critically — never
 * ADDS an MCP server. `input.mcpServers` is the complete already-authorized set
 * (materialized by the dispatch authorization layer before `invoke()`); the
 * profile may only narrow it, never widen it.
 */

import { CODEX_DANGER_WRITE } from '../config.js';
import type { McpServerConfig } from './types.js';
import { turnDeniesAllTools } from './types.js';

export type CodexCapabilityMode =
  | 'tool-less'
  | 'read-only-research'
  | 'workspace-agent'
  | 'full-trust';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Bound on how far a turn may run. `maxTurns` has no Codex equivalent, and
 * silently ignoring it is not acceptable for a caller that asked to be bounded.
 *
 * `maxToolItems: 0` is checked on the SDK path: a tool-less turn that emits any
 * tool item stops with a visible error. That is a backstop that bounds further
 * tool use, not preventive enforcement — the item has already started by then.
 *
 * `deadlineMs` is carried for observability and for the App Server transport,
 * which can `turn/interrupt`. The SDK path deliberately does NOT enforce it:
 * every bounded caller already supplies its own AbortController timeout, and a
 * second competing timer would risk regressing working paths for no safety gain.
 */
export interface CodexTurnBudget {
  deadlineMs?: number;
  maxToolItems?: number;
}

export interface CodexCapabilityProfile {
  mode: CodexCapabilityMode;
  sandboxMode: CodexSandboxMode;
  shellEnabled: boolean;
  webSearchEnabled: boolean;
  /** False = confine the sandbox's network access. True = not additionally confined. */
  networkAccess: boolean;
  /**
   * Whether the HOST-OWNED Codex Apps server (`codex_apps`) may remain available.
   * Distinct from `mcpServers`, which covers only ClaudeClaw-provided servers:
   * Codex 0.144.6 materializes `codex_apps` from the account regardless of an
   * empty `mcp_servers` table, and it exposes the operator's connector and skill
   * inventory. Disabled for `tool-less` and `read-only-research` so an
   * untrusted-input turn cannot enumerate the account; may remain enabled for the
   * trusted `workspace-agent` and `full-trust` profiles.
   *
   * The stable gate is `features.apps = false` (the runtime maps it onto
   * `McpConfig.apps_enabled`, which is an internal field and NOT a config key).
   */
  hostAppsEnabled: boolean;
  /**
   * The authorized MCP set for this turn — never broader than the caller's.
   *
   * An empty set means no CALLER-CONFIGURED server — it is NOT by itself a no-MCP
   * turn. On codex-cli 0.144.6 the host-owned `codex_apps` server is materialized
   * from the account independently and was observed enumerating 30 account
   * resources on a probe turn with an empty table. `hostAppsEnabled` is the gate
   * that removes it; the two fields must both be set to get a no-MCP turn.
   */
  mcpServers: Record<string, McpServerConfig>;
  turnBudget: CodexTurnBudget;
}

/** The transport-neutral slice of `AgentTurnInput` this policy reads. */
export interface CodexPolicyInput {
  allowedTools?: string[];
  disallowedTools?: string[];
  allowDangerouslySkipPermissions?: boolean;
  maxTurns?: number;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface CodexPolicyOptions {
  /**
   * The trusted-operator write gate (`CODEX_DANGER_WRITE`). Defaults to config.
   * Injectable so the policy can be tested in both states without env juggling.
   */
  dangerWriteEnabled?: boolean;
}

/**
 * Claude tool names that mutate the workspace or run commands. A non-empty
 * allow-list containing NONE of these signals read-only intent (e.g. the bot's
 * conversational chat profile of {Read, Grep, Glob}).
 */
const WRITE_OR_EXEC_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Wall-clock bound advertised for a tool-less turn (routing, classification,
 * memory extraction). Declared for the App Server transport and for logs; see
 * CodexTurnBudget on why the SDK path does not add its own timer.
 */
const TOOL_LESS_DEADLINE_MS = 120_000;

/**
 * Whether a Claude-named tool is permitted this turn, mirroring the ACP
 * adapter's allow/deny semantics: a '*' or explicit deny blocks it; a non-empty
 * allow-list must include it. Deny rules always win over allow rules.
 */
export function codexToolAllowed(input: CodexPolicyInput, name: string): boolean {
  if (input.disallowedTools?.includes('*')) return false;
  if (input.disallowedTools?.includes(name)) return false;
  if (input.allowedTools && input.allowedTools.length > 0) return input.allowedTools.includes(name);
  return true;
}

/** True when a non-empty allow-list grants no write/exec tool (read-only intent). */
function isReadOnlyAllowList(allowedTools: string[] | undefined): boolean {
  return !!allowedTools
    && allowedTools.length > 0
    && !allowedTools.some((t) => WRITE_OR_EXEC_TOOLS.has(t));
}

/**
 * Resolve the caller's intent into exactly one Codex-native capability profile.
 *
 * Precedence — DENY WINS over allow rules and over defaults:
 *  1. deny-all ('*' denied) or an explicitly empty allow-list → 'tool-less'.
 *     This outranks `allowDangerouslySkipPermissions`: memory ingestion and the
 *     war-room warmups pass BOTH deny-all and skip-permissions today, and a
 *     locked-down turn must never be promoted to full trust by a stale flag.
 *  2. a non-empty allow-list with no write/exec tool → 'read-only-research'
 *     (shell may still serve repository reads, but the sandbox is read-only).
 *  3. explicit `allowDangerouslySkipPermissions` → 'full-trust'.
 *  4. an otherwise-write turn plus the operator gate CODEX_DANGER_WRITE →
 *     'full-trust' (needed because the current native Windows host applies
 *     read-only instead of the requested 'workspace-write', so writes never
 *     land; 'danger-full-access' is honored).
 *  5. otherwise → 'workspace-agent'.
 *
 * Never inferred from an incomplete policy: 'full-trust' requires an explicit
 * caller decision (3) or the explicit operator gate (4).
 */
export function resolveCodexCapabilityProfile(
  input: CodexPolicyInput,
  options: CodexPolicyOptions = {},
): CodexCapabilityProfile {
  const dangerWrite = options.dangerWriteEnabled ?? CODEX_DANGER_WRITE;
  // The authorized set, as handed to us. Copied so a profile can narrow it
  // without mutating the caller's object.
  const authorizedMcp = { ...(input.mcpServers ?? {}) };

  // 1. tool-less
  if (turnDeniesAllTools(input)) {
    return {
      mode: 'tool-less',
      sandboxMode: 'read-only',
      shellEnabled: false,
      webSearchEnabled: false,
      networkAccess: false,
      hostAppsEnabled: false,
      mcpServers: {},
      turnBudget: { deadlineMs: TOOL_LESS_DEADLINE_MS, maxToolItems: 0 },
    };
  }

  const webSearchEnabled = codexToolAllowed(input, 'WebSearch');

  // 2. read-only research
  if (isReadOnlyAllowList(input.allowedTools)) {
    return {
      mode: 'read-only-research',
      sandboxMode: 'read-only',
      shellEnabled: true,
      webSearchEnabled,
      networkAccess: false,
      // Untrusted-input research and voice turns must not enumerate the
      // operator's account connectors.
      hostAppsEnabled: false,
      mcpServers: authorizedMcp,
      turnBudget: {},
    };
  }

  // 3 + 4. full trust — explicit caller intent, or the explicit operator gate.
  if (input.allowDangerouslySkipPermissions === true || dangerWrite) {
    return {
      mode: 'full-trust',
      sandboxMode: 'danger-full-access',
      shellEnabled: true,
      webSearchEnabled,
      networkAccess: true,
      hostAppsEnabled: true,
      mcpServers: authorizedMcp,
      turnBudget: {},
    };
  }

  // 5. normal trusted agent work: writes confined to cwd, network off.
  return {
    mode: 'workspace-agent',
    sandboxMode: 'workspace-write',
    shellEnabled: true,
    webSearchEnabled,
    networkAccess: false,
    hostAppsEnabled: true,
    mcpServers: authorizedMcp,
    turnBudget: {},
  };
}
