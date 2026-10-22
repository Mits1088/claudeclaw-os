import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { assertTestStoreIsHermetic } from './db.js';

const root = path.resolve(import.meta.dirname, '..');
function child(script: string, store: string) {
  const fixture = path.join(root, `.store-isolation-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(fixture, script);
  try {
    return execFileSync(process.execPath, ['--import', 'tsx', fixture], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, CLAUDECLAW_SCRIPT_STORE_DIR: undefined, CLAUDECLAW_STORE_DIR: store, DB_ENCRYPTION_KEY: 'a'.repeat(64) },
    }).trim();
  } finally {
    fs.rmSync(fixture, { force: true });
  }
}

describe('test database isolation', () => {
  it('overrides an inherited store before config loads', () => {
    const inherited = fs.mkdtempSync(path.join(os.tmpdir(), 'inherited-store-'));
    let isolated: string | undefined;
    try {
      isolated = child(`await import('./src/test-env-setup.ts');
        const { STORE_DIR } = await import('./src/config.ts');
        console.log(STORE_DIR);`, inherited).split('\n').at(-1)!;
      expect(isolated).not.toBe(inherited);
      expect(fs.realpathSync(isolated).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)).toBe(true);
      expect(fs.readdirSync(inherited)).toEqual([]);
    } finally {
      fs.rmSync(inherited, { recursive: true, force: true });
      if (isolated) fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('rejects stores outside tmp before opening a database', () => {
    const outside = fs.mkdtempSync(path.join(root, '.test-store-'));
    const sentinel = path.join(outside, 'claudeclaw.db');
    fs.writeFileSync(sentinel, 'must remain untouched');
    try {
      expect(child(`const { initDatabase } = await import('./src/db.ts');
        try { initDatabase(); throw new Error('unexpected success'); }
        catch (e) { console.log(e.message); }`, outside)).toContain('outside tmpdir');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('must remain untouched');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('isolates standalone scripts from an inherited live store', () => {
    const inherited = fs.mkdtempSync(path.join(os.tmpdir(), 'script-inherited-store-'));
    let isolated: string | undefined;
    try {
      isolated = child(`await import('./scripts/_hermetic-store.ts');
        const { STORE_DIR } = await import('./src/config.ts'); console.log(STORE_DIR);`, inherited).split('\n').at(-1)!;
      expect(isolated).not.toBe(inherited);
      expect(fs.readdirSync(inherited)).toEqual([]);
    } finally {
      fs.rmSync(inherited, { recursive: true, force: true });
      if (isolated) fs.rmSync(isolated, { recursive: true, force: true });
    }
  });

  it('accepts a real temporary store', () => {
    expect(() => assertTestStoreIsHermetic(os.tmpdir())).not.toThrow();
  });
});
