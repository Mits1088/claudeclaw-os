// The generated config dir is what bounds a third-party model's tool surface.
// Measured against the real CLI on 2026-08-20:
//
//   no CLAUDE_CONFIG_DIR  → 24 MCP servers, 273 tools (CRM, mailboxes, 4x SSH)
//   empty CLAUDE_CONFIG_DIR → 0 servers
//   empty + SDK-supplied servers → exactly the supplied ones
//
// So the dir does not need to CONTAIN the allowlist — it needs to contain
// NOTHING, while ClaudeClaw keeps handing the allowlisted servers to the SDK
// directly. That is strictly better than writing server definitions to disk:
// no credential is ever serialized.
//
// These tests pin the one property that makes it work: the dir never grows an
// mcpServers block, not even one a human puts there.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCompatConfigDir, compatConfigDirName } from './anthropic-compat-config-dir.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-compat-cfg-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureCompatConfigDir', () => {
  it('creates the dir under the given root and returns its path', () => {
    const dir = ensureCompatConfigDir(root);
    expect(dir).toBe(path.join(root, compatConfigDirName));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent and keeps unrelated state across calls', () => {
    const dir = ensureCompatConfigDir(root);
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', 'marker.txt'), 'session state');
    expect(ensureCompatConfigDir(root)).toBe(dir);
    expect(fs.readFileSync(path.join(dir, 'projects', 'marker.txt'), 'utf-8')).toBe('session state');
  });

  // The whole security property in one test: whatever ends up in .claude.json,
  // an mcpServers block does not survive. Without this the dir would be just
  // another place a global server list can grow back.
  it('strips an mcpServers block that someone put there', () => {
    const dir = ensureCompatConfigDir(root);
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      userID: 'untouched',
      mcpServers: { 'ssh-mcp': { command: 'ssh-mcp', type: 'stdio' } },
    }));

    ensureCompatConfigDir(root);

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.mcpServers).toBeUndefined();
    // Everything else the CLI keeps there must survive — this is the CLI's own
    // state file, we only take the one key away.
    expect(after.userID).toBe('untouched');
  });

  it('leaves a clean .claude.json byte-identical', () => {
    const dir = ensureCompatConfigDir(root);
    const file = path.join(dir, '.claude.json');
    const content = JSON.stringify({ userID: 'abc', firstStartTime: '2026-08-20T00:00:00.000Z' }, null, 2);
    fs.writeFileSync(file, content);
    ensureCompatConfigDir(root);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  // A corrupt state file must not take the turn down: the CLI rewrites it
  // anyway, and an unparseable file cannot carry an mcpServers block.
  it('tolerates an unparseable .claude.json', () => {
    const dir = ensureCompatConfigDir(root);
    fs.writeFileSync(path.join(dir, '.claude.json'), 'not json {{{');
    expect(() => ensureCompatConfigDir(root)).not.toThrow();
  });

  it('does not create a settings.json that could re-add servers', () => {
    const dir = ensureCompatConfigDir(root);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });
});
