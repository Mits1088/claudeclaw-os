import { outboundText } from '../outbound-payload.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Codex } from '@openai/codex-sdk';
import type {
  CodexOptions,
  ModelReasoningEffort,
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Usage,
} from '@openai/codex-sdk';

import { OPENAI_API_KEY, DEFAULT_OPENAI_MODEL, CLAUDECLAW_CONFIG, PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { normalizedEffortForProvider } from '../model-catalog.js';
import { getScrubbedSdkEnv } from '../security.js';
import { resolveCodexCapabilityProfile, type CodexCapabilityProfile } from './codex-capability-policy.js';
import { summarizeCommand } from './command-summary.js';
import {
  CodexAuthPreparationError,
  applyCodexAuth,
  detectCodexAuth,
  ensureIsolatedCodexHome,
} from './codex-home.js';
import {
  contextWindowForOpenAiModel,
  estimateOpenAiCostUsd,
} from './openai-pricing.js';
import type {
  AgentEngine,
  AgentEngineEvent,
  AgentEngineProgressEvent,
  AgentEngineUsage,
  AgentTurnInput,
  McpServerConfig,
} from './types.js';
import { emptyUsage } from './types.js';
import { composeSystemPrompt } from '../runtime-identity.js';
import { toProviderFailure } from '../provider-recovery.js';
import type { ExecutionCertainty } from './types.js';

type CodexConfigObject = NonNullable<CodexOptions['config']>;

/**
 * Persona delivery ceiling for the `--config developer_instructions=...` path.
 *
 * The Codex SDK passes config overrides as command-line arguments (the prompt
 * itself rides on stdin and has no such limit). Windows caps a process's whole
 * command line at ~32k chars, so a large persona in argv would make the spawn
 * itself fail. Personas at or under this size are pinned as developer
 * instructions (present on every turn, survive compaction — closest analogue
 * to the Claude SDK's systemPrompt); larger ones are prepended in-band on the
 * first turn of a thread instead, where they persist via Codex's session
 * transcript on resume.
 */
const MAX_PERSONA_ARGV_CHARS = 8_000;

/** Codex MCP server ids must be simple identifiers; ClaudeClaw allows dots etc. */
function sanitizeMcpServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Map ClaudeClaw MCP server configs onto Codex `mcp_servers.*` config keys.
 * stdio servers map 1:1; streamable-HTTP servers map to `url`. Servers we
 * can't represent faithfully are skipped with a warning rather than passed in
 * a shape that would fail confusingly at call time:
 *  - `sse` transports (Codex speaks streamable HTTP, not legacy SSE)
 *  - HTTP servers requiring custom headers (Codex has no per-header config)
 */
interface McpMapping {
  /** The `mcp_servers` table, keyed by the sanitized Codex id. */
  servers: CodexConfigObject;
  /** Sanitized id to the original authorized name that produced it. */
  origin: Map<string, string>;
}

function toCodexMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): McpMapping | undefined {
  if (!servers) return undefined;
  const out: CodexConfigObject = {};
  const origin = new Map<string, string>();
  for (const [name, cfg] of Object.entries(servers)) {
    const id = sanitizeMcpServerName(name);
    // Distinct source names can sanitize to the same id (e.g. "files.local"
    // and "files_local"). Warn rather than silently drop the earlier server —
    // the tools would just be missing on OpenAI turns with no explanation.
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      logger.warn(
        {
          server: truncate(name, 120),
          sanitizedId: truncate(id, 120),
          heldBy: truncate(origin.get(id) ?? '', 120),
        },
        'Skipping MCP server for Codex: sanitized id collides with an earlier server',
      );
      continue;
    }
    if ('command' in cfg) {
      const entry: CodexConfigObject = { command: cfg.command };
      if (cfg.args?.length) entry.args = cfg.args;
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = { ...cfg.env };
      out[id] = entry;
      origin.set(id, name);
      continue;
    }
    if (cfg.type === 'sdk') {
      // In-process SDK server (a live McpServer instance, e.g. the dispatch
      // tools). Codex runs out-of-process (`codex exec`), so it cannot consume
      // an in-memory server — only stdio/streamable-HTTP. Skip it here; Codex
      // reaches these tools via the stdio dispatch server instead (Part B).
      logger.warn({ server: name }, 'Skipping MCP server for Codex: in-process SDK server not consumable out-of-process');
      continue;
    }
    if (cfg.type === 'sse') {
      logger.warn({ server: name }, 'Skipping MCP server for Codex: SSE transport not supported');
      continue;
    }
    if (cfg.headers && Object.keys(cfg.headers).length > 0) {
      logger.warn({ server: name }, 'Skipping MCP server for Codex: custom HTTP headers not supported');
      continue;
    }
    out[id] = { url: cfg.url };
    origin.set(id, name);
  }
  return Object.keys(out).length > 0 ? { servers: out, origin } : undefined;
}

/** Server name of the stdio dispatch bridge; kept as a literal so the adapter
 *  does NOT import the heavy dispatch stack (cli-actions → db). Must match
 *  DISPATCH_STDIO_SERVER_NAME in dispatch-tools.ts. The adapter only ever
 *  RECOGNIZES this name (to pre-approve an already-authorized entry) — it never
 *  constructs or adds it; that belongs to the dispatch authorization layer. */
const DISPATCH_MCP_SERVER_NAME = 'claudeclaw-dispatch';

/**
 * Reasoning depth: the dashboard's thinking selector passes provider-native
 * values through `thinkingMode`; the Claude-style `effort` (derived from
 * runtimeMode) is the fallback so quick/deep modes still bite on GPT.
 */
