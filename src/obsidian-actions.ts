/**
 * Shared, structured vault actions — the ONE implementation behind both front
 * doors (`obsidian-cli.ts` and the obsidian dispatch tools in
 * `dispatch-tools.ts`). Neither front door may re-implement a permission
 * check, resolve a vault path, or touch the filesystem directly: everything
 * they are allowed to do lives here, so CLI and dispatch cannot drift into
 * different permission behaviour.
 *
 * Every action enforces, in order:
 *   1. the runtime master switch (`obsidian_config.enabled`),
 *   2. the ACTING AGENT, taken from the trusted execution context
 *      (CLAUDECLAW_AGENT_ID, stamped by the runtime / the dispatch bridge) —
 *      never from a caller-supplied argument, or a model could simply name a
 *      more privileged agent to borrow its scope,
 *   3. that agent's `obsidian:` block, and
 *   4. read scope (`folders` + `read_only`) or write scope (`write_folders`),
 *      checked against the RESOLVED vault-relative path so traversal and
 *      filesystem aliases cannot widen it.
 *
 * Failures are `CliActionError`, which the CLI prints to stderr and the
 * dispatch layer turns into an `isError` tool result.
 */

import fs from 'fs';

import { loadAgentConfig } from './agent-config.js';
import { CliActionError } from './cli-actions.js';
import {
  getObsidianRuntimeConfig,
  resolveVaultDir,
  type ObsidianRuntimeConfig,
} from './obsidian-config.js';
import {
  appendToNote,
  dailyNote,
  dailyNotePath,
  listMarkdownFiles,
  readNote,
  searchNotes,
  vaultRelative,
  writeNote,
  type SearchMatch,
  type VaultContext,
} from './obsidian.js';
import type { GitResult } from './vault-sync.js';

/** The per-agent vault scope, as it appears in agent.yaml. */
export interface AgentVaultScope {
  vault?: string;
  folders?: string[];
  readOnly?: string[];
  writeFolders?: string[];
}

/** Resolved, permission-checked context for one vault operation. */
interface ActingContext {
  agentId: string;
  vault: VaultContext;
  readScope: Set<string>;
  writeScope: Set<string>;
}

/**
 * The agent this call acts as. Comes from the process the runtime started for
 * that agent (or, for out-of-process providers, the value the dispatch bridge
 * stamped) — deliberately not a parameter.
 */
export function actingAgentId(): string {
  return process.env.CLAUDECLAW_AGENT_ID || 'main';
}

/**
 * Whether an agent has any vault scope at all. An `obsidian:` block with every
 * list empty grants nothing, so it counts as no access rather than as access
 * that happens to deny everything.
 */
export function hasVaultAccess(obsidian: AgentVaultScope | undefined): boolean {
  if (!obsidian) return false;
  return (
    (obsidian.folders?.length ?? 0) +
      (obsidian.readOnly?.length ?? 0) +
      (obsidian.writeFolders?.length ?? 0) >
    0
  );
}

/**
 * Whether vault tools should be OFFERED to this process's agent at all.
 *
 * Exposure is gated as well as execution: an install with Obsidian disabled,
 * or an agent with no vault scope, is handed no vault tools and no CLI index
 * entry, so a model is never shown a capability it cannot use. This is
 * advertisement only — every action re-checks the same conditions at execution
 * time, which is what covers a turn that started before the feature was
 * switched off.
 *
 * Fails CLOSED: if the setting or the agent config cannot be read, offer
 * nothing.
 */
export function obsidianAvailable(): boolean {
  try {
    if (!getObsidianRuntimeConfig().enabled) return false;
    return hasVaultAccess(loadAgentConfig(actingAgentId()).obsidian);
  } catch {
    return false;
  }
}

