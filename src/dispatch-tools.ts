/**
 * In-process dispatch tools — the first-class, subprocess-free form of the
 * load-bearing agent CLIs (mission / schedule / hive).
 *
 * ONE implementation, two front doors. These tools call the SAME action
 * functions in `cli-actions.ts` that the `*-cli.ts` entrypoints call — no
 * duplicated argv parsing, no second copy of the business logic to drift. And
 * the tool NAME and INPUT SCHEMA are DERIVED from the `CliDescriptor.tool` specs
 * in `cli-descriptors.ts` (the Phase 1 single source of truth), so an executable
 * tool can never drift from its documented CLI command. The schema-derivation
 * test guards that; the Phase 1 drift/coverage guards guard the descriptors.
 *
 * Why in-process at all: shelling out to `node "$PROJECT_ROOT/dist/*-cli.js"`
 * depends on a filesystem/sandbox boundary that a hardened provider legitimately
 * refuses to cross, and pays a full `node` cold-start (db open, config parse,
 * key read) per call. An in-process SDK MCP server removes the subprocess.
 *
 * Access policy (asymmetric): only the Claude provider is granted these tools.
 * Non-Claude providers (acp-codex/gemini/opencode via ACP, openrouter) are
 * restricted — `dispatchMcpServersFor` returns nothing for them. This is both
 * policy and technical reality: only the Claude SDK engine can host in-process
 * SDK tools (ACP runs in a subprocess; OpenRouter is tool-less). The tools flow
 * through the normal `mcpServers`/`allowedTools` gate in the Claude adapter —
 * they never bypass the chat-path tool-lockdown / `/code` escalation policy: a
 * locked-down turn whose `allowedTools` omits `mcp__claudeclaw__*` still cannot
 * call them.
 *
 * Registration is process-global (via `registerDispatchTools`, called once at
 * runtime boot in `bootMessenger`), so scheduled turns — which fire with a
 * scrubbed env — still see the tools: they live in module state, not env.
 */

import path from 'path';

import { z } from 'zod';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';

import { compatDispatchAllowed } from './anthropic-compat-env.js';
import type { CliCommand, CliToolParam, CliToolSpec } from './cli-reference.js';
import { hiveDescriptor, missionDescriptor, scheduleDescriptor } from './cli-descriptors.js';
import { CLAUDECLAW_CONFIG, DB_ENCRYPTION_KEY, DISPATCH_ALLOW_HIVE_READ, PROJECT_ROOT, STORE_DIR } from './config.js';
import type { McpServerConfig, McpStdioConfig, TurnToolPolicy } from './agent-engine/types.js';
import { turnDeniesAllTools } from './agent-engine/types.js';
import { setDispatchResolver, type DispatchTurnContext } from './dispatch-registry.js';
import {
  CliActionError,
  actionCancelMission,
  actionCancelMissionChain,
  actionContinueMission,
  actionCreateMission,
  actionCreateSchedule,
  actionDeleteSchedule,
  actionGather,
  actionHandbackMission,
  actionHiveLog,
  actionHivePath,
  actionHiveRead,
  actionListMissions,
  actionListSchedules,
  actionMissionResult,
  actionPauseSchedule,
  actionResumeSchedule,
} from './cli-actions.js';

/** Name of the in-process MCP server. Tools surface as `mcp__claudeclaw__<name>`. */
export const DISPATCH_SERVER_NAME = 'claudeclaw';

/** Descriptors promoted to first-class tools this phase (mission/schedule/hive). */
const DISPATCH_DESCRIPTORS = [missionDescriptor, scheduleDescriptor, hiveDescriptor];

// ── schema derivation (descriptor spec → zod raw shape) ──────────────────────

function zodForParam(p: CliToolParam): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (p.type) {
    case 'number':
      base = z.number();
      break;
    case 'boolean':
      base = z.boolean();
      break;
    case 'string[]':
      base = z.array(z.string());
      break;
    case 'string':
    default:
      base = z.string();
      break;
  }
  base = base.describe(p.description);
  return p.required ? base : base.optional();
}

/**
 * Derive the zod input shape for a tool from its descriptor spec. The tool
 * schema is therefore never hand-authored — it is a pure function of the
 * documented CLI command's declared params.
 */
export function deriveToolSchema(spec: CliToolSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of spec.params) shape[p.name] = zodForParam(p);
  return shape;
}

// ── handlers (structured args → shared action → text summary) ────────────────
//
// Handlers return a plain summary string; `buildTool` wraps them so a
// `CliActionError` (unknown agent, bad cron, missing task) becomes an
// `isError` tool result the model can read, exactly as the CLI prints it to
// stderr. Snake_case tool params map to the actions' camelCase inputs here.

