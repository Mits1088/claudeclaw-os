import fs from 'fs';
import { atomicEnvWrite } from './env-write.js';
import { compatEnvSource, compatProviderEnabled, DEFAULT_COMPAT_BASE_URL, DEFAULT_COMPAT_MODEL, DEFAULT_COMPAT_FAST_MODEL, resolveCompatApiKey, resolveCompatBaseUrl, resetCompatConfigCache, type CompatEnvSource } from './anthropic-compat-env.js';

const KEY_NAMES = ['ZAI_API_KEY', 'ANTHROPIC_COMPAT_API_KEY', 'GLM_API_KEY'];

export function zaiSetupStatus(src: CompatEnvSource = compatEnvSource(), processEnv: NodeJS.ProcessEnv = process.env, baseUrl?: string) {
  const names = KEY_NAMES.filter((name) => !!src[name]?.trim());
  const managedExternally = KEY_NAMES.some((name) => !!processEnv[name]);
  let builtIn = false;
  let validEndpoint = false;
  try { builtIn = resolveCompatBaseUrl(src, baseUrl) === DEFAULT_COMPAT_BASE_URL; validEndpoint = true; } catch { /* advanced endpoint requires manual configuration */ }
  let configured = false;
  try { resolveCompatApiKey(src); configured = true; } catch { /* never return credential-bearing errors */ }
  const enabled = compatProviderEnabled(src);
  const model = src.ANTHROPIC_COMPAT_MODEL?.trim() || DEFAULT_COMPAT_MODEL;
  const fast = src.ANTHROPIC_COMPAT_FAST_MODEL?.trim() || DEFAULT_COMPAT_FAST_MODEL;
  return {
    configured, enabled, ready: configured && enabled && validEndpoint,
    canEdit: builtIn && !managedExternally,
    legacyKey: names.length === 1 && names[0] !== 'ZAI_API_KEY',
    message: !validEndpoint ? 'The endpoint configuration is invalid. Correct it in the server configuration before saving this provider.'
      : !builtIn ? 'A custom endpoint is configured. Manage its credential in the server configuration.'
      : managedExternally ? 'The service environment supplies this key. Update it in your service configuration.'
      : names.length > 1 ? 'Multiple key names are configured. Save a replacement to consolidate them into ZAI_API_KEY.'
      : !enabled ? 'Z.ai is disabled. Set ANTHROPIC_COMPAT_ENABLED=true in the server configuration and check again.'
      : configured ? 'API key configured. Its validity is checked when the provider is used.'
      : 'Add your Z.ai API key to finish setup.',
    models: [...new Set([model, fast])].map((id) => ({ id, label: id })),
    defaultModel: model,
  };
}

/** Writes only the Z.ai credential, in one atomic replacement. No key is returned. */
export function saveZaiKey(envPath: string, input: { apiKey?: unknown; migrate?: unknown }, src: CompatEnvSource = compatEnvSource(), processEnv: NodeJS.ProcessEnv = process.env) {
  if (!zaiSetupStatus(src, processEnv).canEdit) throw new Error('This credential is managed outside Z.ai dashboard setup. Use the server configuration.');
  const key = input.migrate === true && input.apiKey === undefined ? resolveCompatApiKey(src) : input.apiKey;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{8,4096}$/.test(key)) throw new Error('Enter an unquoted API key without spaces or line breaks.');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read the installation configuration.'); }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const retained = lines.filter((line) => !/^\s*(?:ZAI_API_KEY|ANTHROPIC_COMPAT_API_KEY|GLM_API_KEY)\s*=/.test(line));
  if (retained.at(-1) === '') retained.pop();
  retained.push(`ZAI_API_KEY=${key}`, '');
  try { atomicEnvWrite(envPath, retained.join(newline)); } catch { throw new Error('Could not save the installation configuration.'); }
  resetCompatConfigCache();
  return { saved: true, restartRequired: true };
}
