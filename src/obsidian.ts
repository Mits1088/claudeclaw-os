import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { pullFF, commitAndPush, quarantineConflicts, type GitResult } from './vault-sync.js';
import { withVaultLock } from './vault-lock.js';

export interface ObsidianConfig {
  vault: string;
  folders: string[];
  readOnly?: string[];
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

/** True when `target` is the root itself or lives beneath it. Uses
 *  path.relative rather than string prefixes so Windows drive-letter case
 *  and separator differences don't produce a false negative. */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve relPath to the real filesystem target it designates, rejecting
 * anything that lands outside the vault. Agents supply relPath, so this is a
 * security boundary, not a nicety.
 *
 * Lexical resolution alone is not enough: a symlink or Windows junction
 * sitting inside an allowed folder points somewhere else entirely, and
 * `path.resolve` cannot see that. So the deepest EXISTING ancestor is
 * realpath'd — for a note that does not exist yet, that is the parent
 * directory it would be created in — and the check is applied to the real
 * location. The returned `rel` is derived from the real path too, so folder
 * scoping upstream is checked against where the write actually lands rather
 * than the alias used to reach it.
 */
function resolveInVault(vaultPath: string, relPath: string): { full: string; rel: string } {
  let vaultRoot: string;
  try {
    vaultRoot = fs.realpathSync(path.resolve(vaultPath));
  } catch {
    throw new Error(`Vault directory does not exist: ${vaultPath}`);
  }

  const lexical = path.resolve(vaultRoot, relPath);
  if (!isInside(vaultRoot, lexical)) {
    throw new Error(`Path escapes vault: ${relPath}`);
  }

  // Walk up to the deepest component that exists on disk; everything below it
  // is yet to be created and cannot itself be an alias.
  let existing = lexical;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  let realExisting: string;
  try {
    realExisting = fs.realpathSync(existing);
  } catch {
    throw new Error(`Path escapes vault: ${relPath}`);
  }

  const remainder = path.relative(existing, lexical);
  const full = remainder ? path.join(realExisting, remainder) : realExisting;

  if (!isInside(vaultRoot, full)) {
    throw new Error(`Path escapes vault: ${relPath}`);
  }

  return { full, rel: path.relative(vaultRoot, full).split(path.sep).join('/') };
}

/**
 * The vault-relative, normalized, forward-slash form of relPath — the form
 * per-agent folder scoping MUST be checked against. Comparing the raw
 * argument instead lets `Notes/../Private/x.md` pass a check for "Notes"
 * while resolving into Private/, lets a junction under an allowed folder
 * alias into a disallowed one, and on Windows makes `Notes\x.md` fail a
 * check that `Notes/x.md` passes. Throws if the path escapes the vault.
 */
export function vaultRelative(vaultPath: string, relPath: string): string {
  return resolveInVault(vaultPath, relPath).rel;
}

/** relPath in the same forward-slash, dot-free form `resolveInVault` reports,
 *  but without consulting the filesystem — what the path CLAIMS to be. Only
 *  the platform separator is rewritten: on Windows that folds `Notes\x.md`
 *  into `Notes/x.md` just as `path.resolve` does, while on POSIX a backslash
 *  is an ordinary filename character and must be left alone. */
function lexicalRel(relPath: string): string {
  const normalized = path.posix.normalize(relPath.split(path.sep).join('/'));
  return normalized === '.' ? '' : normalized.replace(/\/+$/, '');
}

/**
 * Resolve relPath and insist it lands where its own name says. The permission
 * layer scope-checks the resolved path BEFORE the transaction; inside it, the
 * filesystem can change (a pull lands another client's commit) and the same
 * name can start resolving through an alias into a folder that was never
 * checked. Rather than teach this module about agent scopes, hold the
 * invariant that lets the earlier check stand: the target is exactly the
 * vault-relative path the caller was cleared for, or the operation stops.
 */
function resolveExactly(vaultPath: string, relPath: string): { full: string; rel: string } {
  const resolved = resolveInVault(vaultPath, relPath);
  const claimed = lexicalRel(relPath);
  if (resolved.rel !== claimed) {
    throw new Error(
      `Path ${claimed || '(vault root)'} resolves to ${resolved.rel || '(vault root)'} through an alias; refusing.`,
    );
  }
  return resolved;
}

/**
 * Where and how a vault is stored. `sync: false` is local-vault mode: the
 * vault is a plain folder on disk (typically one the user already keeps for
 * Obsidian) and no git command is ever run against it.
 */
export interface VaultContext {
  vaultPath: string;
  sync: boolean;
}

/** Read a note's raw content, or null if it doesn't exist. */
export async function readNote(vaultPath: string, relPath: string): Promise<string | null> {
  const { full } = resolveInVault(vaultPath, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf-8');
}

/** Pull, when this vault is git-backed at all. Never throws. */
async function syncIn(ctx: VaultContext): Promise<void> {
  if (!ctx.sync) return;
  const pulled = await pullFF(ctx.vaultPath);
  if (!pulled.ok) {
    logger.warn({ vaultPath: ctx.vaultPath, error: pulled.error }, 'Vault: pull-before-write failed, continuing');
  }
}

/** Publish, when this vault is git-backed. A local vault is already durable
 *  the moment the file is written, so there is nothing to report. */
async function syncOut(ctx: VaultContext, message: string): Promise<GitResult> {
  if (!ctx.sync) return { ok: true };
  return commitAndPush(ctx.vaultPath, message);
}

/** A push refused because the remote moved on — the recoverable case, as
 *  opposed to a missing remote, auth failure, or broken repo. */
function isDivergedPush(error: string | undefined): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|behind its remote/i.test(error ?? '');
}

function writeFile(full: string, content: string): void {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/**
 * The whole read/modify/write/sync transaction for one note, holding the
 * vault lock so concurrent agents cannot interleave.
 *
 * `compute` receives the note's content AFTER the pull, so an append is
 * always computed from the synchronized state rather than a stale local
 * read. On a diverged push the local divergence is quarantined, the working
 * copy is reset onto the remote, and `compute` runs AGAIN against the
 * post-recovery content — otherwise the retry would republish content
 * derived from the very state that was just rolled back.
 *
 * Both resolutions go through `resolveExactly`: the caller's scope check ran
 * against the path as it stood before the pull, and a pull can bring in an
 * alias that makes the same name land elsewhere.
 */
async function mutateNote(
  ctx: VaultContext,
  relPath: string,
  compute: (current: string | null) => string,
  message: string,
): Promise<GitResult> {
  return withVaultLock(ctx.vaultPath, async () => {
    await syncIn(ctx);

    const resolved = resolveExactly(ctx.vaultPath, relPath);
    const before = fs.existsSync(resolved.full) ? fs.readFileSync(resolved.full, 'utf-8') : null;
    writeFile(resolved.full, compute(before));

    const result = await syncOut(ctx, message);
    if (result.ok || !isDivergedPush(result.error)) return result;

    const quarantined = await quarantineConflicts(ctx.vaultPath);
    logger.warn(
      { vaultPath: ctx.vaultPath, quarantined, relPath },
      'Vault: diverged on push, recovered and recomputing write',
    );

    const after = resolveExactly(ctx.vaultPath, relPath);
    const recovered = fs.existsSync(after.full) ? fs.readFileSync(after.full, 'utf-8') : null;
    writeFile(after.full, compute(recovered));
    return syncOut(ctx, message);
  });
}

/** Write (create or overwrite) a note, then sync: best-effort pull first
 *  (a stale local write is still worth keeping locally even if the pull
 *  fails), write the file, commit, and push. */
export async function writeNote(ctx: VaultContext, relPath: string, content: string): Promise<GitResult> {
  return mutateNote(ctx, relPath, () => content, `Update ${relPath}`);
}

/**
 * Append a line of text to a note, creating it if it doesn't exist yet.
 *
 * The existing content is read inside the transaction, after the pull —
 * reading it first (as this used to) published a note computed from a stale
 * copy, silently dropping whatever another client had appended in between,
 * and reported ok.
 */
export async function appendToNote(ctx: VaultContext, relPath: string, text: string): Promise<GitResult> {
  return mutateNote(
    ctx,
    relPath,
    (current) => (current ? `${current}\n${text}` : text),
    `Update ${relPath}`,
  );
}

/** Grep-style search across `.md` files in the given folders. */
export function searchNotes(vaultPath: string, folders: string[], query: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const needle = query.toLowerCase();

  let vaultRoot: string;
  try {
    vaultRoot = fs.realpathSync(path.resolve(vaultPath));
  } catch {
    return matches;
  }

  for (const folder of folders) {
    let folderPath: string;
    try {
      // A scoped folder must BE the folder its name says: one that is really
      // a junction onto another folder (inside the vault or out of it) is
      // skipped, not searched at its destination.
      folderPath = resolveExactly(vaultPath, folder).full;
    } catch {
      continue;
    }
    if (!fs.existsSync(folderPath)) continue;

    for (const entry of walkMarkdownFiles(folderPath)) {
      // Individual files can be aliases too; keep only what really lives
      // under this folder so search cannot read around the folder scope.
      let realEntry: string;
      try {
        realEntry = fs.realpathSync(entry);
      } catch {
        continue;
      }
      if (!isInside(folderPath, realEntry)) continue;
      const relFile = path.relative(vaultRoot, realEntry).split(path.sep).join('/');
      const content = fs.readFileSync(entry, 'utf-8');
      content.split('\n').forEach((line, idx) => {
        if (line.toLowerCase().includes(needle)) {
          matches.push({ file: relFile, line: idx + 1, text: line.trim() });
        }
      });
    }
  }

  return matches;
}

/** `.md` files directly inside a vault folder, resolved through the same
 *  containment check every other path goes through. */
export function listMarkdownFiles(vaultPath: string, relFolder: string): string[] {
  const { full } = resolveInVault(vaultPath, relFolder);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

/** Vault-relative path of an agent's daily note for today. Exported so the
 *  permission layer can scope-check it exactly like any other write target. */
export function dailyNotePath(agentId: string): string {
  return `ClaudeClaw/${agentId}/${new Date().toISOString().slice(0, 10)}.md`;
}

/**
 * Get-or-create today's daily note for an agent
 * (ClaudeClaw/<agentId>/YYYY-MM-DD.md).
 *
 * The existence check happens inside the transaction, after the pull: probing
 * beforehand could miss a note another client had already created today and
 * overwrite it with an empty stub. A sync failure is returned rather than
 * swallowed, so the caller learns the note did not reach the remote.
 */
export async function dailyNote(
  ctx: VaultContext,
  agentId: string,
): Promise<{ relPath: string; result: GitResult }> {
  const relPath = dailyNotePath(agentId);
  const date = relPath.slice(-13, -3);
  const result = await mutateNote(
    ctx,
    relPath,
    (current) => current ?? `# ${agentId} — ${date}\n`,
    `Update ${relPath}`,
  );
  return { relPath, result };
}

interface ObsidianNote {
  title: string;
  folder: string;
  openTasks: string[];
}

let _cache: ObsidianNote[] = [];
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function buildObsidianContext(config: ObsidianConfig | undefined): string {
  if (!config) return '';

  // Validate vault path exists on first cache build
  if (_cacheTime === 0 && !fs.existsSync(config.vault)) {
    logger.warn(
      { vault: config.vault },
      'Obsidian vault path does not exist. Check agent.yaml obsidian.vault setting. Obsidian integration is disabled.',
    );
    return '';
  }

  const now = Date.now();
  if (now - _cacheTime > CACHE_TTL_MS) {
    _cache = scanFolders(config);
    _cacheTime = now;
  }

  if (_cache.length === 0) return '';

  const lines: string[] = ['[Obsidian context]'];
  let currentFolder = '';

  for (const note of _cache) {
    if (note.folder !== currentFolder) {
      currentFolder = note.folder;
      lines.push(`  ${currentFolder}/`);
    }
    for (const task of note.openTasks) {
      lines.push(`    Open: ${task} (${note.title})`);
    }
  }

  lines.push('[End Obsidian context]');
  return lines.join('\n');
}

function scanFolders(config: ObsidianConfig): ObsidianNote[] {
  const allFolders = [...config.folders, ...(config.readOnly ?? [])];
  const notes: ObsidianNote[] = [];

  for (const folder of allFolders) {
    const folderPath = path.join(config.vault, folder);
    if (!fs.existsSync(folderPath)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = path.join(folderPath, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // Skip notes tagged as done
      if (/^status:\s*done/mi.test(content)) continue;

      // Extract open tasks: lines matching - [ ]
      const openTasks: string[] = [];
      for (const line of content.split('\n')) {
        const match = line.match(/^-\s+\[\s\]\s+(.+)/);
        if (match) {
          openTasks.push(match[1].trim());
        }
      }

      if (openTasks.length > 0) {
        const title = entry.name.replace(/\.md$/, '');
        notes.push({ title, folder, openTasks });
      }
    }
  }

  return notes;
}

/** Reset cache (for testing). */
export function _resetObsidianCache(): void {
  _cache = [];
  _cacheTime = 0;
}
