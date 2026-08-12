/**
 * Shared, callable implementations behind the agent CLIs.
 *
 * These functions are the SINGLE source of business logic for mission /
 * schedule / hive operations. Two callers share them, so behavior can never
 * drift between "run the CLI" and "call the tool":
 *
 *   1. The `*-cli.ts` entrypoints parse argv, call an action, and format the
 *      result for stdout.
 *   2. The in-process dispatch tools (`dispatch-tools.ts`) validate a schema,
 *      call the SAME action, and return a text summary to the model.
 *
 * Actions take STRUCTURED input (never argv) and return STRUCTURED results —
 * they never `console.log` or `process.exit`. Recoverable validation problems
 * (unknown agent, bad cron, missing task) throw `CliActionError`; each caller
 * decides how to surface it (the CLI prints to stderr + exits 1; the tool
 * returns an `isError` result). This keeps `db.ts` the leaf data layer and
 * avoids re-parsing argv in two places.
 */

import { randomBytes } from 'crypto';
import path from 'path';

import { STORE_DIR } from './config.js';
import {
  ensureDatabase,
  createMissionTask,
  getMissionTasks,
  getMissionTask,
  cancelMissionTask,
  createScheduledTask,
  getAllScheduledTasks,
  deleteScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  logToHiveMind,
  getHiveMindEntries,
  type MissionTask,
  type ScheduledTask,
  type HiveMindEntry,
} from './db.js';
import { resolveAgentId, knownAgentIds } from './agent-config.js';
import { resolveHandbackDestination, MAIN_AGENT_ID } from './routing.js';
import { computeNextRun } from './cron.js';

/**
 * A recoverable, user-facing action failure (unknown agent, bad cron, missing
 * task). Thrown before any write, so aborting leaves the store untouched — no
 * dead letters. Distinguished from programmer errors so callers can surface the
 * message verbatim rather than a stack trace.
 */
export class CliActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliActionError';
  }
}

/** Default creating/owning agent for a write, from the process env. */
function defaultAgent(): string {
  return process.env.CLAUDECLAW_AGENT_ID ?? 'main';
}

/**
 * Resolve an agent reference (id, display name, or alias) to its canonical id,
 * throwing `CliActionError` (never exiting) on an unknown agent. The message is
 * identical to the CLI-exit variant so callers keep the same self-diagnosing
 * error surface.
 */
export function resolveAgentOrThrow(input: string): string {
  const id = resolveAgentId(input);
  if (id === null) {
    throw new CliActionError(`unknown agent '${input}' — known: ${knownAgentIds().join(', ')}`);
  }
  return id;
}

// ── mission ────────────────────────────────────────────────────────────────

export interface CreateMissionInput {
  prompt: string;
  agent?: string | null;
  title?: string;
  priority?: number;
  createdBy?: string;
}
export interface CreateMissionResult {
  id: string;
  title: string;
  agent: string | null;
  priority: number;
  prompt: string;
}

export function actionCreateMission(input: CreateMissionInput): CreateMissionResult {
  const prompt = input.prompt;
  if (!prompt) throw new CliActionError('a mission prompt is required');
  ensureDatabase();
  const resolvedAgent =
    input.agent !== null && input.agent !== undefined && input.agent !== ''
      ? resolveAgentOrThrow(input.agent)
      : null;
  const priority = input.priority ?? 5;
  const title = input.title || prompt.slice(0, 60);
  const id = randomBytes(4).toString('hex');
  createMissionTask(id, title, prompt, resolvedAgent, input.createdBy ?? defaultAgent(), priority);
  return { id, title, agent: resolvedAgent, priority, prompt };
}

export interface HandbackInput {
  taskId: string;
  report: string;
  priority?: number;
  createdBy?: string;
}
export interface HandbackResult {
  kind: 'agent' | 'human';
  missionId: string;
  parentId: string;
  dest: string;
  reason?: string;
}