function resolveContext(): ActingContext {
  const runtime: ObsidianRuntimeConfig = getObsidianRuntimeConfig();
  if (!runtime.enabled) {
    throw new CliActionError(
      'Obsidian is not enabled. Turn it on in the dashboard Settings (or ask the main agent to).',
    );
  }

  const agentId = actingAgentId();
  let obsidian;
  try {
    obsidian = loadAgentConfig(agentId).obsidian;
  } catch {
    throw new CliActionError(`Could not load agent config for "${agentId}".`);
  }
  if (!obsidian) {
    throw new CliActionError(`No obsidian: block configured for agent "${agentId}" in agent.yaml.`);
  }

  const vaultPath = resolveVaultDir(obsidian.vault, runtime);
  if (!fs.existsSync(vaultPath)) {
    throw new CliActionError(
      `Vault directory does not exist: ${vaultPath}. ` +
        (runtime.sync
          ? 'Re-save the Obsidian setting in the dashboard to provision it.'
          : 'Create it, or point obsidian_config.vaultPath at your existing vault.'),
    );
  }

  return {
    agentId,
    vault: { vaultPath, sync: runtime.sync },
    readScope: new Set([...(obsidian.folders ?? []), ...(obsidian.readOnly ?? [])]),
    writeScope: new Set(obsidian.writeFolders ?? []),
  };
}

/** Resolve a caller-supplied path and confirm it lands inside an allowed
 *  folder. Resolution happens first, so `Notes/../Private/x.md` and a
 *  junction under an allowed folder are both judged by where they land. */
function checkScope(
  ctx: ActingContext,
  relPath: string,
  mode: 'read' | 'write',
): string {
  let resolved: string;
  try {
    resolved = vaultRelative(ctx.vault.vaultPath, relPath);
  } catch (e) {
    throw new CliActionError(e instanceof Error ? e.message : String(e));
  }

  const scope = mode === 'read' ? ctx.readScope : ctx.writeScope;
  const top = resolved.split('/')[0] ?? '';
  if (!scope.has(top)) {
    const listed = [...scope].join(', ') || '(none configured)';
    throw new CliActionError(
      mode === 'read'
        ? `Agent "${ctx.agentId}" cannot read outside its configured folders: ${listed}`
        : `Agent "${ctx.agentId}" cannot write outside its configured write_folders: ${listed}`,
    );
  }
  return resolved;
}

function assertSynced(result: GitResult, what: string): void {
  if (!result.ok) {
    throw new CliActionError(`${what} saved locally but sync failed: ${result.error}`);
  }
}

export async function actionObsidianRead(relPath: string): Promise<string> {
  const ctx = resolveContext();
  const rel = checkScope(ctx, relPath, 'read');
  const content = await readNote(ctx.vault.vaultPath, rel);
  if (content === null) throw new CliActionError(`Note not found: ${rel}`);
  return content;
}

export async function actionObsidianWrite(relPath: string, content: string): Promise<string> {
  const ctx = resolveContext();
  const rel = checkScope(ctx, relPath, 'write');
  assertSynced(await writeNote(ctx.vault, rel, content), 'Write');
  return `Wrote ${rel}`;
}

export async function actionObsidianAppend(relPath: string, text: string): Promise<string> {
  const ctx = resolveContext();
  const rel = checkScope(ctx, relPath, 'write');
  assertSynced(await appendToNote(ctx.vault, rel, text), 'Append');
  return `Appended to ${rel}`;
}

export async function actionObsidianSearch(query: string): Promise<SearchMatch[]> {
  const ctx = resolveContext();
  return searchNotes(ctx.vault.vaultPath, [...ctx.readScope], query);
}

/**
 * Get-or-create today's daily note. Scope-checked like any other write: the
 * daily note is a write into ClaudeClaw/, so an agent needs that folder in
 * its write_folders. It used to bypass the check entirely, letting an agent
 * with no write scope write to the vault.
 */
export async function actionObsidianDaily(): Promise<string> {
  const ctx = resolveContext();
  checkScope(ctx, dailyNotePath(ctx.agentId), 'write');
  const { relPath, result } = await dailyNote(ctx.vault, ctx.agentId);
  assertSynced(result, 'Daily note');
  return relPath;
}

export async function actionObsidianList(folder: string): Promise<string[]> {
  const ctx = resolveContext();
  // An empty folder argument means the vault root, which is never inside a
  // scoped folder — require an explicit one rather than listing everything.
  if (!folder) {
    throw new CliActionError(
      `Specify a folder to list. Agent "${ctx.agentId}" can read: ${[...ctx.readScope].join(', ') || '(none configured)'}`,
    );
  }
  const rel = checkScope(ctx, folder, 'read');
  return listMarkdownFiles(ctx.vault.vaultPath, rel);
}
