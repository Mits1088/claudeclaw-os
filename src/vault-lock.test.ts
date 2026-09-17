import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), `vault-lock-test-${Date.now()}`);
const storeDir = path.join(tmpRoot, 'store');
const vaultDir = path.join(tmpRoot, 'vault');

vi.mock('./config.js', () => ({
  get STORE_DIR() { return storeDir; },
  get PROJECT_ROOT() { return tmpRoot; },
}));

const { withVaultLock, vaultLockPath, _setVaultLockTimings } = await import('./vault-lock.js');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Create the lock exactly as a DIFFERENT process would: the lock is pure
 *  filesystem state, so this is a faithful stand-in for a peer holding it. */
function foreignHolderTakesLock(ageMs = 0): string {
  const dir = vaultLockPath(vaultDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({ pid: process.pid + 1, at: Date.now() - ageMs }),
  );
  return dir;
}

describe('withVaultLock', { timeout: 30_000 }, () => {
  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  it('keeps the lock OUTSIDE the vault so git add -A cannot commit it', () => {
    const lock = vaultLockPath(vaultDir);
    expect(path.relative(path.resolve(vaultDir), lock).startsWith('..')).toBe(true);
  });

  it('maps a vault path to a stable lock path', () => {
    expect(vaultLockPath(vaultDir)).toBe(vaultLockPath(vaultDir));
    expect(vaultLockPath(vaultDir)).not.toBe(vaultLockPath(path.join(tmpRoot, 'other-vault')));
  });

  it('maps every filesystem path to the same vault onto ONE lock', () => {
    // A junction (or symlink) is a different string for the same directory;
    // two writers reaching the vault through different names must still
    // exclude each other.
    const alias = path.join(tmpRoot, 'vault-alias');
    fs.symlinkSync(vaultDir, alias, 'junction');
    expect(vaultLockPath(alias)).toBe(vaultLockPath(vaultDir));
    // Relative spelling and trailing separators are the same vault too.
    expect(vaultLockPath(vaultDir + path.sep)).toBe(vaultLockPath(vaultDir));
  });

  it('does not throw for a vault path that does not exist yet', () => {
    expect(() => vaultLockPath(path.join(tmpRoot, 'not-provisioned'))).not.toThrow();
  });

  it('keeps a long-running holder lock alive past the stale window', async () => {
    // A slow push can outlive a fixed staleness window; the holder must keep
    // proving it is alive so a waiter does not reclaim the lock underneath it.
    _setVaultLockTimings({ staleMs: 200, heartbeatMs: 40 });
    try {
      const events: string[] = [];
      const slow = withVaultLock(vaultDir, async () => {
        events.push('slow:enter');
        await sleep(600); // 3x the stale window
        events.push('slow:exit');
      });
      await sleep(50);
      const eager = withVaultLock(vaultDir, async () => { events.push('eager:enter'); }, 5_000);
      await Promise.all([slow, eager]);
      expect(events).toEqual(['slow:enter', 'slow:exit', 'eager:enter']);
    } finally {
      _setVaultLockTimings();
    }
  });

  it('still reclaims a lock whose holder stopped heartbeating', async () => {
    _setVaultLockTimings({ staleMs: 200, heartbeatMs: 40 });
    try {
      foreignHolderTakesLock(250); // stamped once, never refreshed: dead
      expect(await withVaultLock(vaultDir, async () => 'proceeded', 5_000)).toBe('proceeded');
    } finally {
      _setVaultLockTimings();
    }
  });

  it('serializes overlapping critical sections', async () => {
    const events: string[] = [];
    const task = (name: string) =>
      withVaultLock(vaultDir, async () => {
        events.push(`${name}:enter`);
        await sleep(60);
        events.push(`${name}:exit`);
      });

    await Promise.all([task('a'), task('b'), task('c')]);

    // Never interleaved: every enter is immediately followed by its own exit.
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i + 1]).toBe(events[i].replace(':enter', ':exit'));
    }
    expect(events).toHaveLength(6);
  });

  it('waits for a lock held by another process, then proceeds once released', async () => {
    const heldDir = foreignHolderTakesLock();
    let ran = false;

    const pending = withVaultLock(vaultDir, async () => { ran = true; });

    await sleep(150);
    expect(ran).toBe(false); // still blocked by the peer

    fs.rmSync(heldDir, { recursive: true, force: true }); // peer finishes
    await pending;
    expect(ran).toBe(true);
  });

  it('takes over a lock abandoned by a dead process', async () => {
    // Older than the staleness window: the holder never released it.
    foreignHolderTakesLock(60_000);
    const ran = await withVaultLock(vaultDir, async () => 'proceeded');
    expect(ran).toBe('proceeded');
  });

  it('times out rather than hanging forever when a peer keeps the lock', async () => {
    foreignHolderTakesLock();
    await expect(
      withVaultLock(vaultDir, async () => 'never', 300),
    ).rejects.toThrow(/Timed out .* waiting for the vault lock/);
  });

  it('releases the lock when the critical section throws', async () => {
    await expect(
      withVaultLock(vaultDir, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');

    expect(fs.existsSync(vaultLockPath(vaultDir))).toBe(false);
    // And the next caller is not wedged.
    expect(await withVaultLock(vaultDir, async () => 'ok')).toBe('ok');
  });
});
