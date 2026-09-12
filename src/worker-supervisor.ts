import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { listAgentIds, loadAgentConfig } from './agent-config.js';
import { activateAgentAndWait } from './agent-create.js';
import { PROJECT_ROOT, STORE_DIR } from './config.js';
import {
  acquireWorkerLease,
  beginWorkerSupervisorEpoch,
  ensureWorkerDesiredState,
  getWorkerRuntime,
  heartbeatWorkerLease,
  isWorkerLeaseCurrent,
  listWorkerRuntime,
  releaseWorkerLease,
} from './db.js';
import { logger } from './logger.js';
import { isProcessAlive, killProcess, listAgentProcesses } from './platform.js';

export const WORKER_HEARTBEAT_MS = 15_000;
let ownedEpoch: string | undefined;

function runtimeBuildId(): string {
  const entry = path.join(PROJECT_ROOT, 'dist', 'index.js');
  try {
    const stat = fs.statSync(entry);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    return 'unbuilt';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopAndConfirm(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  killProcess(pid);
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if (!isProcessAlive(pid)) return true;
  }
  killProcess(pid, true);
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if (!isProcessAlive(pid)) return true;
  }
  return false;
}

/**
 * Main-process startup reconciliation. Every startup creates a new fencing
 * epoch, stops all headless or no-longer-configured processes from this exact
 * checkout, and launches desired workers against the new epoch/build.
 */
export async function reconcileHeadlessWorkers(): Promise<void> {
  const configured = new Map<string, 'headless' | 'messenger'>();
  for (const id of listAgentIds()) {
    try {
      configured.set(id, loadAgentConfig(id).runtimeMode);
    } catch {
      // Broken configs are not safe to launch. Existing exact-checkout
      // processes with that id are treated as orphans below.
    }
  }

  const processes = listAgentProcesses(PROJECT_ROOT);
  const runningIds = new Set(processes.map((process) => process.agentId));

  // Backward-compatible first run: a legacy PID file means the worker had
  // been explicitly activated under the pre-lease runtime, even if its PID is
  // now stale. Configured workers without that evidence stay inactive.
  for (const [id, mode] of configured) {
    if (mode !== 'headless' || getWorkerRuntime(id)) continue;
    const legacyPidFile = path.join(STORE_DIR, `agent-${id}.pid`);
    ensureWorkerDesiredState(id, fs.existsSync(legacyPidFile) || runningIds.has(id) ? 'active' : 'inactive');
  }

  const epoch = crypto.randomUUID();
  const buildId = runtimeBuildId();
  beginWorkerSupervisorEpoch(epoch, buildId);
  ownedEpoch = epoch;

  const failedStops = new Set<string>();
  for (const process of processes) {
    const mode = configured.get(process.agentId);
    if (mode === 'messenger') continue;
    const stopped = await stopAndConfirm(process.pid);
    if (!stopped) {
      failedStops.add(process.agentId);
      logger.error({ agentId: process.agentId, pid: process.pid }, 'Worker reconciliation could not stop stale process');
    } else {
      logger.info({ agentId: process.agentId, pid: process.pid }, 'Stopped stale worker process');
    }
  }

  const launches: Promise<void>[] = [];
  for (const state of listWorkerRuntime()) {
    if (state.desired_state !== 'active' || configured.get(state.agent_id) !== 'headless') continue;
    if (failedStops.has(state.agent_id)) {
      logger.error({ agentId: state.agent_id }, 'Worker left unhealthy because stale process termination was not confirmed');
      continue;
    }
    launches.push(activateAgentAndWait(state.agent_id, { preserveDesiredState: true }).then((result) => {
      if (!result.ok) logger.error({ agentId: state.agent_id, error: result.error }, 'Worker relaunch failed during reconciliation');
    }));
  }
  await Promise.all(launches);

  logger.info({ epoch, buildId }, 'Headless worker reconciliation complete');
}

/** Revoke all leases and stop worker children before the main process exits. */
export async function shutdownHeadlessWorkers(): Promise<void> {
  if (!ownedEpoch || beginWorkerSupervisorEpoch(`shutdown-${crypto.randomUUID()}`, runtimeBuildId(), ownedEpoch) === false) return;
  ownedEpoch = undefined;
  const messengerIds = new Set<string>();
  for (const id of listAgentIds()) {
    try {
      if (loadAgentConfig(id).runtimeMode === 'messenger') messengerIds.add(id);
    } catch { /* unknown exact-checkout processes are treated as orphans */ }
  }
  for (const process of listAgentProcesses(PROJECT_ROOT)) {
    if (messengerIds.has(process.agentId)) continue;
    const stopped = await stopAndConfirm(process.pid);
    if (!stopped) logger.error({ agentId: process.agentId, pid: process.pid }, 'Worker did not stop during main shutdown');
  }
}

export interface WorkerLeaseHandle {
  instanceId: string;
  isCurrent(): boolean;
  stop(): void;
}

/** Acquire and maintain the lease supplied by the current main supervisor. */
export function startWorkerLease(agentId: string): WorkerLeaseHandle {
  const instanceId = process.env.CLAUDECLAW_WORKER_INSTANCE_ID ?? '';
  const supervisorEpoch = process.env.CLAUDECLAW_WORKER_SUPERVISOR_EPOCH ?? '';
  const buildId = process.env.CLAUDECLAW_WORKER_BUILD_ID ?? '';
  if (!instanceId || !supervisorEpoch || !buildId) {
    throw new Error(`Headless worker ${agentId} must be launched by the active ClaudeClaw supervisor`);
  }
  const acquired = acquireWorkerLease({
    agentId,
    instanceId,
    supervisorEpoch,
    pid: process.pid,
    processStartedAt: Math.floor(Date.now() / 1000),
    runtimeBuildId: buildId,
  });
  if (!acquired) throw new Error(`Headless worker ${agentId} was denied a stale or inactive lease`);

  const timer = setInterval(() => {
    if (heartbeatWorkerLease(agentId, instanceId)) return;
    clearInterval(timer);
    logger.error({ agentId, instanceId }, 'Worker lease was revoked; exiting stale process');
    try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(1); }
  }, WORKER_HEARTBEAT_MS);
  timer.unref();

  return {
    instanceId,
    isCurrent: () => isWorkerLeaseCurrent(agentId, instanceId),
    stop: () => {
      clearInterval(timer);
      releaseWorkerLease(agentId, instanceId);
    },
  };
}
