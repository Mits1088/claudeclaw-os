import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readNote,
  writeNote,
  appendToNote,
  searchNotes,
  dailyNote,
  vaultRelative,
  type VaultContext,
} from './obsidian.js';
import { ensureVaultProvisioned, getVaultRemotePath } from './vault-sync.js';

const execFileAsync = promisify(execFile);
const tmpDir = path.join(os.tmpdir(), `obsidian-rw-test-${Date.now()}`);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

async function initClone(remote: string, dir: string): Promise<void> {
  await git(path.dirname(dir), ['clone', remote, dir]);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
}

/** A git-synced vault, as the VPS workflow uses it. */
async function setupVault(): Promise<VaultContext> {
  const working = path.join(tmpDir, 'vault');
  await ensureVaultProvisioned(working, getVaultRemotePath(working));
  return { vaultPath: working, sync: true };
}

/** A plain folder of notes with no git anywhere — local-vault mode. */
function setupLocalVault(name = 'local-vault'): VaultContext {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(dir, 'Notes'), { recursive: true });
  return { vaultPath: dir, sync: false };
}

describe('obsidian read/write API', { timeout: 60_000 }, () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10 });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10 });
  });

  describe('readNote / writeNote', () => {
    it('returns null for a note that does not exist', async () => {
      const vault = await setupVault();
      expect(await readNote(vault.vaultPath, 'missing.md')).toBeNull();
    });

    it('writes a note and reads it back', async () => {
      const vault = await setupVault();
      const result = await writeNote(vault, 'Notes/hello.md', '# hello');
      expect(result.ok).toBe(true);
      expect(await readNote(vault.vaultPath, 'Notes/hello.md')).toBe('# hello');
    });

    it('publishes the write to the vault remote', async () => {
      const vault = await setupVault();
      await writeNote(vault, 'Notes/hello.md', '# hello');

      const checkout = path.join(tmpDir, 'checkout');
      await initClone(getVaultRemotePath(vault.vaultPath), checkout);
      expect(fs.readFileSync(path.join(checkout, 'Notes', 'hello.md'), 'utf-8')).toBe('# hello');
    });
  });

  describe('local-vault mode (sync: false)', () => {
    it('reads and writes an existing non-git vault without running git', async () => {
      const vault = setupLocalVault();
      fs.writeFileSync(path.join(vault.vaultPath, 'Notes', 'existing.md'), 'already here');

      expect(await readNote(vault.vaultPath, 'Notes/existing.md')).toBe('already here');
      const result = await writeNote(vault, 'Notes/new.md', 'fresh');
      expect(result.ok).toBe(true);
      expect(await readNote(vault.vaultPath, 'Notes/new.md')).toBe('fresh');

      // The whole point of local mode: nothing turned it into a repo.
      expect(fs.existsSync(path.join(vault.vaultPath, '.git'))).toBe(false);
      expect(fs.existsSync(getVaultRemotePath(vault.vaultPath))).toBe(false);
    });

    it('appends safely under concurrency with no git involved', async () => {
      const vault = setupLocalVault();
      await writeNote(vault, 'Notes/log.md', 'start');

      await Promise.all([
        appendToNote(vault, 'Notes/log.md', 'one'),
        appendToNote(vault, 'Notes/log.md', 'two'),
        appendToNote(vault, 'Notes/log.md', 'three'),
      ]);

      const content = (await readNote(vault.vaultPath, 'Notes/log.md')) ?? '';
      // Without the lock, the last writer would clobber the others.
      for (const line of ['start', 'one', 'two', 'three']) {
        expect(content).toContain(line);
      }
      expect(content.split('\n').filter(Boolean)).toHaveLength(4);
    });
  });

  describe('appendToNote', () => {
    it('creates the note when absent', async () => {
      const vault = await setupVault();
      await appendToNote(vault, 'Notes/log.md', 'first');
      expect(await readNote(vault.vaultPath, 'Notes/log.md')).toBe('first');
    });

    it('does not drop another client\'s update (reads after sync, not before)', async () => {
      const vault = await setupVault();
      await writeNote(vault, 'Notes/log.md', 'base');

      // A second client appends its own line and pushes it.
      const other = path.join(tmpDir, 'other');
      await initClone(getVaultRemotePath(vault.vaultPath), other);
      fs.writeFileSync(path.join(other, 'Notes', 'log.md'), 'base\nfrom laptop');
      await git(other, ['add', '-A']);
      await git(other, ['commit', '-m', 'laptop append']);
      await git(other, ['push']);

      // The agent appends without having seen it. Reading before the pull
      // published "base\nfrom agent" and silently removed the laptop line.
      const result = await appendToNote(vault, 'Notes/log.md', 'from agent');
      expect(result.ok).toBe(true);

      const content = (await readNote(vault.vaultPath, 'Notes/log.md')) ?? '';
      expect(content).toContain('from laptop');
      expect(content).toContain('from agent');
    });

    it('serializes concurrent appends so none are lost', async () => {
      const vault = await setupVault();
      await writeNote(vault, 'Notes/log.md', 'start');

      await Promise.all([
        appendToNote(vault, 'Notes/log.md', 'alpha'),
        appendToNote(vault, 'Notes/log.md', 'beta'),
      ]);

      const content = (await readNote(vault.vaultPath, 'Notes/log.md')) ?? '';
      expect(content).toContain('alpha');
      expect(content).toContain('beta');
    });
  });

  describe('searchNotes', () => {
    it('finds matching lines in readable folders', async () => {
      const vault = await setupVault();
      await writeNote(vault, 'Notes/a.md', 'nothing here\nthe TARGET line');
      const matches = searchNotes(vault.vaultPath, ['Notes'], 'target');
      expect(matches).toHaveLength(1);
      expect(matches[0].file).toBe('Notes/a.md');
      expect(matches[0].text).toBe('the TARGET line');
    });

    it('does not read through an allowed folder that is really an alias into a disallowed one', async () => {
      const vault = setupLocalVault('search-alias');
      const privateDir = path.join(vault.vaultPath, 'Private');
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(path.join(privateDir, 'secret.md'), 'the TARGET secret');
      // "Shared" is in the agent's read scope, but on disk it is a junction
      // onto Private, which is not.
      fs.symlinkSync(privateDir, path.join(vault.vaultPath, 'Shared'), 'junction');

      expect(searchNotes(vault.vaultPath, ['Shared'], 'target')).toEqual([]);
    });

    it('still searches a real folder that is listed alongside an aliased one', async () => {
      const vault = setupLocalVault('search-alias-2');
      fs.writeFileSync(path.join(vault.vaultPath, 'Notes', 'a.md'), 'TARGET here');
      const privateDir = path.join(vault.vaultPath, 'Private');
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(path.join(privateDir, 'secret.md'), 'TARGET there');
      fs.symlinkSync(privateDir, path.join(vault.vaultPath, 'Shared'), 'junction');

      const files = searchNotes(vault.vaultPath, ['Notes', 'Shared'], 'target').map((m) => m.file);
      expect(files).toEqual(['Notes/a.md']);
    });
  });

  describe('dailyNote', () => {
    it('creates a dated note under ClaudeClaw/<agentId>/', async () => {
      const vault = await setupVault();
      const { relPath, result } = await dailyNote(vault, 'research');
      expect(result.ok).toBe(true);
      expect(relPath).toMatch(/^ClaudeClaw\/research\/\d{4}-\d{2}-\d{2}\.md$/);
      expect(await readNote(vault.vaultPath, relPath)).not.toBeNull();
    });

    it('returns the same note on a second call the same day rather than overwriting', async () => {
      const vault = await setupVault();
      const first = await dailyNote(vault, 'research');
      await appendToNote(vault, first.relPath, 'a finding');
      const second = await dailyNote(vault, 'research');
      expect(second.relPath).toBe(first.relPath);
      expect(await readNote(vault.vaultPath, second.relPath)).toContain('a finding');
    });

    it('does not overwrite a daily note another client created (checks after sync)', async () => {
      const vault = await setupVault();
      // Seed so the remote has a branch to clone.
      await writeNote(vault, 'Notes/seed.md', 'seed');

      const today = new Date().toISOString().slice(0, 10);
      const rel = `ClaudeClaw/research/${today}.md`;

      const other = path.join(tmpDir, 'other');
      await initClone(getVaultRemotePath(vault.vaultPath), other);
      fs.mkdirSync(path.dirname(path.join(other, rel)), { recursive: true });
      fs.writeFileSync(path.join(other, rel), '# already written elsewhere\nimportant');
      await git(other, ['add', '-A']);
      await git(other, ['commit', '-m', 'daily from laptop']);
      await git(other, ['push']);

      const { result } = await dailyNote(vault, 'research');
      expect(result.ok).toBe(true);
      // Probing existence before the pull would have missed this and
      // replaced it with an empty stub.
      expect(await readNote(vault.vaultPath, rel)).toContain('important');
    });

    it('reports a sync failure instead of swallowing it', async () => {
      const vault = await setupVault();
      await writeNote(vault, 'Notes/seed.md', 'seed');
      // Break the remote so the push cannot succeed.
      fs.rmSync(getVaultRemotePath(vault.vaultPath), { recursive: true, force: true });

      const { result } = await dailyNote(vault, 'research');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('vaultRelative (per-agent scope boundary)', () => {
    it('normalizes traversal so a folder allowlist cannot be walked around', async () => {
      const vault = await setupVault();
      fs.mkdirSync(path.join(vault.vaultPath, 'Private'), { recursive: true });
      expect(vaultRelative(vault.vaultPath, 'Notes/../Private/secret.md')).toBe('Private/secret.md');
    });

    it('resolves an alias inside an allowed folder to where it really points', async () => {
      const vault = await setupVault();
      const privateDir = path.join(vault.vaultPath, 'Private');
      fs.mkdirSync(privateDir, { recursive: true });
      fs.writeFileSync(path.join(privateDir, 'secret.md'), 'CONFIDENTIAL');
      fs.mkdirSync(path.join(vault.vaultPath, 'Notes'), { recursive: true });

      // A junction (Windows) / symlink (POSIX) under an allowed folder
      // pointing at a folder the agent may not read.
      fs.symlinkSync(privateDir, path.join(vault.vaultPath, 'Notes', 'alias'), 'junction');

      // Scope must be judged by the real destination, not the alias path.
      expect(vaultRelative(vault.vaultPath, 'Notes/alias/secret.md')).toBe('Private/secret.md');
    });

    it('refuses an alias that points outside the vault entirely', async () => {
      const vault = await setupVault();
      const outside = path.join(tmpDir, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.md'), 'NOT IN THE VAULT');
      fs.mkdirSync(path.join(vault.vaultPath, 'Notes'), { recursive: true });
      fs.symlinkSync(outside, path.join(vault.vaultPath, 'Notes', 'escape'), 'junction');

      expect(() => vaultRelative(vault.vaultPath, 'Notes/escape/secret.md')).toThrow(/escapes vault/i);
    });

    it('validates the parent directory of a note that does not exist yet', async () => {
      const vault = await setupVault();
      const outside = path.join(tmpDir, 'outside2');
      fs.mkdirSync(outside, { recursive: true });
      fs.mkdirSync(path.join(vault.vaultPath, 'Notes'), { recursive: true });
      fs.symlinkSync(outside, path.join(vault.vaultPath, 'Notes', 'out'), 'junction');

      // The file does not exist, so only its parent can be checked — and the
      // parent is an alias out of the vault.
      expect(() => vaultRelative(vault.vaultPath, 'Notes/out/brand-new.md')).toThrow(/escapes vault/i);
    });

    it('normalizes Windows separators to the forward-slash form scopes use', async () => {
      const vault = await setupVault();
      fs.mkdirSync(path.join(vault.vaultPath, 'Notes', 'nested'), { recursive: true });
      expect(vaultRelative(vault.vaultPath, `Notes${path.sep}nested${path.sep}note.md`))
        .toBe('Notes/nested/note.md');
    });

    it('still refuses a path that escapes the vault lexically', async () => {
      const vault = await setupVault();
      expect(() => vaultRelative(vault.vaultPath, '../outside.md')).toThrow(/escapes vault/i);
    });
  });

  describe('writeNote conflict recovery', () => {
    it('recovers and still lands the write when another client pushed first', async () => {
      const vault = await setupVault();
      await writeNote(vault, 'Notes/seed.md', 'seed');

      const other = path.join(tmpDir, 'other');
      await initClone(getVaultRemotePath(vault.vaultPath), other);
      fs.mkdirSync(path.join(other, 'Notes'), { recursive: true });
      fs.writeFileSync(path.join(other, 'Notes', 'from-other.md'), 'from other client');
      await git(other, ['add', '-A']);
      await git(other, ['commit', '-m', 'other client note']);
      await git(other, ['push']);

      // Diverge locally without seeing that push.
      fs.writeFileSync(path.join(vault.vaultPath, 'Notes', 'local.md'), 'local work');
      await git(vault.vaultPath, ['add', '-A']);
      await git(vault.vaultPath, ['commit', '-m', 'local work']);

      const result = await writeNote(vault, 'Notes/agent-note.md', 'the agent note');

      expect(result.ok).toBe(true);
      expect(await readNote(vault.vaultPath, 'Notes/agent-note.md')).toBe('the agent note');

      const checkout = path.join(tmpDir, 'checkout');
      await initClone(getVaultRemotePath(vault.vaultPath), checkout);
      expect(fs.readFileSync(path.join(checkout, 'Notes', 'agent-note.md'), 'utf-8')).toBe('the agent note');
      expect(fs.existsSync(path.join(checkout, 'Notes', 'from-other.md'))).toBe(true);
      expect(fs.existsSync(path.join(vault.vaultPath, 'conflicts'))).toBe(true);
    });

    it('recomputes an append against the recovered content, not the rolled-back state', async () => {
      const vault = await setupVault();
      await writeNote(vault, 'Notes/log.md', 'base');

      const other = path.join(tmpDir, 'other');
      await initClone(getVaultRemotePath(vault.vaultPath), other);
      fs.writeFileSync(path.join(other, 'Notes', 'log.md'), 'base\nremote line');
      await git(other, ['add', '-A']);
      await git(other, ['commit', '-m', 'remote append']);
      await git(other, ['push']);

      // Local divergence that will be quarantined during recovery.
      fs.writeFileSync(path.join(vault.vaultPath, 'Notes', 'stray.md'), 'stray');
      await git(vault.vaultPath, ['add', '-A']);
      await git(vault.vaultPath, ['commit', '-m', 'stray local commit']);

      const result = await appendToNote(vault, 'Notes/log.md', 'agent line');
      expect(result.ok).toBe(true);

      const content = (await readNote(vault.vaultPath, 'Notes/log.md')) ?? '';
      expect(content).toContain('remote line');
      expect(content).toContain('agent line');
    });
  });
});
