/**
 * War-room tool / MCP policy.
 *
 * The text war-room used to call `query()` with `permissionMode:
 * 'bypassPermissions'`, no `allowedTools` policy, and every MCP server
 * the user has installed. That meant any prompt-injected war-room
 * message could, in principle, drive Chrome, write files, send Slack,
 * or talk to Microsoft 365 without the user noticing — there was no
 * permission UI, no tool allowlist, no MCP scope.
 *
 * This module enforces the boundary:
 *
 *   - Default-allow read-only built-ins: Read, Glob, Grep, WebSearch,
 *     WebFetch, TodoWrite. These are safe for "answer in chat" turns.
 *   - Default-deny side-effect built-ins: Bash, Write, Edit,
 *     NotebookEdit, ExitPlanMode, Skill.
 *   - Default-deny every MCP server, browser-driving and email-suite
 *     ones (claude-in-chrome, claude_ai_*) included. filterMcpServers()
 *     drops every server that is not explicitly opted in, so an
 *     unlisted server is never attached to the runtime.
 *   - Per-agent opt-in via `warroom_tools:` in agents/<id>/agent.yaml
 *     (parsed in agent-config.ts). Ops and Comms default to Bash + Skill;
 *     MCP access requires an `mcp:<server>` entry.
 *
 * Operators can customize the per-agent allowlist; the default-deny
 * list is hardcoded so a misconfigured agent.yaml can't accidentally
 * grant browser/M365 access.
 */

export interface WarRoomToolPolicy {
  /** Names passed to SDK `allowedTools`. Empty = SDK default-allows. */
  allowedTools: string[];
  /** Names passed to SDK `disallowedTools`. Used as defense-in-depth. */
  disallowedTools: string[];
  /** Allowlist of MCP server names; empty = no MCPs exposed. */
  allowedMcpServers: string[];
}

// Built-in tool names from the Anthropic Agent SDK. Read-only side
// matches the SDK's documented "safe to bypass permissions" set; the
// side-effect set is everything that can mutate state.
const SAFE_READONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
] as const;

const SIDE_EFFECT_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'ExitPlanMode',
  'Skill',
  // MCP servers are deliberately absent here. They are blocked one
  // level up by filterMcpServers(), which never hands an unlisted server
  // to the runtime, so there is no per-tool name for this list to carry.
] as const;

// Agents configured for operational tasks. These defaults are sane
// starting points — each user can override via agents/<id>/agent.yaml.
const DEFAULT_AGENT_ALLOWLISTS: Record<string, string[]> = {
  // Main is the host. Default to read-only — when in doubt, route to a
  // specialist instead of doing the work directly.
  main: [],
  // Ops drives schedules and calendars; needs Bash + Skill.
  ops: ['Bash', 'Skill'],
  // Comms triages email and routes; needs Skill (gmail/slack) + Bash.
  comms: ['Bash', 'Skill'],
  // Content drafts copy. Default Skill (linkedin-post etc.) + Write so
  // it can drop drafts in outputs/. Bash explicitly NOT default — most
  // content tasks shouldn't need shell.
  content: ['Skill', 'Write'],
  // Research does web lookups via WebSearch (already in safe set);
  // shouldn't generally write files in war room. To let it log findings to
  // the Obsidian vault from the war room, opt in per-install with
  // `warroom_tools: [Skill]` in agents/research/agent.yaml.
  research: [],
};

/**
 * Build the tool/MCP policy for a given agent in the war room. Pass
 * `agentTools` from the agent's loaded `agent.yaml` (the `warroom_tools`
 * field, if present) to replace the per-agent defaults. An explicit
 * empty list is a read-only lockdown.
 */
export function warRoomToolPolicy(
  agentId: string,
  agentTools?: string[],
): WarRoomToolPolicy {
  const effectiveEntries = agentTools !== undefined
    ? agentTools
    : DEFAULT_AGENT_ALLOWLISTS[agentId] ?? [];
  const builtinTools = effectiveEntries.filter((entry) => !entry.startsWith('mcp:'));
  const allowed = Array.from(new Set([...SAFE_READONLY_TOOLS, ...builtinTools]));

  // Disallow EVERY side-effect tool the agent didn't explicitly opt into.
  // allowedTools is never empty because the read-only floor is always
  // present. Naming dangerous built-ins here provides defense in depth;
  // MCP access is gated separately by filterMcpServers().
  const disallowed = SIDE_EFFECT_TOOLS.filter((t) => !allowed.includes(t));

  // MCP servers default to none. An operator can opt agents in via
  // effective `warroom_tools` entries that begin with `mcp:`
  // (e.g. `mcp:gmail`). Keep these tokens out of SDK allowedTools:
  // MCP tools use runtime-specific names, not the configuration token.
  const allowedMcpServers = Array.from(new Set(
    effectiveEntries
      .filter((entry) => entry.startsWith('mcp:') && entry.length > 'mcp:'.length)
      .map((entry) => entry.slice('mcp:'.length)),
  ));

  return {
    allowedTools: allowed,
    disallowedTools: disallowed,
    allowedMcpServers,
  };
}

/**
 * Filter a map of MCP servers (from `loadMcpServers`) to only those the
 * policy permits. Any server not in `allowedMcpServers` is dropped.
 */
export function filterMcpServers<T>(
  servers: Record<string, T>,
  policy: WarRoomToolPolicy,
): Record<string, T> {
  if (policy.allowedMcpServers.length === 0) return {};
  const out: Record<string, T> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (policy.allowedMcpServers.includes(name)) out[name] = cfg;
  }
  return out;
}
