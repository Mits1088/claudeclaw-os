import path from 'path';

import { PROJECT_ROOT } from './config.js';
import { ensureDatabase, getDashboardSetting } from './db.js';

export interface ObsidianRuntimeConfig {
  enabled: boolean;
  vaultName: string;
  /**
   * Absolute path to the vault. Empty means the managed default under the
   * install dir. Set this to point at a vault the user already keeps
   * elsewhere on the filesystem.
   */
  vaultPath: string;
  /**
   * Whether the vault is kept in sync with a git remote. False is
   * "local-vault mode": no bare remote is provisioned and no git command is
   * ever run against the vault, for users who just want their local Obsidian
   * folder readable and writable by agents.
   */
  sync: boolean;
}

export const DEFAULT_OBSIDIAN_CONFIG: ObsidianRuntimeConfig = {
  enabled: false,
  vaultName: 'ClaudeClaw Vault',
  vaultPath: '',
  sync: true,
};

const SETTING_KEY = 'obsidian_config';

/** The managed vault location used when no explicit vaultPath is configured. */
export function defaultVaultDir(): string {
  return path.join(PROJECT_ROOT, 'vault');
}

/**
 * Validate a raw JSON string destined for the `obsidian_config` dashboard
 * setting. Returns null when valid, or a human-readable error otherwise.
 * Mirrors validateStandupConfigJson in src/dashboard.ts.
 */
export function validateObsidianConfigJson(value: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return 'obsidian_config: value must be valid JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'obsidian_config: value must be a JSON object';
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.enabled !== 'boolean') {
    return 'obsidian_config: enabled must be boolean';
  }
  if (obj.vaultName !== undefined) {
    if (typeof obj.vaultName !== 'string') {
      return 'obsidian_config: vaultName must be a string';
    }
    if (obj.vaultName.length > 80) {
      return 'obsidian_config: vaultName must be 80 characters or fewer';
    }
  }
  if (obj.vaultPath !== undefined) {
    if (typeof obj.vaultPath !== 'string') {
      return 'obsidian_config: vaultPath must be a string';
    }
    // A relative path would resolve against whatever cwd the calling process
    // happens to have (agent, dashboard, scheduler all differ), so require it
    // to be unambiguous.
    if (obj.vaultPath !== '' && !path.isAbsolute(obj.vaultPath)) {
      return 'obsidian_config: vaultPath must be an absolute path';
    }
    if (obj.vaultPath.length > 4096) {
      return 'obsidian_config: vaultPath is too long';
    }
  }
  if (obj.sync !== undefined && typeof obj.sync !== 'boolean') {
    return 'obsidian_config: sync must be boolean';
  }
  return null;
}

/**
 * Parse a raw `obsidian_config` JSON string, falling back to defaults on
 * anything malformed or absent. Never throws.
 */
export function parseObsidianConfigJson(value: string | undefined): ObsidianRuntimeConfig {
  if (!value) return DEFAULT_OBSIDIAN_CONFIG;
  try {
    const parsed = JSON.parse(value) as Partial<ObsidianRuntimeConfig>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_OBSIDIAN_CONFIG.enabled,
      vaultName: typeof parsed.vaultName === 'string' ? parsed.vaultName : DEFAULT_OBSIDIAN_CONFIG.vaultName,
      vaultPath: typeof parsed.vaultPath === 'string' ? parsed.vaultPath : DEFAULT_OBSIDIAN_CONFIG.vaultPath,
      sync: typeof parsed.sync === 'boolean' ? parsed.sync : DEFAULT_OBSIDIAN_CONFIG.sync,
    };
  } catch {
    return DEFAULT_OBSIDIAN_CONFIG;
  }
}

/** Read the live `obsidian_config` dashboard setting. This is the master
 *  switch, enforced at the entry points agents actually use: obsidian-cli and
 *  the obsidian dispatch tools both refuse every command while it is
 *  disabled, regardless of what an agent.yaml says. */
export function getObsidianRuntimeConfig(): ObsidianRuntimeConfig {
  // Open the store if this process has not already — the same lazy pattern
  // cli-actions uses. The stdio dispatch bridge builds its tool list before
  // any action has run, so without this the very first read would hit an
  // unopened database, throw, and (because availability fails closed) hide
  // the vault tools from that transport entirely even when they are enabled.
  ensureDatabase();
  return parseObsidianConfigJson(getDashboardSetting(SETTING_KEY) ?? undefined);
}

/**
 * The vault directory an agent actually operates on, most specific first:
 * the agent's own `obsidian.vault` override, then the dashboard-configured
 * vaultPath, then the managed default. Kept here (rather than in
 * agent-config.ts) so resolving it can consult the runtime setting without
 * agent-config having to depend on the database.
 */
export function resolveVaultDir(
  agentVault: string | undefined,
  runtime: ObsidianRuntimeConfig,
): string {
  if (agentVault) return path.resolve(agentVault);
  if (runtime.vaultPath) return path.resolve(runtime.vaultPath);
  return defaultVaultDir();
}
