import { AGENT_ID } from './config.js';
import { sanitizePresentation } from './outbound-payload.js';
import fs from 'fs';
import path from 'path';

import { AGENT_IDLE_TIMEOUT_MS, AGENT_MAX_RUNTIME_MS, AGENT_MAX_TURNS, PROJECT_ROOT, agentCwd, agentSystemPrompt } from './config.js';
import { TurnWatchdog, type TurnAbortReason } from './turn-watchdog.js';
import { readEnvFile } from './env.js';
import { classifyError, AgentError } from './errors.js';
import { logger } from './logger.js';
import { getScrubbedSdkEnv } from './security.js';
import { requireEnabled } from './kill-switches.js';
import { EngineFactory } from './agent-engine/index.js';
import type { AskUserQuestionResolver } from './agent-engine/index.js';
import {
  ProviderConfig,
  decodeProviderSession,
  effectiveSkipPermissions,
  encodeProviderSession,
  sessionBelongsToProvider,
} from './provider.js';
import { defaultModelForProvider, getSelectedProviderConfig } from './active-provider.js';
import { claudeThinkingForModel, selectedEffortForProvider } from './model-catalog.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { dispatchMcpServersForTurn } from './dispatch-registry.js';
import { runtimeModelIdentity } from './runtime-identity.js';
import { toProviderFailure } from './provider-recovery.js';
import type { ProviderFailure } from './agent-engine/types.js';
import { missionExecutionEnv, getMissionExecutionContext } from './mission-execution-context.js';
import { missionEntryEnv } from './mission-entry-key.js';
import { missionCoordinatorToolPolicy } from './mission-coordinator-policy.js';
import { outboundOptionsForSeam } from './outbound-policy.js';
import { sanitizeOutboundText } from './outbound-sanitizer.js';
import { OutboundStreamGuard } from './outbound-stream-guard.js';

// ── MCP server loading ──────────────────────────────────────────────
// The Agent SDK's settingSources loads CLAUDE.md and permissions from
// project/user settings, but does NOT load mcpServers from those files.
// We read them ourselves and pass them via the `mcpServers` option.

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

// Mirrors agent-engine/types.ts McpServerConfig. Includes the in-process SDK
// variant so the dispatch tools can be merged into a turn's mcpServers (see
// runAgent). `loadMcpServers` itself only ever emits stdio/http from settings;
// the union just has to admit the SDK server that runAgent adds afterward.
export type McpConfig = McpStdioConfig | McpHttpConfig | McpSdkServerConfigWithInstance;

/**
 * Merge MCP server configs from user settings (~/.claude/settings.json) and
 * project settings (.claude/settings.json in cwd), optionally filtered by
 * an allowlist (e.g. from an agent's agent.yaml `mcp_servers` field).
 *
 * Supports both stdio transport (command/args/env) and HTTP/SSE transport
 * (type/url/headers), matching the Claude Agent SDK's McpServerConfig types.
 *
 * Exported so the voice bridge can reuse the exact same loader the text
 * bot uses — keeping behavior consistent across channels.
 */
