import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ensureVaultProvisioned,
  pullFF,
  commitAndPush,
  quarantineConflicts,
} from './vault-sync.js';

const execFileAsync = promisify(execFile);

const tmpDir = path.join(os.tmpdir(), `vault-sync-test-${Date.now()}`);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

async function initClone(remote: string, dir: string): Promise<void> {
  await git(path.dirname(dir), ['clone', remote, dir]);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
}

async function commitFile(dir: string, relPath: string, content: string, message: string): Promise<void> {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
}

// Each test drives several real git subprocesses against local repos, which
// is slower than mocked I/O — give it real headroom rather than tuning to
// this machine's current speed.
describe('vault-sync', { timeout: 20_000 }, () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10 });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10 });
  });

  describe('ensureVaultProvisioned', () => {
    it('creates a bare remote and a working copy when neither exists', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const working = path.join(tmpDir, 'vault');

      await ensureVaultProvisioned(working, remote);

      expect(fs.existsSync(path.join(remote, 'HEAD'))).toBe(true);
      expect(fs.existsSync(path.join(working, '.git'))).toBe(true);
    });

    it('sets a local git identity on the working copy so commits succeed', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const working = path.join(tmpDir, 'vault');

      await ensureVaultProvisioned(working, remote);
      fs.writeFileSync(path.join(working, 'note.md'), '# hello');
      await git(working, ['add', '-A']);
      // Would throw "Author identity unknown" if user.name/email weren't set.
      await expect(git(working, ['commit', '-m', 'test commit'])).resolves.toBeDefined();
    });

    it('adopts a pre-existing vault directory instead of failing on clone', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const working = path.join(tmpDir, 'vault');

      // The user already keeps notes here — git clone refuses a non-empty
      // target, which used to abort provisioning outright.
      fs.mkdirSync(path.join(working, 'Notes'), { recursive: true });
      fs.writeFileSync(path.join(working, 'Notes', 'existing.md'), 'my notes');

      await ensureVaultProvisioned(working, remote);

      expect(fs.existsSync(path.join(working, '.git'))).toBe(true);
      // The pre-existing note is untouched locally...
      expect(fs.readFileSync(path.join(working, 'Notes', 'existing.md'), 'utf-8')).toBe('my notes');
      // ...and published, so another client cloning the vault gets it.
      const checkout = path.join(tmpDir, 'checkout');
      await initClone(remote, checkout);
      expect(fs.readFileSync(path.join(checkout, 'Notes', 'existing.md'), 'utf-8')).toBe('my notes');
    });

    it('is idempotent: calling twice does not error or wipe existing content', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const working = path.join(tmpDir, 'vault');

      await ensureVaultProvisioned(working, remote);
      fs.writeFileSync(path.join(working, 'keep.md'), 'important');
      await git(working, ['add', '-A']);
      await git(working, ['commit', '-m', 'keep']);

      await ensureVaultProvisioned(working, remote);

      expect(fs.readFileSync(path.join(working, 'keep.md'), 'utf-8')).toBe('important');
    });
  });

  describe('pullFF', () => {
    it('returns ok:true when already up to date', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const seed = path.join(tmpDir, 'seed');
      await git(tmpDir, ['init', '--bare', remote]);
      await initClone(remote, seed);
      await commitFile(seed, 'a.md', 'a', 'init');
      await git(seed, ['push', 'origin', 'HEAD']);

      const working = path.join(tmpDir, 'working');
      await initClone(remote, working);

      const result = await pullFF(working);
      expect(result.ok).toBe(true);
    });

    it('fast-forwards and pulls in a remote change', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const seed = path.join(tmpDir, 'seed');
      await git(tmpDir, ['init', '--bare', remote]);
      await initClone(remote, seed);
      await commitFile(seed, 'a.md', 'a', 'init');
      await git(seed, ['push', 'origin', 'HEAD']);

      const working = path.join(tmpDir, 'working');
      await initClone(remote, working);

      // Another writer pushes a new commit.
      await commitFile(seed, 'b.md', 'b', 'add b');
      await git(seed, ['push', 'origin', 'HEAD']);

      const result = await pullFF(working);
      expect(result.ok).toBe(true);
      expect(fs.existsSync(path.join(working, 'b.md'))).toBe(true);
    });

    it('returns ok:false when history has diverged', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const seed = path.join(tmpDir, 'seed');
      await git(tmpDir, ['init', '--bare', remote]);
      await initClone(remote, seed);
      await commitFile(seed, 'a.md', 'a', 'init');
      await git(seed, ['push', 'origin', 'HEAD']);

      const working = path.join(tmpDir, 'working');
      await initClone(remote, working);

      // Remote gets a new commit...
      await commitFile(seed, 'b.md', 'b', 'add b');
      await git(seed, ['push', 'origin', 'HEAD']);

      // ...while working also makes its own unpushed local commit.
      await commitFile(working, 'c.md', 'c', 'add c locally');

      const result = await pullFF(working);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('commitAndPush', () => {
    it('commits and pushes a new file', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const working = path.join(tmpDir, 'working');
      await ensureVaultProvisioned(working, remote);

      fs.writeFileSync(path.join(working, 'note.md'), 'hello');
      const result = await commitAndPush(working, 'add note');
      expect(result.ok).toBe(true);

      const checkout = path.join(tmpDir, 'checkout');
      await initClone(remote, checkout);
      expect(fs.readFileSync(path.join(checkout, 'note.md'), 'utf-8')).toBe('hello');
    });

    it('is a no-op success when there is nothing to commit', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const working = path.join(tmpDir, 'working');
      await ensureVaultProvisioned(working, remote);

      const result = await commitAndPush(working, 'nothing changed');
      expect(result.ok).toBe(true);
    });

    it('still pushes commits that never reached the remote', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const working = path.join(tmpDir, 'working');
      await ensureVaultProvisioned(working, remote);

      // A commit made outside commitAndPush and never pushed — previously
      // "nothing to commit" returned ok WITHOUT pushing, so the caller was
      // told the vault had synced while the remote never saw this note.
      await commitFile(working, 'orphan.md', 'never pushed', 'local only');

      const result = await commitAndPush(working, 'nothing new to stage');
      expect(result.ok).toBe(true);

      const checkout = path.join(tmpDir, 'checkout');
      await initClone(remote, checkout);
      expect(fs.existsSync(path.join(checkout, 'orphan.md'))).toBe(true);
    });
  });

  describe('quarantineConflicts', () => {
    it('moves locally-diverged files into conflicts/<timestamp>/ and resets to match remote', async () => {
      const remote = path.join(tmpDir, 'vault.git');
      const seed = path.join(tmpDir, 'seed');
      await git(tmpDir, ['init', '--bare', remote]);
      await initClone(remote, seed);
      await commitFile(seed, 'a.md', 'a', 'init');
      await git(seed, ['push', 'origin', 'HEAD']);

      const working = path.join(tmpDir, 'working');
      await initClone(remote, working);

      // Remote diverges...
      await commitFile(seed, 'b.md', 'remote-b', 'add b remotely');
      await git(seed, ['push', 'origin', 'HEAD']);

      // ...while working makes its own unpushed local commit touching c.md.
      await commitFile(working, 'c.md', 'local-c', 'add c locally');

      const preFail = await pullFF(working);
      expect(preFail.ok).toBe(false);

      const quarantined = await quarantineConflicts(working);

      expect(quarantined).toContain('c.md');
      // The working copy is now reset to match remote: b.md present, in sync.
      expect(fs.existsSync(path.join(working, 'b.md'))).toBe(true);
      const postFix = await pullFF(working);
      expect(postFix.ok).toBe(true);

      // The quarantined file's original local content is preserved somewhere
      // under conflicts/.
      const conflictsDir = path.join(working, 'conflicts');
      expect(fs.existsSync(conflictsDir)).toBe(true);
      const found = findFileRecursive(conflictsDir, 'c.md');
      expect(found).not.toBeNull();
      expect(fs.readFileSync(found!, 'utf-8')).toBe('local-c');
    });

    it('preserves a diverged note whose filename is not plain ASCII', async () => {
      // git quotes and octal-escapes non-ASCII paths ("Notes/caf\303\251.md")
      // unless asked for -z output. Parsing the quoted form matched nothing on
      // disk, so the file was skipped here and then destroyed by reset --hard.
      const accented = 'Notes/réunion-café.md';
      const remote = path.join(tmpDir, 'vault.git');
      const seed = path.join(tmpDir, 'seed');
      await git(tmpDir, ['init', '--bare', remote]);
      await initClone(remote, seed);
      await commitFile(seed, accented, 'ORIGINAL', 'init accented note');
      await git(seed, ['push', 'origin', 'HEAD']);

      const working = path.join(tmpDir, 'working');
      await initClone(remote, working);

      // Remote edits it...
      await commitFile(seed, accented, 'REMOTE EDIT', 'remote edits accented');
      await git(seed, ['push', 'origin', 'HEAD']);
      // ...while the working copy commits its own version.
      await commitFile(working, accented, 'LOCAL EDIT', 'local edits accented');

      expect((await pullFF(working)).ok).toBe(false);

      const quarantined = await quarantineConflicts(working);

      expect(quarantined).toContain(accented);
      const found = findFileRecursive(path.join(working, 'conflicts'), 'réunion-café.md');
      expect(found).not.toBeNull();
      expect(fs.readFileSync(found!, 'utf-8')).toBe('LOCAL EDIT');
    });
  });
});

function findFileRecursive(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}
