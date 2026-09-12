import type { AgentRuntimeMode } from './agent-config.js';

/** Trusted local workers use the existing supervisor lease, not OS isolation. */
export function assertWorkerRuntimeContained(runtimeMode: AgentRuntimeMode): void {
  if (runtimeMode === 'messenger') return;
  if (!process.env.CLAUDECLAW_WORKER_INSTANCE_ID
    || !process.env.CLAUDECLAW_WORKER_SUPERVISOR_EPOCH
    || !process.env.CLAUDECLAW_WORKER_BUILD_ID) {
    throw new Error('Headless worker requires admission through the active supervisor');
  }
}