export function loadMcpServers(allowlist?: string[], projectCwd?: string): Record<string, McpConfig> {
  const merged: Record<string, McpConfig> = {};

  // Load from project settings (.claude/settings.json in cwd). `projectCwd`
  // lets callers (e.g. the voice bridge) target a specific sub-agent's
  // settings file without needing the module-level `agentCwd` to be set.
  const projectSettings = path.join(projectCwd ?? agentCwd ?? PROJECT_ROOT, '.claude', 'settings.json');
  // Load from user settings (~/.claude/settings.json)
  const userSettings = path.join(
    process.env.HOME ?? '/tmp',
    '.claude',
    'settings.json',
  );

  for (const file of [userSettings, projectSettings]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const servers = raw?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as Record<string, unknown>;
          if (cfg.url && typeof cfg.url === 'string') {
            merged[name] = {
              type: (cfg.type as 'http' | 'sse') ?? 'http',
              url: cfg.url,
              ...(cfg.headers ? { headers: cfg.headers as Record<string, string> } : {}),
            };
          } else if (cfg.command && typeof cfg.command === 'string') {
            merged[name] = {
              command: cfg.command,
              ...(cfg.args ? { args: cfg.args as string[] } : {}),
              ...(cfg.env ? { env: cfg.env as Record<string, string> } : {}),
            };
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid — skip
    }
  }

  // If an allowlist is provided, only keep the MCPs in that list
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(merged)) {
      if (!allowed.has(name)) delete merged[name];
    }
  }

  return merged;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Cumulative cache_creation_input_tokens (cache writes) across the turn. */
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  /**
   * Whether totalCostUsd is money or a placeholder. See
   * AgentEngineUsage.costSource — 'unknown' means nobody priced this turn and
   * the figure must not be summed or displayed as a price.
   */
  costSource: 'provider' | 'unknown';
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The cache_creation_input_tokens from the LAST API call in the turn —
   * the cache-write count that pairs with lastCallCacheRead for savings math.
   */
  lastCallCacheCreation: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
  /**
   * The active model's real context window (tokens), from the SDK's
   * result.modelUsage. Null for engines that don't report one — callers
   * fall back to CONTEXT_LIMIT. Use this (not CONTEXT_LIMIT) to size the
   * context gauge so it tracks the actual model (e.g. Opus 4.8 = 1M,
   * Sonnet 4.6 = 200k).
   */
  contextWindow: number | null;
  /** Per-turn telemetry from the SDK result object. */
  model: string | null;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  stopReasonDetail: string | null;
  isError: boolean;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active' | 'plan';
  description: string;
  status?: string;
  kind?: string;
  toolCallId?: string;
  locations?: Array<{ path: string; line?: number | null }>;
  planEntries?: Array<{ content: string; status: string; priority?: string }>;
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
  aborted?: boolean;
  abortReason?: TurnAbortReason;
  /** SDK result subtype (e.g. 'success', 'error_during_execution'). */
  stopReason?: string;
  /** Structured provider failure; absent on successful/aborted turns. */
  failure?: ProviderFailure;
}

/**
 * Whether a non-aborted result is actually a failed run. Both engines can
 * surface a failure as a normal result instead of a throw: the Claude SDK
 * emits `stopReason: 'error_during_execution'` / `usage.isError`, and the
 * Codex app-server adapter yields the error message as `text` with
 * `stopReason: 'error'`. Every consumer routing on success/failure must use
 * this single predicate rather than re-deriving it.
 */
export function isFailedTurn(result: AgentResult): boolean {
  return result.usage?.isError === true || result.stopReason?.startsWith('error') === true;
}

/**
 * Reply text for a completed turn that produced no assistant text. A clean
 * silent turn reads as "Done." — but an errored turn must not: mapping an
 * error result to "Done." tells the user their message was handled when it
 * never was, and hides that every following turn may fail the same way.
 */
export function emptyTurnReply(result: AgentResult): string {
  if (!isFailedTurn(result)) return 'Done.';
  const reason = result.stopReason ?? 'unknown error';
  return `⚠️ The agent run failed (${reason}) and produced no reply — this message was not handled. Check the agent log for details.`;
}

/**
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
/**
 * Per-turn tool restriction passed by chat call sites. Mission tasks and
 * scheduled jobs should leave this undefined so they keep full tool access.
 */
export interface AgentToolPolicy {
  allowedTools?: string[];
  disallowedTools?: string[];
}