export function actionHandbackMission(input: HandbackInput): HandbackResult {
  if (!input.taskId || !input.report) throw new CliActionError('handback requires a task id and report text');
  ensureDatabase();
  const createdBy = input.createdBy ?? defaultAgent();
  const priority = input.priority ?? 5;
  const parent = getMissionTask(input.taskId);
  if (!parent) throw new CliActionError(`Task not found: ${input.taskId}`);
  if (parent.role === 'handback') {
    throw new CliActionError(`Task ${parent.id} is already a terminal handback and cannot generate another handback`);
  }

  const dest = resolveHandbackDestination(parent.created_by);
  if (dest.kind === 'agent' && dest.agent === createdBy.trim().toLowerCase()) {
    throw new CliActionError(
      `Task ${parent.id} was created by and assigned back to @${dest.agent}; complete it directly without a handback`,
    );
  }
  const id = randomBytes(4).toString('hex');
  const title = `Handback: ${parent.title}`.slice(0, 80);

  if (dest.kind === 'agent') {
    const body = [
      `Handback report for task ${parent.id} ("${parent.title}").`,
      `From: @${createdBy}`,
      '',
      input.report,
    ].join('\n');
    createMissionTask(id, title, body, dest.agent, createdBy, priority, parent.id, null, 'handback');
    return { kind: 'agent', missionId: id, parentId: parent.id, dest: dest.agent };
  }

  const body = [
    `Relay the following handback report to the user on Telegram.`,
    `Reply with the report (lightly cleaned up if useful) so it is delivered — do not just acknowledge it.`,
    `Context: ${dest.reason} (task originator was "${parent.created_by}").`,
    `Handback for task ${parent.id} ("${parent.title}"), from @${createdBy}:`,
    '',
    input.report,
  ].join('\n');
  createMissionTask(id, title, body, dest.via ?? MAIN_AGENT_ID, createdBy, priority, parent.id, null, 'handback');
  return { kind: 'human', missionId: id, parentId: parent.id, dest: dest.via, reason: dest.reason };
}

export function actionListMissions(input: { status?: string } = {}): MissionTask[] {
  ensureDatabase();
  return getMissionTasks(undefined, input.status);
}

export function actionMissionResult(input: { id: string }): MissionTask {
  if (!input.id) throw new CliActionError('a mission id is required');
  ensureDatabase();
  const task = getMissionTask(input.id);
  if (!task) throw new CliActionError(`Task not found: ${input.id}`);
  return task;
}

export function actionCancelMission(input: { id: string }): boolean {
  if (!input.id) throw new CliActionError('a mission id is required');
  ensureDatabase();
  return cancelMissionTask(input.id);
}

export interface GatherInput {
  summaryAgent: string;
  tasks: string[];
  joinPrompt?: string;
  title?: string;
  priority?: number;
  createdBy?: string;
}
export interface GatherResult {
  groupId: string;
  childIds: string[];
  joinId: string;
  summaryAgent: string;
}

