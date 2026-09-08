import { AsyncLocalStorage } from 'node:async_hooks';

/** Explicit identity for one scheduler-owned mission execution. */
export interface MissionExecutionContext {
  taskId: string;
  actor: string;
}

export const MISSION_TASK_ID_ENV = 'CLAUDECLAW_MISSION_TASK_ID';
export const MISSION_ACTOR_ENV = 'CLAUDECLAW_MISSION_ACTOR';

const storage = new AsyncLocalStorage<MissionExecutionContext>();

function normalize(context: MissionExecutionContext): MissionExecutionContext {
  return {
    taskId: context.taskId.trim(),
    actor: context.actor.trim().toLowerCase(),
  };
}

/** Run a mission turn with identity that follows its async call chain. */
export function runWithMissionExecutionContext<T>(
  context: MissionExecutionContext,
  fn: () => T,
): T {
  return storage.run(normalize(context), fn);
}

/**
 * Read the current identity. Environment fallback is intentionally limited to
 * the two explicit variables used by CLI/stdio child processes; there is no
 * lookup for "whatever task this agent currently has running".
 */
export function getMissionExecutionContext(
  env: NodeJS.ProcessEnv = process.env,
): MissionExecutionContext | undefined {
  const local = storage.getStore();
  if (local) return local;
  const taskId = env[MISSION_TASK_ID_ENV]?.trim();
  const actor = env[MISSION_ACTOR_ENV]?.trim().toLowerCase();
  // A propagated task id without an actor is malformed mission scope, not an
  // interactive turn. Preserve it with an empty actor so store validation fails
  // closed instead of silently becoming unscoped.
  return taskId ? { taskId, actor: actor ?? '' } : undefined;
}

/** Explicit values to add to a provider/CLI child environment. */
export function missionExecutionEnv(
  context: MissionExecutionContext | undefined = getMissionExecutionContext(),
): Record<string, string> {
  return context
    ? { [MISSION_TASK_ID_ENV]: context.taskId, [MISSION_ACTOR_ENV]: context.actor }
    : {};
}
