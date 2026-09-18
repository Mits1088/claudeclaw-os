import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openRouterApiKey, openRouterSetupStatus, saveOpenRouterKey } from './openrouter-setup.js';
import { readEnvFile } from './env.js';

vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrouter-setup-'));
  dirs.push(dir);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  return file;
}

describe('OpenRouter key setup', () => {
  it('reports configuration without exposing keys and honors the experimental gate', () => {
    expect(openRouterSetupStatus(true, '', false).ready).toBe(false);
    const status = openRouterSetupStatus(true, 'synthetic-secret', false);
    expect(status.ready).toBe(true);
    expect(JSON.stringify(status)).not.toContain('synthetic-secret');
    expect(openRouterSetupStatus(false, 'synthetic-secret', false).ready).toBe(false);
    expect(openRouterSetupStatus(true, 'synthetic-secret', true).canEdit).toBe(false);
  });
  it('atomically replaces duplicates while preserving other provider keys and comments', () => {
    const file = fixture('# keep\r\nZAI_API_KEY=zai-secret\r\nOPENROUTER_API_KEY=old-key\r\nOPENROUTER_API_KEY=duplicate\r\n');
    expect(saveOpenRouterKey(file, 'replacement-key', false)).toEqual({ saved: true, restartRequired: false });
    expect(fs.readFileSync(file, 'utf8')).toBe('# keep\r\nZAI_API_KEY=zai-secret\r\nOPENROUTER_API_KEY=replacement-key\r\n');
  });
  it('refuses injection and externally managed credentials without modifying the file', () => {
    const file = fixture('# untouched\n');
    expect(() => saveOpenRouterKey(file, 'valid-key\nINJECTED=true', false)).toThrow();
    expect(() => saveOpenRouterKey(file, 'replacement-key', true)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('# untouched\n');
  });
  it('reads the latest file key for each turn while honoring service overrides', () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.mocked(readEnvFile).mockReturnValue({ OPENROUTER_API_KEY: 'first-key' });
    expect(openRouterApiKey()).toBe('first-key');
    vi.mocked(readEnvFile).mockReturnValue({ OPENROUTER_API_KEY: 'new-key' });
    expect(openRouterApiKey()).toBe('new-key');
    vi.stubEnv('OPENROUTER_API_KEY', 'service-key');
    expect(openRouterApiKey()).toBe('service-key');
  });
});
