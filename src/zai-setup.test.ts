import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { saveZaiKey, zaiSetupStatus } from './zai-setup.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-setup-'));
  dirs.push(dir);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, content);
  return file;
}

describe('Z.ai setup', () => {
  it('offers models without a key and never returns credentials', () => {
    expect(zaiSetupStatus({}, {}).models.length).toBeGreaterThan(0);
    expect(zaiSetupStatus({}, {}).ready).toBe(false);
    const status = zaiSetupStatus({ ZAI_API_KEY: 'synthetic-secret' }, {});
    expect(status.ready).toBe(true);
    expect(JSON.stringify(status)).not.toContain('synthetic-secret');
  });
  it('migrates legacy credentials and preserves unrelated content and CRLF', () => {
    const file = fixture('# keep comment\r\nOTHER=value\r\nANTHROPIC_COMPAT_API_KEY=synthetic-secret\r\n');
    saveZaiKey(file, { migrate: true }, { ANTHROPIC_COMPAT_API_KEY: 'synthetic-secret' }, {});
    expect(fs.readFileSync(file, 'utf8')).toBe('# keep comment\r\nOTHER=value\r\nZAI_API_KEY=synthetic-secret\r\n');
  });
  it('replaces all duplicate aliases in one save', () => {
    const file = fixture('ZAI_API_KEY=old-secret\nGLM_API_KEY=other-secret\nZAI_API_KEY=duplicate\n');
    saveZaiKey(file, { apiKey: 'replacement-key' }, { ZAI_API_KEY: 'old-secret', GLM_API_KEY: 'other-secret' }, {});
    expect(fs.readFileSync(file, 'utf8')).toBe('ZAI_API_KEY=replacement-key\n');
  });
  it('rejects environment injection without changing the file', () => {
    const file = fixture('# untouched\n');
    for (const apiKey of ['valid-key\nOTHER=evil', ' key-value ', '"key-value"', 'key#comment']) {
      expect(() => saveZaiKey(file, { apiKey }, {}, {})).toThrow();
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('# untouched\n');
  });
  it('honors agent endpoint pins and does not mark invalid endpoints ready', () => {
    const src = { ZAI_API_KEY: 'synthetic-secret', ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS: 'true', ANTHROPIC_COMPAT_ALLOWED_HOSTS: 'example.com' };
    expect(zaiSetupStatus(src, {}, 'https://example.com').canEdit).toBe(false);
    expect(zaiSetupStatus(src, {}, 'https://example.com').ready).toBe(true);
    expect(zaiSetupStatus(src, {}, 'http://example.com').ready).toBe(false);
    expect(zaiSetupStatus({ ...src, ANTHROPIC_COMPAT_BASE_URL: 'broken' }, {}).ready).toBe(false);
  });
  it('protects external credentials, custom endpoints, and ambiguous migration', () => {
    const file = fixture('# untouched\n');
    expect(() => saveZaiKey(file, { apiKey: 'replacement' }, {}, { ZAI_API_KEY: 'external' })).toThrow();
    expect(() => saveZaiKey(file, { apiKey: 'replacement' }, { ANTHROPIC_COMPAT_BASE_URL: 'https://example.com' }, {})).toThrow();
    expect(() => saveZaiKey(file, { migrate: true }, { ZAI_API_KEY: 'one', GLM_API_KEY: 'two' }, {})).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('# untouched\n');
  });
});