type Handler = (args: Record<string, unknown>) => string;

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

const HANDLERS: Record<string, Handler> = {
  mission_create: (a) => {
    const r = actionCreateMission({
      prompt: asStr(a.prompt) ?? '',
      agent: asStr(a.agent) ?? null,
      title: asStr(a.title),
      priority: asNum(a.priority),
    });
    return [
      `Mission task created: ${r.id}`,
      `  Title:    ${r.title}`,
      `  Agent:    ${r.agent || 'unassigned (use dashboard to assign)'}`,
      `  Priority: ${r.priority}`,
      `  Prompt:   ${truncate(r.prompt, 100)}`,
    ].join('\n');
  },

  mission_handback: (a) => {
    const r = actionHandbackMission({
      taskId: asStr(a.task_id) ?? '',
      report: asStr(a.report) ?? '',
      priority: asNum(a.priority),
    });
    return r.kind === 'agent'
      ? `Handback delivered to @${r.dest} (originator of ${r.parentId}). Mission: ${r.missionId}`
      : `Handback routed to @${r.dest} to surface to the human (${r.reason}). Mission: ${r.missionId}`;
  },

  mission_continue: (a) => {
    const r = actionContinueMission({
      taskId: asStr(a.task_id) ?? '', prompt: asStr(a.prompt) ?? '',
      idempotencyKey: asStr(a.idempotency_key) ?? '', maxSteps: asNum(a.max_steps),
      priority: asNum(a.priority),
    });
    return `${r.duplicate ? 'Existing' : 'Queued'} continuation ${r.step}/${r.limit} in chain ${r.chainId}. Mission: ${r.missionId}`;
  },

  mission_cancel_chain: (a) => {
    const r = actionCancelMissionChain({ chainId: asStr(a.chain_id) ?? '' });
    return r.alreadyCancelled
      ? `Continuation chain ${r.chainId} is already cancelled.`
      : `Cancelled continuation chain ${r.chainId}; ${r.cancelledTasks} queued task(s) stopped.`;
  },

  mission_gather: (a) => {
    const r = actionGather({
      summaryAgent: asStr(a.summary_agent) ?? '',
      tasks: Array.isArray(a.tasks) ? (a.tasks as unknown[]).map(String) : [],
      joinPrompt: asStr(a.join_prompt),
      title: asStr(a.title),
      priority: asNum(a.priority),
    });
    return [
      `Gather group created: ${r.groupId}`,
      `  Children: ${r.childIds.join(', ')}`,
      `  Join (parked, waiting): ${r.joinId} -> @${r.summaryAgent}`,
    ].join('\n');
  },

  mission_list: (a) => {
    const tasks = actionListMissions({ status: asStr(a.status) });
    if (tasks.length === 0) {
      const suffix = asStr(a.status) ? ` with status "${asStr(a.status)}"` : '';
      return `No mission tasks${suffix}.`;
    }
    const lines = [`${tasks.length} mission task${tasks.length === 1 ? '' : 's'}:`];
    for (const t of tasks) {
      lines.push(`${t.id} [${t.status}] @${t.assigned_agent} — ${t.title}`);
    }
    return lines.join('\n');
  },

  mission_result: (a) => {
    const t = actionMissionResult({ id: asStr(a.id) ?? '' });
    const body = t.result
      ? `\nResult:\n${t.result}`
      : t.error
        ? `\nError: ${t.error}`
        : '\nNo result yet.';
    return [`Task:   ${t.id} [${t.status}]`, `Title:  ${t.title}`, `Agent:  ${t.assigned_agent}`, body].join('\n');
  },

  mission_cancel: (a) => {
    const id = asStr(a.id) ?? '';
    return actionCancelMission({ id })
      ? `Cancelled task: ${id}`
      : `Could not cancel (may already be completed): ${id}`;
  },

  schedule_create: (a) => {
    const r = actionCreateSchedule({
      prompt: asStr(a.prompt) ?? '',
      cron: asStr(a.cron) ?? '',
      agent: asStr(a.agent),
    });
    return [
      `Scheduled task created: ${r.id}`,
      `  Agent:    ${r.agent}`,
      `  Schedule: ${r.cron}`,
      `  Prompt:   ${truncate(r.prompt, 100)}`,
    ].join('\n');
  },

  schedule_list: (a) => {
    const tasks = actionListSchedules({ agent: asStr(a.agent) });
    if (tasks.length === 0) return 'No scheduled tasks.';
    const lines = [`${tasks.length} scheduled task${tasks.length === 1 ? '' : 's'}:`];
    for (const t of tasks) {
      const paused = t.status === 'paused' ? ' [PAUSED]' : '';
      lines.push(`${t.id}${paused} @${t.agent_id} — ${t.schedule} — ${truncate(t.prompt, 80)}`);
    }
    return lines.join('\n');
  },

  schedule_delete: (a) => {
    const id = asStr(a.id) ?? '';
    actionDeleteSchedule({ id });
    return `Deleted task: ${id}`;
  },

  schedule_pause: (a) => {
    const id = asStr(a.id) ?? '';
    actionPauseSchedule({ id });
    return `Paused task: ${id}`;
  },

  schedule_resume: (a) => {
    const id = asStr(a.id) ?? '';
    actionResumeSchedule({ id });
    return `Resumed task: ${id}`;
  },

  hive_path: () => actionHivePath(),

  hive_read: (a) => {
    const entries = actionHiveRead({ limit: asNum(a.limit) });
    if (entries.length === 0) return 'Hive mind is empty.';
    const lines = [`${entries.length} recent hive_mind entr${entries.length === 1 ? 'y' : 'ies'}:`];
    for (const e of entries) {
      lines.push(`@${e.agent_id} — ${e.action}: ${e.summary}`);
    }
    return lines.join('\n');
  },

  hive_log: (a) => {
    const r = actionHiveLog({
      action: asStr(a.action) ?? '',
      summary: asStr(a.summary) ?? '',
      agent: asStr(a.agent),
    });
    return `Logged to hive mind as @${r.agent}: ${r.action}`;
  },
};

