import type { RegisterSteering } from './steering.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderConfig } from '../provider.js';

/** Whether a failed provider attempt could have begun executing the prompt. */
export type ExecutionCertainty = 'not_started' | 'started' | 'unknown';

/** Attach delivery evidence without introducing a provider recovery subsystem. */
export function withExecutionCertainty(error: unknown, execution: ExecutionCertainty): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  Object.assign(normalized, { execution });
  return normalized;
}

export function executionCertaintyOf(error: unknown): ExecutionCertainty | undefined {
  const execution = (error as { execution?: unknown } | null)?.execution;
  return execution === 'not_started' || execution === 'started' || execution === 'unknown'
    ? execution
    : undefined;
}

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

/**
 * A configured MCP server: stdio (command-based), HTTP/SSE (url-based), or an
 * in-process SDK server (a live McpServer instance, e.g. the dispatch tools).
 * The in-process variant is only meaningful to the Claude SDK engine; the ACP
 * adapter filters it out (it can only spawn stdio subprocess servers).
 */
export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSdkServerConfigWithInstance;

export interface AgentEngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  /**
   * Where `totalCostUsd` comes from, and therefore whether it may be summed.
   *
   *  - `provider`  — the runtime priced this turn. Meaningful money.
   *  - `unknown`   — nobody priced it. `totalCostUsd` is 0 as a placeholder and
   *                  must be EXCLUDED from totals, not added as zero.
   *
   * The distinction is load-bearing for anthropic-compatible turns: the Claude
   * SDK still emits a `total_cost_usd`, but it is Anthropic list pricing
   * applied to a third-party model — a number that looks like money and is
   * not. Summing it would misreport spend; storing 0 without this marker would
   * report a paid turn as free.
   */
  costSource: 'provider' | 'unknown';
  didCompact: boolean;
  preCompactTokens: number | null;
  lastCallCacheRead: number;
  lastCallCacheCreation: number;
  lastCallInputTokens: number;
  /**
   * The active model's real context window (tokens), as reported by the SDK in
   * `result.modelUsage[model].contextWindow`. Null when the engine doesn't
   * report one (e.g. ACP providers) — consumers fall back to CONTEXT_LIMIT.
   */
  contextWindow: number | null;
  /** Per-turn telemetry (from the SDK result object; free to capture). */
  model: string | null;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  stopReasonDetail: string | null;
  isError: boolean;
}

export interface AgentEngineProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active' | 'plan';
  description: string;
  status?: string;
  kind?: string;
  toolCallId?: string;
  locations?: Array<{ path: string; line?: number | null }>;
  planEntries?: Array<{ content: string; status: string; priority?: string }>;
}

/** One selectable option in an AskUserQuestion question. */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

/** A single question the model wants answered. */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

/** Structured payload the model passes to the AskUserQuestion tool. */
export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[];
}

/** The user's answer to one question (selected option labels, by header). */
export interface AskUserQuestionAnswerItem {
  header: string;
  question: string;
  selected: string[];
}

/**
 * Resolved answer fed back to the model. `null` from the resolver means the
 * user skipped or timed out — the engine surfaces the SDK's default
 * "did not answer" result in that case.
 */
export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[];
  /**
   * Optional meta-instruction appended to the tool result, e.g. the user asked
   * to stop the clarifying-question flow and proceed. Delivered to the model
   * alongside (or instead of) the selected answers.
   */
  directive?: string;
}

/**
 * Interactive resolver for the built-in AskUserQuestion tool. A host (e.g. the
 * Telegram bot) supplies this to render the question as a tap-to-choose UI and
 * await the user's selection. Returns `null` if the user does not answer.
 */
export type AskUserQuestionResolver = (
  request: AskUserQuestionRequest,
) => Promise<AskUserQuestionAnswer | null>;

