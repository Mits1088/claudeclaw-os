#!/usr/bin/env node
/**
 * ClaudeClaw Dispatch MCP Server (stdio)
 *
 * A standalone MCP server that exposes the mission/schedule/hive dispatch tools
 * over a **stdio** transport, so **out-of-process providers** (Codex and other
 * non-Claude adapters that spawn a CLI binary) can reach fleet dispatch. Claude
 * keeps the faster in-process `createSdkMcpServer` path (dispatch-tools.ts); this
 * bridge is purely additive for providers that consume MCP over a real transport.
 *
 * Three front doors, ONE implementation, zero drift:
 *   - the `*-cli.ts` entrypoints,
 *   - the in-process SDK tools (dispatch-tools.ts, Claude turns),
 *   - and this stdio server (out-of-process turns)
 * all call the SAME `cli-actions.ts` functions, and every tool name/schema here
 * is DERIVED from the shared `dispatchToolDefinitions()` (ultimately the Phase 1
 * `CliDescriptor` specs) — never hand-authored.
 *
 * Identity: stdio has no per-call identity channel, so the spawning adapter sets
 * the acting agent via env (`CLAUDECLAW_DISPATCH_AGENT`). We mirror the CLIs,
 * which read `CLAUDECLAW_AGENT_ID`, by stamping that env before serving.
 *
 * Governance: `hive_read` returns shared cross-agent memory, which egresses to
 * the provider vendor on a non-Claude turn. It is WITHHELD from this bridge
 * unless `DISPATCH_ALLOW_HIVE_READ` is set. `hive_log` and the mission/schedule
 * verbs are always exposed.
 *
 * [PART B, separate branch] The provider adapter (codex-sdk-adapter.ts on
 * feat/mk--codex-sdk-provider) injects this server into a turn's mcpServers as a
 * `{ command, args, env }` stdio entry. That wiring lands once that branch is on
 * main; this file is the self-contained server it will point at.
 */

import { pathToFileURL } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { DISPATCH_ALLOW_HIVE_READ } from './config.js';
import { renderHelp } from './cli-reference.js';
import { dispatchMcpServerDescriptor as descriptor } from './cli-descriptors.js';
import { dispatchToolDefinitions, EGRESS_GATED_TOOLS, type DispatchToolDefinition } from './dispatch-tools.js';

/** Server name; tools surface to the model as `mcp__claudeclaw-dispatch__<name>`. */
export const DISPATCH_MCP_SERVER_NAME = 'claudeclaw-dispatch';

/**
 * Tools withheld from a non-Claude vendor unless explicitly enabled, because
 * they egress shared data. The list moved next to the tool definitions when
 * the in-process path started enforcing it too — keeping it here as well would
 * have meant two lists, or an import cycle. Re-exported so this module's
 * public surface is unchanged. See `DISPATCH_ALLOW_HIVE_READ`.
 */
export { EGRESS_GATED_TOOLS } from './dispatch-tools.js';

/**
 * The tool set this bridge exposes: all of `dispatchToolDefinitions()`, minus
 * the egress-gated tools (hive_read) unless `allowHiveRead` is set. Defaults to
 * the deployment config flag so production behavior matches the toggle.
 */
export function dispatchMcpServerToolDefinitions(
  opts: { allowHiveRead?: boolean } = {},
): DispatchToolDefinition[] {
  const allowHiveRead = opts.allowHiveRead ?? DISPATCH_ALLOW_HIVE_READ;
  return dispatchToolDefinitions().filter((d) => allowHiveRead || !EGRESS_GATED_TOOLS.has(d.name));
}

/**
 * Resolve the acting agent id for authorship. Mirrors the CLIs, which read
 * `CLAUDECLAW_AGENT_ID`; the adapter passes it in as `CLAUDECLAW_DISPATCH_AGENT`
 * (preferred) since stdio has no per-call identity channel.
 */
export function resolveDispatchAgentId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDECLAW_DISPATCH_AGENT || env.CLAUDECLAW_AGENT_ID || 'main';
}

/** Build the MCP server with the eligible dispatch tools registered. */
export function buildDispatchMcpServer(opts: { allowHiveRead?: boolean } = {}): McpServer {
  const server = new McpServer({ name: DISPATCH_MCP_SERVER_NAME, version: '1.0.0' });
  for (const def of dispatchMcpServerToolDefinitions(opts)) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      // The shared handler already validates via the derived schema layer and
      // returns an isError result on CliActionError; it never throws.
      def.handler as never,
    );
  }
  return server;
}

async function main(): Promise<void> {
  // Stamp the acting agent so the shared actions attribute authorship correctly
  // (mission created_by, hive_log/schedule agent defaulting all read
  // CLAUDECLAW_AGENT_ID at call time).
  process.env.CLAUDECLAW_AGENT_ID = resolveDispatchAgentId();
  const server = buildDispatchMcpServer();
  await server.connect(new StdioServerTransport());
}

// Only run when invoked directly, so importing the testable helpers above does
// not open a transport.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(renderHelp(descriptor));
    process.exit(0);
  }
  main().catch((err) => {
    // stderr only — stdout is the MCP transport channel and must stay clean.
    console.error('dispatch-mcp-server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
