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
  createMissionHandback,
  createMissionContinuation,
  cancelMissionChain,
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
  getWorkerRuntime,
  isWorkerLeaseCurrent,
} from './db.js';
import { resolveAgentId, knownAgentIds, loadAgentConfig } from './agent-config.js';
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

function isHeadlessAgent(agentId: string): boolean {
  try {
    return loadAgentConfig(agentId).runtimeMode === 'headless';
  } catch {
    return false;
  }
}

function assertMissionTargetAvailable(agentId: string): void {
  if (!isHeadlessAgent(agentId)) return;
  const worker = getWorkerRuntime(agentId);
  if (!worker?.instance_id || !isWorkerLeaseCurrent(agentId, worker.instance_id)) {
    throw new CliActionError(`headless worker '${agentId}' is offline or has no current lease`);
  }
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
  at?: string;
}
export interface CreateMissionResult {
  id: string;
  title: string;
  agent: string | null;
  priority: number;
  prompt: string;
  availableAt: number | null;
}

function parseMissionAvailableAt(value: string | undefined): number | null {
  if (value === undefined) return null;
  // Require an explicit offset. A bare local timestamp would depend on the
  // timezone of whichever process/provider created the task.
  const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i;
  const match = rfc3339.exec(value);
  if (!match) {
    throw new CliActionError('--at must be RFC 3339 with Z or an explicit UTC offset');
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zoneHour = zone.toUpperCase() === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone.toUpperCase() === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
      hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) {
    throw new CliActionError(`invalid --at timestamp: ${value}`);
  }
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) {
    throw new CliActionError(`invalid --at timestamp: ${value}`);
  }
  const availableAt = Math.floor(parsedMs / 1000);
  if (availableAt <= Math.floor(Date.now() / 1000)) {
    throw new CliActionError('--at must be in the future');
  }
  return availableAt;
}

export function actionCreateMission(input: CreateMissionInput): CreateMissionResult {
  const prompt = input.prompt;
  if (!prompt) throw new CliActionError('a mission prompt is required');
  ensureDatabase();
  const resolvedAgent =
    input.agent !== null && input.agent !== undefined && input.agent !== ''
      ? resolveAgentOrThrow(input.agent)
      : null;
  if (resolvedAgent) assertMissionTargetAvailable(resolvedAgent);
  const priority = input.priority ?? 5;
  const title = input.title || prompt.slice(0, 60);
  const id = randomBytes(4).toString('hex');
  const availableAt = parseMissionAvailableAt(input.at);
  createMissionTask(
    id, title, prompt, resolvedAgent, input.createdBy ?? defaultAgent(), priority,
    null, null, 'task', 'queued', availableAt,
  );
  return { id, title, agent: resolvedAgent, priority, prompt, availableAt };
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
  duplicate: boolean;
  reason?: string;
}

export function actionHandbackMission(input: HandbackInput): HandbackResult {
  if (!input.taskId || !input.report) throw new CliActionError('handback requires a task id and report text');
  ensureDatabase();
  const createdBy = input.createdBy ?? defaultAgent();
  const priority = input.priority ?? 5;
  const parent = getMissionTask(input.taskId);
  if (!parent) throw new CliActionError(`Task not found: ${input.taskId}`);
  if (parent.workflow_id) {
    throw new CliActionError(`Task ${parent.id} is a retained Crew workflow task and cannot create ordinary work`);
  }
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
    const created = createMissionHandback({
      id, title, prompt: body, agent: dest.agent, createdBy, priority, parentId: parent.id,
    });
    if (created.ineligibleStatus) {
      throw new CliActionError(`Task ${parent.id} cannot create a handback while ${created.ineligibleStatus}`);
    }
    return {
      kind: 'agent', missionId: created.id, parentId: parent.id,
      dest: dest.agent, duplicate: created.duplicate,
    };
  }

  const body = [
    `Relay the following handback report to the user on Telegram.`,
    `Reply with the report (lightly cleaned up if useful) so it is delivered — do not just acknowledge it.`,
    `Context: ${dest.reason} (task originator was "${parent.created_by}").`,
    `Handback for task ${parent.id} ("${parent.title}"), from @${createdBy}:`,
    '',
    input.report,
  ].join('\n');
  const created = createMissionHandback({
    id, title, prompt: body, agent: dest.via ?? MAIN_AGENT_ID,
    createdBy, priority, parentId: parent.id,
  });
  if (created.ineligibleStatus) {
    throw new CliActionError(`Task ${parent.id} cannot create a handback while ${created.ineligibleStatus}`);
  }
  return {
    kind: 'human', missionId: created.id, parentId: parent.id,
    dest: dest.via, reason: dest.reason, duplicate: created.duplicate,
  };
}

