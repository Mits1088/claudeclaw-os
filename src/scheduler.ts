import {
  AGENT_ID,
  ALLOWED_CHAT_ID,
  SCHEDULER_IDLE_TIMEOUT_MS,
  SCHEDULER_MAX_RUNTIME_MS,
  agentMcpAllowlist,
  agentDefaultModel,
} from './config.js';
import { computeNextRun } from './cron.js';
import { ingestConversationTurn } from './memory-ingest.js';
import {
  getDueTasks,
  getSession,
  logConversationTurn,
  markTaskRunning,
  updateTaskAfterRun,
  resetStuckTasks,
  claimNextMissionTask,
  completeMissionTask,
  resetStuckMissionTasks,
  failStuckMissionTasks,
  getMissionTask,
  missionClaimIsCurrent,
  maybeReleaseJoinForMission,
  isWorkerLeaseCurrent,
  markWorkerTaskScopeStarted,
  deactivateWorkerIfTaskScopeDrained,
  type MissionTask,
  type MissionClaimFence,
  type ScheduledTask,
} from './db.js';
import type { AgentLifecycleMode } from './agent-config.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { isFailedTurn, runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { getSelectedProviderConfig } from './active-provider.js';
import { evaluateAcceptance } from './acceptance.js';
import { TurnWatchdog, type TurnAbortReason } from './turn-watchdog.js';

type Sender = (text: string) => Promise<void>;

let sender: Sender = async () => {
  throw new Error('scheduler is not ready');
};
let schedulerInitialized = false;

function formatRuntime(ms: number, attributive = false): string {
  if (ms % 60_000 !== 0) return `${ms}ms`;
  const minutes = ms / 60_000;
  return attributive ? `${minutes}-minute` : `${minutes} minutes`;
}

export function schedulerAbortDescription(reason: TurnAbortReason | undefined): string {
  if (reason === 'idle_timeout') {
    return `Timed out after ${formatRuntime(SCHEDULER_IDLE_TIMEOUT_MS)} without provider activity`;
  }
  if (reason === 'max_runtime') {
    return `Stopped after reaching the ${formatRuntime(SCHEDULER_MAX_RUNTIME_MS, true)} maximum runtime`;
  }
  return 'Stopped';
}

/**
 * In-memory set of task IDs currently being executed.
 * Acts as a fast-path guard alongside the DB-level lock in markTaskRunning.
 */
const runningTaskIds = new Set<string>();

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
let schedulerAgentId = 'main';
let schedulerWorkerInstanceId: string | undefined;
let schedulerLifecycleMode: AgentLifecycleMode = 'persistent';
let onTaskScopeDrained: (() => void) | undefined;
let taskScopeDrainRequested = false;

/**
 * Give the target agent the mission identity required by the documented
 * `mission-cli handback <task-id>` workflow. The stored user prompt remains
 * unchanged; runtime metadata is added only when the mission is executed.
 */
export function missionExecutionPrompt(mission: Pick<MissionTask, 'id' | 'title' | 'created_by' | 'assigned_agent' | 'prompt' | 'role' | 'continuation_limit'>): string {
  const completionInstruction = mission.role === 'handback'
    ? 'This is a terminal handback. Return the report directly and do not create another handback.'
    : mission.assigned_agent === mission.created_by
      ? mission.role === 'continuation'
        ? `This is a bounded self-directed continuation. To queue another step, use the mission_continue tool when available with task_id ${mission.id}; CLI fallback: mission-cli continue ${mission.id} "<next-step prompt>" --key <stable-key>. The chain limit is ${mission.continuation_limit}.`
        : `This task is self-directed. Complete it directly without a handback. If the request explicitly requires a bounded queued continuation, use the mission_continue tool when available with task_id ${mission.id}; CLI fallback: mission-cli continue ${mission.id} "<next-step prompt>" --key <stable-key> --max-steps <N>.`
    : `If an explicit handback is required, use: mission-cli handback ${mission.id} "<report>".`;
  return [
    `[Mission task: ${mission.title}]`,
    `Task ID: ${mission.id}`,
    `Created by: @${mission.created_by}`,
    completionInstruction,
    '',
    mission.prompt,
  ].join('\n');
}

