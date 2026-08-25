// The config dir handed to an anthropic-compatible subprocess.
//
// WHY THIS EXISTS. A `claude` subprocess with no CLAUDE_CONFIG_DIR loads the
// machine's global configuration. Measured on this install (2026-08-20):
// 24 MCP servers and 273 tools, including CRM, the mail accounts, WooCommerce,
// ownCloud and four SSH hosts. An agent's `mcp_servers` allowlist does not
// bound that — the allowlist only limits what ClaudeClaw HANDS OVER, and says
// nothing about what the CLI offers on its own. For an unattended agent
// running against a third-party model, that gap is a data-egress hole.
//
// WHAT IT DOES. Points the subprocess at a directory that contains no server
// configuration at all. Measured in the same session: an empty dir yields
// zero servers, and servers passed programmatically (the SDK's `mcpServers`
// option, which ClaudeClaw already fills from the agent's allowlist) still
// arrive. So the allowlist becomes the complete, enforced tool surface —
// without a single credential being written to disk.
//
// The dir is otherwise the subprocess's own state (sessions, project history),
// which is a second benefit: a third-party turn never touches ~/.claude and
// cannot resume, or be resumed by, a Claude session.

import fs from 'fs';
import path from 'path';

/** Directory name below the store root. Stable — sessions live here. */
export const compatConfigDirName = 'anthropic-compat-config';

/**
 * Ensures the config dir exists and carries no server configuration.
 *
 * The strip step is the enforcement, and it is deliberately not a one-off at
 * install time: the CLI rewrites `.claude.json` on every run, and `claude mcp
 * add` (or a well-meaning hand edit) would otherwise plant a global server
 * that every future third-party turn inherits. Cheap enough to run per turn.
 *
 * Never throws on a damaged state file — the CLI recreates it, and a file that
 * does not parse cannot carry an mcpServers block either.
 */
export function ensureCompatConfigDir(storeRoot: string): string {
  const dir = path.join(storeRoot, compatConfigDirName);
  fs.mkdirSync(dir, { recursive: true });

  const stateFile = path.join(dir, '.claude.json');
  try {
    const raw = fs.readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'mcpServers' in parsed) {
      delete parsed.mcpServers;
      fs.writeFileSync(stateFile, JSON.stringify(parsed, null, 2), 'utf-8');
    }
  } catch {
    // Missing (first run) or unparseable — nothing to strip either way.
  }

  return dir;
}
