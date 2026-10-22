import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  error?: string;
}

/**
 * The bare remote that backs a given working copy — a sibling `<vault>.git`.
 * Only used in git-synced mode; a local-only vault has no remote at all.
 */
export function getVaultRemotePath(vaultDir: string): string {
  const resolved = path.resolve(vaultDir);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}.git`);
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    // The no-change commit paths below match Git's diagnostic text.
    env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
  });
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    // execFile rejections carry the real git output on stdout/stderr, not
    // in .message (which is just "Command failed: ...").
    const { stdout, stderr } = e as Error & { stdout?: string; stderr?: string };
    return [e.message, stdout, stderr].filter(Boolean).join('\n');
  }
  return String(e);
}

/**
 * Idempotently provision the vault: create the bare remote if missing,
 * clone the working copy if missing, and set a local git identity on the
 * working copy so agent commits succeed. Safe to call repeatedly.
 */
export async function ensureVaultProvisioned(workingPath: string, remotePath: string): Promise<void> {
  if (!fs.existsSync(remotePath)) {
    fs.mkdirSync(path.dirname(remotePath), { recursive: true });
    await git(path.dirname(remotePath), ['init', '--bare', remotePath]);
    logger.info({ remotePath }, 'Vault: initialized bare remote');
  }

  if (!fs.existsSync(path.join(workingPath, '.git'))) {
    fs.mkdirSync(path.dirname(workingPath), { recursive: true });
    const existingEntries = fs.existsSync(workingPath) ? fs.readdirSync(workingPath) : [];

    if (existingEntries.length === 0) {
      await git(path.dirname(workingPath), ['clone', remotePath, workingPath]);
      logger.info({ workingPath }, 'Vault: cloned working copy');
    } else {
      // A user who already keeps notes here (a copied Obsidian vault, or a
      // leftover from a previous install) must not be told to move them:
      // `git clone` refuses a non-empty target, which used to surface as a
      // raw "destination path already exists" failure. Adopt the directory
      // in place instead — same end state, nothing moved or deleted.
      await adoptExistingVault(workingPath, remotePath);
    }
  }

  await git(workingPath, ['config', 'user.email', 'vault@claudeclaw.local']);
  await git(workingPath, ['config', 'user.name', 'ClaudeClaw']);
}

/**
 * Turn a plain directory of notes into the vault working copy: init it,
 * point it at the bare remote, and publish what is already there. If the
 * remote already carries history, check that branch out first so the
 * adopted files land on top of it rather than as an unrelated root — git
 * refuses (loudly, without overwriting) if a remote file collides with a
 * local one, which is the safe outcome.
 */
async function adoptExistingVault(workingPath: string, remotePath: string): Promise<void> {
  await git(workingPath, ['init']);
  await git(workingPath, ['remote', 'add', 'origin', remotePath]);
  await git(workingPath, ['config', 'user.email', 'vault@claudeclaw.local']);
  await git(workingPath, ['config', 'user.name', 'ClaudeClaw']);

  const { stdout: remoteHeads } = await git(workingPath, ['ls-remote', '--heads', 'origin']);
  const remoteBranch = remoteHeads.split('\n')[0]?.split('refs/heads/')[1]?.trim();

  if (remoteBranch) {
    await git(workingPath, ['fetch', 'origin']);
    await git(workingPath, ['checkout', '-b', remoteBranch, '--track', `origin/${remoteBranch}`]);
  }

  await git(workingPath, ['add', '-A']);
  try {
    await git(workingPath, ['commit', '-m', 'Adopt existing vault contents']);
  } catch (e) {
    // An empty-but-for-dotfiles directory has nothing to commit; that is
    // fine, the working copy is still correctly wired to the remote.
    if (!/nothing to commit/i.test(errorMessage(e))) throw e;
  }
  await git(workingPath, ['push', '-u', 'origin', 'HEAD']);
  logger.info({ workingPath }, 'Vault: adopted existing directory as the working copy');
}

/** `git pull --ff-only`. Returns ok:false (never throws) on any failure,
 *  including diverged history — callers decide whether to quarantine. */
export async function pullFF(vaultPath: string): Promise<GitResult> {
  try {
    await git(vaultPath, ['pull', '--ff-only']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Stage all changes, commit, and push. A "nothing to commit" state is
 *  treated as success, not an error. */
export async function commitAndPush(vaultPath: string, message: string): Promise<GitResult> {
  try {
    await git(vaultPath, ['add', '-A']);
    try {
      await git(vaultPath, ['commit', '-m', message]);
    } catch (e) {
      if (!/nothing to commit/i.test(errorMessage(e))) throw e;
      // Nothing NEW to commit still has to reach the remote: earlier commits
      // may be unpushed (a previous push that was rejected, or a write made
      // by another process). Returning ok here without pushing reported a
      // successful sync while the vault silently stayed diverged.
    }
    try {
      await git(vaultPath, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      // Unborn HEAD: freshly provisioned and never written to, so there is
      // genuinely nothing to push.
      return { ok: true };
    }
    await git(vaultPath, ['push']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * Recover from a pullFF failure caused by diverged history: move any files
 * touched by local commits/changes not yet on the remote into
 * conflicts/<timestamp>/ (preserving their content), then hard-reset the
 * working copy to match the remote so it's usable again. Returns the
 * relative paths that were quarantined.
 */
export async function quarantineConflicts(vaultPath: string): Promise<string[]> {
  await git(vaultPath, ['fetch']);

  const dirty = new Set<string>();
  // -z everywhere: without it git QUOTES and octal-escapes any path that is
  // not plain ASCII (`"Notes/caf\303\251.md"`), and a path parsed in that
  // form matches nothing on disk — the file was then skipped here and
  // destroyed by the reset below. -z emits raw NUL-terminated paths.
  try {
    const { stdout } = await git(vaultPath, ['status', '--porcelain', '-z']);
    for (const entry of stdout.split('\0')) {
      if (!entry) continue;
      // Records are `XY <path>`; a rename/copy adds a second bare record
      // holding the source path, which has no status prefix of its own.
      const match = /^(.)(.) (.*)$/s.exec(entry);
      dirty.add(match ? match[3] : entry);
    }
  } catch { /* ignore — status should not normally fail */ }

  try {
    const { stdout: mergeBase } = await git(vaultPath, ['merge-base', 'HEAD', '@{u}']);
    const { stdout: diffOut } = await git(vaultPath, ['diff', '--name-only', '-z', mergeBase.trim(), 'HEAD']);
    for (const relPath of diffOut.split('\0')) {
      if (relPath) dirty.add(relPath);
    }
  } catch { /* no upstream divergence to diff, or no commits yet */ }

  const quarantined: string[] = [];
  if (dirty.size > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantineDir = path.join(vaultPath, 'conflicts', timestamp);

    for (const relPath of dirty) {
      if (relPath.startsWith('conflicts/') || relPath === 'conflicts') continue;
      const src = path.join(vaultPath, relPath);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      const dest = path.join(quarantineDir, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      quarantined.push(relPath);
    }
  }

  await git(vaultPath, ['reset', '--hard', '@{u}']);
  logger.warn({ vaultPath, quarantined }, 'Vault: quarantined diverged files and reset to remote');

  return quarantined;
}