export function initScheduler(
  send: Sender,
  agentId = 'main',
  workerInstanceId?: string,
  lifecycleMode: AgentLifecycleMode = 'persistent',
  drained?: () => void,
): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerInitialized = true;
  schedulerAgentId = agentId;
  schedulerWorkerInstanceId = workerInstanceId;
  schedulerLifecycleMode = lifecycleMode;
  onTaskScopeDrained = drained;
  taskScopeDrainRequested = false;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = workerInstanceId
    ? failStuckMissionTasks(agentId, 'Worker process restarted before recording completion; inspect side effects before retrying')
    : resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn(
      { recovered: recoveredMission, agentId, fencedWorker: Boolean(workerInstanceId) },
      'Marked interrupted missions failed; automatic replay is disabled',
    );
  }

  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

function armTaskScope(workId: string): void {
  if (schedulerLifecycleMode !== 'task-scoped' || !schedulerWorkerInstanceId) return;
  markWorkerTaskScopeStarted(schedulerAgentId, schedulerWorkerInstanceId, workId);
}

function maybeDeactivateTaskScope(): void {
  if (
    taskScopeDrainRequested
    || schedulerLifecycleMode !== 'task-scoped'
    || !schedulerWorkerInstanceId
  ) return;
  if (!deactivateWorkerIfTaskScopeDrained(schedulerAgentId, schedulerWorkerInstanceId)) return;
  taskScopeDrainRequested = true;
  logger.info({ agentId: schedulerAgentId }, 'Task-scoped worker drained; deactivating');
  onTaskScopeDrained?.();
}

async function runDueTasks(): Promise<void> {
  if (schedulerWorkerInstanceId && !isWorkerLeaseCurrent(schedulerAgentId, schedulerWorkerInstanceId)) {
    logger.warn({ agentId: schedulerAgentId }, 'Worker scheduler paused because its lease is not current');
    return;
  }
  const tasks = getDueTasks(schedulerAgentId);

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks');
  }

  for (const task of tasks) {
    // In-memory guard: skip if already running in this process
    if (runningTaskIds.has(task.id)) {
      logger.warn({ taskId: task.id }, 'Task already running, skipping duplicate fire');
      continue;
    }

    // Compute next occurrence BEFORE executing so we can lock the task
    // in the DB immediately, preventing re-fire on subsequent ticks.
    const nextRun = computeNextRun(task.schedule);
    enqueueScheduledTask(task, nextRun, false);
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
  maybeDeactivateTaskScope();
}

export type QueueScheduledTaskNowResult =
  | { ok: true; queued: true }
  | { ok: false; reason: 'unavailable' | 'unsupported_agent' | 'already_running'; error: string };

/**
 * Queue one scheduled task immediately without changing its cron or next_run.
 * The dashboard only runs in the main process, so it must not execute another
 * agent's task with main's provider, model, allowlist, and notification sender.
 */
export function queueScheduledTaskNow(task: ScheduledTask): QueueScheduledTaskNowResult {
  if (!schedulerInitialized) {
    return { ok: false, reason: 'unavailable', error: 'scheduler is not ready' };
  }
  if (task.agent_id !== schedulerAgentId) {
    return {
      ok: false,
      reason: 'unsupported_agent',
      error: `run now is only available for ${schedulerAgentId} tasks in this dashboard`,
    };
  }
  if (task.status === 'running' || runningTaskIds.has(task.id)) {
    return { ok: false, reason: 'already_running', error: 'task is already running or queued' };
  }

  enqueueScheduledTask(task, task.next_run, true);
  return { ok: true, queued: true };
}

