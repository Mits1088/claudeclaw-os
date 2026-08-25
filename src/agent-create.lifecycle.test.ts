import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const state = vi.hoisted(() => ({
  projectRoot: '',
  storeDir: '',
  claudeclawConfig: '',
  alive: new Set<number>(),
  killed: [] as Array<{ pid: number; force: boolean }>,
  exactProcesses: [] as Array<{ pid: number; agentId: string; commandLine: string }>,
  blockers: { open_missions: 0, retained_schedules: 0 },
  runtime: null as null | {
    agent_id: string;
    desired_state: 'active' | 'inactive';
    instance_id: string | null;
    supervisor_epoch: string | null;
    pid: number | null;
    process_started_at: number | null;
    heartbeat_at: number | null;
    runtime_build_id: string | null;
  },
  runtimeDeletes: 0,
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

vi.mock('./agent-config.js', () => ({
  ensureAgentsMdSymlink: () => {},
  listAgentIds: () => ['worker'],
  loadAgentConfig: (id: string) => ({ id, runtimeMode: id === 'worker' ? 'headless' : 'messenger' }),
  resolveAgentDir: (id: string) => path.join(state.projectRoot, 'agents', id),
  refreshWarRoomRoster: () => {},
  findAgentIdentityCollision: () => null,
}));

vi.mock('./orchestrator.js', () => ({ refreshAgentRegistry: () => {} }));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

vi.mock('./db.js', () => ({
  ensureDatabase: () => {},
  getWorkerRuntime: () => state.runtime,
  getWorkerSupervisor: () => null,
  isWorkerLeaseCurrent: (_agentId: string, instanceId: string) => (
    state.runtime?.desired_state === 'active' && state.runtime.instance_id === instanceId
  ),
  ensureWorkerDesiredState: (_agentId: string, desired: 'active' | 'inactive') => {
    if (!state.runtime) return;
    state.runtime.desired_state = desired;
    if (desired === 'inactive') {
      state.runtime.instance_id = null;
      state.runtime.supervisor_epoch = null;
      state.runtime.pid = null;
      state.runtime.process_started_at = null;
      state.runtime.heartbeat_at = null;
      state.runtime.runtime_build_id = null;
    }
  },
  getAgentDeletionBlockers: () => state.blockers,
  deleteWorkerRuntime: () => {
    state.runtimeDeletes += 1;
    state.runtime = null;
  },
}));

vi.mock('./platform.js', () => ({
  IS_MACOS: false,
  killProcess: (pid: number, force = false) => {
    state.killed.push({ pid, force });
    state.alive.delete(pid);
    return true;
  },
  isProcessAlive: (pid: number) => state.alive.has(pid),
  claudeCodeHandoff: () => '',
  findProcessesByPattern: async () => [],
  listAgentProcesses: () => state.exactProcesses,
}));

let tmpRoot: string;

function pidFile(): string {
  return path.join(state.storeDir, 'agent-worker.pid');
}

function agentDir(): string {
  return path.join(state.projectRoot, 'agents', 'worker');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-agent-lifecycle-'));
  state.projectRoot = path.join(tmpRoot, 'project');
  state.storeDir = path.join(tmpRoot, 'store');
  state.claudeclawConfig = path.join(tmpRoot, 'config');
  fs.mkdirSync(agentDir(), { recursive: true });
  fs.mkdirSync(state.storeDir, { recursive: true });
  fs.writeFileSync(path.join(state.projectRoot, '.env'), '', 'utf-8');
  state.alive = new Set([4242]);
  state.killed = [];
  state.exactProcesses = [{ pid: 4242, agentId: 'worker', commandLine: 'worker' }];
  state.blockers = { open_missions: 0, retained_schedules: 0 };
  state.runtime = {
    agent_id: 'worker',
    desired_state: 'active',
    instance_id: 'instance-1',
    supervisor_epoch: 'epoch-1',
    pid: 4242,
    process_started_at: 100,
    heartbeat_at: 101,
    runtime_build_id: 'build-1',
  };
  state.runtimeDeletes = 0;
  fs.writeFileSync(pidFile(), '4242', 'utf-8');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('headless agent lifecycle safety', () => {
  it('fences the lease, confirms process exit, and removes the PID file', async () => {
    const { deactivateAgent } = await import('./agent-create.js');

    expect(deactivateAgent('worker')).toEqual({ ok: true });
    expect(state.killed).toEqual([{ pid: 4242, force: false }]);
    expect(state.runtime).toMatchObject({
      desired_state: 'inactive',
      instance_id: null,
      pid: null,
      heartbeat_at: null,
    });
    expect(fs.existsSync(pidFile())).toBe(false);
  });

  it('refuses deletion while durable responsibilities remain', async () => {
    state.blockers = { open_missions: 2, retained_schedules: 1 };
    const { deleteAgent } = await import('./agent-create.js');

    const result = deleteAgent('worker');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/2 open mission\(s\).*1 retained schedule\(s\)/);
    expect(fs.existsSync(agentDir())).toBe(true);
    expect(state.killed).toHaveLength(0);
    expect(state.runtimeDeletes).toBe(0);
  });

  it('aborts deletion when a live PID cannot be verified as this worker', async () => {
    state.runtime = null;
    state.exactProcesses = [];
    const { deleteAgent } = await import('./agent-create.js');

    const result = deleteAgent('worker');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unverified PID 4242/);
    expect(fs.existsSync(agentDir())).toBe(true);
    expect(fs.existsSync(pidFile())).toBe(true);
    expect(state.runtimeDeletes).toBe(0);
  });

  it('deletes files and runtime state only after safe deactivation', async () => {
    const { deleteAgent } = await import('./agent-create.js');

    expect(deleteAgent('worker')).toEqual({ ok: true });
    expect(state.killed).toEqual([{ pid: 4242, force: false }]);
    expect(fs.existsSync(agentDir())).toBe(false);
    expect(state.runtimeDeletes).toBe(1);
  });
});
