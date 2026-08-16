import { AGENT_ID, ALLOWED_CHAT_ID, agentMcpAllowlist, agentDefaultModel } from './config.js';
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
  getMissionTask,
  maybeReleaseJoinForMission,
  type MissionTask,
} from './db.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { isFailedTurn, runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';
import { getSelectedProviderConfig } from './active-provider.js';
import { evaluateAcceptance } from './acceptance.js';

type Sender = (text: string) => Promise<void>;

/** Max time (ms) a scheduled task can run before being killed. */
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let sender: Sender;

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

export function initScheduler(send: Sender, agentId = 'main'): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  schedulerAgentId = agentId;

  // Recover tasks stuck in 'running' from a previous crash
  const recovered = resetStuckTasks(agentId);
  if (recovered > 0) {
    logger.warn({ recovered, agentId }, 'Reset stuck tasks from previous crash');
  }
  const recoveredMission = resetStuckMissionTasks(agentId);
  if (recoveredMission > 0) {
    logger.warn({ recovered: recoveredMission, agentId }, 'Reset stuck mission tasks from previous crash');
  }

  setInterval(() => void runDueTasks(), 60_000);
  logger.info({ agentId }, 'Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
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
    runningTaskIds.add(task.id);
    markTaskRunning(task.id, nextRun);

    logger.info({ taskId: task.id, prompt: task.prompt.slice(0, 60) }, 'Firing task');

    // Route through the message queue so scheduled tasks wait for any
    // in-flight user message to finish before running. This prevents
    // two Claude processes from hitting the same session simultaneously.
    const chatId = ALLOWED_CHAT_ID || 'scheduler';
    messageQueue.enqueue(chatId, async () => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

      try {
        await sender([
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
        );
        clearTimeout(timeout);

        if (result.aborted) {
          updateTaskAfterRun(task.id, nextRun, 'Timed out after 10 minutes', 'timeout');
          await sender(`⏱ Task timed out after 10m: "${task.prompt.slice(0, 60)}..." — killed.`);
          logger.warn({ taskId: task.id }, 'Task timed out');
          return;
        }

        if (isFailedTurn(result)) {
          const reason = result.stopReason ?? 'unknown error';
          // Codex adapter puts the error message in result.text — keep it as the
          // error, never as the result.
          updateTaskAfterRun(task.id, nextRun, `Agent run failed (${reason})${result.text ? `: ${result.text.slice(0, 400)}` : ''}`.slice(0, 500), 'failed');
          logger.error({ taskId: task.id, stopReason: result.stopReason }, 'Scheduled task run failed');
          try {
            await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${reason}`);
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
          await sender(chunk);
        }
        if (!acceptancePassed) {
          await sender(`⚠ Acceptance check not met: expected output to contain "${task.acceptance_check}".`);
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

        logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
      } catch (err) {
        clearTimeout(timeout);
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskAfterRun(task.id, nextRun, errMsg.slice(0, 500), 'failed');

        logger.error({ err, taskId: task.id }, 'Scheduled task failed');
        try {
          await sender(`❌ Task failed: "${task.prompt.slice(0, 60)}..." — ${errMsg.slice(0, 200)}`);
        } catch {
          // ignore send failure
        }
      } finally {
        runningTaskIds.delete(task.id);
      }
    });
  }

  // Also check for queued mission tasks (one-shot async tasks from Mission Control)
  await runDueMissionTasks();
}

async function runDueMissionTasks(): Promise<void> {
  const mission = claimNextMissionTask(schedulerAgentId);
  if (!mission) return;

  const missionKey = 'mission-' + mission.id;
  if (runningTaskIds.has(missionKey)) return;
  runningTaskIds.add(missionKey);

  logger.info({ missionId: mission.id, title: mission.title }, 'Running mission task');

  const chatId = ALLOWED_CHAT_ID || 'mission';
  messageQueue.enqueue(chatId, async () => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

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
      );
      clearTimeout(timeout);
      clearInterval(cancelPoll);

      if (result.aborted) {
        if (cancelledByUser) {
          // Status is already 'cancelled' from the dashboard write — leave it.
          logger.info({ missionId: mission.id }, 'Mission task cancelled by user');
        } else {
          completeMissionTask(mission.id, null, 'failed', 'Timed out after 10 minutes');
          maybeReleaseJoinForMission({ ...mission, status: 'failed' });
          logger.warn({ missionId: mission.id }, 'Mission task timed out');
          try {
            await sender('Mission task timed out: "' + mission.title + '"');
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
        completeMissionTask(mission.id, null, 'failed', `Agent run failed (${reason})${result.text ? `: ${result.text.slice(0, 400)}` : ''}`);
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
        completeMissionTask(mission.id, text, 'completed');
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
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (cancelledByUser) {
        logger.info({ missionId: mission.id }, 'Mission task cancelled by user (threw on abort)');
      } else {
        completeMissionTask(mission.id, null, 'failed', errMsg.slice(0, 500));
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
      runningTaskIds.delete(missionKey);
    }
  });
}

// Re-exported from the leaf `cron.ts` so the historical `./scheduler.js` import
// path (dashboard.ts, etc.) keeps working while the single implementation lives
// in a module the dispatch action layer can import without a cycle.
export { computeNextRun } from './cron.js';