export function actionGather(input: GatherInput): GatherResult {
  if (!input.summaryAgent) throw new CliActionError('gather requires a summary agent');
  if (!input.tasks || input.tasks.length === 0) {
    throw new CliActionError('gather requires at least one task "agent:prompt"');
  }
  ensureDatabase();
  const createdBy = input.createdBy ?? defaultAgent();
  const priority = input.priority ?? 5;
  const title = input.title || 'Gather';
  const joinPrompt =
    input.joinPrompt ||
    'All grouped tasks are complete. Produce ONE consolidated summary of the collected results below.';

  // Parse + resolve every agent reference BEFORE writing any row, so an unknown
  // agent aborts the whole gather without leaving partial children.
  const children = input.tasks.map((taskArg) => {
    const sepIdx = taskArg.indexOf(':');
    if (sepIdx === -1) {
      throw new CliActionError(`Invalid --task value (expected "agent:prompt"): ${taskArg}`);
    }
    return {
      agent: resolveAgentOrThrow(taskArg.slice(0, sepIdx)),
      prompt: taskArg.slice(sepIdx + 1),
    };
  });
  const resolvedSummaryAgent = resolveAgentOrThrow(input.summaryAgent);

  const groupId = randomBytes(4).toString('hex');
  const childIds: string[] = [];
  for (const child of children) {
    const childId = randomBytes(4).toString('hex');
    const childTitle = `${title} (${child.agent})`.slice(0, 80);
    const body = [
      child.prompt,
      '',
      'Complete this mission with your findings as your final output. Do NOT fire a handback.',
    ].join('\n');
    createMissionTask(childId, childTitle, body, child.agent, createdBy, priority, null, groupId, 'task');
    childIds.push(childId);
  }

  const joinId = randomBytes(4).toString('hex');
  const joinTitle = `${title} (join)`.slice(0, 80);
  createMissionTask(joinId, joinTitle, joinPrompt, resolvedSummaryAgent, createdBy, priority, null, groupId, 'join', 'waiting');

  return { groupId, childIds, joinId, summaryAgent: resolvedSummaryAgent };
}

// ── schedule ─────────────────────────────────────────────────────────────

export interface CreateScheduleInput {
  prompt: string;
  cron: string;
  agent?: string;
}
export interface CreateScheduleResult {
  id: string;
  agent: string;
  prompt: string;
  cron: string;
  nextRun: number;
}

export function actionCreateSchedule(input: CreateScheduleInput): CreateScheduleResult {
  if (!input.prompt || !input.cron) throw new CliActionError('schedule create requires a prompt and a cron expression');
  ensureDatabase();
  const agentId = resolveAgentOrThrow(input.agent ?? defaultAgent());
  let nextRun: number;
  try {
    nextRun = computeNextRun(input.cron);
  } catch {
    throw new CliActionError(`Invalid cron expression: "${input.cron}"`);
  }
  const id = randomBytes(4).toString('hex');
  createScheduledTask(id, input.prompt, input.cron, nextRun, agentId);
  return { id, agent: agentId, prompt: input.prompt, cron: input.cron, nextRun };
}

export function actionListSchedules(input: { agent?: string } = {}): ScheduledTask[] {
  ensureDatabase();
  const agentId = resolveAgentOrThrow(input.agent ?? defaultAgent());
  return getAllScheduledTasks(agentId === 'main' ? undefined : agentId);
}

export function actionDeleteSchedule(input: { id: string }): void {
  if (!input.id) throw new CliActionError('a scheduled task id is required');
  ensureDatabase();
  deleteScheduledTask(input.id);
}

export function actionPauseSchedule(input: { id: string }): void {
  if (!input.id) throw new CliActionError('a scheduled task id is required');
  ensureDatabase();
  pauseScheduledTask(input.id);
}

export function actionResumeSchedule(input: { id: string }): void {
  if (!input.id) throw new CliActionError('a scheduled task id is required');
  ensureDatabase();
  resumeScheduledTask(input.id);
}

// ── hive ───────────────────────────────────────────────────────────────────

/** The resolved hive-mind DB absolute path. Does NOT open the DB. */
export function actionHivePath(): string {
  return path.join(STORE_DIR, 'claudeclaw.db');
}

export function actionHiveRead(input: { limit?: number } = {}): HiveMindEntry[] {
  ensureDatabase();
  const limit =
    input.limit != null && Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : 10;
  return getHiveMindEntries(limit);
}

export interface HiveLogInput {
  action: string;
  summary: string;
  agent?: string;
}

export function actionHiveLog(input: HiveLogInput): { agent: string; action: string } {
  if (!input.action || !input.summary) throw new CliActionError('hive log requires an action and a summary');
  ensureDatabase();
  const agentId = input.agent ?? defaultAgent();
  // chat_id is NOT NULL in the schema; CLI/tool-originated logs use a 'cli' marker.
  logToHiveMind(agentId, 'cli', input.action, input.summary);
  return { agent: agentId, action: input.action };
}
