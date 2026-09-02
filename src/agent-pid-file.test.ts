// The dashboard reported a running main agent as Offline, permanently and on
// every install.
//
// Two copies of one convention drifted. messenger.ts writes main's PID to
// store/claudeclaw.pid (main is the root process, not a spawned child) and
// sub-agents to store/agent-<id>.pid. isAgentRunning() only ever knew the
// second form, so it looked for an agent-main.pid that nothing writes and
// returned false forever. GET /api/agents handled claudeclaw.pid itself, but
// only in the branch taken when agents/main/agent.yaml is ABSENT — and the
// boot migration (backfillMainAgent) creates that file on every start, so the
// branch that got it right was unreachable.
//
// These cases pin the naming rule and the status read that hangs off it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// GET /api/agents runs the provider preflight, which shells out to
// `where`/`which` to probe PATH. Claim every command exists so the status
// assertion doesn't depend on which CLIs the host happens to have installed
// (same stub as dashboard.contract.test.ts).
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
});

let storeDir: string;
const configDirs: string[] = [];

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pid-'));
  vi.stubEnv('CLAUDECLAW_STORE_DIR', storeDir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(storeDir, { recursive: true, force: true });
  for (const dir of configDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agentPidFile', () => {
  it('points main at claudeclaw.pid, the file the runtime actually writes', async () => {
    const { agentPidFile } = await import('./agent-config.js');
    expect(agentPidFile('main')).toBe(path.join(storeDir, 'claudeclaw.pid'));
  });

  it('points a sub-agent at agent-<id>.pid', async () => {
    const { agentPidFile } = await import('./agent-config.js');
    expect(agentPidFile('comms')).toBe(path.join(storeDir, 'agent-comms.pid'));
  });
});

describe('isAgentRunning("main")', () => {
  it('is true when claudeclaw.pid holds a live PID and no agent-main.pid exists', async () => {
    // Exactly the on-disk shape of a healthy install: the root process wrote
    // claudeclaw.pid at boot and nothing ever creates agent-main.pid.
    fs.writeFileSync(path.join(storeDir, 'claudeclaw.pid'), String(process.pid), 'utf-8');
    expect(fs.existsSync(path.join(storeDir, 'agent-main.pid'))).toBe(false);

    const { isAgentRunning } = await import('./agent-create.js');
    expect(isAgentRunning('main')).toBe(true);
  });

  it('is false when claudeclaw.pid is stale', async () => {
    // A PID that cannot be alive: the file lingering after a crash must not
    // read as running.
    fs.writeFileSync(path.join(storeDir, 'claudeclaw.pid'), '2147483646', 'utf-8');

    const { isAgentRunning } = await import('./agent-create.js');
    expect(isAgentRunning('main')).toBe(false);
  });

  it('is false when no PID file was ever written', async () => {
    const { isAgentRunning } = await import('./agent-create.js');
    expect(isAgentRunning('main')).toBe(false);
  });
});

describe('GET /api/agents', () => {
  it('reports a live main as running when agents/main/agent.yaml exists', async () => {
    // The shape of every real install: the boot migration (backfillMainAgent,
    // #154) writes agents/main/agent.yaml, so listAgentIds() contains 'main'
    // and the route takes its hasMain branch. That branch asks
    // isAgentRunning('main') — which is exactly where main's PID file used to
    // be resolved as the agent-main.pid nothing writes.
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pid-config-'));
    configDirs.push(configDir);
    fs.mkdirSync(path.join(configDir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'agents', 'main', 'agent.yaml'), 'name: Main\n', 'utf-8');
    vi.stubEnv('CLAUDECLAW_CONFIG', configDir);

    // The root process is up and wrote its PID, as messenger.ts does at boot.
    fs.writeFileSync(path.join(storeDir, 'claudeclaw.pid'), String(process.pid), 'utf-8');

    const { _initTestDatabase } = await import('./db.js');
    _initTestDatabase();
    const { buildDashboardApp } = await import('./dashboard.js');
    const app = buildDashboardApp(undefined);

    const res = await app.request('/api/agents?token=test-contract-token');
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ id: string; running: boolean }> };
    const main = body.agents.find((agent) => agent.id === 'main');

    expect(main, 'main missing from /api/agents').toBeTruthy();
    expect(main!.running).toBe(true);
  });
});
