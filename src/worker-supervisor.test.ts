import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  desired: new Map<string, 'active' | 'inactive'>(),
  alive: new Set<number>(),
  killed: [] as number[],
  activated: [] as string[],
  epochs: [] as Array<{ epoch: string; build: string }>,
}));

vi.mock('./config.js', () => ({
  PROJECT_ROOT: 'D:\\runtime',
  STORE_DIR: 'D:\\runtime\\store',
}));

vi.mock('./agent-config.js', () => ({
  listAgentIds: () => ['amos', 'ashford'],
  loadAgentConfig: (id: string) => ({ runtimeMode: id === 'ashford' ? 'headless' : 'messenger' }),
}));

vi.mock('./agent-create.js', () => ({
  activateAgent: (id: string) => {
    state.activated.push(id);
    return { ok: true, pid: 500 };
  },
}));

vi.mock('./db.js', () => ({
  acquireWorkerLease: vi.fn(),
  heartbeatWorkerLease: vi.fn(),
  isWorkerLeaseCurrent: vi.fn(),
  releaseWorkerLease: vi.fn(),
  getWorkerRuntime: (id: string) => state.desired.has(id)
    ? { agent_id: id, desired_state: state.desired.get(id) }
    : null,
  ensureWorkerDesiredState: (id: string, desired: 'active' | 'inactive') => state.desired.set(id, desired),
  listWorkerRuntime: () => [...state.desired].map(([agent_id, desired_state]) => ({ agent_id, desired_state })),
  beginWorkerSupervisorEpoch: (epoch: string, build: string) => state.epochs.push({ epoch, build }),
}));

vi.mock('./platform.js', () => ({
  listAgentProcesses: () => [
    { pid: 101, agentId: 'ashford', commandLine: 'worker' },
    { pid: 102, agentId: 'deleted-worker', commandLine: 'orphan' },
    { pid: 103, agentId: 'amos', commandLine: 'messenger' },
  ],
  isProcessAlive: (pid: number) => state.alive.has(pid),
  killProcess: (pid: number) => {
    state.killed.push(pid);
    state.alive.delete(pid);
    return true;
  },
}));

describe('headless worker reconciliation', () => {
  beforeEach(() => {
    state.desired = new Map();
    state.alive = new Set([101, 102, 103]);
    state.killed = [];
    state.activated = [];
    state.epochs = [];
  });

  it('fences, stops stale and deleted workers, preserves messenger agents, and relaunches desired workers', async () => {
    const { reconcileHeadlessWorkers } = await import('./worker-supervisor.js');

    await reconcileHeadlessWorkers();

    expect(state.epochs).toHaveLength(1);
    expect(state.killed).toEqual(expect.arrayContaining([101, 102]));
    expect(state.killed).not.toContain(103);
    expect(state.activated).toEqual(['ashford']);
    expect(state.desired.get('ashford')).toBe('active');
  });
});