// ── tool assembly ────────────────────────────────────────────────────────────

/** A minimal MCP text tool-call result. Structurally matches the SDK's CallToolResult. */
export type DispatchToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const textResult = (text: string, isError = false): DispatchToolResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

/** One promoted command: its descriptor spec, source command, and derived schema. */
export interface DispatchToolEntry {
  spec: CliToolSpec;
  command: CliCommand;
  schema: Record<string, z.ZodTypeAny>;
}

/** Every command across the promoted descriptors that declares a first-class tool. */
export function dispatchToolEntries(): DispatchToolEntry[] {
  const entries: DispatchToolEntry[] = [];
  for (const d of DISPATCH_DESCRIPTORS) {
    for (const command of d.commands) {
      if (!command.tool) continue;
      entries.push({ spec: command.tool, command, schema: deriveToolSchema(command.tool) });
    }
  }
  return entries;
}

/** All promoted tool names (mission/schedule/hive). */
export function dispatchToolNames(): string[] {
  return dispatchToolEntries().map((e) => e.spec.name);
}

/**
 * A transport-neutral dispatch tool: its name, description, derived input
 * schema, and a wrapped handler. The handler catches `CliActionError` and
 * returns an `isError` result (never throws it), so any MCP front door can use
 * it as-is.
 */
export interface DispatchToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<DispatchToolResult>;
}

/**
 * The single source of dispatch tool definitions. Both front doors build from
 * these — `buildDispatchSdkTools` (the in-process Anthropic SDK server for
 * Claude turns) and the standalone stdio server in `dispatch-mcp-server.ts` (for
 * out-of-process providers). One handler, one derived schema, zero drift.
 */
export function dispatchToolDefinitions(): DispatchToolDefinition[] {
  return dispatchToolEntries().map((entry) => {
    const raw = HANDLERS[entry.spec.name];
    if (!raw) {
      // A descriptor declared a tool with no implementation — a wiring bug that
      // must fail loudly at build/boot, not silently ship a dead tool.
      throw new Error(`dispatch-tools: no handler registered for tool '${entry.spec.name}'`);
    }
    return {
      name: entry.spec.name,
      description: entry.command.description,
      schema: entry.schema,
      handler: async (args: Record<string, unknown>): Promise<DispatchToolResult> => {
        try {
          return textResult(raw(args));
        } catch (e) {
          if (e instanceof CliActionError) return textResult(e.message, true);
          return textResult(
            `dispatch tool '${entry.spec.name}' failed: ${e instanceof Error ? e.message : String(e)}`,
            true,
          );
        }
      },
    };
  });
}

/**
 * Dispatch verbs withheld from third-party vendors unless explicitly enabled,
 * because they egress data every agent has contributed. Defined here, next to
 * the tools themselves, so both consumers — the in-process server below and
 * the stdio bridge in dispatch-mcp-server.ts — read ONE list; the bridge used
 * to own it, which would now be an import cycle.
 */