export interface AgentTurnInput {
  prompt: string;
  provider: ProviderConfig;
  sessionId?: string;
  cwd: string;
  model?: string;
  /** Raw provider-specific runtime/mode value selected in the dashboard. */
  runtimeMode?: string;
  /** Raw provider-specific thinking/thought-level value selected in the dashboard. */
  thinkingMode?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  /** Claude SDK turn cap. ACP has no portable max-turns request field; ACP callers must also pass an abort timeout. */
  maxTurns?: number;
  permissionMode?: 'default' | 'bypassPermissions' | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Names within `mcpServers` that ClaudeClaw itself materialized and vouches
   * for this turn — currently only the dispatch bridge, added by the dispatch
   * authorization layer. An engine may pre-approve these (skip its runtime's
   * approval gating) and must apply default gating to every other server.
   *
   * This carries PROVENANCE, not a name convention: trust must not be inferred
   * from a server's name, because a project/user-configured `.mcp.json` entry
   * could claim the same name and inherit the pre-approval. Only the
   * authorization layer that constructed the entry may list it here.
   */
  trustedMcpServers?: string[];
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  settingSources?: string[];
  /** Claude SDK only — streams partial assistant text. The ACP adapter ignores
   *  this (ACP has no equivalent flag; it streams via agent_message_chunk
   *  regardless). (#72 Finding 13) */
  includePartialMessages?: boolean;
  /**
   * Agent persona (CLAUDE.md) to use as the system prompt. When set, the Claude
   * SDK engine passes it as a plain-string `systemPrompt`, pinning identity and
   * boundaries into the system layer so they are present on every turn and
   * survive compaction. This is the persona alone — no `claude_code` preset is
   * applied (the preset was never part of this runtime). Ignored by engines that
   * don't model a system prompt (e.g. ACP), which must deliver the persona
   * in-band instead.
   */
  systemPrompt?: string;
  /** Resolved provider/model identity for this specific turn. */
  runtimeIdentity?: string;
  /**
   * Interactive AskUserQuestion resolver. When supplied, the Claude SDK engine
   * intercepts AskUserQuestion tool calls and routes them through this resolver
   * (e.g. a Telegram inline keyboard) instead of letting the headless SDK
   * auto-resolve them as unanswered. Engines that can't intercept the tool
   * ignore this field.
   */
  onAskUserQuestion?: AskUserQuestionResolver;
  /** Interactive gateway only; adapters publish an invocation-scoped capability. */
  registerSteering?: RegisterSteering;
}

export type AgentEngineEvent =
  | { type: 'session'; sessionId: string; raw?: unknown }
  | { type: 'text_delta'; delta: string; accumulatedText: string; raw?: unknown }
  | { type: 'progress'; progress: AgentEngineProgressEvent; raw?: unknown }
  | { type: 'usage'; usage: AgentEngineUsage; raw?: unknown }
  | { type: 'compact'; preCompactTokens: number | null; trigger?: string; raw?: unknown }
  | { type: 'result'; text: string | null; usage: AgentEngineUsage | null; stopReason?: string; raw?: unknown }
  | { type: 'aborted'; text: string | null; sessionId?: string; usage: AgentEngineUsage | null; raw?: unknown }
  | { type: 'error'; error: unknown; raw?: unknown };

export interface AgentEngine {
  invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent>;
}

/**
 * The caller's tool authorization, as carried on the engine seam. Narrower than
 * `AgentTurnInput` so policy layers above the engine (dispatch authorization,
 * the Codex capability profile) can share one predicate without depending on a
 * whole turn input.
 */
export interface TurnToolPolicy {
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * True when the caller granted NO tools at all — a '*' deny or an explicitly
 * empty allow-list. Provider-neutral and deliberately conservative: this is the
 * gate that keeps restricted turns (memory ingestion, routing/warmup, untrusted
 * voice, default-deny war-room) from being handed trusted MCP servers or a
 * capability profile they never asked for.
 *
 * An `undefined` allow-list is NOT deny-all — it means "no restriction stated".
 * Only an explicitly empty array expresses "nothing".
 */
export function turnDeniesAllTools(policy: TurnToolPolicy): boolean {
  if (policy.disallowedTools?.includes('*')) return true;
  return policy.allowedTools?.length === 0;
}

export function emptyUsage(): AgentEngineUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
    // 'provider' keeps every existing engine's reporting exactly as it was.
    // Engines that genuinely cannot price a turn opt in to 'unknown'; today
    // only the anthropic-compatible path does, and widening that judgement to
    // the ACP family would change cost reporting this change has no business
    // touching.
    costSource: 'provider',
    didCompact: false,
    preCompactTokens: null,
    lastCallCacheRead: 0,
    lastCallCacheCreation: 0,
    lastCallInputTokens: 0,
    contextWindow: null,
    model: null,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 0,
    stopReasonDetail: null,
    isError: false,
  };
}