export interface ContinueMissionInput {
  taskId: string;
  prompt: string;
  idempotencyKey: string;
  maxSteps?: number;
  priority?: number;
  createdBy?: string;
}

export function actionContinueMission(input: ContinueMissionInput): {
  missionId: string; chainId: string; step: number; limit: number; duplicate: boolean;
} {
  if (!input.taskId || !input.prompt || !input.idempotencyKey) {
    throw new CliActionError('continue requires a task id, next-step prompt, and idempotency key');
  }
  ensureDatabase();
  const agent = (input.createdBy ?? defaultAgent()).trim().toLowerCase();
  const parent = getMissionTask(input.taskId);
  if (!parent) throw new CliActionError(`Task not found: ${input.taskId}`);
  if (parent.workflow_id) {
    throw new CliActionError(`Task ${parent.id} is a retained Crew workflow task and cannot create ordinary work`);
  }
  if (parent.role === 'handback') {
    throw new CliActionError(`Task ${parent.id} is a terminal handback and cannot continue`);
  }
  if (parent.assigned_agent !== agent || parent.created_by.trim().toLowerCase() !== agent) {
    throw new CliActionError(`Task ${parent.id} is not a self-directed task owned by @${agent}`);
  }
  const limit = parent.continuation_limit ?? input.maxSteps;
  if (!Number.isInteger(limit) || limit! < 1 || limit! > 100) {
    throw new CliActionError('the first continuation requires --max-steps from 1 to 100');
  }
  if (parent.continuation_limit != null && input.maxSteps != null && input.maxSteps !== parent.continuation_limit) {
    throw new CliActionError(`continuation limit is already fixed at ${parent.continuation_limit}`);
  }
  const step = (parent.continuation_step ?? 0) + 1;
  if (step > limit!) throw new CliActionError(`continuation chain exhausted at ${limit} step(s)`);
  const chainId = parent.chain_id ?? parent.id;
  const id = randomBytes(4).toString('hex');
  const prompt = [
    input.prompt,
    '',
    '[Continuation control: If this step queues another continuation, use the Task ID from this mission\'s own runtime metadata. Never reuse a parent task id.]',
  ].join('\n');
  const created = createMissionContinuation({
    id, title: `Continuation ${step}/${limit}: ${parent.title}`.slice(0, 80), prompt,
    agent, priority: input.priority ?? parent.priority, parentId: parent.id, chainId,
    step, limit: limit!, key: `${chainId}:${parent.id}:${input.idempotencyKey}`,
  });
  if (created.cancelled) throw new CliActionError(`continuation chain ${chainId} is cancelled`);
  if (created.ineligibleStatus) {
    throw new CliActionError(`Task ${parent.id} cannot continue while ${created.ineligibleStatus}`);
  }
  return { missionId: created.id, chainId, step, limit: limit!, duplicate: created.duplicate };
}

export function actionCancelMissionChain(input: { chainId: string; createdBy?: string }): {
  chainId: string; alreadyCancelled: boolean; cancelledTasks: number;
} {
  if (!input.chainId) throw new CliActionError('a continuation chain id is required');
  ensureDatabase();
  const agent = (input.createdBy ?? defaultAgent()).trim().toLowerCase();
  const result = cancelMissionChain(input.chainId, agent);
  if (!result.found) throw new CliActionError(`Continuation chain not found or not owned by @${agent}: ${input.chainId}`);
  return { chainId: input.chainId, alreadyCancelled: result.alreadyCancelled, cancelledTasks: result.cancelledTasks };
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
  for (const child of children) assertMissionTargetAvailable(child.agent);
  assertMissionTargetAvailable(resolvedSummaryAgent);

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