export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  mcpAllowlist?: string[],
  providerConfig?: ProviderConfig,
  toolPolicy?: AgentToolPolicy,
  onAskUserQuestion?: AskUserQuestionResolver,
  sharedWatchdog?: TurnWatchdog,
  maxTurnsOverride?: number,
): Promise<AgentResult> {
  // Centralized kill-switch enforcement. Throws KillSwitchDisabledError if
  // LLM_SPAWN_ENABLED has been flipped off — caller is expected to surface
  // a "feature disabled" message rather than retry. This is the SINGLE
  // chokepoint for Telegram, scheduler, mission worker, and any other
  // path that ends up here; the war-room and voice paths have their own
  // requireEnabled calls at their own SDK boundaries.
  requireEnabled('LLM_SPAWN_ENABLED');

  const provider = providerConfig ?? getSelectedProviderConfig();
  const turnAbort = abortController ?? new AbortController();
  const watchdog = sharedWatchdog ?? new TurnWatchdog(turnAbort, AGENT_IDLE_TIMEOUT_MS, AGENT_MAX_RUNTIME_MS);
  const ownsWatchdog = !sharedWatchdog;
  if (ownsWatchdog) watchdog.start();
  const providerSessionId = sessionBelongsToProvider(sessionId, provider)
    ? decodeProviderSession(provider, sessionId)
    : undefined;

  const effectiveModel = model ?? defaultModelForProvider(provider);
  // Resolve the provider-specific effort field once, then use that same
  // normalized value for execution, identity, and reporting.
  const selectedEffort = selectedEffortForProvider(provider, effectiveModel);
  // AgentTurnInput.effort is the Claude-compatible subset; OpenAI's `none`
  // travels through thinkingMode, which is the Codex-native field.
  const effectiveEffort = (selectedEffort === 'none' ? undefined : selectedEffort) as
    | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  const effectiveThinkingMode = provider.type === 'openai'
    ? selectedEffort
    : provider.thinkingMode;
  const effectiveThinking = provider.type === 'claude' && effectiveModel
    ? claudeThinkingForModel(effectiveModel, provider.thinkingMode, effectiveEffort)
    : undefined;
  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  // Strip secret-shaped env vars (DASHBOARD_TOKEN, third-party API keys,
  // DB_ENCRYPTION_KEY, etc.) before handing process.env to the SDK
  // subprocess. A prompt-injected agent that calls `env` or `cat .env`
  // can otherwise read every credential the parent process holds.
  const sdkEnv = { ...getScrubbedSdkEnv(secrets), ...missionExecutionEnv(), ...missionEntryEnv() };

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let resultStopReason: string | undefined;
  let resultFailure: ProviderFailure | undefined;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;
  const outboundOptions = outboundOptionsForSeam('agent.output');
  const streamGuard = new OutboundStreamGuard(outboundOptions);

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  try {
    // Load MCP servers from project + user settings files, filtered by agent allowlist
    const mcpServers = loadMcpServers(mcpAllowlist);
    // Merge the dispatch tools (mission/schedule/hive) for eligible turns —
    // the in-process server for Claude, the stdio bridge for native OpenAI.
    // `dispatchMcpServersForTurn` returns {} unless the runtime has registered
    // them (bootMessenger), the provider is granted them, AND this turn's tool
    // policy grants tools at all. This is the single AUTHORIZATION point for
    // chat, scheduled, and mission turns: engine adapters receive the resulting
    // set as complete and must never add to it, so a direct engine caller that
    // doesn't come through here (memory ingest, war-room, voice) gets no
    // dispatch by design. Because the server lives in module state (not env),
    // scheduled turns with a scrubbed env still see it.
    const dispatchServers = dispatchMcpServersForTurn({
      provider,
      ...(toolPolicy === missionCoordinatorToolPolicy && getMissionExecutionContext() ? { dispatchAccess: 'grant' as const } : {}),
      ...(toolPolicy?.allowedTools ? { allowedTools: toolPolicy.allowedTools } : {}),
      ...(toolPolicy?.disallowedTools ? { disallowedTools: toolPolicy.disallowedTools } : {}),
    });
    // Assigned AFTER the settings-file servers so an authorized dispatch entry
    // wins a name collision with a project/user-configured server.
    Object.assign(mcpServers, dispatchServers);
    // Provenance for engines that pre-approve trusted servers: only what the
    // authorization layer actually built this turn. Never a name match — a
    // `.mcp.json` entry claiming the dispatch name must not inherit its trust.
    const trustedMcpServers = Object.keys(dispatchServers);
    const mcpServerNames = Object.keys(mcpServers);
    logger.info(
      { sessionId: providerSessionId ?? 'new', messageLen: message.length, mcpServers: mcpServerNames },
      'Starting agent query',
    );

    const engine = EngineFactory.forProvider(provider);
    for await (const event of engine.invoke({
      prompt: message,
      provider,
      sessionId: providerSessionId,
      cwd: agentCwd ?? PROJECT_ROOT,
      // 'user' only: the persona now rides in the system prompt (below), so we no
      // longer need 'project' to re-load agents/{id}/CLAUDE.md from cwd on every
      // turn. 'user' still loads ~/.claude/CLAUDE.md and global skills.
      settingSources: ['user'],
      ...(agentSystemPrompt ? { systemPrompt: agentSystemPrompt } : {}),
      runtimeIdentity: runtimeModelIdentity(provider, effectiveModel, {
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
      }),
      permissionMode: effectiveSkipPermissions(provider) ? 'bypassPermissions' : 'default',
      allowDangerouslySkipPermissions: effectiveSkipPermissions(provider),
      ...((maxTurnsOverride ?? AGENT_MAX_TURNS) > 0
        ? { maxTurns: maxTurnsOverride ?? AGENT_MAX_TURNS }
        : {}),
      env: sdkEnv,
      ...(mcpServerNames.length > 0 ? { mcpServers } : {}),
      ...(trustedMcpServers.length > 0 ? { trustedMcpServers } : {}),
      includePartialMessages: !!onStreamText,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(provider.runtimeMode ? { runtimeMode: provider.runtimeMode } : {}),
      ...(effectiveThinkingMode ? { thinkingMode: effectiveThinkingMode } : {}),
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
      ...(toolPolicy?.allowedTools ? { allowedTools: toolPolicy.allowedTools } : {}),
      ...(toolPolicy?.disallowedTools ? { disallowedTools: toolPolicy.disallowedTools } : {}),
      ...(onAskUserQuestion ? { onAskUserQuestion } : {}),
      abortController: turnAbort,
    })) {
      watchdog.touch();
      if (event.type === 'session') {
        newSessionId = event.sessionId;
        logger.info({ newSessionId }, 'Session initialized');
      }

      if (event.type === 'compact') {
        didCompact = true;
        preCompactTokens = event.preCompactTokens;
        logger.warn(
          { trigger: event.trigger, preCompactTokens },
          'Context window compacted',
        );
        onProgress?.({
          type: 'task_completed',
          description: 'Context compacted',
          status: 'notice',
          kind: 'compact',
          toolCallId: 'context-compaction',
        });
      }

      if (event.type === 'progress') {
        onProgress?.(sanitizePresentation(event.progress, 'agent.progress'));
      }

      if (event.type === 'text_delta') {
        if (onStreamText) {
          const released = streamGuard.pushAccumulated(event.accumulatedText);
          if (released) onStreamText(streamGuard.safeText);
        }
      }

      if (event.type === 'usage') {
        usage = event.usage;
        lastCallCacheRead = usage.lastCallCacheRead;
        lastCallInputTokens = usage.lastCallInputTokens;
      }

      if (event.type === 'aborted') {
        return {
          text: event.text == null ? event.text : sanitizeOutboundText(event.text, outboundOptions),
          newSessionId: encodeProviderSession(provider, event.sessionId ?? newSessionId ?? providerSessionId),
          usage: event.usage,
          aborted: true,
          abortReason: watchdog.reason(),
        };
      }

      if (event.type === 'result') {
        resultText = event.text;
        resultStopReason = event.stopReason;
        resultFailure = event.failure;
        if (event.usage) {
          usage = event.usage;
          logger.info(
            {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              lastCallCacheRead: usage.lastCallCacheRead,
              lastCallInputTokens: usage.lastCallInputTokens,
              costUsd: usage.totalCostUsd,
              didCompact,
            },
            'Turn usage',
          );
        }

        logger.info(
          { hasResult: !!resultText, subtype: event.stopReason },
          'Agent result received',
        );
      }
    }
  } catch (err) {
    if (turnAbort.signal.aborted) {
      const abortReason = watchdog.reason();
      logger.info({ abortReason }, 'Agent query aborted');
      return { text: null, newSessionId, usage, aborted: true, abortReason };
    }

    // Classify the error and attach context-aware metadata
    const contextTokens = lastCallInputTokens || lastCallCacheRead || 0;
    const classified = classifyError(err, contextTokens || undefined);
    // Engine throws do not establish whether the SDK delivered the request.
    // Preserve the familiar AgentError API while carrying a conservative
    // failure envelope for callers that understand bounded recovery.
    const carriedFailure = (err as { failure?: ProviderFailure } | null)?.failure;
    Object.assign(classified, { failure: carriedFailure ?? toProviderFailure(err, provider, 'unknown') });
    logger.error(
      { category: classified.category, recovery: classified.recovery, originalMsg: (err as Error)?.message },
      'Agent query failed (classified)',
    );
    throw classified;
  } finally {
    clearInterval(typingInterval);
    if (ownsWatchdog) watchdog.dispose();
  }

  const releasedTail = streamGuard.finalize();
  if (releasedTail) onStreamText?.(streamGuard.safeText);
  return {
    text: resultText == null ? resultText : sanitizeOutboundText(resultText, outboundOptions),
    newSessionId: encodeProviderSession(provider, newSessionId),
    usage,
    stopReason: resultStopReason,
    ...(resultFailure ? { failure: resultFailure } : {}),
  };
}