function reasoningEffortFor(input: AgentTurnInput, model: string): ModelReasoningEffort | undefined {
  const provider = { type: 'openai' as const, model };
  const raw = input.thinkingMode?.trim();
  // An EXPLICIT thinking selection is authoritative: a supported effort is used
  // verbatim; 'auto' or any unsupported value (e.g. a stale 'minimal') means
  // "no override — model default". Critically, an explicit-but-unsupported
  // value must NOT fall through to the runtimeMode-derived effort below (that
  // would turn thinkingMode='minimal' + runtimeMode='deep' into 'high').
  if (raw) {
    return normalizedEffortForProvider(provider, raw) as ModelReasoningEffort | undefined;
  }
  // No explicit thinking selection → Claude-style effort from runtimeMode,
  // still constrained by the selected model (Astra, for example, rejects none).
  return normalizedEffortForProvider(provider, input.effort) as ModelReasoningEffort | undefined;
}

/**
 * Ensure the isolated CODEX_HOME and put its credentials in order, then return it.
 *
 * Both halves now come from `codex-home.ts`, shared with the App Server path.
 * They had drifted: this adapter created the home AND prepared its auth, while
 * the App Server adapter created the home and stopped there — so a subscription
 * turn there could start without the operator's current login. The isolation
 * rules and the credential rules are identical for the two engines, so there is
 * one copy of each.
 *
 * Two behaviour changes come with the extraction, both deliberate. Preparation
 * now FAILS CLOSED rather than logging a warning and continuing: a failed
 * removal in API-key mode leaves the turn able to read the subscription
 * credential the mode exists to keep away from it, and a failed copy only
 * postpones the failure to a much less clear place. And a credential the
 * operator has deleted is now removed from the isolated home instead of
 * lingering, so a revoked login cannot outlive itself here.
 *
 * `detect` then `apply` back to back, because this engine spawns one process per
 * turn and has no warm child whose credentials could be changed underneath it.
 * The App Server path defers the apply until its outgoing child has exited.
 */
function ensureCodexHomeWithAuth(hasApiKey: boolean, cwd: string): string {
  // Not caught: a failure here must abort the turn (fail-closed), not fall
  // through to the user's ~/.codex/config.toml.
  const home = ensureIsolatedCodexHome(CLAUDECLAW_CONFIG, PROJECT_ROOT, cwd);
  applyCodexAuth(detectCodexAuth(home, hasApiKey));
  return home;
}

/**
 * Build the env for the Codex CLI subprocess. When the caller supplies an env
 * (agent.ts, warroom) it is already scrubbed; when it does NOT, fall back to
 * `getScrubbedSdkEnv()` — the same canonical scrubber the Claude/ACP paths use
 * — rather than raw `process.env`, so an env-less call site can never leak the
 * parent's DASHBOARD_TOKEN / DB_ENCRYPTION_KEY / third-party API keys into a
 * GPT-driven shell. Undefined values are dropped (the SDK wants
 * Record<string,string> and, when env is provided, inherits NOTHING from
 * process.env — exactly the isolation we want). Every Anthropic credential is
 * stripped case-insensitively (getScrubbedSdkEnv re-injects Claude auth for the
 * Claude SDK; none of it should reach Codex, and Windows env-var names are
 * case-insensitive). Finally CODEX_HOME is pinned to ClaudeClaw's isolated home
 * (see ensureCodexHomeWithAuth) so the operator's global config never loads.
 */
function buildCodexEnv(input: AgentTurnInput): Record<string, string> {
  const source = input.env ?? getScrubbedSdkEnv();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(key) || /^CLAUDE_CODE_/i.test(key)) delete env[key];
  }
  // Throws on failure → invoke() turns it into a fail-closed error. Never
  // leave CODEX_HOME pointing at the operator's real ~/.codex.
  env.CODEX_HOME = ensureCodexHomeWithAuth(!!OPENAI_API_KEY, input.cwd);
  return env;
}

// Min gap between surfaced command_execution "still working" pulses. Codex fires
// many small shell steps; this coalesces them into an occasional heartbeat so a
// long task isn't silent but a quick one isn't a flood.
const COMMAND_HEARTBEAT_MS = 15_000;

/**
 * Codex item types that represent an actual TOOL invocation (as opposed to
 * assistant text, reasoning, or plan updates). Used to enforce the tool-less
 * profile's `maxToolItems: 0` at runtime.
 */
const TOOL_ITEM_TYPES = new Set(['command_execution', 'mcp_tool_call', 'web_search', 'file_change']);

