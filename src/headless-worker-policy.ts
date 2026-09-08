import type { AgentRuntimeMode } from './agent-config.js';

/**
 * Recovery containment. The shared host process has production credentials and
 * store access. Provider tool lists and write sandboxes cannot isolate reads or
 * credential helpers, so no headless worker may boot through this host path.
 * There is deliberately no environment/config override. Replace this gate only
 * with a verified isolated launcher, not an operator permission toggle.
 */
export function assertWorkerRuntimeContained(runtimeMode: AgentRuntimeMode): void {
  if (runtimeMode !== 'messenger') {
    throw new Error('Headless worker execution is disabled pending isolated worker permission enforcement');
  }
}
