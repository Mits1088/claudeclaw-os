// Pins agent activation on Linux.
//
// Why this file exists: `activateSystemd` used to run `systemctl --user
// enable/start com.claudeclaw.agent-<id>` against a unit that nothing in the
// codebase ever wrote — the macOS path writes its plist first, and Windows
// spawns the child directly, but Linux had neither. It failed for every Linux
// user, and it failed silently (execSync with stdio:'ignore').
//
// It is also unfixable in place on a headless deploy: the VPS installer runs
// the bot from a SYSTEM unit as a `--system --shell /usr/sbin/nologin` account,
// which has no user D-Bus, so `systemctl --user` can never connect there.
//
// So Linux now takes the same detached-child path as Windows. These tests pin
// that: a child is spawned, the PID file lands where isAgentRunning() and the
// dashboard both read it, and nothing shells out to systemctl.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({
  projectRoot: '',
  storeDir: '',
  claudeclawConfig: '',
  platform: 'linux' as 'linux' | 'win32' | 'darwin',
  spawnCalls: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  execCalls: [] as string[],
  nextPid: undefined as number | undefined,
  killed: [] as number[],
  alive: new Set<number>(),
}));

vi.mock('./config.js', () => ({
  get CLAUDECLAW_CONFIG() { return state.claudeclawConfig; },
  get PROJECT_ROOT() { return state.projectRoot; },
  get STORE_DIR() { return state.storeDir; },
  get WARROOM_TMP_DIR() { return path.join(state.storeDir, 'tmp'); },
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
}));

// Cut the heavy import chain (orchestrator -> agent -> SDK).
vi.mock('./orchestrator.js', () => ({ refreshAgentRegistry: () => {} }));
vi.mock('./env.js', () => ({ readEnvFile: () => ({ TEST_BOT_TOKEN: 'dummy' }) }));

// Platform booleans are module-level consts, so they are getters here to let a
// single suite exercise more than the host it happens to run on.
vi.mock('./platform.js', async () => {
  const actual = await vi.importActual<typeof import('./platform.js')>('./platform.js');
  return {
    ...actual,
    get IS_WINDOWS() { return state.platform === 'win32'; },
    get IS_MACOS() { return state.platform === 'darwin'; },
    get IS_LINUX() { return state.platform === 'linux'; },
    killProcess: vi.fn((pid: number) => {
      state.killed.push(pid);
      state.alive.delete(pid);
      return true;
    }),
    isProcessAlive: vi.fn((pid: number) => state.alive.has(pid)),
  };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      state.spawnCalls.push({ cmd, args, opts });
      const pid = state.nextPid;
      if (pid !== undefined) state.alive.add(pid);
      return { pid, unref: () => {} };
    }),
    execSync: vi.fn((cmd: string) => {
      state.execCalls.push(cmd);
      return Buffer.from('');
    }),
  };
});

let tmpRoot: string;

function writeDistEntry(): void {
  fs.mkdirSync(path.join(state.projectRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(state.projectRoot, 'dist', 'main-entry.js'), '// built entry', 'utf-8');
}

function pidFile(agentId: string): string {
  return path.join(state.storeDir, `agent-${agentId}.pid`);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-activate-'));
  state.projectRoot = path.join(tmpRoot, 'project');
  state.claudeclawConfig = path.join(tmpRoot, 'config');
  state.storeDir = path.join(tmpRoot, 'store');
  fs.mkdirSync(path.join(state.projectRoot, 'agents'), { recursive: true });
  fs.mkdirSync(state.storeDir, { recursive: true });
  state.platform = 'linux';
  state.spawnCalls = [];
  state.execCalls = [];
  state.killed = [];
  state.alive = new Set();
  state.nextPid = 4242;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('activateAgent on Linux', () => {
  it('spawns a detached child and records its PID where the dashboard reads it', async () => {
    writeDistEntry();
    const { activateAgent } = await import('./agent-create.js');

    const result = activateAgent('research');

    expect(result).toMatchObject({ ok: true, pid: 4242 });
    expect(state.spawnCalls).toHaveLength(1);
    const call = state.spawnCalls[0];
    expect(call.args).toEqual([
      path.join(state.projectRoot, 'dist', 'main-entry.js'),
      '--agent',
      'research',
    ]);
    expect(call.opts).toMatchObject({ detached: true, cwd: state.projectRoot });
    expect(fs.readFileSync(pidFile('research'), 'utf-8')).toBe('4242');
  });

  it('never shells out to systemctl', async () => {
    writeDistEntry();
    const { activateAgent } = await import('./agent-create.js');

    activateAgent('research');

    expect(state.execCalls.join('\n')).not.toMatch(/systemctl/);
  });

  it('reports a build-output failure instead of claiming success', async () => {
    // No dist/main-entry.js on purpose.
    const { activateAgent } = await import('./agent-create.js');

    const result = activateAgent('research');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/npm run build/);
    expect(fs.existsSync(pidFile('research'))).toBe(false);
  });

  it('rejects a malformed agent id before spawning anything', async () => {
    writeDistEntry();
    const { activateAgent } = await import('./agent-create.js');

    const result = activateAgent('../../etc/passwd');

    expect(result.ok).toBe(false);
    expect(state.spawnCalls).toHaveLength(0);
  });
});

describe('deactivateAgent on Linux', () => {
  it('kills the recorded PID and clears the PID file without systemctl', async () => {
    fs.writeFileSync(pidFile('research'), '4242', 'utf-8');
    state.alive.add(4242);
    const { deactivateAgent } = await import('./agent-create.js');

    const result = deactivateAgent('research');

    expect(result.ok).toBe(true);
    expect(state.killed).toContain(4242);
    expect(fs.existsSync(pidFile('research'))).toBe(false);
    expect(state.execCalls.join('\n')).not.toMatch(/systemctl/);
  });
});

describe('restartAgent on Linux', () => {
  it('kills the old child then spawns a replacement', async () => {
    writeDistEntry();
    fs.writeFileSync(pidFile('research'), '111', 'utf-8');
    state.alive.add(111);
    state.nextPid = 999;
    const { restartAgent } = await import('./agent-create.js');

    const result = restartAgent('research');

    expect(result.ok).toBe(true);
    expect(state.killed).toContain(111);
    expect(state.spawnCalls).toHaveLength(1);
    expect(fs.readFileSync(pidFile('research'), 'utf-8')).toBe('999');
    expect(state.execCalls.join('\n')).not.toMatch(/systemctl/);
  });
});