export const EGRESS_GATED_TOOLS = new Set<string>(['hive_read']);

/** Build the Anthropic SDK tool definitions for every promoted command (in-process, Claude path). */
export function buildDispatchSdkTools(opts: { allowHiveRead?: boolean } = {}) {
  const allowHiveRead = opts.allowHiveRead ?? true;
  return dispatchToolDefinitions()
    .filter((def) => allowHiveRead || !EGRESS_GATED_TOOLS.has(def.name))
    .map((def) => tool(def.name, def.description, def.schema, def.handler));
}

/**
 * One server instance PER POLICY, never one instance that gets edited.
 *
 * The in-process server is shared by every concurrent turn in this process. A
 * Claude turn and a third-party turn can be in flight at the same moment, so
 * filtering by mutating a shared tool list would either hand hive_read to the
 * third-party turn or take it away from the Claude one, depending on ordering.
 * Keying the cache on the policy makes the two physically different objects and
 * removes the race instead of narrowing it.
 */
const cachedServers = new Map<string, McpSdkServerConfigWithInstance>();

/**
 * The in-process dispatch MCP server for a given policy, built once per policy.
 * Defaults to the full tool set, which is what the Claude path has always had.
 */
export function getDispatchMcpServer(
  opts: { allowHiveRead?: boolean } = {},
): McpSdkServerConfigWithInstance {
  const allowHiveRead = opts.allowHiveRead ?? true;
  const key = allowHiveRead ? 'full' : 'no-hive-read';
  let server = cachedServers.get(key);
  if (!server) {
    server = createSdkMcpServer({
      name: DISPATCH_SERVER_NAME,
      version: '1.0.0',
      tools: buildDispatchSdkTools({ allowHiveRead }),
    });
    cachedServers.set(key, server);
  }
  return server;
}

// ── access policy + registration ─────────────────────────────────────────────

/**
 * Server name of the stdio dispatch bridge used by out-of-process providers.
 * Must match DISPATCH_MCP_SERVER_NAME in dispatch-mcp-server.ts.
 */
export const DISPATCH_STDIO_SERVER_NAME = 'claudeclaw-dispatch';

/**
 * The stdio dispatch-server entry for a native Codex/OpenAI turn. Codex runs
 * out-of-process, so it cannot consume the in-memory SDK server the Claude
 * engine uses; it reaches mission/schedule/hive through this thin stdio MCP
 * server instead — `node dist/dispatch-mcp-server.js`.
 *
 * Codex scrubs the shell env for servers it spawns, so everything the server
 * needs to open the store and act as the right agent is passed EXPLICITLY.
 * hive-read stays default-off: DISPATCH_ALLOW_HIVE_READ is forwarded only when
 * the operator has set it.
 *
 * Whether dispatch reaches the turn at all is decided upstream by
 * `dispatchToolsAllowed` (tool policy → explicit dispatchAccess → per-provider
 * default); this function only builds the entry once that decision is yes.
 *
 * Lives here, not in the adapter: an adapter must never be able to introduce an
 * MCP server on its own (see `dispatchMcpServersFor`).
 */
function codexDispatchStdioEntry(): McpStdioConfig {
  const env: Record<string, string> = {
    CLAUDECLAW_DISPATCH_AGENT: process.env.CLAUDECLAW_AGENT_ID ?? 'main',
    CLAUDECLAW_CONFIG,
    // STORE_DIR and DB_ENCRYPTION_KEY resolve from the runtime-root .env INTO
    // config (envConfig), NOT into process.env. The spawned server runs with a
    // different cwd and no .env in reach, so forward the config-RESOLVED values
    // explicitly — otherwise it opens the wrong/empty store (or has no key) and
    // the first DB-touching tool call (e.g. mission_create) fails while tool
    // listing, which needs no DB, still looks healthy.
    CLAUDECLAW_STORE_DIR: STORE_DIR,
  };
  if (DB_ENCRYPTION_KEY) env.DB_ENCRYPTION_KEY = DB_ENCRYPTION_KEY;
  // Forward the CONFIG-resolved hive-read flag (reads process.env OR .env), not
  // process.env alone, so the default-off governance toggle honors .env. Only
  // forwarded when true; absent => server keeps hive-read off.
  if (DISPATCH_ALLOW_HIVE_READ) env.DISPATCH_ALLOW_HIVE_READ = 'true';

  return {
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist', 'dispatch-mcp-server.js')],
    env,
  };
}

