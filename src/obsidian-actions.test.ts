import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), `obsidian-actions-test-${Date.now()}`);
const vaultDir = path.join(tmpRoot, 'vault');
const storeDir = path.join(tmpRoot, 'store');

// Runtime settings + agent config are the two inputs the permission layer
// reads; drive them directly rather than standing up a database and an
// agents/ tree.
let settingValue: string;
let agentObsidian: Record<string, unknown> | undefined;

// Mirrors the real db module's contract: the handle is opened lazily, and
// reading a setting before ensureDatabase() has run throws. The stdio
// dispatch bridge builds its tool list before any action runs, so anything
// reading the Obsidian setting must open the store itself.
let dbOpen = false;
vi.mock('./db.js', () => ({
  ensureDatabase: () => { dbOpen = true; },
  getDashboardSetting: () => {
    if (!dbOpen) throw new TypeError("Cannot read properties of undefined (reading 'prepare')");
    return settingValue;
  },
}));

vi.mock('./config.js', () => ({
  get PROJECT_ROOT() { return tmpRoot; },
  get STORE_DIR() { return storeDir; },
  CLAUDECLAW_CONFIG: '',
  WARROOM_TMP_DIR: '',
}));

vi.mock('./agent-config.js', () => ({
  loadAgentConfig: (id: string) => {
    if (id === 'unknown') throw new Error('no such agent');
    return { obsidian: agentObsidian };
  },
}));

const {
  actionObsidianRead,
  actionObsidianWrite,
  actionObsidianAppend,
  actionObsidianDaily,
  actionObsidianList,
} = await import('./obsidian-actions.js');
const { dispatchToolDefinitions } = await import('./dispatch-tools.js');

function setRuntime(over: Record<string, unknown> = {}): void {
  settingValue = JSON.stringify({ enabled: true, sync: false, vaultPath: vaultDir, ...over });
}

/** Call an obsidian tool through the dispatch front door. */
async function viaDispatch(name: string, args: Record<string, unknown>): Promise<string> {
  const def = dispatchToolDefinitions().find((d) => d.name === name);
  if (!def) throw new Error(`tool ${name} not registered`);
  const res = await def.handler(args);
  return `${res.isError ? 'ERROR: ' : ''}${res.content[0].text}`;
}

