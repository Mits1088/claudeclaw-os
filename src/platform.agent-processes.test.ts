// listAgentProcesses() drives worker reconciliation (worker-supervisor.ts) and
// agent-create's process cleanup: whatever it fails to return is a process
// nobody stops. Every other suite that touches those paths mocks it out
// (worker-supervisor.test.ts, agent-create.lifecycle.test.ts), so this file
// exercises the real implementation against real processes -- no mocks -- and
// is what would have caught the enumerator being left on dist/index.js while
// activation moved to dist/main-entry.js.
//
// Fixtures live in a temporary project root, so the matcher only ever sees the
// children spawned here and never a ClaudeClaw instance running on the machine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listAgentProcesses } from './platform.js';

// A child must appear in `ps` / Win32_Process before it can be matched, and on
// Windows each poll shells out to PowerShell, so the budget is generous.
const APPEAR_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 200;

let projectRoot = '';
const children: ChildProcess[] = [];

/** Spawn a fixture script from the fake dist/ and keep a handle for teardown. */
function spawnFixture(scriptName: string, args: string[]): ChildProcess {
  const child = spawn(process.execPath, [path.join(projectRoot, 'dist', scriptName), ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
}

async function waitForPids(pids: number[]): Promise<void> {
  const deadline = Date.now() + APPEAR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = new Set(listAgentProcesses(projectRoot).map((info) => info.pid));
    if (pids.every((pid) => found.has(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

describe('listAgentProcesses enumerates real agent processes', () => {
  let dispatcherPid = 0;
  let legacyPid = 0;
  let unrelatedPid = 0;
  let anonymousPid = 0;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-entrypoints-'));
    fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    // Stay alive long enough to be observed, and self-terminate if teardown is
    // ever skipped so a failing run cannot leak a process onto the machine.
    const stayAlive = 'setTimeout(() => process.exit(0), 120000);\n';
    for (const name of ['main-entry.js', 'index.js', 'other.js']) {
      fs.writeFileSync(path.join(projectRoot, 'dist', name), stayAlive, 'utf-8');
    }

    dispatcherPid = spawnFixture('main-entry.js', ['--agent', 'alpha']).pid ?? 0;
    legacyPid = spawnFixture('index.js', ['--agent', 'beta']).pid ?? 0;
    unrelatedPid = spawnFixture('other.js', ['--agent', 'gamma']).pid ?? 0;
    anonymousPid = spawnFixture('main-entry.js', []).pid ?? 0;

    await waitForPids([dispatcherPid, legacyPid]);
  }, 60_000);

  afterAll(() => {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns a dispatcher process with the agent id from its command line', () => {
    const found = listAgentProcesses(projectRoot).find((info) => info.pid === dispatcherPid);
    expect(found).toBeDefined();
    expect(found?.agentId).toBe('alpha');
    expect(found?.commandLine).toContain('dist');
    expect(found?.commandLine).toContain('main-entry.js');
  });

  it('still returns a process launched from the legacy entrypoint', () => {
    // Services installed before the dispatcher change keep launching
    // dist/index.js until the operator re-runs setup. Dropping them from the
    // enumeration would orphan them instead of reconciling them.
    const found = listAgentProcesses(projectRoot).find((info) => info.pid === legacyPid);
    expect(found).toBeDefined();
    expect(found?.agentId).toBe('beta');
  });

  it('ignores a node process from the same checkout that is not a build entrypoint', () => {
    const pids = listAgentProcesses(projectRoot).map((info) => info.pid);
    expect(pids).not.toContain(unrelatedPid);
  });

  it('ignores an entrypoint process that carries no --agent identity', () => {
    const pids = listAgentProcesses(projectRoot).map((info) => info.pid);
    expect(pids).not.toContain(anonymousPid);
  });

  it('ignores processes belonging to another checkout', () => {
    expect(listAgentProcesses(path.join(projectRoot, 'elsewhere'))).toEqual([]);
  });
});
