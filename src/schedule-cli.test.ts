import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'schedule-cli.js');
const PROJECT_DIR = path.resolve(__dirname, '..');

// The CLI runs as a child process and loads real config, which requires a
// DB_ENCRYPTION_KEY (>= 32 chars). A checkout without a populated .env (e.g. a
// fresh worktree or CI) has none, so the child would exit on config validation.
// Inject a throwaway key, and point CLAUDECLAW_CONFIG / CLAUDECLAW_STORE_DIR at
// fresh temp dirs so these tests are hermetic and never touch the live fleet.
const TEST_DB_KEY = 'a'.repeat(64);

let tmpRoot: string;
let cfgDir: string;
let storeDir: string;

function seedAgent(id: string, cfg: Record<string, unknown>) {
  const dir = path.join(cfgDir, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), yaml.dump(cfg), 'utf-8');
}

function childEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    DB_ENCRYPTION_KEY: TEST_DB_KEY,
    CLAUDECLAW_CONFIG: cfgDir,
    CLAUDECLAW_STORE_DIR: storeDir,
    CLAUDECLAW_AGENT_ID: undefined,
    ...overrides,
  };
}

interface RunResult { status: number; stdout: string; stderr: string; }

function run(args: string, envOverrides: Record<string, string | undefined> = {}): RunResult {
  try {
    const stdout = execSync(`node "${CLI_PATH}" ${args}`, {
      cwd: PROJECT_DIR,
      env: childEnv(envOverrides),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('schedule-cli agent routing', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-schedule-cli-'));
    cfgDir = path.join(tmpRoot, 'config');
    storeDir = path.join(tmpRoot, 'store');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    seedAgent('main', { name: 'Holden', description: 'hub' });
    seedAgent('comms', { name: 'Comms', description: 'comms', telegram_bot_token_env: 'TEST_BOT_TOKEN' });
    seedAgent('ops', { name: 'Ops', description: 'ops', telegram_bot_token_env: 'TEST_BOT_TOKEN' });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('auto-detects agent from CLAUDECLAW_AGENT_ID env var', () => {
    const result = run('create "test auto-detect" "0 9 * * *"', { CLAUDECLAW_AGENT_ID: 'comms' });
    expect(result.stdout).toContain('Agent:        comms');
  });

  it('--agent flag overrides CLAUDECLAW_AGENT_ID env var', () => {
    const result = run('create "test override" "0 9 * * *" --agent ops', { CLAUDECLAW_AGENT_ID: 'comms' });
    expect(result.stdout).toContain('Agent:        ops');
  });

  it('defaults to main when no env var and no --agent flag', () => {
    const result = run('create "test default" "0 9 * * *"');
    expect(result.stdout).toContain('Agent:        main');
  });

  it('resolves a display name to the canonical id (regression for fdfec14a)', () => {
    const result = run('create "by display name" "0 9 * * *" --agent Holden');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Agent:        main');
  });

  it('rejects an unknown agent: non-zero exit, known-list, writes nothing', () => {
    const result = run('create "bad routing" "0 9 * * *" --agent bogus');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown agent 'bogus'");
    expect(result.stderr).toContain('known:');

    // Nothing was written for the bogus agent.
    const listed = run('list');
    expect(listed.stdout).toContain('No scheduled tasks');
  });
});