/**
 * Version-pinned Codex config overrides that disable the shell and web search
 * for a tool-less turn (verified expressible on codex-cli 0.144.6):
 *  - `features.shell_tool = false` — the sanctioned toggle; the CLI's
 *    `--disable shell_tool` is exactly `-c features.shell_tool=false`.
 *  - top-level `web_search = "disabled"` — the `[tools] web_search` boolean form
 *    is deprecated in this version.
 *
 * VERIFIED on a live 0.144.6 turn (2026-07-24), against a control run of the same
 * prompt without these overrides:
 *  - `features.shell_tool = false` DOES suppress the shell: 0 `command_execution`
 *    items vs 4 in the control.
 *  - the `read-only` sandbox DOES block writes on this native Windows host: an
 *    `apply_patch` was rejected ("writing is blocked by read-only sandbox") and
 *    the target file was byte-identical afterwards.
 *
 *  - `features.apps = false` DOES remove the host-owned `codex_apps` server: 0
 *    `mcp_tool_call` items, and the model reported no MCP servers available. An
 *    empty `mcp_servers` table alone did NOT — before this gate, a tool-less turn
 *    called `list_mcp_resources` and enumerated 30 account resources (connectors
 *    and skills). `apps_enabled` is the runtime's internal field, not the config
 *    key; `features.apps` is the stable gate.
 *  - the same gate holds with the shell ENABLED (read-only-research): 5
 *    `command_execution` items for repository reads, still 0 `mcp_tool_call`.
 *
 * Residual, accepted per RFC: `apply_patch` may still be presented. It is
 * CONTAINED by the read-only sandbox rather than removed.
 *
 * The streamTurn backstop (TOOL_ITEM_TYPES) remains DETECTION, not prevention:
 * the item has already started when it fires, and a REJECTED apply_patch emits no
 * item at all (router-level log only), so it is invisible to the backstop.
 */
function applyCapabilityHardening(config: CodexConfigObject, profile: CodexCapabilityProfile): void {
  const features: Record<string, boolean> = {};
  if (!profile.shellEnabled) features.shell_tool = false;
  // `mcp_servers: {}` covers only ClaudeClaw-provided servers. The host-owned
  // `codex_apps` server is materialized from the account independently, so this
  // separate gate is mandatory — not redundant — for every untrusted-input turn.
  if (!profile.hostAppsEnabled) features.apps = false;
  if (profile.mode === 'mission-control') features.multi_agent = false;
  if (Object.keys(features).length > 0) config.features = features;
  if (!profile.webSearchEnabled) config.web_search = 'disabled';
}

