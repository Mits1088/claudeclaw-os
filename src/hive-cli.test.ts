import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'hive-cli.js');
const PROJECT_DIR = path.resolve(__dirname, '..');

// A >=32 char throwaway key so the DB-opening subcommands are hermetic and
// don't depend on a populated .env (matches schedule-cli.test.ts).
const TEST_DB_KEY = 'a'.repeat(64);

const tempDirs: string[] = [];

/**
 * Create a temp CWD holding a .env that pins CLAUDECLAW_STORE_DIR. The child
 * runs with this as cwd so config.ts's readEnvFile reads THIS .env — exercising
 * the `envConfig` (.env) resolution branch, which is invisible to process.env
 * and to any raw bash sqlite call. That is the whole point of hive-cli.
 */
function makeEnvCwd(storeDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cli-cwd-'));
  fs.writeFileSync(path.join(dir, '.env'), `CLAUDECLAW_STORE_DIR=${storeDir}\n`, 'utf-8');
  tempDirs.push(dir);
  tempDirs.push(storeDir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('hive-cli path (store resolution)', () => {
  it('resolves the DB via config.ts honoring a .env CLAUDECLAW_STORE_DIR pin', () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cli-store-'));
    const cwd = makeEnvCwd(storeDir);

    // Deliberately NO DB_ENCRYPTION_KEY and NO process-env store var: `path`
    // must not open the DB, and must honor the .env pin, not process.env.
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.CLAUDECLAW_STORE_DIR;
    delete env.DB_ENCRYPTION_KEY;

    const out = execSync(`node "${CLI_PATH}" path`, { cwd, env, encoding: 'utf-8' }).trim();

    expect(out).toBe(path.join(storeDir, 'claudeclaw.db'));
  });

  it('prints the resolved DB path (default PROJECT_ROOT/store when unpinned)', () => {
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.CLAUDECLAW_STORE_DIR;
    delete env.DB_ENCRYPTION_KEY;

    // Run from a scratch cwd with an empty .env so no pin is seen.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cli-nopin-'));
    fs.writeFileSync(path.join(cwd, '.env'), '', 'utf-8');
    tempDirs.push(cwd);

    const out = execSync(`node "${CLI_PATH}" path`, { cwd, env, encoding: 'utf-8' }).trim();

    expect(out).toBe(path.join(PROJECT_DIR, 'store', 'claudeclaw.db'));
  });
});

describe('hive-cli log + read (round-trip against the pinned store)', () => {
  it('logs an entry and reads it back from the .env-pinned DB', () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cli-store-'));
    const cwd = makeEnvCwd(storeDir);
    const env = { ...process.env, DB_ENCRYPTION_KEY: TEST_DB_KEY, CLAUDECLAW_AGENT_ID: 'testbot' } as Record<string, string | undefined>;
    delete env.CLAUDECLAW_STORE_DIR;

    execSync(
      `node "${CLI_PATH}" log --action "unit-test" --summary "hive-cli round trip"`,
      { cwd, env, encoding: 'utf-8' },
    );
    const readOut = execSync(`node "${CLI_PATH}" read --limit 5`, { cwd, env, encoding: 'utf-8' });

    expect(readOut).toContain('@testbot');
    expect(readOut).toContain('unit-test');
    expect(readOut).toContain('hive-cli round trip');
    // The write must have landed in the PINNED store, not the default one.
    expect(fs.existsSync(path.join(storeDir, 'claudeclaw.db'))).toBe(true);
  });
});

describe('setup placeholder enforcement', () => {
  // Mirrors the replacement + enforcement pass in scripts/setup.ts. Guards that
  // the shipped CLAUDE.md.example is fully covered by setup's replacement set,
  // so a generated runtime config never keeps a misdirecting bracket token.
  it('leaves no bracket placeholder tokens after personalization', () => {
    const example = fs.readFileSync(path.join(PROJECT_DIR, 'CLAUDE.md.example'), 'utf-8');

    const assistantName = 'Holden';
    const ownerName = 'Mike';
    const ownerWork = 'runs an AI automation shop';
    let content = example;
    const replacements: Array<[string, string]> = [
      ['[does what you do]', ownerWork],
      [' [Brief description of your main projects/work].', ''],
      ['[Brief description of your main projects/work]', ''],
      ['[YOUR ASSISTANT NAME]', assistantName],
      ['[YOUR NAME]', ownerName],
    ];
    for (const [token, value] of replacements) content = content.split(token).join(value);

    const enumerated = [
      '[YOUR NAME]', '[YOUR ASSISTANT NAME]', '[does what you do]',
      '[Brief description of your main projects/work]',
    ].filter((t) => content.includes(t));
    const generic = content.match(/\[[A-Z][A-Z ]{2,}\]/g) || [];

    expect(enumerated).toEqual([]);
    expect(generic).toEqual([]);
  });
});