describe('obsidian actions (shared permission layer)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    dbOpen = true;
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
    fs.mkdirSync(path.join(vaultDir, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, 'Private'), { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'Notes', 'ok.md'), 'readable');
    fs.writeFileSync(path.join(vaultDir, 'Private', 'secret.md'), 'CONFIDENTIAL');
    process.env.CLAUDECLAW_AGENT_ID = 'research';
    agentObsidian = { folders: ['Notes'], readOnly: [], writeFolders: ['Notes'] };
    setRuntime();
  });

  afterAll(() => {
    delete process.env.CLAUDECLAW_AGENT_ID;
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10 });
  });

  describe('master switch', () => {
    it('refuses every action while obsidian is disabled', async () => {
      // Execution-time enforcement. Exposure is a separate boundary — when
      // disabled the tools are not offered at all, so this asserts the
      // actions directly rather than through a tool that no longer exists.
      setRuntime({ enabled: false });
      await expect(actionObsidianRead('Notes/ok.md')).rejects.toThrow(/not enabled/i);
      await expect(actionObsidianWrite('Notes/x.md', 'x')).rejects.toThrow(/not enabled/i);
      await expect(actionObsidianAppend('Notes/x.md', 'x')).rejects.toThrow(/not enabled/i);
      await expect(actionObsidianDaily()).rejects.toThrow(/not enabled/i);
      await expect(actionObsidianList('Notes')).rejects.toThrow(/not enabled/i);
    });
  });

  describe('read scope', () => {
    it('reads inside the agent\'s folders', async () => {
      expect(await actionObsidianRead('Notes/ok.md')).toBe('readable');
    });

    it('refuses a folder the agent cannot read', async () => {
      await expect(actionObsidianRead('Private/secret.md')).rejects.toThrow(/cannot read/i);
    });

    it('refuses traversal out of an allowed folder', async () => {
      await expect(actionObsidianRead('Notes/../Private/secret.md')).rejects.toThrow(/cannot read/i);
    });

    it('refuses an alias from an allowed folder into a disallowed one', async () => {
      fs.symlinkSync(path.join(vaultDir, 'Private'), path.join(vaultDir, 'Notes', 'alias'), 'junction');
      await expect(actionObsidianRead('Notes/alias/secret.md')).rejects.toThrow(/cannot read/i);
    });

    it('refuses an alias that leaves the vault', async () => {
      const outside = path.join(tmpRoot, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE');
      fs.symlinkSync(outside, path.join(vaultDir, 'Notes', 'escape'), 'junction');
      await expect(actionObsidianRead('Notes/escape/secret.md')).rejects.toThrow(/escapes vault/i);
    });
  });

  describe('write scope', () => {
    it('writes inside write_folders', async () => {
      expect(await actionObsidianWrite('Notes/new.md', 'hi')).toMatch(/Wrote Notes\/new\.md/);
    });

    it('refuses a write outside write_folders', async () => {
      await expect(actionObsidianWrite('Private/x.md', 'hi')).rejects.toThrow(/cannot write/i);
    });

    it('refuses a write whose PARENT directory aliases out of the vault', async () => {
      const outside = path.join(tmpRoot, 'outside-w');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(vaultDir, 'Notes', 'out'), 'junction');
      await expect(actionObsidianWrite('Notes/out/new.md', 'hi')).rejects.toThrow(/escapes vault/i);
      expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
    });

    it('refuses an append outside write_folders', async () => {
      await expect(actionObsidianAppend('Private/x.md', 'hi')).rejects.toThrow(/cannot write/i);
    });
  });

  describe('daily note permissions', () => {
    it('refuses when ClaudeClaw is not in write_folders', async () => {
      // It used to write regardless, so an agent with no write scope at all
      // could still put files in the vault.
      await expect(actionObsidianDaily()).rejects.toThrow(/cannot write/i);
    });

    it('writes the daily note when ClaudeClaw is in write_folders', async () => {
      agentObsidian = { folders: ['Notes'], writeFolders: ['Notes', 'ClaudeClaw'] };
      const rel = await actionObsidianDaily();
      expect(rel).toMatch(/^ClaudeClaw\/research\/\d{4}-\d{2}-\d{2}\.md$/);
      expect(fs.existsSync(path.join(vaultDir, rel))).toBe(true);
    });
  });

  describe('acting agent comes from the runtime, not the caller', () => {
    it('uses CLAUDECLAW_AGENT_ID for scope decisions', async () => {
      process.env.CLAUDECLAW_AGENT_ID = 'research';
      agentObsidian = { folders: ['Notes'], writeFolders: [] };
      await expect(actionObsidianWrite('Notes/x.md', 'x')).rejects.toThrow(/cannot write/i);
    });

    it('exposes no agent parameter on any obsidian dispatch tool', () => {
      const obsidianTools = dispatchToolDefinitions().filter((d) => d.name.startsWith('obsidian_'));
      expect(obsidianTools.length).toBeGreaterThan(0);
      for (const t of obsidianTools) {
        expect(Object.keys(t.schema)).not.toContain('agent');
        expect(Object.keys(t.schema)).not.toContain('agent_id');
      }
    });
  });

  describe('CLI / dispatch permission parity', () => {
    it('applies the same read denial through both front doors', async () => {
      const direct = await actionObsidianRead('Notes/ok.md');
      expect(await viaDispatch('obsidian_read', { path: 'Notes/ok.md' })).toBe(direct);

      await expect(actionObsidianRead('Private/secret.md')).rejects.toThrow(/cannot read/i);
      expect(await viaDispatch('obsidian_read', { path: 'Private/secret.md' })).toMatch(/ERROR: .*cannot read/i);
    });

    it('applies the same write denial through both front doors', async () => {
      await expect(actionObsidianWrite('Private/x.md', 'v')).rejects.toThrow(/cannot write/i);
      expect(await viaDispatch('obsidian_write', { path: 'Private/x.md', content: 'v' }))
        .toMatch(/ERROR: .*cannot write/i);
    });

    it('applies the same daily-note denial through both front doors', async () => {
      await expect(actionObsidianDaily()).rejects.toThrow(/cannot write/i);
      expect(await viaDispatch('obsidian_daily', {})).toMatch(/ERROR: .*cannot write/i);
    });
  });

  describe('exposure gating (nothing is offered that cannot be used)', () => {
    const obsidianToolNames = () =>
      dispatchToolDefinitions().map((d) => d.name).filter((n) => n.startsWith('obsidian_'));

    it('offers the vault tools when enabled and the agent has scope', () => {
      expect(obsidianToolNames().sort()).toEqual([
        'obsidian_append', 'obsidian_daily', 'obsidian_list',
        'obsidian_read', 'obsidian_search', 'obsidian_write',
      ]);
    });

    it('offers NO vault tools when the install has Obsidian disabled', () => {
      setRuntime({ enabled: false });
      expect(obsidianToolNames()).toEqual([]);
      // The other dispatch tools are unaffected.
      expect(dispatchToolDefinitions().length).toBeGreaterThan(0);
    });

    it('offers NO vault tools to an agent with no obsidian block', () => {
      agentObsidian = undefined;
      expect(obsidianToolNames()).toEqual([]);
    });

    it('offers NO vault tools to an agent whose scopes are all empty', () => {
      // A block that grants nothing is no access, not access that denies.
      agentObsidian = { folders: [], readOnly: [], writeFolders: [] };
      expect(obsidianToolNames()).toEqual([]);
    });

    it('fails closed when the agent config cannot be read', () => {
      process.env.CLAUDECLAW_AGENT_ID = 'unknown';
      expect(obsidianToolNames()).toEqual([]);
    });

    it('offers the vault tools even when the store has not been opened yet', () => {
      // The stdio dispatch bridge builds its tool list before any action has
      // run, so nothing has opened the database. Reading the setting must
      // open it rather than throwing — otherwise fail-closed would hide the
      // vault tools from that transport entirely, even when enabled.
      dbOpen = false;
      expect(obsidianToolNames()).toHaveLength(6);
    });

    it('still enforces permissions at execution after the feature is disabled', async () => {
      // A turn can hold a tool handle obtained while the feature was on.
      const read = dispatchToolDefinitions().find((d) => d.name === 'obsidian_read');
      expect(read).toBeDefined();

      setRuntime({ enabled: false });

      const res = await read!.handler({ path: 'Notes/ok.md' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/not enabled/i);
      await expect(actionObsidianRead('Notes/ok.md')).rejects.toThrow(/not enabled/i);
    });
  });

  describe('list', () => {
    it('lists markdown in a readable folder', async () => {
      expect(await actionObsidianList('Notes')).toEqual(['ok.md']);
    });

    it('refuses a folder outside read scope', async () => {
      await expect(actionObsidianList('Private')).rejects.toThrow(/cannot read/i);
    });

    it('refuses an empty folder argument rather than listing the vault root', async () => {
      await expect(actionObsidianList('')).rejects.toThrow(/Specify a folder/i);
    });
  });
});