function truncate(text: string, max: number): string {
  const oneLine = outboundText(text, 'provider.preview').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function usageFromTurn(model: string, u: Usage, durationMs: number): AgentEngineUsage {
  const usage = emptyUsage();
  const cached = Math.max(0, u.cached_input_tokens ?? 0);
  // OpenAI's input_tokens INCLUDES the cached portion, but the engine seam
  // follows the Anthropic convention (inputTokens EXCLUDES cache reads) — every
  // downstream consumer sums inputTokens + cacheReadInputTokens to get total
  // context (bot.ts cost line, dashboard context gauge, cache hit-rate stats).
  // Subtract here or a warm-cache GPT turn double-counts and reads ~2x context.
  usage.inputTokens = Math.max(0, (u.input_tokens ?? 0) - cached);
  usage.outputTokens = u.output_tokens ?? 0;
  usage.cacheReadInputTokens = cached;
  usage.cacheCreationInputTokens = Math.max(0, u.cache_write_input_tokens ?? 0);
  usage.lastCallInputTokens = usage.inputTokens;
  usage.lastCallCacheRead = usage.cacheReadInputTokens;
  usage.lastCallCacheCreation = usage.cacheCreationInputTokens;
  // Estimated — Codex reports tokens, not dollars. Pass the raw usage (with
  // cached still folded into input_tokens); estimateOpenAiCostUsd subtracts.
  usage.totalCostUsd = estimateOpenAiCostUsd(model, u);
  usage.contextWindow = contextWindowForOpenAiModel(model);
  usage.model = model;
  usage.durationMs = durationMs;
  usage.numTurns = 1;
  return usage;
}

function isStaleSessionError(message: string): boolean {
  // Codex's resume failure text has taken a few forms across CLI versions,
  // e.g. "thread/resume failed: no rollout found for thread id ...". Match the
  // subject (session/thread/rollout/conversation) AND an explicit absence signal
  // in either word order ("not found" or "no rollout found"). A bare "resume
  // failed" is not enough: auth, rate and transport errors use that prefix too,
  // and replaying those as though the saved thread were missing is unsafe.
  return /(?:session|thread|conversation|rollout)(?:\s+(?:id|record))?\s+(?:was\s+)?(?:not found|missing|does not exist)|no\s+(?:such\s+)?(?:session|thread|conversation|rollout)(?:\s+(?:id|record))?[^.\n]*?found|missing\s+(?:session|thread|conversation|rollout)|could not find\s+(?:the\s+)?(?:session|thread|conversation|rollout)/i.test(message);
}

/**
 * Marks a failure raised by ClaudeClaw's own policy enforcement rather than by
 * Codex. Such a failure is already an actionable sentence (so it passes through
 * friendlyCodexError untouched) and must never be retried on a fresh thread.
 */
const POLICY_VIOLATION_PREFIX = 'codex-policy-violation: ';

function isPolicyViolation(message: string): boolean {
  return message.startsWith(POLICY_VIOLATION_PREFIX);
}

/** Turn a raw Codex failure into an actionable, user-visible message. */
function friendlyCodexError(message: string): string {
  if (isPolicyViolation(message)) return message.slice(POLICY_VIOLATION_PREFIX.length);
  if (/model is not supported when using Codex with a ChatGPT account|model[^\n]*not supported[^\n]*ChatGPT account/i.test(message)) {
    return 'This model is not enabled for the current ChatGPT Codex account yet. Retry after the rollout reaches the account, or configure an API key with access to the model.';
  }
  if (/401|unauthorized|not (logged|signed) in|login|auth/i.test(message)) {
    return 'Codex isn\'t authenticated. Run `codex login` on the host (ChatGPT subscription) or set OPENAI_API_KEY in .env, then restart with `pm2 restart claudeclaw --update-env`.';
  }
  if (/429|rate.?limit|usage limit|quota/i.test(message)) {
    return `OpenAI rate/usage limit hit: ${message}. Wait a bit or switch models in Settings.`;
  }
  if (/402|insufficient_quota|billing/i.test(message)) {
    return `OpenAI reports a billing/quota problem: ${message}. Check your plan or API credits.`;
  }
  if (/ENAMETOOLONG|E2BIG|argument list too long|command line is too long/i.test(message)) {
    return 'The Codex turn config (persona + MCP server definitions) exceeded the OS command-line limit. Trim the agent persona or reduce the number/size of MCP servers for this agent.';
  }
  if (/ENOENT|spawn|no such file/i.test(message)) {
    return 'The Codex runtime binary could not be started. Run `npm install` to restore @openai/codex-sdk, then restart the service.';
  }
  return `OpenAI (Codex) request failed: ${message}`;
}

/**
 * Native OpenAI engine built on @openai/codex-sdk. The SDK drives the Codex
 * CLI runtime (`codex exec --experimental-json`), which owns the agentic
 * loop — shell tools, patching, MCP, web search, session persistence in
 * ~/.codex/sessions — while this adapter translates ClaudeClaw's engine seam
 * onto it:
 *
 *  - sessions:   thread_id ⇄ AgentTurnInput.sessionId ('openai:<id>' prefix
 *                is applied by the provider layer, not here)
 *  - persona:    developer_instructions config (≤8k chars) or in-band
 *                first-turn prepend (see MAX_PERSONA_ARGV_CHARS)
 *  - text:       agent_message → text_delta; command/MCP/file/search items →
 *                progress events
 *  - cost:       computed locally from turn.completed token counts
 *  - permissions: tool policy + effectiveSkipPermissions → sandboxMode via
 *                sandboxModeFor; approvals are always 'never' (headless)
 *
 * Note on streaming: `codex exec --experimental-json` (CLI 0.144.x) emits
 * agent_message ONLY as item.completed — no incremental item.started/updated
 * for assistant text — so a turn's reply arrives as a single text_delta at the
 * end, not token-by-token. The delta-diff machinery in mapItemEvent is a no-op
 * today but stays correct if a future CLI adds incremental updates.
 *
 * Not bridgeable (accepted parity gaps, same as the ACP path): interactive
 * AskUserQuestion (no approval channel in exec mode — the resolver is
 * ignored), maxTurns, and per-tool allow/deny lists beyond the WebSearch
 * toggle (Codex brings its own toolset).
 */
export class CodexSdkEngineAdapter implements AgentEngine {
  async *invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent> {
    const model = input.model ?? input.provider.model ?? DEFAULT_OPENAI_MODEL;
    const persona = input.systemPrompt?.trim() || undefined;
    const identity = input.runtimeIdentity?.trim() || undefined;
    const combinedPersona = composeSystemPrompt(persona, identity);
    const personaViaConfig = !!persona && !!combinedPersona && combinedPersona.length <= MAX_PERSONA_ARGV_CHARS;

    const reasoningEffort = reasoningEffortFor(input, model);
    // The shared, transport-neutral capability profile (codex-capability-policy):
    // the single translation of resolved caller intent onto Codex-native
    // controls. The App Server transport consumes the same helper and then
    // verifies the effective policy Codex reports back.
    const profile = resolveCodexCapabilityProfile(input);
    const sandboxMode = profile.sandboxMode;
    // Force network OFF whenever we're not in explicit full-access mode, so a
    // user config's sandbox_workspace_write.network_access=true can't grant a
    // locked-down / workspace-write turn outbound network.
    const networkAccessEnabled = profile.networkAccess ? undefined : false;

    const config: CodexConfigObject = {};
    if (combinedPersona && personaViaConfig) config.developer_instructions = combinedPersona;
    else if (identity) config.developer_instructions = identity;
    // `profile.mcpServers` is the COMPLETE authorized MCP set for this turn.
    // Authorization happens above the engine seam: chat/mission turns get
    // dispatch merged in by the dispatch authorization layer (dispatch-tools),
    // the war room filters through its per-agent allowlist, and the voice bridge
    // withholds MCP on untrusted turns. This adapter may only ever CONSUME or
    // NARROW that set — it must never add a server (a tool-less profile narrows
    // it to nothing). Adding one here would hand trusted, state-changing tools
    // to callers that explicitly requested none.
    const mcpMapping = toCodexMcpServers(profile.mcpServers);
    const mcpServers = mcpMapping?.servers;
    // Pre-approve only servers ClaudeClaw itself materialized this turn, so Codex
    // does not classify their tools as approval-required. In `codex exec` there is
    // no interactive approval responder, so an approval-required tool call
    // resolves to Cancel ("user cancelled MCP tool call").
    //
    // Trust comes from PROVENANCE (`input.trustedMcpServers`, populated by the
    // dispatch authorization layer), never from a server's name: a project/user
    // `.mcp.json` entry could otherwise call itself `claudeclaw-dispatch` and
    // inherit auto-approval — most easily when the real bridge is switched off and
    // the name is free. Every other server keeps Codex's default gating.
    //
    // Must be set on the MAPPED entry: toCodexMcpServers rebuilds entries as
    // {command,args,env} and would drop the field if set upstream.
    if (mcpServers) {
      for (const trusted of input.trustedMcpServers ?? []) {
        // Only if the profile actually kept it (a tool-less profile keeps none).
        if (!(trusted in profile.mcpServers)) continue;
        const id = sanitizeMcpServerName(trusted);
        const owner = mcpMapping?.origin.get(id);
        if (owner !== undefined && owner !== trusted) {
          // Sanitizing is lossy. If an untrusted server won the mapped id, stamping
          // approval on that entry would transfer the trusted server's standing.
          // Refuse the turn before constructing Codex or sending the prompt.
          const safeTrusted = truncate(trusted, 120);
          const safeId = truncate(id, 120);
          const safeOwner = truncate(owner, 120);
          logger.error(
            { trustedServer: safeTrusted, sanitizedId: safeId, heldBy: safeOwner },
            'codex_trusted_mcp_collision',
          );
          const friendly = `OpenAI (Codex) turn aborted: MCP server "${safeTrusted}" is trusted for this turn, but its Codex id "${safeId}" is already held by "${safeOwner}". Rename one of them; ClaudeClaw will not transfer trusted approval to a different server.`;
          yield { type: 'text_delta', delta: friendly, accumulatedText: friendly };
          yield {
            type: 'result', text: friendly, usage: emptyUsage(), stopReason: 'error',
            failure: toProviderFailure(new Error(friendly), input.provider, 'not_started'),
          };
          return;
        }
        const entry = mcpServers[id];
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          (entry as Record<string, unknown>).default_tools_approval_mode = 'approve';
        }
      }
    }
    if (mcpServers) config.mcp_servers = mcpServers;
    // Codex-native capability gates for this profile: shell, host-owned apps, and
    // web search. Applied for every profile, not just tool-less — read-only
    // research turns must also have host apps off.
    applyCapabilityHardening(config, profile);

    // ── Config hardening (forced via -c, so these win over any config even if
    //    isolation somehow failed) ──
    // Don't let Codex ALSO auto-load AGENTS.md from cwd: ClaudeClaw agents
    // symlink AGENTS.md → CLAUDE.md, and we already deliver the persona
    // (developer_instructions or in-band), so project-doc loading would
    // double-inject it. developer_instructions is our single instruction source
    // for the stable persona and the per-turn runtime identity.
    config.project_doc_max_bytes = 0;
    // Keep the CLI's injected CODEX_API_KEY (and any OpenAI key) OUT of the
    // environment handed to shell commands the model runs.
    config.shell_environment_policy = {
      ignore_default_excludes: false,
      exclude: ['CODEX_API_KEY', 'OPENAI_API_KEY', '*_API_KEY', '*_TOKEN', '*_SECRET'],
    };
    // Disable login shells (TOP-LEVEL key, not under shell_environment_policy —
    // that path is silently ignored) so a shell profile can't re-export a
    // secret we excluded from the initial child env.
    config.allow_login_shell = false;
    // Pin the model provider to OpenAI so no stray config can redirect the turn
    // (and the injected key) to a custom/compatible endpoint.
    config.model_provider = 'openai';
    const threadOptions: ThreadOptions = {
      model,
      workingDirectory: input.cwd,
      skipGitRepoCheck: true,
      // Approvals can't be answered in exec mode, so the sandbox — not an
      // approval prompt — is the enforcement boundary. sandboxModeFor maps the
      // turn's tool/permission policy onto it: locked-down or read-only-tool
      // turns get 'read-only', explicit skip-permissions gets
      // 'danger-full-access', everything else 'workspace-write' (writes in cwd,
      // no network).
      sandboxMode,
      approvalPolicy: 'never',
      // Parity with Claude's server-side WebSearch: on unless the capability
      // profile denies it (a '*' deny, an explicit WebSearch deny, a restricted
      // allow-list that omits it, or any tool-less turn).
      webSearchEnabled: profile.webSearchEnabled,
      ...(networkAccessEnabled === false ? { networkAccessEnabled: false } : {}),
      ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
    };

    let codex: Codex;
    try {
      codex = new Codex({
        ...(OPENAI_API_KEY ? { apiKey: OPENAI_API_KEY } : {}),
        env: buildCodexEnv(input), // throws if the isolated CODEX_HOME can't be established
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });
    } catch (err) {
      // Fail CLOSED: if we can't guarantee the isolated CODEX_HOME (so the
      // operator's global ~/.codex/config.toml won't load), do NOT run the turn
      // against it. Surface an actionable error via the text_delta+result path.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Codex isolated CODEX_HOME could not be established; refusing to run un-isolated');
      // A credential failure already says what to do about itself. Wrapping it in "check
      // that directory is writable" would point the operator at the directory when the
      // problem is a single unreadable file, or a login that changed mid-flight.
      const friendly = err instanceof CodexAuthPreparationError
        ? `OpenAI (Codex) turn aborted: ${msg}`
        : `OpenAI (Codex) turn aborted: could not set up the isolated Codex config directory under ${CLAUDECLAW_CONFIG} (${msg}). Check that directory is writable, then retry.`;
      yield { type: 'text_delta', delta: friendly, accumulatedText: friendly, raw: { message: msg } };
      yield {
        type: 'result', text: friendly, usage: emptyUsage(), stopReason: 'error',
        failure: toProviderFailure(err, input.provider, 'not_started'),
      };
      return;
    }

    logger.info(
      {
        provider: 'openai',
        model,
        resume: !!input.sessionId,
        persona: persona ? (personaViaConfig ? 'developer_instructions' : 'in-band') : (identity ? 'runtime_identity' : 'none'),
        mcpServers: mcpServers ? Object.keys(mcpServers) : [],
        capabilityMode: profile.mode,
        // REQUESTED, not applied. The SDK transport cannot observe the sandbox the
        // host actually enforced (that visibility gap is what App Server's
        // effective-policy verification closes), so this must never be logged as
        // though it were the effective policy.
        requestedSandbox: sandboxMode,
        shell: profile.shellEnabled,
        hostApps: profile.hostAppsEnabled,
        webSearch: threadOptions.webSearchEnabled,
        reasoningEffort: reasoningEffort ?? 'default',
        // maxTurns has no Codex equivalent; log the request alongside the budget
        // it was translated into so the approximation stays visible.
        requestedMaxTurns: input.maxTurns ?? null,
        turnBudget: profile.turnBudget,
      },
      'Codex SDK turn starting',
    );

    // Attempt 1 resumes the stored thread when there is one; if Codex can't
    // find it (pruned ~/.codex/sessions, different host), fall back to a
    // fresh thread once — provided nothing was streamed yet.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resuming = attempt === 0 && !!input.sessionId;
      let thread: Thread;
      try {
        thread = resuming
          ? codex.resumeThread(input.sessionId!, threadOptions)
          : codex.startThread(threadOptions);
      } catch (err) {
        const failure = err instanceof Error ? err.message : String(err);
        // Thread construction is synchronous in the SDK and happens before
        // runStreamed receives the prompt. A stale saved id is therefore safe to
        // replace once; every other setup failure is definitively not-started.
        if (resuming && isStaleSessionError(failure)) {
          logger.warn({ sessionId: input.sessionId }, 'Codex thread not resumable — starting a fresh thread');
          continue;
        }
        const friendly = friendlyCodexError(failure);
        logger.error({ model, failure }, 'Codex SDK thread setup failed');
        yield { type: 'text_delta', delta: friendly, accumulatedText: friendly, raw: { message: failure } };
        yield {
          type: 'result', text: friendly, usage: null, stopReason: 'error',
          failure: toProviderFailure(err, input.provider, 'not_started'),
        };
        return;
      }

      // In-band persona: only on the first turn of a thread — Codex persists
      // the full transcript, so resumed threads already carry it.
      const prompt = persona && !personaViaConfig && !resuming
        ? `[Agent persona — your identity, tone, and boundaries for every reply]\n${persona}\n\n---\n\n${input.prompt}`
        : input.prompt;

      const outcome = yield* this.streamTurn(thread, prompt, model, input, profile);
      if (outcome.done) return;
      // A policy stop is never retried: the configuration, not the thread, is the
      // problem, and re-running would re-attempt the unauthorized capability.
      if (resuming && !outcome.emitted && !isPolicyViolation(outcome.failure) && isStaleSessionError(outcome.failure)) {
        logger.warn({ sessionId: input.sessionId }, 'Codex thread not resumable — starting a fresh thread');
        continue;
      }

      const friendly = friendlyCodexError(outcome.failure);
      const text = outcome.text ? `${outcome.text}\n\n${friendly}` : friendly;
      logger.error({ model, failure: outcome.failure }, 'Codex SDK turn failed');
      // agent.ts consumes every engine event type EXCEPT 'error' — surface
      // failures via text_delta + result (OpenRouter adapter precedent) so
      // the user sees an actionable message instead of silence.
      yield { type: 'text_delta', delta: friendly, accumulatedText: text, raw: { message: outcome.failure } };
      yield {
        type: 'result', text, usage: outcome.usage, stopReason: 'error',
        failure: toProviderFailure(new Error(outcome.failure), input.provider, outcome.execution),
      };
      return;
    }
  }

  /**
   * Run one turn on one thread, translating Codex events to engine events.
   * Returns instead of yielding on failure so invoke() can decide between the
   * stale-session retry and the user-visible error path.
   */
  private async *streamTurn(
    thread: Thread,
    prompt: string,
    model: string,
    input: AgentTurnInput,
    profile: CodexCapabilityProfile,
  ): AsyncGenerator<
    AgentEngineEvent,
    { done: boolean; emitted: boolean; execution: ExecutionCertainty; failure: string; text: string; usage: AgentEngineUsage | null }
  > {
    const startedAt = Date.now();
    const signal = input.abortController?.signal;
    // Internal abort, used to stop the Codex child when a capability invariant is
    // violated mid-turn. Chained to the caller's signal so a caller abort still
    // reaches the child, but kept SEPARATE so a policy stop is never reported to
    // the user as "you cancelled" — it must surface as a visible error.
    const policyAbort = new AbortController();
    const relayCallerAbort = () => policyAbort.abort();
    // An ALREADY-aborted caller signal never fires 'abort', so copy its state
    // instead of subscribing — otherwise a pre-aborted invocation would hand
    // runStreamed a live signal and start a Codex turn before the first event is
    // observed.
    if (signal?.aborted) policyAbort.abort();
    else signal?.addEventListener('abort', relayCallerAbort, { once: true });
    // Set when a tool item appears on a turn whose budget forbids tools.
    let policyViolation: string | null = null;
    // `emitted` = any observable output OR side-effecting tool ran this turn.
    // Gates the stale-session retry: once true, invoke() must NOT re-run the
    // prompt on a fresh thread, or already-executed commands replay.
    let emitted = false;
    let accumulated = '';
    let sessionId = input.sessionId;
    let usage: AgentEngineUsage | null = null;
    let failure: string | null = null;
    // The SDK has no request-delivery receipt. Until it yields an event we
    // cannot distinguish a local rejection from a delivered request.
    let execution: ExecutionCertainty = 'unknown';
    // Set once turn.completed arrives. After that the turn is terminal and
    // SUCCESSFUL: trailing error events and the SDK's nonzero-exit wrapper throw
    // must NOT relatch a failure or flip the result to an error.
    let completed = false;
    // Latest full text per agent_message item id. Authoritative for the
    // terminal text: Codex item.updated/completed carry the full text so far,
    // and the map's latest snapshot reflects any rewrite — whereas the streamed
    // `accumulated` only ever grows by forward deltas and can drift on a
    // non-prefix revision. Result/aborted text is built from this map.
    const messageText = new Map<string, string>();
    // Heartbeat throttle for command_execution progress: coalesce Codex's many
    // small shell steps into an occasional "still working" pulse (see mapItemEvent).
    const cmdHeartbeat = { last: 0 };
    const finalText = (): string | null => {
      const joined = [...messageText.values()].map((t) => t.trim()).filter(Boolean).join('\n\n');
      return joined || accumulated || null;
    };

    const fail = (message: string) => ({ done: false, emitted, execution, failure: message, text: finalText() ?? '', usage });

    try {
      const { events } = await thread.runStreamed(prompt, { signal: policyAbort.signal });

      for await (const ev of events) {
        // Any streamed turn event establishes that Codex created/processed this
        // turn. Absence of events does NOT establish the inverse.
        execution = 'started';
        if (signal?.aborted) {
          yield { type: 'aborted', text: finalText(), sessionId, usage };
          return { done: true, emitted, execution, failure: '', text: finalText() ?? '', usage };
        }

        // Tool budget check. A tool-less turn (maxToolItems: 0) that produces ANY
        // tool item means a requested control did not hold on this host — e.g. the
        // shell survived `features.shell_tool = false`. Stop the turn rather than
        // let a caller that authorized no tools keep running with them.
        //
        // This is a backstop, not the boundary: the item has already started, so
        // it bounds further tool use and makes the broken assumption visible — it
        // does not prevent the first one.
        if (
          !policyViolation
          && profile.turnBudget.maxToolItems === 0
          && (ev.type === 'item.started' || ev.type === 'item.updated' || ev.type === 'item.completed')
          && TOOL_ITEM_TYPES.has(ev.item.type)
        ) {
          logger.error(
            { capabilityMode: profile.mode, itemType: ev.item.type, requestedSandbox: profile.sandboxMode },
            'codex_policy_violation: tool item on a tool-less turn — failing the turn closed',
          );
          policyViolation = `${POLICY_VIOLATION_PREFIX}This OpenAI (Codex) turn was authorized with no tools, but the Codex runtime started a ${ev.item.type}. The turn was stopped. Check that the pinned Codex version still honors the tool-less configuration.`;
          policyAbort.abort();
          break;
        }

        switch (ev.type) {
          case 'thread.started':
            sessionId = ev.thread_id;
            emitted = true;
            yield { type: 'session', sessionId: ev.thread_id, raw: ev };
            break;

          case 'item.started':
          case 'item.updated':
          case 'item.completed': {
            for (const mapped of this.mapItemEvent(ev.type, ev.item, messageText, cmdHeartbeat)) {
              // A progress event means a tool ran (a side effect); a text_delta
              // means the user saw output. Either way this turn is no longer
              // safely replayable.
              emitted = true;
              if (mapped.type === 'text_delta') {
                accumulated = accumulated + mapped.delta;
                yield { ...mapped, accumulatedText: accumulated };
              } else {
                yield mapped;
              }
            }
            break;
          }

          case 'turn.completed': {
            usage = usageFromTurn(model, ev.usage, Date.now() - startedAt);
            emitted = true;
            // Authoritative success: mark terminal and clear any provisional
            // error the stream emitted mid-flight then recovered from.
            completed = true;
            failure = null;
            yield { type: 'usage', usage: { ...usage }, raw: ev };
            break;
          }

          case 'turn.failed':
            // Ignore once the turn already completed successfully. Otherwise
            // keep the FIRST recorded failure — the root cause (e.g. a 401) is
            // typically emitted before generic "stream disconnected" follow-ups
            // and is what friendlyCodexError needs for an actionable message.
            if (!completed) failure = failure ?? (ev.error?.message || 'unknown Codex turn failure');
            break;

          case 'error':
            if (!completed) failure = failure ?? (ev.message || 'unknown Codex stream error');
            break;

          default:
            break;
        }
      }
    } catch (err) {
      // A policy stop aborts the child, so the SDK throws AbortError — but this
      // is NOT a user cancellation and must surface as a visible error.
      if (policyViolation) return fail(policyViolation);
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        yield { type: 'aborted', text: finalText(), sessionId, usage };
        return { done: true, emitted, execution, failure: '', text: finalText() ?? '', usage };
      }
      // If the turn already completed successfully, a trailing nonzero-exit
      // wrapper throw is not a real failure — emit the normal result.
      if (completed) {
        yield {
          type: 'result',
          text: finalText(),
          usage: usage ?? emptyUsage(),
          stopReason: 'end_turn',
        };
        return { done: true, emitted, execution, failure: '', text: finalText() ?? '', usage };
      }
      // Otherwise the SDK's generic "Codex Exec exited with code N" wrapper came
      // AFTER a structured turn.failed / error event. Prefer the specific
      // failure we recorded (keep-first) so friendlyCodexError can still map
      // auth and stale-session cases; fall back to the thrown message.
      return fail(failure ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      signal?.removeEventListener('abort', relayCallerAbort);
    }

    if (signal?.aborted) {
      yield { type: 'aborted', text: finalText(), sessionId, usage };
      return { done: true, emitted, execution, failure: '', text: finalText() ?? '', usage };
    }
    // A policy stop that broke the loop cleanly (no throw) lands here.
    if (policyViolation) return fail(policyViolation);
    if (failure) return fail(failure);

    yield {
      type: 'result',
      text: finalText(),
      usage: usage ?? usageFromTurn(model, { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }, Date.now() - startedAt),
      stopReason: 'end_turn',
    };
    return { done: true, emitted, execution, failure: '', text: finalText() ?? '', usage };
  }

  /** Translate one Codex item event into zero or more engine events. */
  private mapItemEvent(
    phase: 'item.started' | 'item.updated' | 'item.completed',
    item: ThreadItem,
    messageText: Map<string, string>,
    cmdHeartbeat: { last: number },
  ): AgentEngineEvent[] {
    switch (item.type) {
      case 'agent_message': {
        const prev = messageText.get(item.id) ?? '';
        const next = item.text ?? '';
        // Whether another message item already produced text (for the
        // paragraph separator) — computed BEFORE recording this item.
        const hadOtherText = [...messageText.entries()].some(([id, t]) => id !== item.id && t.length > 0);
        // The map is authoritative for the final text, so record the latest
        // snapshot unconditionally (even a shorter rewrite).
        messageText.set(item.id, next);
        // Stream a delta only for a forward prefix-extension. A non-prefix
        // rewrite or a shrink would make `slice(prev.length)` garbage; skip the
        // live delta and let the map-built terminal text carry the correction.
        if (!next.startsWith(prev) || next.length <= prev.length) return [];
        let delta = next.slice(prev.length);
        // A later agent_message item in the same turn reads as a new paragraph.
        if (!prev && hadOtherText) delta = `\n\n${delta}`;
        // accumulatedText is rewritten by streamTurn, which owns the
        // cross-item accumulation.
        return [{ type: 'text_delta', delta, accumulatedText: '', raw: item }];
      }

      case 'command_execution': {
        // Codex runs many small shell commands (reads, greps, execs) per turn.
        // Surfacing each floods the chat; suppressing all of them makes a long
        // task (e.g. sol writing a spec) go dark for minutes. Balance: a throttled
        // heartbeat — at most one 'started' pulse per COMMAND_HEARTBEAT_MS — plus
        // always surface a NON-ZERO exit. file_change / mcp_tool_call / web_search
        // report normally.
        if (phase === 'item.completed') {
          const nonZero = !(item.exit_code === 0 || item.status === 'completed');
          if (!nonZero) return [];
          // Advisory, not a failure, and carrying its exit code — same reasoning as the
          // App Server path: `rg` exits 1 on no match, so a run of ordinary search
          // misses was rendering as a wall of warnings that read like a broken agent.
          const suffix = typeof item.exit_code === 'number' ? ` · exit ${item.exit_code}` : '';
          return [{
            type: 'progress',
            progress: {
              type: 'task_completed',
              description: `${summarizeCommand(item.command, 140)}${suffix}`,
              status: 'notice',
              kind: 'execute',
              toolCallId: item.id,
            },
            raw: item,
          }];
        }
        if (phase !== 'item.started') return []; // item.updated churns output
        const now = Date.now();
        if (now - cmdHeartbeat.last < COMMAND_HEARTBEAT_MS) return [];
        cmdHeartbeat.last = now;
        return [{ type: 'progress', progress: { type: 'tool_active', description: summarizeCommand(item.command), kind: 'execute', toolCallId: item.id }, raw: item }];
      }

      case 'mcp_tool_call': {
        const description = `${item.server}: ${item.tool}`;
        if (phase === 'item.started') {
          return [{ type: 'progress', progress: { type: 'tool_active', description, kind: 'mcp', toolCallId: item.id }, raw: item }];
        }
        if (phase === 'item.completed') {
          return [{
            type: 'progress',
            progress: { type: 'task_completed', description, status: item.status, kind: 'mcp', toolCallId: item.id },
            raw: item,
          }];
        }
        return [];
      }

      case 'file_change': {
        if (phase !== 'item.completed') return [];
        const paths = item.changes.map((c) => c.path);
        return [{
          type: 'progress',
          progress: {
            type: 'task_completed',
            description: `Edited ${paths.length} file${paths.length === 1 ? '' : 's'}: ${truncate(paths.join(', '), 160)}`,
            status: item.status,
            kind: 'edit',
            toolCallId: item.id,
            locations: paths.map((p) => ({ path: p })),
          },
          raw: item,
        }];
      }

      case 'web_search': {
        if (phase !== 'item.started' && phase !== 'item.completed') return [];
        const progress: AgentEngineProgressEvent = phase === 'item.started'
          ? { type: 'tool_active', description: `Web search: ${truncate(item.query, 160)}`, kind: 'search', toolCallId: item.id }
          : { type: 'task_completed', description: `Web search: ${truncate(item.query, 160)}`, status: 'completed', kind: 'search', toolCallId: item.id };
        return [{ type: 'progress', progress, raw: item }];
      }

      case 'todo_list': {
        return [{
          type: 'progress',
          progress: {
            type: 'plan',
            description: 'Plan updated',
            planEntries: item.items.map((t) => ({ content: t.text, status: t.completed ? 'completed' : 'pending' })),
          },
          raw: item,
        }];
      }

      case 'error':
        logger.warn({ message: item.message }, 'Codex reported a non-fatal error item');
        return [];

      case 'reasoning':
      default:
        return [];
    }
  }
}