/**
 * Whether this turn is authorized for dispatch tools.
 *
 * Gates, in precedence order:
 *
 *  1. TOOL POLICY (deny always wins): a caller that granted no tools ('*' denied
 *     or an empty allow-list) gets nothing — memory ingest, routing/warmup,
 *     untrusted voice, default-deny war-room. Dispatch exposes state-changing
 *     mission/schedule/hive verbs, so this outranks even an explicit 'grant'.
 *  2. EXPLICIT CALLER DECISION: `dispatchAccess` 'deny' or 'grant' is honoured.
 *  3. PER-PROVIDER DEFAULT — and this is asymmetric ON PURPOSE:
 *       • claude — any tools allowed is enough. The Claude runtime applies our
 *         allow/deny lists to MCP tool NAMES (`mcp__claudeclaw__mission_create`),
 *         so a read-only profile like {Read, Grep, Glob} genuinely cannot invoke
 *         a dispatch verb even with the server present.
 *       • openai — requires an UNRESTRICTED turn. The Codex runtime does not
 *         apply Claude-style tool names to MCP invocation at all, so an
 *         allow-list is not an enforcement boundary there: with the server
 *         present, `allowedTools: ['Read']` could still call mission_create.
 *         A caller that stated a restriction therefore gets no dispatch unless
 *         it opts in explicitly via `dispatchAccess: 'grant'`.
 *       • everything else — restricted. Keyed on provider identity (not
 *         `ENABLE_ACP`) so the policy is explicit and unconditional.
 *
 * The rule to keep: never treat "some tools are allowed" as authorization for
 * dispatch on a runtime that cannot gate individual MCP tools.
 */
export function dispatchToolsAllowed(ctx: DispatchTurnContext): boolean {
  if (turnDeniesAllTools(ctx)) return false;
  if (ctx.dispatchAccess === 'deny') return false;
  if (ctx.dispatchAccess === 'grant') {
    return ctx.provider?.type === 'claude' || ctx.provider?.type === 'openai';
  }
  if (ctx.provider?.type === 'claude') return true;
  if (ctx.provider?.type === 'openai') return !turnRestrictsTools(ctx);
  // Dispatch lets a turn create missions, schedule work and read the shared
  // hive. Granting that to a third-party model is a decision an operator makes
  // deliberately, so it is off until ANTHROPIC_COMPAT_ALLOW_DISPATCH says
  // otherwise — and even then hive_read stays withheld (see below).
  if (ctx.provider?.type === 'anthropic-compatible') {
    return compatDispatchAllowed() && !turnRestrictsTools(ctx);
  }
  return false;
}

/**
 * True when the caller stated an explicit allow-list. Such a restriction is
 * enforceable for Claude-named tools but NOT for MCP tools on the Codex runtime,
 * which is why native OpenAI treats it as "no dispatch" rather than "filtered
 * dispatch". (The empty-array case is deny-all and handled before this.)
 */
function turnRestrictsTools(policy: TurnToolPolicy): boolean {
  return !!policy.allowedTools && policy.allowedTools.length > 0;
}

/**
 * The dispatch MCP servers to merge for a turn — the SINGLE place dispatch may
 * enter a turn, for every provider. Engine adapters consume the resulting
 * authorized set and may never add to it.
 *
 * Returns the in-process `claudeclaw` server for a Claude turn, the stdio
 * `claudeclaw-dispatch` bridge for a native OpenAI turn, or `{}` when the turn
 * is not authorized (restricted tool policy or restricted provider).
 */
export function dispatchMcpServersFor(
  ctx: DispatchTurnContext,
): Record<string, McpServerConfig> {
  if (!dispatchToolsAllowed(ctx)) return {};
  if (ctx.provider?.type === 'openai') {
    return { [DISPATCH_STDIO_SERVER_NAME]: codexDispatchStdioEntry() };
  }
  if (ctx.provider?.type === 'anthropic-compatible') {
    // hive_read egresses everything every agent has ever written to the shared
    // mind. The stdio bridge has withheld it from non-Claude vendors since it
    // existed; the in-process path never enforced that because, until now, only
    // Claude used it. Same rule, now actually applied.
    return { [DISPATCH_SERVER_NAME]: getDispatchMcpServer({ allowHiveRead: false }) };
  }
  return { [DISPATCH_SERVER_NAME]: getDispatchMcpServer() };
}

/**
 * Register the in-process dispatch tools into the process-global registry so
 * `runAgent` merges them into every eligible turn. Called once at runtime boot.
 * Idempotent — safe to call more than once.
 */
export function registerDispatchTools(): void {
  setDispatchResolver(dispatchMcpServersFor);
}
