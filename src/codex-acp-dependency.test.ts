import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

function versionAtLeast(actual: string | undefined, minimum: [number, number, number]): boolean {
  if (!actual) return false;
  const parts = actual.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
}

describe('Codex ACP dependency', () => {
  it('uses the maintained adapter package at the GPT-5.6-compatible release line', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };

    expect(manifest.dependencies?.['@zed-industries/codex-acp']).toBeUndefined();
    expect(manifest.dependencies?.['@agentclientprotocol/codex-acp']).toBe('^1.6.2');
    expect(lock.packages?.['node_modules/@zed-industries/codex-acp']).toBeUndefined();
    expect(versionAtLeast(
      lock.packages?.['node_modules/@agentclientprotocol/codex-acp']?.version,
      [1, 6, 2],
    )).toBe(true);
  });
});