// ── Retry wrapper ─────────────────────────────────────────────────

function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

let warnedLegacyModelFallback = false;

/**
 * Run interactive turns with durable health and explicit provider policy.
 * Replay requires positive pre-execution evidence and an eligible failure.
 * Calls onRetry before each retry so the caller can notify the user.
 */
export async function runAgentWithRetry(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  onRetry?: (attempt: number, error: AgentError) => void,
  /** @deprecated Detection only; configure the agent.yaml fallback policy instead. */
  fallbackModels?: string[],
  mcpAllowlist?: string[],
  providerConfig?: ProviderConfig,
  toolPolicy?: AgentToolPolicy,
  onAskUserQuestion?: AskUserQuestionResolver,
): Promise<AgentResult> {
  const turnAbort = abortController ?? new AbortController();
  const watchdog = new TurnWatchdog(turnAbort, AGENT_IDLE_TIMEOUT_MS, AGENT_MAX_RUNTIME_MS);
  watchdog.start();
  try {
    // Legacy fallbackModels is retained in the API only. Provider authorization
    // comes exclusively from the active agent's explicit fallback policy.
    if (fallbackModels?.length && !warnedLegacyModelFallback) {
      warnedLegacyModelFallback = true;
      logger.warn('MODEL_FALLBACK_CHAIN is deprecated and ignored; configure the agent.yaml fallback policy instead');
    }
    const { executeInteractiveProvider } = await import('./interactive-provider-execution.js');
    const { getRecentMissionReportContext } = await import('./db.js');
    const missionContext = getMissionExecutionContext() ? '' : getRecentMissionReportContext(AGENT_ID);
    const interactiveMessage = missionContext ? `${missionContext}\n\n${message}` : message;
    return await executeInteractiveProvider({
      agent: AGENT_ID,
      primary: { ...(providerConfig ?? getSelectedProviderConfig()), ...(model ? { model } : {}) },
      signal: turnAbort.signal,
      wait: ms => sleepUntil(ms, turnAbort.signal),
      onRetry: (attempt, error) => { if (error instanceof AgentError) onRetry?.(attempt, error); },
      invoke: (provider, fallback) => runAgent(
        interactiveMessage, fallback ? undefined : sessionId, onTyping, onProgress,
        provider.model, turnAbort, onStreamText, mcpAllowlist, provider,
        toolPolicy, onAskUserQuestion, watchdog,
      ),
    });
  } catch (error) {
    if (turnAbort.signal.aborted) {
      return { text: null, newSessionId: sessionId, usage: null, aborted: true, abortReason: watchdog.reason() };
    }
    throw error;
  } finally {
    watchdog.dispose();
  }
}
