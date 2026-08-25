/**
 * Per-provider chat-path tool profiles.
 *
 * Replaces the old binary "Claude = unrestricted, everyone-else = one shared
 * `CHAT_ACP_TOOL_POLICY` bucket" with an explicit profile per provider, so each
 * provider's chat capability is tuned on its own merits. Shared by bot.ts and
 * signal-bot.ts (previously duplicated in both).
 *
 * Data-driven on purpose: the code table is the default; a future dashboard can
 * expose these as per-provider tool checkboxes by layering a persisted override
 * on top (same pattern as the model picker), with no engine changes.
 *
 * Safety intent preserved: non-Claude models tend to read a casual chat message
 * as a coding task (Codex once ran the whole test suite on "hey, wake up"), so
 * they stay read-only for code-exec by default. Web-answer tools (WebSearch,
 * WebFetch) are read-only and safe to grant, so a vetted provider can have them.
 */

import type { AgentToolPolicy } from './agent.js';
import type { ProviderConfig, ProviderType } from './provider.js';

/** The safest profile: read-only file inspection, nothing else. Also the
 *  fallback for any provider type not explicitly listed. */
export const STRICTEST_CHAT_TOOL_PROFILE: AgentToolPolicy = {
  allowedTools: ['Read', 'Grep', 'Glob'],
};

/**
 * Vocabulary reference — every verb you can list in an `allowedTools` array.
 * (`'full'` grants all of them; an explicit allow-list grants only what it names.)
 *
 * Read-only built-ins (safe for "answer in chat" turns):
 *   Read, Glob, Grep, WebSearch, WebFetch, TodoWrite, NotebookRead, BashOutput
 *
 * Write / exec built-ins (side-effecting). On the Codex path, ANY of these in
 * the allow-list resolves the turn to the 'workspace-agent' capability profile
 * (see WRITE_OR_EXEC_TOOLS in codex-capability-policy.ts: Bash, Write, Edit,
 * MultiEdit, NotebookEdit):
 *   Bash, Write, Edit, MultiEdit, NotebookEdit, KillShell
 *
 * Other built-ins:
 *   Skill, Task, ExitPlanMode
 *
 * MCP tools follow the `mcp__<server>__<tool>` naming. The fleet dispatch verbs
 * (mission / schedule / hive) are materialized by the dispatch authorization
 * layer (dispatch-tools.ts) before the engine is called — and only for a turn
 * that grants tools at all, so a deny-all profile here also means no dispatch.
 * Anything omitted from an explicit allow-list is denied.
 */

/** `'full'` = no restriction (all tools). Otherwise an explicit allow-list. */
export type ChatToolProfile = AgentToolPolicy | 'full';

/**
 * One explicit profile per provider. Unknown/new types fall to STRICTEST.
 * Tune a single provider by editing its row; nothing else is affected.
 */
export const CHAT_TOOL_PROFILES: Record<ProviderType, ChatToolProfile> = {
  claude: 'full', // load-bearing, proven track record
  // Native Codex SDK (type 'openai'): 'full', same as Claude. Trust layers are
  // proven out (OS-sandbox containment, isolated CODEX_HOME, dispatch verified),
  // so there is no reason to carry a different chat surface than Claude. The
  // Codex adapter still confines the turn via sandboxModeFor -> 'workspace-write'
  // (writes in cwd, network off); the OS sandbox, not the tool list, is the
  // boundary.
  openai: 'full',
  // Everything below stays minimal until individually vetted.
  //
  // anthropic-compatible runs the SAME engine as Claude, and it is tempting to
  // read that as "so it can have Claude's chat surface". It cannot: engine
  // sameness buys enforceability of an allow-list, not judgment about what to
  // do with a casual message. That judgment is a property of the MODEL, and
  // this provider's model is by definition not Claude — and swappable per
  // .env, so no track record accrues to it either. Stays minimal.
  'anthropic-compatible': STRICTEST_CHAT_TOOL_PROFILE,
  'acp-codex': STRICTEST_CHAT_TOOL_PROFILE, // Codex over ACP, not the native runtime
  gemini: STRICTEST_CHAT_TOOL_PROFILE,
  opencode: STRICTEST_CHAT_TOOL_PROFILE,
  openrouter: STRICTEST_CHAT_TOOL_PROFILE,
  acp: STRICTEST_CHAT_TOOL_PROFILE,
};

/**
 * Resolve the chat tool policy for a provider. Returns `undefined` for a 'full'
 * profile (no restriction), an allow-list otherwise. Unknown provider or type
 * falls to STRICTEST (safe-by-default).
 */
export function chatToolProfileFor(
  provider: ProviderConfig | undefined,
): AgentToolPolicy | undefined {
  const profile = provider ? CHAT_TOOL_PROFILES[provider.type] : STRICTEST_CHAT_TOOL_PROFILE;
  if (profile === 'full') return undefined;
  return profile ?? STRICTEST_CHAT_TOOL_PROFILE;
}