function enqueueScheduledTask(
  task: ScheduledTask,
  nextRun: number,
  manual: boolean,
): void {
  const send = sender;

  armTaskScope(task.id);
  runningTaskIds.add(task.id);
  try {
    // Automatic fires advance next_run before enqueueing. Manual fires only
    // take the DB lock. The same write persists activation for completion or
    // crash recovery; no callback-only state is needed to keep a job paused.
    markTaskRunning(task.id, manual ? undefined : nextRun);
  } catch (err) {
    runningTaskIds.delete(task.id);
    throw err;
  }

  logger.info(
    { taskId: task.id, prompt: task.prompt.slice(0, 60), manual },
    manual ? 'Queueing scheduled task for manual run' : 'Firing task',
  );

  // Route through the message queue so scheduled tasks wait for any
  // in-flight user message to finish before running. This prevents
  // two Claude processes from hitting the same session simultaneously.
  const chatId = ALLOWED_CHAT_ID || 'scheduler';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const watchdog = new TurnWatchdog(
      abortController,
      SCHEDULER_IDLE_TIMEOUT_MS,
      SCHEDULER_MAX_RUNTIME_MS,
    );
    watchdog.start();

    try {
      await send([
        `🕐 Scheduled job running: "${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '...' : ''}"`,
        `Job ID: ${task.id}`,
      ].join('\n'));

      // Run as a fresh agent call (no session — scheduled tasks are autonomous)
      const result = await runAgent(
        task.prompt,
        undefined,
        () => {},
        undefined,
        agentDefaultModel,
        abortController,
        undefined,
        agentMcpAllowlist,
        getSelectedProviderConfig(),
        undefined,
        undefined,
        watchdog,
      );

      if (result.aborted) {
        const description = schedulerAbortDescription(result.abortReason);
        updateTaskAfterRun(task.id, nextRun, description, 'timeout');
        await send(`⏱ Task stopped: "${task.prompt.slice(0, 60)}..." — ${description}.`);
        logger.warn({ taskId: task.id, abortReason: result.abortReason }, 'Task stopped by scheduler watchdog');
        return;
      }

      if (isFailedTurn(result)) {
        const reason = result.stopReason ?? 'unknown error';
        // Codex adapter puts the error message in result.text — keep it as the
        // error, never as the result.
        updateTaskAfterRun(task.id, nextRun, `Agent run failed (${reason})${result.text ? `: ${result.text.slice(0, 400)}` : ''}`.slice(0, 500), 'failed');
        logger.error({ taskId: task.id, stopReason: result.stopReason }, 'Scheduled task run failed');
        try {
          await send(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${reason}`);
        } catch (sendErr) {
          logger.warn({ err: sendErr, taskId: task.id }, 'Failed to send task failure notification');
        }
        return;
      }

      const text = result.text?.trim() || 'Task completed with no output.';
      const acceptancePassed = evaluateAcceptance(task.acceptance_check, result.text ?? '');
      const lastStatus: 'success' | 'failed' = acceptancePassed ? 'success' : 'failed';
      const resultText = acceptancePassed
        ? text
        : `Acceptance check not met: output did not contain "${task.acceptance_check}".\n\n${text}`;
      for (const chunk of splitMessage(formatForTelegram(text))) {
        await send(chunk);
      }
      if (!acceptancePassed) {
        await send(`⚠ Acceptance check not met: expected output to contain "${task.acceptance_check}".`);
      }

      // Inject task output into the active chat session so user replies have context
      if (ALLOWED_CHAT_ID) {
        const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
        logConversationTurn(ALLOWED_CHAT_ID, 'user', `[Scheduled task]: ${task.prompt}`, activeSession ?? undefined, schedulerAgentId);
        logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
      }

      // Fire-and-forget memory extraction. Synthetic chat_id when this agent has no
      // user-facing Telegram chat (specialists usually don't). Memory is valuable
      // even on background tasks — they produce content worth remembering, just
      // grouped under a per-agent synthetic thread instead of a real user chat.
      const ingestChatId = ALLOWED_CHAT_ID || `scheduled-${schedulerAgentId}`;
      void ingestConversationTurn(ingestChatId, `[Scheduled task]: ${task.prompt}`, text, schedulerAgentId).catch((err) => {
        logger.error({ err, taskId: task.id }, 'Memory ingestion fire-and-forget failed (scheduled task)');
      });

      updateTaskAfterRun(task.id, nextRun, resultText, lastStatus);

      logger.info({ taskId: task.id, nextRun, manual }, 'Task complete, next run scheduled');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

      logger.error({ err, taskId: task.id }, 'Scheduled task failed');
      try {
        await send(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
      } catch {
        // ignore send failure
      }
    } finally {
      watchdog.dispose();
      runningTaskIds.delete(task.id);
      maybeDeactivateTaskScope();
    }
  });
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId, schedulerWorkerInstanceId);
  if (!mission) return;
  const claimFence: MissionClaimFence | undefined = schedulerWorkerInstanceId
    ? {
        agentId: schedulerAgentId,
        instanceId: schedulerWorkerInstanceId,
        generation: mission.claim_generation ?? 0,
      }
    : undefined;
  armTaskScope(mission.id);

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  logger.info({ missionId: mission.id, title: mission.title }, 'Running mission task');

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    if (!missionClaimIsCurrent(mission.id, claimFence)) {
      logger.info({ missionId: mission.id }, 'Skipped stale queued mission callback');
      runningTaskIds.delete(missionKey);
      maybeDeactivateTaskScope();
      return;
    }
    const abortController = new AbortController();
    const watchdog = new TurnWatchdog(
      abortController,
      SCHEDULER_IDLE_TIMEOUT_MS,
      SCHEDULER_MAX_RUNTIME_MS,
    );
    watchdog.start();

    // Cross-process cancel signal: dashboard flips status to 'cancelled' in
    // SQLite, this poll picks it up within 5s and aborts the runAgent call.
    let cancelledByUser = false;
    const cancelPoll = setInterval(() => {
      const current = getMissionTask(mission.id);
      if (current?.status === 'cancelled') {
        cancelledByUser = true;
        abortController.abort();
        clearInterval(cancelPoll);
      }
    }, 5_000);

    try {
      await sender([
        `🎯 Mission task running: "${mission.title}"`,
        `Task ID: ${mission.id}`,
      ].join('\n'));

      // Sending the startup notification is awaited and may yield behind other
      // work. Recheck the durable claim immediately before invoking a provider.
      if (!missionClaimIsCurrent(mission.id, claimFence)) {
        logger.info({ missionId: mission.id }, 'Mission claim ended before provider execution');
        return;
      }

      const result = await runAgent(
        missionExecutionPrompt(mission),
        undefined,
        () => {},
        undefined,
        agentDefaultModel,
        abortController,
        undefined,
        agentMcpAllowlist,
        getSelectedProviderConfig(),
        undefined,
        undefined,
        watchdog,
      );
      clearInterval(cancelPoll);

      if (result.aborted) {
        if (cancelledByUser) {
          // Status is already 'cancelled' from the dashboard write — leave it.
          logger.info({ missionId: mission.id }, 'Mission task cancelled by user');
        } else {
          const description = schedulerAbortDescription(result.abortReason);
          if (!completeMissionTask(mission.id, null, 'failed', description, claimFence)) {
            logger.info({ missionId: mission.id }, 'Ignored stale mission timeout completion');
            return;
          }
          maybeReleaseJoinForMission({ ...mission, status: 'failed' });
          logger.warn(
            { missionId: mission.id, abortReason: result.abortReason },
            'Mission task stopped by scheduler watchdog',
          );
          try {
            await sender('Mission task stopped: "' + mission.title + '" — ' + description + '.');
          } catch (sendErr) {
            // Sender can fail for Telegram API blips or chat-not-found. We
            // still want to see it so the user isn't silently unnotified.
            logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission timeout notification');
          }
        }
      } else if (isFailedTurn(result)) {
        const reason = result.stopReason ?? 'unknown error';
        // Codex adapter puts the error message in result.text — keep it as the
        // error, never as the result.
        if (!completeMissionTask(
          mission.id,
          null,
          'failed',
          `Agent run failed (${reason})${result.text ? `: ${result.text.slice(0, 400)}` : ''}`,
          claimFence,
        )) {
          logger.info({ missionId: mission.id }, 'Ignored stale mission failure completion');
          return;
        }
        maybeReleaseJoinForMission({ ...mission, status: 'failed' });
        logger.error({ missionId: mission.id, stopReason: result.stopReason }, 'Mission task run failed');
        try {
          await sender(`❌ Mission task failed: "${mission.title}" (${reason})`);
        } catch (sendErr) {
          logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission failure notification');
        }
      } else {
        // A mission can finish with nothing to say — most often an FYI handback
        // that landed on this agent's board (e.g. a report routed back to the
        // originator). We still want a closure signal (silence reads as an
        // unresponsive bot), but not the noisy "Task completed with no output."
        // wall. So: real output goes through as-is; an empty turn gets a compact
        // completion marker, and doesn't pollute conversation context/memory.
        const rawText = result.text?.trim() ?? '';
        const hasOutput = rawText.length > 0;
        const text = hasOutput ? rawText : 'Task completed with no output.';
        if (!completeMissionTask(mission.id, text, 'completed', undefined, claimFence)) {
          logger.info({ missionId: mission.id }, 'Ignored stale mission success completion');
          return;
        }
        maybeReleaseJoinForMission({ ...mission, status: 'completed' });
        logger.info({ missionId: mission.id, hasOutput }, 'Mission task completed');

        // Always give a closure signal: full output when there is any,
        // otherwise a compact one-line marker instead of the noisy placeholder.
        if (hasOutput) {
          for (const chunk of splitMessage(formatForTelegram(text))) {
            await sender(chunk);
          }
        } else {
          await sender(`✓ ${mission.title} — done`);
        }

        // Inject into conversation context so agent can reference it (skip empty turns).
        if (ALLOWED_CHAT_ID && hasOutput) {
          const activeSession = getSession(ALLOWED_CHAT_ID, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'user', '[Mission task: ' + mission.title + ']: ' + mission.prompt, activeSession ?? undefined, schedulerAgentId);
          logConversationTurn(ALLOWED_CHAT_ID, 'assistant', text, activeSession ?? undefined, schedulerAgentId);
        }

        // Fire-and-forget memory extraction. Synthetic chat_id when this agent has no
        // user-facing Telegram chat (specialists usually don't). Mission tasks produce
        // content worth remembering, grouped under a per-agent synthetic thread.
        // Skip when there was no output — nothing worth remembering.
        if (hasOutput) {
          const ingestChatId = ALLOWED_CHAT_ID || `mission-${schedulerAgentId}`;
          void ingestConversationTurn(ingestChatId, '[Mission task: ' + mission.title + ']: ' + mission.prompt, text, schedulerAgentId).catch((err) => {
            logger.error({ err, missionId: mission.id }, 'Memory ingestion fire-and-forget failed (mission task)');
          });
        }
      }
    } catch (err) {
      clearInterval(cancelPoll);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (cancelledByUser) {
        logger.info({ missionId: mission.id }, 'Mission task cancelled by user (threw on abort)');
      } else {
        if (!completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500), claimFence)) {
          logger.info({ missionId: mission.id }, 'Ignored stale thrown mission completion');
          return;
        }
        maybeReleaseJoinForMission({ ...mission, status: 'failed' });
        logger.error({ err, missionId: mission.id }, 'Mission task failed');
        try {
          await sender(`❌ Mission task failed: "${mission.title}" — ${errMsg.slice(0, 200)}`);
        } catch (sendErr) {
          logger.warn({ err: sendErr, missionId: mission.id }, 'Failed to send mission failure notification');
        }
      }
    } finally {
      clearInterval(cancelPoll);
      watchdog.dispose();
      runningTaskIds.delete(missionKey);
      maybeDeactivateTaskScope();
    }
  });
}

// Re-exported from the leaf `cron.ts` so the historical `./scheduler.js` import
// path (dashboard.ts, etc.) keeps working while the single implementation lives
// in a module the dispatch action layer can import without a cycle.
export { computeNextRun } from './cron.js';
