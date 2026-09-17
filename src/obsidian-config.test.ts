import { describe, it, expect } from 'vitest';
import path from 'path';

import {
  validateObsidianConfigJson,
  parseObsidianConfigJson,
  resolveVaultDir,
  defaultVaultDir,
  DEFAULT_OBSIDIAN_CONFIG,
} from './obsidian-config.js';

describe('validateObsidianConfigJson', () => {
  it('accepts a well-formed payload', () => {
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: true, vaultName: 'My Vault' }))).toBeNull();
  });

  it('rejects non-JSON value', () => {
    expect(validateObsidianConfigJson('not json {')).toMatch(/obsidian_config/);
  });

  it('rejects a JSON array', () => {
    expect(validateObsidianConfigJson('[]')).toMatch(/must be a JSON object/);
  });

  it('rejects a non-boolean enabled', () => {
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: 'yes', vaultName: 'x' }))).toMatch(/enabled must be boolean/);
  });

  it('rejects a non-string vaultName', () => {
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: true, vaultName: 42 }))).toMatch(/vaultName must be a string/);
  });

  it('rejects a vaultName over 80 chars', () => {
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: true, vaultName: 'x'.repeat(81) }))).toMatch(/vaultName/);
  });

  it('allows vaultName to be omitted', () => {
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: false }))).toBeNull();
  });
});

describe('parseObsidianConfigJson', () => {
  it('returns defaults when given undefined', () => {
    expect(parseObsidianConfigJson(undefined)).toEqual(DEFAULT_OBSIDIAN_CONFIG);
  });

  it('returns defaults when given malformed JSON', () => {
    expect(parseObsidianConfigJson('not json')).toEqual(DEFAULT_OBSIDIAN_CONFIG);
  });

  it('parses a well-formed payload', () => {
    expect(parseObsidianConfigJson(JSON.stringify({
      enabled: true,
      vaultName: 'Brain',
      vaultPath: path.join(path.sep, 'srv', 'vault'),
      sync: false,
    }))).toEqual({
      enabled: true,
      vaultName: 'Brain',
      vaultPath: path.join(path.sep, 'srv', 'vault'),
      sync: false,
    });
  });

  it('fills in missing fields with the defaults', () => {
    expect(parseObsidianConfigJson(JSON.stringify({ enabled: true })))
      .toEqual({
        enabled: true,
        vaultName: DEFAULT_OBSIDIAN_CONFIG.vaultName,
        vaultPath: DEFAULT_OBSIDIAN_CONFIG.vaultPath,
        sync: DEFAULT_OBSIDIAN_CONFIG.sync,
      });
  });

  it('defaults sync to on, so an existing install keeps its git-backed vault', () => {
    expect(DEFAULT_OBSIDIAN_CONFIG.sync).toBe(true);
    expect(parseObsidianConfigJson(JSON.stringify({ enabled: true })).sync).toBe(true);
  });
});

describe('validateObsidianConfigJson — vaultPath and sync', () => {
  it('accepts an absolute vaultPath', () => {
    expect(validateObsidianConfigJson(JSON.stringify({
      enabled: true, vaultPath: path.join(path.sep, 'srv', 'vault'),
    }))).toBeNull();
  });

  it('accepts an empty vaultPath, meaning the managed default', () => {
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: true, vaultPath: '' }))).toBeNull();
  });

  it('rejects a relative vaultPath', () => {
    // Agent, dashboard and scheduler processes each have a different cwd, so
    // a relative path would resolve differently depending on the caller.
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: true, vaultPath: 'my-vault' })))
      .toMatch(/absolute path/i);
  });

  it('rejects a non-boolean sync', () => {
    expect(validateObsidianConfigJson(JSON.stringify({ enabled: true, sync: 'yes' })))
      .toMatch(/sync must be boolean/i);
  });
});

describe('resolveVaultDir', () => {
  const runtime = { enabled: true, vaultName: 'v', vaultPath: '', sync: true };

  it('prefers the agent\'s own vault override', () => {
    const agentVault = path.join(path.sep, 'agent', 'vault');
    expect(resolveVaultDir(agentVault, { ...runtime, vaultPath: path.join(path.sep, 'configured') }))
      .toBe(path.resolve(agentVault));
  });

  it('falls back to the configured vaultPath', () => {
    const configured = path.join(path.sep, 'configured', 'vault');
    expect(resolveVaultDir(undefined, { ...runtime, vaultPath: configured })).toBe(path.resolve(configured));
  });

  it('falls back to the managed default when nothing is configured', () => {
    expect(resolveVaultDir(undefined, runtime)).toBe(defaultVaultDir());
  });
});
