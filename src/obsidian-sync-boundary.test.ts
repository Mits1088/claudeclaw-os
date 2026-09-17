import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), `obsidian-sync-boundary-${Date.now()}`);
const storeDir = path.join(tmpRoot, 'store');
const vaultDir = path.join(tmpRoot, 'vault');

vi.mock('./config.js', () => ({
  get STORE_DIR() { return storeDir; },
  get PROJECT_ROOT() { return tmpRoot; },
}));

// Stand in for git: "pull" runs whatever the test planted, so the filesystem
// can change exactly at the sync boundary inside the write transaction — the
// moment another client's commit lands in the working copy.
let onPull: (() => void) | undefined;
vi.mock('./vault-sync.js', () => ({
  pullFF: async () => { onPull?.(); return { ok: true }; },
  commitAndPush: async () => ({ ok: true }),
  quarantineConflicts: async () => [],
}));

const { writeNote, appendToNote, vaultRelative } = await import('./obsidian.js');

describe('write scope survives the sync boundary', { timeout: 30_000 }, () => {
  beforeEach(() => {
    onPull = undefined;
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
    fs.mkdirSync(path.join(vaultDir, 'Notes', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'Private'), { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  it('refuses a target that a pull turned into an alias out of its folder', async () => {
    const ctx = { vaultPath: vaultDir, sync: true };

    // The permission layer checks scope against the resolved path first — at
    // this point Notes/sub is a real directory, so the check passes.
    expect(vaultRelative(vaultDir, 'Notes/sub/x.md')).toBe('Notes/sub/x.md');

    // Then the pull replaces Notes/sub with a junction onto Private/.
    onPull = () => {
      fs.rmdirSync(path.join(vaultDir, 'Notes', 'sub'));
      fs.symlinkSync(path.join(vaultDir, 'Private'), path.join(vaultDir, 'Notes', 'sub'), 'junction');
    };

    await expect(writeNote(ctx, 'Notes/sub/x.md', 'leaked')).rejects.toThrow(/resolves to Private\/x\.md/);
    expect(fs.existsSync(path.join(vaultDir, 'Private', 'x.md'))).toBe(false);
  });

  it('refuses an append the same way', async () => {
    const ctx = { vaultPath: vaultDir, sync: true };
    fs.writeFileSync(path.join(vaultDir, 'Private', 'x.md'), 'original');
    onPull = () => {
      fs.rmdirSync(path.join(vaultDir, 'Notes', 'sub'));
      fs.symlinkSync(path.join(vaultDir, 'Private'), path.join(vaultDir, 'Notes', 'sub'), 'junction');
    };

    await expect(appendToNote(ctx, 'Notes/sub/x.md', 'leaked')).rejects.toThrow(/resolves to/);
    expect(fs.readFileSync(path.join(vaultDir, 'Private', 'x.md'), 'utf-8')).toBe('original');
  });

  it('still writes when the pull changes nothing about where the path lands', async () => {
    const ctx = { vaultPath: vaultDir, sync: true };
    onPull = () => { fs.writeFileSync(path.join(vaultDir, 'Notes', 'other.md'), 'unrelated'); };

    expect(await writeNote(ctx, 'Notes/sub/x.md', 'fine')).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(vaultDir, 'Notes', 'sub', 'x.md'), 'utf-8')).toBe('fine');
  });

  it('accepts a ./-prefixed spelling of the same path', async () => {
    const ctx = { vaultPath: vaultDir, sync: true };
    // checkScope passes the resolved forward-slash rel; a raw caller might
    // prefix ./. That is not an alias, so it must write.
    expect(await writeNote(ctx, './Notes/sub/y.md', 'a')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(vaultDir, 'Notes', 'sub', 'y.md'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('accepts the Windows separator spelling of the same path', async () => {
    // Only where `\` IS the separator: on POSIX it is a filename character
    // and `Notes\sub\z.md` really is one file at the vault root.
    const ctx = { vaultPath: vaultDir, sync: true };
    expect(await writeNote(ctx, 'Notes\\sub\\z.md', 'b')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(vaultDir, 'Notes', 'sub', 'z.md'))).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('treats a backslash as a filename character on POSIX', async () => {
    const ctx = { vaultPath: vaultDir, sync: true };
    expect(await writeNote(ctx, 'Notes/sub/a\\b.md', 'c')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(vaultDir, 'Notes', 'sub', 'a\\b.md'))).toBe(true);
  });
});
