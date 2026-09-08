import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'mission-cli.js');
const PROJECT_DIR = path.resolve(__dirname, '..');
const SOURCE_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const CLI_COMMAND = fs.existsSync(CLI_PATH)
  ? `node "${CLI_PATH}"`
  : `node --import "${SOURCE_LOADER}" "${path.resolve(__dirname, 'mission-cli.ts')}"`;

// The CLI runs as a child process and loads real config, which requires a
// DB_ENCRYPTION_KEY (>= 32 chars). Inject a throwaway key so these tests are
// hermetic and independent of any .env. Each test points CLAUDECLAW_CONFIG and
// CLAUDECLAW_STORE_DIR at fresh temp dirs so nothing ever touches the live
// fleet's config or database.
const TEST_DB_KEY = 'a'.repeat(64);

let tmpRoot: string;
let cfgDir: string;
let storeDir: string;

function seedAgent(id: string, cfg: Record<string, unknown>) {
  const dir = path.join(cfgDir, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), yaml.dump(cfg), 'utf-8');
}

function childEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    DB_ENCRYPTION_KEY: TEST_DB_KEY,
    CLAUDECLAW_CONFIG: cfgDir,
    CLAUDECLAW_STORE_DIR: storeDir,
    CLAUDECLAW_AGENT_ID: undefined,
  };
}

interface RunResult { status: number; stdout: string; stderr: string; }

function run(args: string): RunResult {
  try {
    const stdout = execSync(`${CLI_COMMAND} ${args}`, {
      cwd: PROJECT_DIR,
      env: childEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('mission-cli create — resolve-then-store guard', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-mission-cli-'));
    cfgDir = path.join(tmpRoot, 'config');
    storeDir = path.join(tmpRoot, 'store');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    // Roster where canonical id != display name (mirrors the live fleet).
    seedAgent('main', { name: 'Holden', description: 'hub' });
    seedAgent('amos', {
      name: 'Amos',
      description: 'ops',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves a display name to the canonical id (regression for fdfec14a)', () => {
    const created = run('create --agent holden --title "Handback" "do the thing"');
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/Agent:\s+main/);

    // Read back through the CLI: the stored assigned_agent is the canonical id,
    // so a poller's WHERE assigned_agent = 'main' will claim it (no dead letter).
    const listed = run('list --status queued');
    expect(listed.stdout).toContain('@main');
    expect(listed.stdout).not.toContain('@holden');
  });

  it('rejects an unknown agent: non-zero exit, known-list, writes nothing', () => {
    const created = run('create --agent bogus --title "X" "prompt"');
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain("unknown agent 'bogus'");
    expect(created.stderr).toContain('known:');
    expect(created.stderr).toContain('main');

    // Nothing was written.
    const listed = run('list');
    expect(listed.stdout).toContain('No mission tasks');
  });

  it('leaves the task unassigned when --agent is omitted', () => {
    const created = run('create --title "later" "assign me on the dashboard"');
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('unassigned');
  });

  it('creates a future mission with an explicit UTC offset', () => {
    const created = run('create --agent main --at 2099-01-02T03:04:05-07:00 "do this later"');
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('Run at:');
    expect(created.stdout).toContain('2099-01-02T10:04:05.000Z');

    const listed = run('list --status queued');
    expect(listed.stdout).toContain('Run at:');
  });

  it('rejects a future timestamp without an explicit offset and writes nothing', () => {
    const created = run('create --agent main --at 2099-01-02T03:04:05 "do this later"');
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('RFC 3339');
    expect(run('list').stdout).toContain('No mission tasks');
  });

  it('rejects a past timestamp and writes nothing', () => {
    const created = run('create --agent main --at 2000-01-02T03:04:05Z "too late"');
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('must be in the future');
    expect(run('list').stdout).toContain('No mission tasks');
  });

  it('rejects an invalid calendar timestamp and writes nothing', () => {
    const created = run('create --agent main --at 2099-02-30T03:04:05Z "never"');
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('invalid --at timestamp');
    expect(run('list').stdout).toContain('No mission tasks');
  });

  it('creates and reads a durable bounded workflow', () => {
    const created = run(
      'workflow --agent amos --owner main --objective "Reach a verified answer" --title "Research" --max-depth 3 --max-tasks 6 --max-fanout 2 --deadline 2099-01-02T03:04:05-07:00 "Research the question"',
    );
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('Durable workflow created:');
    expect(created.stdout).toContain('-> @amos');
    expect(created.stdout).toContain('Owner:        @main');
    expect(created.stdout).toContain('depth 3, tasks 6, fan-out 2');
    expect(created.stdout).toContain('2099-01-02T10:04:05.000Z');

    const workflowId = created.stdout.match(/Durable workflow created: ([a-f0-9]+)/)?.[1];
    expect(workflowId).toBeTruthy();
    const listed = run('workflow-list --status active');
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain(workflowId!);
    expect(listed.stdout).toContain('Reach a verified answer');

    const details = run(`workflow-result ${workflowId}`);
    expect(details.status).toBe(0);
    expect(details.stdout).toContain(`Workflow: ${workflowId} [active]`);
    expect(details.stdout).toContain('Tasks (1):');
    expect(details.stdout).toContain('Outcomes (0):');
    expect(details.stdout).toContain('Transitions (0):');
  });

  it('rejects an invalid durable workflow bound before writing', () => {
    const created = run(
      'workflow --agent amos --objective "Bounded" --max-fanout 0 "Do work"',
    );
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('--max-fanout must be an integer from 1 to 50');
    expect(run('workflow-list').stdout).toContain('No durable mission workflows');
  });

  it('resolves a gather summary display name to its canonical id', () => {
    const gathered = run(
      'gather --summary-agent holden --title "Probe" --task "amos:check the lane" "summarize"',
    );
    expect(gathered.status).toBe(0);
    expect(gathered.stdout).toMatch(/Join .* -> @main/);
    expect(gathered.stdout).not.toMatch(/Join .* -> @holden/);
  });

  it('rejects an unknown gather summary agent before writing any children', () => {
    const gathered = run(
      'gather --summary-agent bogus --title "Probe" --task "amos:check the lane" "summarize"',
    );
    expect(gathered.status).not.toBe(0);
    expect(gathered.stderr).toContain("unknown agent 'bogus'");
    expect(gathered.stderr).toContain('known:');

    const listed = run('list');
    expect(listed.stdout).toContain('No mission tasks');
  });
});

describe('mission-cli — unknown flag rejection (#162)', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-mission-cli-'));
    cfgDir = path.join(tmpRoot, 'config');
    storeDir = path.join(tmpRoot, 'store');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    seedAgent('main', { name: 'Holden', description: 'hub' });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rejects a typo\'d flag instead of swallowing it as the prompt', () => {
    // Previously `--body` was not recognized, not stripped, and became the
    // literal positional prompt — silently corrupting the task body.
    const created = run('create --agent main --title "X" --body "oops" "real prompt"');
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('Unknown flag(s): --body');
    expect(created.stderr).toContain('Known flags:');

    // Nothing was written.
    const listed = run('list');
    expect(listed.stdout).toContain('No mission tasks');
  });

  it('still accepts a valid create with only known flags', () => {
    const created = run('create --agent main --title "X" "real prompt"');
    expect(created.status).toBe(0);
    expect(created.stdout).toMatch(/Mission task created/);
  });
});
