import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), `obsidian-local-test-${Date.now()}`);
const vaultDir = path.join(tmpRoot, 'my-existing-vault');
const storeDir = path.join(tmpRoot, 'store');

vi.mock('./config.js', () => ({
  get PROJECT_ROOT() { return tmpRoot; },
  get STORE_DIR() { return storeDir; },
}));

// Spy on the process-spawn primitive every git call in vault-sync goes
// through. Asserting "no .git directory" only shows git did not SUCCEED at
// creating a repo; this shows no git command was ATTEMPTED at all.
const execFileCalls: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (cmd: string, args: string[], ...rest: unknown[]) => {
      execFileCalls.push([cmd, ...(args ?? [])]);
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(cmd, args, ...rest);
    },
  };
});

const { writeNote, appendToNote, readNote, dailyNote } = await import('./obsidian.js');

const gitCalls = (): string[][] => execFileCalls.filter((c) => /(^|[\\/])git(\.exe)?$/i.test(c[0]));

describe('local-vault mode runs no git', { timeout: 30_000 }, () => {
  const vault = { vaultPath: vaultDir, sync: false };

  beforeEach(() => {
    execFileCalls.length = 0;
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
    fs.mkdirSync(path.join(vaultDir, 'Notes'), { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    // A vault the user already had, with no git anywhere near it.
    fs.writeFileSync(path.join(vaultDir, 'Notes', 'existing.md'), 'my notes');
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  it('reads an existing non-git vault without invoking git', async () => {
    expect(await readNote(vaultDir, 'Notes/existing.md')).toBe('my notes');
    expect(gitCalls()).toEqual([]);
  });

  it('writes without invoking git', async () => {
    const result = await writeNote(vault, 'Notes/new.md', 'fresh');
    expect(result.ok).toBe(true);
    expect(await readNote(vaultDir, 'Notes/new.md')).toBe('fresh');
    expect(gitCalls()).toEqual([]);
  });

  it('appends without invoking git', async () => {
    await appendToNote(vault, 'Notes/existing.md', 'appended');
    expect(await readNote(vaultDir, 'Notes/existing.md')).toBe('my notes\nappended');
    expect(gitCalls()).toEqual([]);
  });

  it('creates a daily note without invoking git', async () => {
    const { relPath, result } = await dailyNote(vault, 'research');
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, relPath))).toBe(true);
    expect(gitCalls()).toEqual([]);
  });

  it('leaves the vault a plain folder — no repo, no bare remote', async () => {
    await writeNote(vault, 'Notes/a.md', 'a');
    await appendToNote(vault, 'Notes/a.md', 'b');
    expect(fs.existsSync(path.join(vaultDir, '.git'))).toBe(false);
    expect(fs.existsSync(`${vaultDir}.git`)).toBe(false);
    expect(gitCalls()).toEqual([]);
  });

  it('still serializes concurrent writes with no git involved', async () => {
    await writeNote(vault, 'Notes/log.md', 'start');
    await Promise.all([
      appendToNote(vault, 'Notes/log.md', 'one'),
      appendToNote(vault, 'Notes/log.md', 'two'),
      appendToNote(vault, 'Notes/log.md', 'three'),
    ]);
    const content = (await readNote(vaultDir, 'Notes/log.md')) ?? '';
    expect(content.split('\n').filter(Boolean)).toHaveLength(4);
    expect(gitCalls()).toEqual([]);
  });
});
