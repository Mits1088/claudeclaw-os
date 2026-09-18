import fs from 'fs';
import { readEnvFile } from './env.js';
import { atomicEnvWrite } from './env-write.js';

export function openRouterApiKey(): string {
  return process.env.OPENROUTER_API_KEY?.trim() || readEnvFile(['OPENROUTER_API_KEY']).OPENROUTER_API_KEY || '';
}

export function openRouterSetupStatus(enabled: boolean, key = openRouterApiKey(), externallyManaged = !!process.env.OPENROUTER_API_KEY) {
  return {
    configured: !!key, enabled, ready: enabled && !!key, canEdit: !externallyManaged, legacyKey: false,
    message: externallyManaged ? 'The service environment supplies this key. Update it in your service configuration.'
      : !enabled ? 'OpenRouter is disabled. Enable experimental providers to use it.'
      : key ? 'API key configured. Its validity is checked when the provider is used.' : 'Add your OpenRouter API key to finish setup.',
  };
}

export function saveOpenRouterKey(envPath: string, key: unknown, externallyManaged = !!process.env.OPENROUTER_API_KEY) {
  if (externallyManaged) throw new Error('This key is supplied by the service environment. Update it there.');
  if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{8,4096}$/.test(key)) throw new Error('Enter an unquoted API key without spaces or line breaks.');
  let content = '';
  try { content = fs.readFileSync(envPath, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read the installation configuration.'); }
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/).filter((line) => !/^\s*OPENROUTER_API_KEY\s*=/.test(line));
  if (lines.at(-1) === '') lines.pop();
  lines.push(`OPENROUTER_API_KEY=${key}`, '');
  try { atomicEnvWrite(envPath, lines.join(newline)); } catch { throw new Error('Could not save the installation configuration.'); }
  return { saved: true, restartRequired: false };
}
