/**
 * Cross-process mutual exclusion for vault mutations.
 *
 * Every vault write is a read/modify/write/sync transaction: pull, read the
 * current note, compute the new content, write, commit, push, and — when the
 * push is rejected — quarantine and retry. Two agents running that
 * concurrently in separate processes corrupt each other: `git add -A` stages
 * whatever the other one has half-written, and an append can publish content
 * computed from a note the other process has already replaced. Local-only
 * vaults have the same read/modify/write hazard without any git involved.
 *
 * The lock is an atomically-created DIRECTORY (`mkdir` fails with EEXIST if it
 * exists — the one filesystem primitive that is atomic on both Windows and
 * POSIX, unlike `existsSync` + create). It lives under STORE_DIR keyed by a
 * hash of the vault path, deliberately NOT inside the vault: anything inside
 * would be swept into a commit by `git add -A` and pushed to every client.
 *
 * A holder that dies without releasing would otherwise wedge the vault
 * forever, so a lock whose owner stamp is older than `staleMs` is taken over.
 * A live holder refreshes that stamp every `heartbeatMs`, so a write that
 * legitimately outlives the window (a slow push over a big vault) keeps its
 * lock; only a holder that has stopped heartbeating — dead — loses it.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

interface LockTimings {
  /** An owner stamp older than this means the holder is gone. */
  staleMs: number;
  /** How often a live holder refreshes its stamp. Several beats fit in
   *  staleMs so one missed write (a busy event loop) is not fatal. */
  heartbeatMs: number;
}
const DEFAULT_TIMINGS: LockTimings = { staleMs: 30_000, heartbeatMs: 10_000 };
let timings: LockTimings = DEFAULT_TIMINGS;

/** How long to wait for a peer to finish before giving up. */
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_MS = 50;

interface LockOwner {
  pid: number;
  at: number;
}

/** Shrink the stale/heartbeat windows so tests can exercise them in
 *  milliseconds. No argument restores the defaults. */
export function _setVaultLockTimings(overrides?: Partial<LockTimings>): void {
  timings = { ...DEFAULT_TIMINGS, ...overrides };
}

/**
 * Lock directory for a vault path. Keyed by the vault's CANONICAL location,
 * so a junction, a symlink, a trailing separator or a relative spelling of
 * the same directory all map to the same lock — two writers must exclude
 * each other however they name the vault. A path that does not exist yet
 * (first provisioning) falls back to its resolved spelling.
 */
export function vaultLockPath(vaultPath: string): string {
  const resolved = path.resolve(vaultPath);
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  const key = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
  return path.join(STORE_DIR, 'vault-locks', `${key}.lock`);
}

/**
 * Write the owner stamp atomically (temp file + rename), so a waiter never
 * reads a half-written stamp, fails to parse it, and falls back to the
 * directory mtime — which after a long hold WOULD look stale.
 */
function stampOwner(lockDir: string): void {
  const target = path.join(lockDir, 'owner.json');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockOwner));
  fs.renameSync(tmp, target);
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf-8')) as LockOwner;
  } catch {
    return null;
  }
}

/** Reclaim a lock whose holder is gone. Returns true if it was removed. */
function takeOverIfStale(lockDir: string): boolean {
  const owner = readOwner(lockDir);
  let heldSince = owner?.at;
  if (heldSince === undefined) {
    // Owner file missing or unreadable — fall back to the directory's own
    // mtime so a half-created lock can still expire.
    try {
      heldSince = fs.statSync(lockDir).mtimeMs;
    } catch {
      return false;
    }
  }
  if (Date.now() - heldSince < timings.staleMs) return false;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    logger.warn({ lockDir, owner }, 'Vault: took over a stale lock');
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` holding the vault lock. The lock is always released, including when
 * `fn` throws. Re-entrancy is NOT provided: callers must acquire once around
 * the whole transaction and use unlocked primitives inside it.
 */
export async function withVaultLock<T>(
  vaultPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const lockDir = vaultLockPath(vaultPath);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (takeOverIfStale(lockDir)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the vault lock (${lockDir}). ` +
            'Another agent is mid-write; retry shortly.',
        );
      }
      await sleep(RETRY_MS);
    }
  }

  const beat = (): void => {
    try {
      stampOwner(lockDir);
    } catch {
      // Losing a stamp only costs stale-detection accuracy (the dir mtime
      // still bounds it, and the next beat retries); it must not fail the
      // operation.
    }
  };
  beat();
  // Keep proving we are alive for as long as the critical section runs.
  // unref'd so a heartbeat never holds the process open on its own.
  const heartbeat = setInterval(beat, timings.heartbeatMs);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (e) {
      logger.error({ lockDir, err: e }, 'Vault: failed to release lock');
    }
  }
}
