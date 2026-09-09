import fs from 'fs';
import path from 'path';

import {
  OPENAI_API_KEY,
  DEFAULT_OPENAI_MODEL,
  CLAUDECLAW_CONFIG,
  PROJECT_ROOT,
  CODEX_APP_SERVER_MAX_CONCURRENT_TURNS,
} from '../config.js';
import { logger } from '../logger.js';
import { normalizedEffortForProvider } from '../model-catalog.js';
import { getScrubbedSdkEnv } from '../security.js';
import { composeSystemPrompt } from '../runtime-identity.js';
import { resolveCodexCapabilityProfile, type CodexCapabilityProfile } from './codex-capability-policy.js';
import { summarizeCommand } from './command-summary.js';
import { requestDeliveryOf } from './codex-app-server-client.js';
import {
  CodexAuthPreparationError,
  CodexWindowsSandboxPreparationError,
  applyCodexAuth,
  applyCodexWindowsSandbox,
  detectCodexAuth,
  detectCodexWindowsSandbox,
  ensureIsolatedCodexHome,
} from './codex-home.js';
import {
  CodexAppServerManager,
  type TurnSink,
} from './codex-app-server-manager.js';
import {
  policyLogFields,
  verifyEffectivePolicy,
  verifyMcpAuthority,
  type RequestedThreadPolicy,
} from './codex-app-server-policy-verify.js';
import {
  parseEffectiveThreadPolicy,
  parseWindowsSandboxReadiness,
  parseMcpServerStatusPage,
  parseThreadItem,
  parseThreadTokenUsage,
  isToolBearingItem,
  parseTurnRef,
  textInput,
  unsubscribeStatus,
  type EffectiveThreadPolicy,
  type McpServerStatusListParams,
  type ThreadTokenUsage,
  type TokenUsageBreakdown,
  type ToolUserInputRequest,
} from './codex-app-server-protocol.js';
import { contextWindowForOpenAiModel, estimateOpenAiCostUsd } from './openai-pricing.js';
import type {
  AgentEngine,
  AgentEngineEvent,
  AgentEngineUsage,
  AgentTurnInput,
  AskUserQuestionAnswer,
  AskUserQuestionResolver,
  McpServerConfig,
} from './types.js';
import { emptyUsage } from './types.js';

/**
 * Native OpenAI engine on the Codex App Server transport.
 *
 * Differences from the SDK adapter that matter:
 *  - one WARM child per ClaudeClaw process instead of `codex exec` per turn;
 *  - persona and MCP config travel as JSON, so the Windows command-line ceiling is
 *    gone and there is no in-band persona fallback;
 *  - the host reports the EFFECTIVE policy, which is verified before `turn/start` —
 *    the visibility gap the SDK path cannot close;
 *  - cancellation is `turn/interrupt` on one turn, not killing a shared process.
 *
 * Unchanged on purpose: this adapter consumes `input.mcpServers` as the complete
 * authorized set and never adds a server, exactly like the SDK adapter after Phase 0.
 */

/** Control-request timeouts. A turn's own lifetime is bounded by the caller's abort. */
const THREAD_CALL_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 60_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
/** How long to wait for the TERMINAL that confirms an interrupt actually landed. */
const INTERRUPT_DRAIN_MS = 5_000;
/**
 * How long a cancellation waits for an unanswered `turn/start` to name its turn.
 *
 * `turn/start` is a control call that returns as soon as the turn exists, so on a
 * healthy server this never elapses. It only bites when the server has gone quiet —
 * which is the case where the caller cancelled, a turn may be running, and we have no
 * id to cancel it by.
 */
const CANCEL_START_GRACE_MS = 5_000;

/** `turn/start` never answered within the cancellation grace. */
const CANCEL_GRACE_EXPIRED = Symbol('cancel-grace-expired');

/**
 * Pages of `mcpServerStatus/list` to follow before giving up. A cursor that never
 * terminates means we never see the whole inventory, which fails the turn CLOSED
 * rather than verifying a prefix of it.
 */
const MAX_MCP_STATUS_PAGES = 10;

const DISPATCH_MCP_SERVER_NAME = 'claudeclaw-dispatch';

/** The subset of the transport these module-level helpers need. */
type RequestFn = { request: (m: string, p?: unknown, t?: number) => Promise<unknown> };

/**
 * Drop the App Server's loaded copy of a thread so the next `thread/resume` rebuilds
 * it from the caller's parameters instead of rejoining it as-is.
 *
 * Best effort by design. `thread/unsubscribe` answers `notLoaded` for a thread that
 * is not in memory (the normal case after a restart) and is idempotent, so the only
 * failures here are transport-level — and the MCP inventory read AFTER the resume is
 * what actually decides whether the turn may run, so a failure here must not refuse a
 * turn that is then proven safe anyway.
 */
async function dropLoadedThread(client: RequestFn, threadId: string): Promise<void> {
  try {
    const result = await client.request('thread/unsubscribe', { threadId }, THREAD_CALL_TIMEOUT_MS);
    logger.debug({ threadId, status: unsubscribeStatus(result) }, 'codex_thread_unsubscribed_before_resume');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), threadId },
      'codex_app_server: thread/unsubscribe before resume failed; the MCP authority check still gates the turn',
    );
  }
}

/**
 * Every MCP server name a thread can currently reach, following the cursor.
 *
 * Only an explicit `null` ends the walk. Stopping on any falsy cursor would let an
 * empty string end it too, and an inventory that stopped early reads as clean —
 * the parser rejects `""` for the same reason.
 */
async function readEffectiveMcpServers(client: RequestFn, threadId: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_MCP_STATUS_PAGES; page++) {
    const params: McpServerStatusListParams = {
      threadId,
      // Names are all verification needs; `full` additionally pulls resources.
      detail: 'toolsAndAuthOnly',
      ...(cursor !== null ? { cursor } : {}),
    };
    const parsed = parseMcpServerStatusPage(
      await client.request('mcpServerStatus/list', params, THREAD_CALL_TIMEOUT_MS),
    );
    names.push(...parsed.names);
    cursor = parsed.nextCursor;
    if (cursor === null) return names;
  }
  throw new Error(`mcpServerStatus/list did not finish paging after ${MAX_MCP_STATUS_PAGES} pages`);
}

function sanitizeMcpServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export { summarizeCommand } from './command-summary.js';

/**
 * First non-empty line, stripped of the markdown emphasis reasoning summaries lead
 * with (`**Checking the config**`). Only the headline is shown, never the body.
 */
export function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[*_`#]/g, '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * Map ClaudeClaw MCP configs onto Codex `mcp_servers.*`. Same rules as the SDK path.
 *
 * Always returns a table, EMPTY included: `config.mcp_servers` states the complete
 * authorized set for this turn, and omitting it on a resume would leave the previous
 * caller's set unstated rather than replaced.
 */
interface McpMapping {
  /** The `config.mcp_servers` table, keyed by sanitized id. */
  servers: Record<string, unknown>;
  /**
   * Sanitized id → the ORIGINAL authorized name that produced it.
   *
   * Sanitizing is lossy (`a.b` and `a-b` both become `a_b`), so the id alone cannot
   * say which caller-authorized server an entry came from. Trust is granted per
   * ORIGINAL name, so granting it needs this: without it, stamping approval on
   * `mcpServers[sanitize(trusted)]` marks whichever server happened to win the id.
   */
  origin: Map<string, string>;
}

function toCodexMcpServers(servers: Record<string, McpServerConfig>): McpMapping {
  const out: Record<string, unknown> = {};
  const origin = new Map<string, string>();
  for (const [name, cfg] of Object.entries(servers)) {
    const id = sanitizeMcpServerName(name);
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      logger.warn({ server: name, sanitizedId: id, heldBy: origin.get(id) }, 'Skipping MCP server for Codex: sanitized id collides');
      continue;
    }
    origin.set(id, name);
    if ('command' in cfg) {
      const entry: Record<string, unknown> = { command: cfg.command };
      if (cfg.args?.length) entry.args = cfg.args;
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = { ...cfg.env };
      out[id] = entry;
      continue;
    }
    // An unsupported transport claims no id: leaving one behind would make a later
    // server with the same sanitized id look like a collision it did not cause.
    if (cfg.type === 'sdk') {
      origin.delete(id);
      logger.warn({ server: name }, 'Skipping MCP server for Codex: in-process SDK server not consumable out-of-process');
      continue;
    }
    if (cfg.type === 'sse') {
      origin.delete(id);
      logger.warn({ server: name }, 'Skipping MCP server for Codex: SSE transport not supported');
      continue;
    }
    if (cfg.headers && Object.keys(cfg.headers).length > 0) {
      origin.delete(id);
      logger.warn({ server: name }, 'Skipping MCP server for Codex: custom HTTP headers not supported');
      continue;
    }
    out[id] = { url: cfg.url };
  }
  return { servers: out, origin };
}

/**
 * The sanitized server ids this turn authorizes — exactly the keys sent as
 * `config.mcp_servers`, which is what Codex reports back in its effective
 * inventory. Derived through the same mapping so the two can never disagree
 * (a server dropped as unsupported is not authorized either).
 */
export function authorizedMcpServerIds(profile: CodexCapabilityProfile): string[] {
  return Object.keys(toCodexMcpServers(profile.mcpServers).servers);
}

/** A trusted server could not be granted approval without granting it to the wrong entry. */
export class TrustedMcpProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedMcpProvenanceError';
  }
}

/** Same precedence as the SDK path: an explicit thinkingMode wins, 'auto' means default. */
function reasoningEffortFor(input: AgentTurnInput, model: string): string | undefined {
  const provider = { type: 'openai' as const, model };
  const raw = input.thinkingMode?.trim();
  if (raw) return normalizedEffortForProvider(provider, raw);
  return normalizedEffortForProvider(provider, input.effort);
}

/** Build the version-pinned Codex config for a turn from its capability profile. */
export function buildThreadConfig(
  profile: CodexCapabilityProfile,
  reasoningEffort: string | undefined,
  /**
   * Names in `profile.mcpServers` that ClaudeClaw itself materialized and vouches for
   * this turn. Provenance, not a name convention — see the pre-approval block below.
   * Read from the CURRENT invocation only; trust is never stored anywhere.
   */
  trustedMcpServers?: string[],
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    // Codex must not ALSO load AGENTS.md from cwd: agents symlink it to CLAUDE.md and
    // the persona already rides in developerInstructions. Verified via the effective
    // `instructionSources` being empty.
    project_doc_max_bytes: 0,
    model_provider: 'openai',
    allow_login_shell: false,
    shell_environment_policy: {
      ignore_default_excludes: false,
      exclude: ['CODEX_API_KEY', 'OPENAI_API_KEY', '*_API_KEY', '*_TOKEN', '*_SECRET'],
    },
  };

  const features: Record<string, boolean> = {};
  if (!profile.shellEnabled) features.shell_tool = false;
  // Separate from `mcp_servers: {}`: the host-owned codex_apps server is materialized
  // from the ACCOUNT regardless of our MCP table (probe-verified).
  if (!profile.hostAppsEnabled) features.apps = false;
  if (Object.keys(features).length > 0) config.features = features;
  if (!profile.webSearchEnabled) config.web_search = 'disabled';

  // Reasoning effort has no thread/start parameter; it travels through config and is
  // reported back as `reasoningEffort` for verification.
  if (reasoningEffort) config.model_reasoning_effort = reasoningEffort;

  if (profile.sandboxMode === 'workspace-write') {
    // Both exclusions are REQUESTED here and VERIFIED in the effective policy: when
    // false, temp directories become implicit writable roots.
    config.sandbox_workspace_write = {
      network_access: profile.networkAccess,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    };
  }

  // ALWAYS sent, empty table included. `mcp_servers` is the complete authorized set
  // for this turn; omitting it when the caller authorized none would say nothing
  // about the servers a resumed thread already has, instead of replacing them.
  const mapping = toCodexMcpServers(profile.mcpServers);

  // ── pre-approval, by PROVENANCE ────────────────────────────────────────────
  //
  // Codex classifies MCP tools as approval-required, and App Server answers every
  // approval request with a denial (there is no interactive approver, and
  // `approvalPolicy` stays "never"). So an authorized dispatch call is cancelled
  // unless its server is pre-approved — which is the parity gap: the SDK path does
  // this and this one did not.
  //
  // Trust comes from `input.trustedMcpServers`, populated by the dispatch
  // authorization layer, and NEVER from a server's name. A project or user
  // `.mcp.json` entry could otherwise call itself `claudeclaw-dispatch` and inherit
  // the pre-approval — most easily when the real bridge is switched off and the name
  // is free. Every other server keeps Codex's default gating.
  //
  // Applied AFTER mapping, on the mapped entry: the mapping rebuilds entries as
  // {command,args,env}, so a field set upstream would be dropped. Stamping the mapped
  // object leaves everything already resolved onto it — the dispatch env, hive-read
  // flag and all — untouched.
  for (const trusted of trustedMcpServers ?? []) {
    // The profile is the authority on what this turn may reach. A trusted name it
    // narrowed away (a tool-less profile keeps none) does not come back.
    if (!Object.prototype.hasOwnProperty.call(profile.mcpServers, trusted)) continue;

    const id = sanitizeMcpServerName(trusted);
    const owner = mapping.origin.get(id);
    if (owner !== undefined && owner !== trusted) {
      // Two authorized names sanitized to one id and the other won it. Approving that
      // entry would hand the trusted server's standing to a different server the
      // caller never vouched for, so the turn does not run.
      throw new TrustedMcpProvenanceError(
        `MCP server "${trusted}" is trusted for this turn, but its Codex id "${id}" is already held by "${owner}". `
        + 'Rename one of them; ClaudeClaw will not transfer trusted approval to a different server.',
      );
    }
    const entry = mapping.servers[id];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      (entry as Record<string, unknown>).default_tools_approval_mode = 'approve';
      continue;
    }
    // Authorized and trusted, but the mapping dropped it (an unsupported transport).
    // Nothing was approved, so nothing is unsafe — the turn simply runs without it.
    logger.warn({ server: trusted, sanitizedId: id }, 'codex_trusted_mcp_not_mapped');
  }

  config.mcp_servers = mapping.servers;
  return config;
}

/** Per-turn usage accumulated from thread-CUMULATIVE token reports. */
class TurnUsage {
  private previousTotal: TokenUsageBreakdown | null = null;
  private aggregate: TokenUsageBreakdown = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  private lastCall: TokenUsageBreakdown | null = null;
  contextWindow: number | null = null;
  didCompact = false;
  received = false;

  /**
   * `tokenUsage.total` is thread-cumulative, so per-turn usage is the component-wise
   * DELTA between successive reports. The first report of a turn seeds from `last`
   * (the most recent model call) rather than from the thread total, which would
   * attribute the whole thread's history to this turn.
   */
  update(usage: ThreadTokenUsage): void {
    if (!this.received) {
      this.aggregate = { ...usage.last };
    } else if (this.previousTotal) {
      const delta = (a: number, b: number): number => Math.max(0, a - b);
      this.aggregate = {
        totalTokens: this.aggregate.totalTokens + delta(usage.total.totalTokens, this.previousTotal.totalTokens),
        inputTokens: this.aggregate.inputTokens + delta(usage.total.inputTokens, this.previousTotal.inputTokens),
        cachedInputTokens: this.aggregate.cachedInputTokens + delta(usage.total.cachedInputTokens, this.previousTotal.cachedInputTokens),
        outputTokens: this.aggregate.outputTokens + delta(usage.total.outputTokens, this.previousTotal.outputTokens),
        reasoningOutputTokens: this.aggregate.reasoningOutputTokens + delta(usage.total.reasoningOutputTokens, this.previousTotal.reasoningOutputTokens),
      };
    }
    this.received = true;
    this.previousTotal = { ...usage.total };
    this.lastCall = { ...usage.last };
    if (usage.modelContextWindow !== null) this.contextWindow = usage.modelContextWindow;
  }

  toEngineUsage(model: string, durationMs: number): AgentEngineUsage {
    const usage = emptyUsage();
    const cached = Math.max(0, this.aggregate.cachedInputTokens);
    // OpenAI's inputTokens INCLUDES the cached portion; the engine seam follows the
    // Anthropic convention where inputTokens EXCLUDES cache reads, so downstream
    // consumers can sum the two for total context without double counting.
    usage.inputTokens = Math.max(0, this.aggregate.inputTokens - cached);
    usage.cacheReadInputTokens = cached;
    usage.outputTokens = this.aggregate.outputTokens;
    usage.lastCallInputTokens = this.lastCall ? Math.max(0, this.lastCall.inputTokens - this.lastCall.cachedInputTokens) : usage.inputTokens;
    usage.lastCallCacheRead = this.lastCall ? this.lastCall.cachedInputTokens : cached;
    // Reasoning output is already inside outputTokens for billing purposes, so the
    // pricing helper takes the same three buckets as the SDK path.
    usage.totalCostUsd = estimateOpenAiCostUsd(model, {
      input_tokens: this.aggregate.inputTokens,
      cached_input_tokens: cached,
      output_tokens: this.aggregate.outputTokens,
    });
    usage.contextWindow = this.contextWindow ?? contextWindowForOpenAiModel(model);
    usage.model = model;
    usage.durationMs = durationMs;
    usage.numTurns = 1;
    usage.didCompact = this.didCompact;
    return usage;
  }
}

/** Codex resume failures that mean "this thread is gone", not "this turn failed". */
export function isStaleThreadError(message: string): boolean {
  // Never treat the generic "resume failed" wrapper as proof that a saved
  // thread is absent; auth, rate, model, and transport errors use it too.
  return /(?:session|thread|conversation|rollout)(?:\s+(?:id|record)(?:\s+(?!not\b|missing\b|does\b|was\b)["'`]?[-\w]+["'`]?)?)?\s+(?:was\s+)?(?:not found|missing|does not exist)|no\s+(?:such\s+)?(?:session|thread|conversation|rollout)(?:\s+(?:id|record))?[^.\n]*?found|missing\s+(?:session|thread|conversation|rollout)|could not find\s+(?:the\s+)?(?:session|thread|conversation|rollout)/i.test(message);
}

/** Turn a raw failure into an actionable, user-visible message. */
export function friendlyAppServerError(message: string): string {
  if (/model is not supported when using Codex with a ChatGPT account|model[^\n]*not supported[^\n]*ChatGPT account/i.test(message)) {
    return 'This model is not enabled for the current ChatGPT Codex account yet. Retry after the rollout reaches the account, or configure an API key with access to the model.';
  }
  if (/401|unauthorized|not (logged|signed) in|login|auth/i.test(message)) {
    return 'Codex isn\'t authenticated. Run `codex login` on the host or set OPENAI_API_KEY, then restart ClaudeClaw.';
  }
  if (/429|rate.?limit|usage limit|quota/i.test(message)) {
    return `OpenAI rate/usage limit hit: ${message}. Wait a bit or switch models in Settings.`;
  }
  if (/402|insufficient_quota|billing/i.test(message)) {
    return `OpenAI reports a billing/quota problem: ${message}. Check your plan or API credits.`;
  }
  if (/ENOENT|spawn|launcher not found/i.test(message)) {
    return 'The Codex App Server could not be started. Run `npm install` to restore @openai/codex, then restart the service.';
  }
  return `OpenAI (Codex App Server) request failed: ${message}`;
}

export interface AppServerAdapterDeps {
  /** Test seam: supply a manager instead of the process-wide singleton. */
  manager?: CodexAppServerManager;
  /** Test seam: shorten the turn/start ceiling so the uncertain-start path is cheap to exercise. */
  turnStartTimeoutMs?: number;
  /** Test seam: shorten the post-cancellation wait for an unanswered turn/start. */
  cancelStartGraceMs?: number;
  /** Test seam: shorten the turn/interrupt ceiling. */
  interruptTimeoutMs?: number;
  /** Test seam: shorten the wait for the terminal that confirms an interrupt. */
  interruptDrainMs?: number;
  /**
   * Test seam: override the capability profile's wall-clock deadline. The real one is
   * two minutes, which is not a thing to sit through in a unit test.
   */
  turnDeadlineMs?: number;
  /** Test seam: native Windows requires an elevated-sandbox readiness preflight. */
  platform?: NodeJS.Platform;
}

export class CodexAppServerEngineAdapter implements AgentEngine {
  constructor(private readonly deps: AppServerAdapterDeps = {}) {}

  async *invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent> {
    const model = input.model ?? input.provider.model ?? DEFAULT_OPENAI_MODEL;
    const profile = resolveCodexCapabilityProfile(input);
    const reasoningEffort = reasoningEffortFor(input, model);
    const signal = input.abortController?.signal;

    let manager: CodexAppServerManager;
    let cwd: string;
    try {
      // Canonicalize BEFORE verification: the policy verifier compares paths and
      // deliberately cannot call realpath itself.
      cwd = canonicalize(input.cwd);
      const codexHome = ensureIsolatedCodexHome(CLAUDECLAW_CONFIG, PROJECT_ROOT, cwd);
      // READ-ONLY here, deliberately. The plan names the credential state the isolated home
      // should hold so it can enter the launch fingerprint below; applying it is deferred to
      // `prepareLaunch`, which the manager calls only once the outgoing child has exited.
      // Mirroring or removing a credential now would change it underneath turns still
      // running on the warm child.
      const auth = detectCodexAuth(codexHome, !!OPENAI_API_KEY);
      const windowsSandbox = detectCodexWindowsSandbox(codexHome, this.deps.platform ?? process.platform);
      // AWAITED, because a launch-environment change cannot be applied to a running
      // child: the outgoing generation drains its turns and its child is observed to exit
      // before the replacement is built, so the two never overlap. This turn has not
      // started yet, which makes it exactly the right one to wait.
      manager = this.deps.manager ?? await CodexAppServerManager.shared({
        env: buildEnv(input, codexHome),
        expectedCodexHome: codexHome,
        clientVersion: process.env.npm_package_version ?? '0.0.0',
        // A mode plus a digest — never the credential. A rotated login, a logout, or a
        // switch between subscription and API-key auth is a different launch environment
        // and rotates the process exactly once.
        authIdentity: auth.identity,
        sandboxIdentity: windowsSandbox.identity,
        prepareLaunch: () => {
          applyCodexAuth(auth);
          applyCodexWindowsSandbox(windowsSandbox);
        },
        // Deliberately NOT part of the launch fingerprint: changing the ceiling does
        // not require a new child, so it is read once for the process rather than
        // replacing a manager that is happily serving turns.
        maxConcurrentTurns: CODEX_APP_SERVER_MAX_CONCURRENT_TURNS,
      });
    } catch (err) {
      // Fail CLOSED: without the isolated home we cannot promise the operator's global
      // ~/.codex/config.toml is out of the picture.
      yield* this.terminalError(
        `OpenAI (Codex) turn aborted: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    try {
      yield* this.runTurn(input, manager, model, profile, reasoningEffort, cwd, signal);
    } catch (err) {
      if (isAbort(err, signal)) {
        yield { type: 'aborted', text: null, sessionId: input.sessionId, usage: null };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'codex_app_server turn failed');
      // A credential-preparation failure already carries the right advice. Routing it
      // through friendlyAppServerError would rewrite "could not read the login at X
      // (EACCES)" into a generic "run `codex login`", which is the wrong thing to do about
      // a permissions problem.
      yield* this.terminalError(
        err instanceof CodexAuthPreparationError || err instanceof CodexWindowsSandboxPreparationError
          ? message
          : friendlyAppServerError(message),
      );
    }
  }

  /**
   * Take a process-wide turn slot, then run the turn.
   *
   * The slot comes BEFORE any thread lock, and the order is not interchangeable: a
   * slot holder may wait on a thread lock, because whoever holds that lock already has
   * a slot and will finish. Taking the lock first and then queueing for a slot lets a
   * lock holder wait on slot holders queued behind that same lock.
   *
   * Released once, in this `finally`, which is reached only after `runTurnWithSlot`
   * has seen a terminal, had a cancellation confirmed, or quarantined the connection —
   * never merely because an interrupt request was accepted.
   */
  private async *runTurn(
    input: AgentTurnInput,
    manager: CodexAppServerManager,
    model: string,
    profile: CodexCapabilityProfile,
    reasoningEffort: string | undefined,
    cwd: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEngineEvent> {
    const releaseSlot = await manager.acquireTurnSlot(signal);
    try {
      yield* this.runTurnWithSlot(input, manager, model, profile, reasoningEffort, cwd, signal);
    } finally {
      releaseSlot();
    }
  }

  private async *runTurnWithSlot(
    input: AgentTurnInput,
    manager: CodexAppServerManager,
    model: string,
    profile: CodexCapabilityProfile,
    reasoningEffort: string | undefined,
    cwd: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEngineEvent> {
    const client = await manager.ready();
    const platform = this.deps.platform ?? process.platform;
    if (platform === 'win32') {
      const windowsSandbox = parseWindowsSandboxReadiness(
        await client.request('windowsSandbox/readiness', undefined, THREAD_CALL_TIMEOUT_MS),
      );
      logger.info(
        {
          provider: 'openai',
          transport: 'app-server',
          windowsSandboxImplementation: 'elevated',
          windowsSandboxReadiness: windowsSandbox.status,
        },
        'codex_windows_sandbox_readiness',
      );
      if (windowsSandbox.status !== 'ready') {
        yield* this.terminalError(
          `OpenAI (Codex) turn refused: elevated Windows sandbox readiness is ${windowsSandbox.status}. `
          + 'Run `codex` once from an elevated terminal to repair the Windows sandbox, then restart ClaudeClaw.',
        );
        return;
      }
    }
    const persona = composeSystemPrompt(input.systemPrompt, input.runtimeIdentity);

    let config: Record<string, unknown>;
    try {
      config = buildThreadConfig(profile, reasoningEffort, input.trustedMcpServers);
    } catch (err) {
      // Refused BEFORE the thread is even started: no `turn/start`, no prompt on the
      // wire, no sink registered, no tool call consumed. The process slot is still
      // held and `runTurn`'s finally gives it back exactly once.
      if (!(err instanceof TrustedMcpProvenanceError)) throw err;
      logger.error({ err: err.message, capabilityMode: profile.mode }, 'codex_trusted_mcp_collision');
      yield* this.terminalError(`OpenAI (Codex) turn refused: ${err.message}`);
      return;
    }

    const threadParams: Record<string, unknown> = {
      model,
      modelProvider: 'openai',
      cwd,
      sandbox: profile.sandboxMode,
      approvalPolicy: 'never',
      config,
      ...(persona ? { developerInstructions: persona } : {}),
    };

    // ── lock ownership ─────────────────────────────────────────────────────────
    // A turn holds the lock for EVERY thread id it names, from before the id can be
    // acted on until terminal cleanup:
    //  - `input.sessionId`, taken before `thread/resume`, because resume MUTATES
    //    shared thread state and the effective policy we verify describes that state;
    //  - the id `thread/start` or `thread/resume` reports back, taken before the
    //    `session` event publishes it, because a consumer that stores the id can
    //    resume the thread the moment it sees it.
    // On a stale-session fallback both are held: callers still using the dead id stay
    // serialized, and the replacement thread is protected under its own key.
    const heldIds = new Set<string>();
    const releases: Array<() => void> = [];
    const lockThread = async (id: string): Promise<void> => {
      if (heldIds.has(id)) return; // the ids coincide on a plain resume
      const release = await manager.acquireThreadLock(id, signal);
      heldIds.add(id);
      releases.push(release);
    };

    if (input.sessionId) await lockThread(input.sessionId);
    try {
      // ── start or resume ──────────────────────────────────────────────────────
      let effective: EffectiveThreadPolicy;
      let resumed = false;
      if (input.sessionId) {
        // A thread already LOADED in the App Server process is REJOINED by
        // `thread/resume`, and a rejoin ignores the resume parameters WHOLESALE —
        // MCP table, sandbox and model all keep the values they were loaded with
        // (probe-verified on pinned 0.144.6: resuming with `mcp_servers: {}` left a
        // previously configured server live, and resuming with a different table
        // never applied it). Dropping the loaded copy first is what makes the resume
        // rebuild the thread from THIS caller's parameters.
        await dropLoadedThread(client, input.sessionId);
        try {
          effective = parseEffectiveThreadPolicy(
            await client.request('thread/resume', { ...threadParams, threadId: input.sessionId, excludeTurns: true }, THREAD_CALL_TIMEOUT_MS),
            'thread/resume',
          );
          resumed = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!isStaleThreadError(message)) throw err;
          // Stale-session fallback is allowed ONLY here, before turn/start: once a turn
          // may have reached the server, replaying the prompt could repeat side effects.
          // The lock on the stale session id is kept: it is what serializes two callers
          // racing to replace the same dead thread.
          logger.warn({ sessionId: input.sessionId }, 'codex thread not resumable — starting a fresh thread');
          effective = parseEffectiveThreadPolicy(await client.request('thread/start', threadParams, THREAD_CALL_TIMEOUT_MS), 'thread/start');
        }
      } else {
        effective = parseEffectiveThreadPolicy(await client.request('thread/start', threadParams, THREAD_CALL_TIMEOUT_MS), 'thread/start');
      }

      const threadId = effective.thread.id;

      // A resume that SUCCEEDS must hand back the thread that was asked for. Anything
      // else means the turn would run on a thread whose lock we do not hold, so fail
      // closed here rather than proceed under the wrong key.
      if (resumed && threadId !== input.sessionId) {
        logger.error({ requested: input.sessionId, returned: threadId }, 'codex_resume_thread_mismatch');
        yield* this.terminalError(
          `OpenAI (Codex) turn refused: thread/resume returned a different thread (${threadId}) than the requested session (${input.sessionId}).`,
        );
        return;
      }

      // Lock the thread that will actually run the turn BEFORE its id is published:
      // once a consumer has the id it can resume that thread itself. A no-op when the
      // resume returned the session we already hold.
      await lockThread(threadId);

      // Emit the session id for a new or fallback thread so the caller can store it.
      if (!resumed || threadId !== input.sessionId) {
        yield { type: 'session', sessionId: threadId };
      }

      // ── verify the EFFECTIVE policy before any turn starts ───────────────────
      const requestedPolicy: RequestedThreadPolicy = {
        model,
        cwd,
        sandboxMode: profile.sandboxMode,
        networkAccess: profile.networkAccess,
        resumedThread: resumed,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
      const verdict = verifyEffectivePolicy(requestedPolicy, effective);
      logger.info(
        {
          provider: 'openai',
          transport: 'app-server',
          threadId,
          resume: resumed,
          capabilityMode: profile.mode,
          mcpServers: Object.keys(profile.mcpServers),
          ...policyLogFields(requestedPolicy, effective),
          ...(verdict.warnings.length > 0 ? { configWarnings: verdict.warnings } : {}),
        },
        verdict.blocking.length > 0 ? 'codex_policy_mismatch' : 'codex_thread_started',
      );

      if (verdict.blocking.length > 0) {
        // No turn/start: fail before any side effect can occur.
        yield* this.terminalError(
          `OpenAI (Codex) turn refused: the host applied a different SANDBOX or AUTHORIZATION policy than ClaudeClaw requested.\n`
          + verdict.blocking.map((m) => `  • ${m}`).join('\n')
          + '\nCheck the Codex host or managed policy layer.',
        );
        return;
      }

      const notices = [...verdict.warnings];

      // ── the resumed thread's EFFECTIVE MCP inventory ─────────────────────────
      //
      // The policy verified above says nothing about MCP: neither thread response
      // carries an MCP field, so a thread that kept a server from an earlier,
      // more privileged turn passes every check so far. On a resume the inventory
      // is therefore READ back and compared with what this turn authorized.
      //
      // Only on resume: a thread this turn STARTED has no earlier authority to
      // inherit, and the read costs a short-lived probe connection per configured
      // server (~40ms), which is not worth spending on every fresh thread.
      if (resumed) {
        const authorized = authorizedMcpServerIds(profile);
        let effectiveMcp: string[];
        try {
          effectiveMcp = await readEffectiveMcpServers(client, threadId);
        } catch (err) {
          // Fail CLOSED: without the inventory we cannot show this turn runs with
          // only the servers it authorized, and that is precisely the guarantee.
          logger.error({ err: err instanceof Error ? err.message : String(err), threadId }, 'codex_mcp_authority_unverifiable');
          yield* this.terminalError(
            'OpenAI (Codex) turn refused: ClaudeClaw could not read the resumed thread\'s effective MCP servers, '
            + 'so it cannot prove the turn runs with only the servers it authorized '
            + `(${err instanceof Error ? err.message : String(err)}).`,
          );
          return;
        }
        const mcpVerdict = verifyMcpAuthority({ authorized, hostAppsEnabled: profile.hostAppsEnabled }, effectiveMcp);
        logger.info(
          { threadId, authorizedMcpServers: authorized, effectiveMcpServers: effectiveMcp },
          mcpVerdict.blocking.length > 0 ? 'codex_mcp_authority_mismatch' : 'codex_mcp_authority_verified',
        );
        if (mcpVerdict.blocking.length > 0) {
          // No turn/start: the prompt never reaches a thread whose MCP authority is
          // not the set this caller was granted — in EITHER direction, since a
          // missing server means the requested table never replaced the thread's own.
          yield* this.terminalError(
            'OpenAI (Codex) turn refused: the resumed Codex thread\'s MCP servers are not the set this turn authorized.\n'
            + mcpVerdict.blocking.map((m) => `  • ${m}`).join('\n')
            + '\nStart a new chat to run this turn under the requested set.',
          );
          return;
        }
        notices.push(...mcpVerdict.warnings);
      }

      // Configuration differences that carry no authority are REPORTED, not enforced.
      // The turn genuinely runs at the thread's own setting, and saying so is the whole
      // point — the alternative is either blocking safe work or implying a change took
      // effect when it did not.
      for (const warning of notices) {
        yield { type: 'progress', progress: { type: 'task_completed', description: warning, status: 'notice', kind: 'notice' } };
      }

      // ── run the turn under the per-thread lock ───────────────────────────────
      yield* this.streamTurn(input, manager, client, threadId, model, profile, signal);
    } finally {
      // Every id acquired above, released exactly once, in reverse order.
      while (releases.length > 0) releases.pop()!();
      heldIds.clear();
    }
  }

  private async *streamTurn(
    input: AgentTurnInput,
    manager: CodexAppServerManager,
    client: { request: (m: string, p?: unknown, t?: number) => Promise<unknown> },
    threadId: string,
    model: string,
    profile: CodexCapabilityProfile,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentEngineEvent> {
    const startedAt = Date.now();
    const usage = new TurnUsage();
    const messageText = new Map<string, string>();
    let accumulated = '';
    // Which message item the accumulated text last grew from. A turn emits SEVERAL
    // agentMessage items (gpt-5.x narrates a preamble before each tool call), and
    // `accumulated` spans the whole turn, so without a boundary the end of one item
    // butts straight against the start of the next: "never secret values.The active
    // files are…". The terminal text is joined from item snapshots and was never
    // affected — this is the live display only.
    let lastDeltaItemId = '';
    let turnId: string | null = null;
    // The turn id is carried on the terminal so cancellation can insist on a terminal
    // for the turn it actually interrupted, rather than accepting any that turns up.
    let terminal: { turnId: string; status: string; error: string | null } | null = null;
    let transportFailure: string | null = null;
    /** Set once the turn breaks its own budget; the message the caller will see. */
    let policyViolation: string | null = null;

    // The turn is over at this wall-clock time, whatever it is doing. Only profiles
    // that state a deadline get one — `undefined` means the caller's own
    // AbortController is the only bound, exactly as on the SDK path.
    const deadlineMs = this.deps.turnDeadlineMs ?? profile.turnBudget.deadlineMs;
    const deadlineAt = deadlineMs !== undefined ? startedAt + deadlineMs : null;
    /**
     * A tool-less turn that emits ANY tool item means a control ClaudeClaw requested
     * did not hold on this host — the shell surviving `features.shell_tool = false`,
     * say. A backstop, not the boundary: the item has already started, so this bounds
     * FURTHER tool use and makes the broken assumption visible rather than preventing
     * the first one. Same contract as the SDK path, enforced here for the first time.
     */
    const toolsForbidden = profile.turnBudget.maxToolItems === 0;

    // Queue + waker: notifications arrive on the client's read loop, and this
    // generator consumes them. A provisional sink is registered BEFORE turn/start so
    // items that arrive before the response is processed are not lost.
    const queue: AgentEngineEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: AgentEngineEvent): void => {
      queue.push(event);
      wake?.();
    };

    const resolver = input.onAskUserQuestion;
    const sink: TurnSink = {
      threadId,
      turnId: null,
      // Only when the host actually offers an interactive UI. Absent, the manager
      // declines the question rather than leaving App Server blocked on an answer.
      ...(resolver
        ? { askUserQuestion: (request, questionSignal) => askUserQuestion(resolver, request, signal, questionSignal) }
        : {}),
      deliver: (notification) => {
        const params = notification.params as Record<string, unknown> | undefined;
        switch (notification.method) {
          case 'claudeclaw/transportFailed':
            transportFailure = String((params?.reason as string) ?? 'transport failed');
            wake?.();
            return;
          case 'turn/started': {
            const ref = parseTurnRef(params, 'turn/started');
            if (sink.turnId !== null && ref.id !== sink.turnId) {
              // The turn/start response already named our turn. A started for a
              // different one is not ours to react to.
              logger.warn({ threadId, expected: sink.turnId, received: ref.id }, 'codex_turn_started_mismatch');
              return;
            }
            turnId = ref.id;
            sink.turnId = ref.id; // bind the provisional sink to its turn
            // Anchor the pre-text window on the one notification guaranteed to arrive.
            // The `reasoning` item is a better signal but its type string is an
            // unverified reconstruction, and if reasoning only lands on item/completed
            // it arrives after the silence rather than during it. This fires first,
            // always, and is superseded by the first real reasoning or text event.
            push({ type: 'progress', progress: { type: 'tool_active', description: 'Thinking', kind: 'thinking' } });
            return;
          }
          case 'turn/completed': {
            const ref = parseTurnRef(params, 'turn/completed');
            if (sink.turnId !== null && ref.id !== sink.turnId) {
              // Routing should never bring another turn's terminal here. If one does
              // arrive it must not end THIS turn, and it must not be mistaken for
              // confirmation of a cancellation we asked for.
              logger.warn({ threadId, expected: sink.turnId, received: ref.id }, 'codex_terminal_turn_mismatch');
              return;
            }
            terminal = { turnId: ref.id, status: ref.status, error: ref.errorMessage };
            wake?.();
            return;
          }
          case 'thread/tokenUsage/updated': {
            const parsed = parseThreadTokenUsage(params);
            if (parsed) usage.update(parsed);
            return;
          }
          case 'thread/compacted': {
            usage.didCompact = true;
            push({ type: 'compact', preCompactTokens: null, trigger: 'thread/compacted' });
            return;
          }
          case 'turn/plan/updated': {
            const plan = Array.isArray(params?.plan) ? params.plan : [];
            push({
              type: 'progress',
              progress: {
                type: 'plan',
                description: typeof params?.explanation === 'string' ? params.explanation : 'Plan updated',
                planEntries: plan
                  .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
                  .map((s) => ({ content: String(s.step ?? ''), status: String(s.status ?? 'pending') })),
              },
            });
            return;
          }
          case 'item/agentMessage/delta': {
            const delta = typeof params?.delta === 'string' ? params.delta : '';
            if (!delta) return;
            const itemId = typeof params?.itemId === 'string' ? params.itemId : '';
            // Paragraph-break on an item change so consecutive messages read as
            // separate paragraphs rather than one run-on sentence.
            if (accumulated && itemId && itemId !== lastDeltaItemId) accumulated += '\n\n';
            lastDeltaItemId = itemId;
            accumulated += delta;
            push({ type: 'text_delta', delta, accumulatedText: accumulated });
            return;
          }
          case 'item/started':
          case 'item/completed': {
            // Classified from the RAW wire tag, before parsing: an item type this
            // build does not model still counts as tool use, which is the point of
            // the exclusion list backing `isToolBearingItem`.
            const itemType = (params?.item as Record<string, unknown> | undefined)?.type;
            if (toolsForbidden && !policyViolation && isToolBearingItem(itemType)) {
              // A tag we cannot read lands here too: it is invalid under the pinned
              // union, and an item we cannot identify is not evidence that nothing
              // happened.
              const named = typeof itemType === 'string' && itemType
                ? `(${itemType})`
                : '(an item whose type ClaudeClaw could not read)';
              logger.error(
                { capabilityMode: profile.mode, itemType, threadId, turnId: sink.turnId },
                'codex_policy_violation: tool item on a tool-less turn',
              );
              policyViolation = `OpenAI (Codex) turn stopped: this turn authorized no tools, but the model used one `
                + `${named}. A sandbox or feature control ClaudeClaw requested did not hold on this host, `
                + `so the turn was cancelled rather than allowed to continue.`;
              wake?.();
              return;
            }
            const item = parseThreadItem(params?.item);
            if (!item) return;
            for (const event of mapItem(notification.method, item, messageText)) push(event);
            return;
          }
          default:
            // Unknown notification methods are ignored: a new one must never break a
            // turn (`remoteControl/status/changed` shows up unsolicited, for one).
            logger.debug({ method: notification.method }, 'codex_app_server: unhandled notification');
        }
      },
    };
    manager.addSink(sink);

    const finalText = (): string | null => {
      const joined = [...messageText.values()].map((t) => t.trim()).filter(Boolean).join('\n\n');
      return joined || accumulated || null;
    };

    try {
      // Cancelled before the prompt was sent. Everything up to here — the lock, the
      // resume, the policy and MCP checks — has side effects on shared thread state,
      // but no turn exists, so there is nothing to interrupt and nothing to quarantine.
      // Checked HERE rather than left to the drain loop: entering it would send the
      // prompt first and then immediately cancel the turn it just started.
      if (signal?.aborted) {
        logger.info({ threadId }, 'codex_turn_cancelled_before_start');
        yield {
          type: 'aborted',
          text: null,
          sessionId: threadId,
          usage: usage.toEngineUsage(model, Date.now() - startedAt),
        };
        return;
      }

      // ── start the turn, racing the caller's cancellation ─────────────────────
      //
      // The prompt is sent ONCE and never replayed. Once it is on the wire it cannot
      // be recalled, so a cancellation arriving now does not abandon it: it waits, for
      // a bounded moment, to learn the id of the turn it has to cancel.
      const startCall = client.request(
        'turn/start',
        { threadId, input: textInput(input.prompt) },
        this.deps.turnStartTimeoutMs ?? TURN_START_TIMEOUT_MS,
      );

      let startResponse: unknown;
      try {
        const outcome = await settleBeforeCancelGrace(
          startCall,
          signal,
          this.deps.cancelStartGraceMs ?? CANCEL_START_GRACE_MS,
        );
        if (outcome === CANCEL_GRACE_EXPIRED) {
          // Cancelled, and the server never said whether the turn began. Identical in
          // kind to an uncertain start: a turn may be running under a name we do not
          // know, so the connection goes rather than the turn being called cancelled.
          yield* this.quarantineUncertainStart(
            manager,
            threadId,
            turnId,
            new Error('cancelled while turn/start was still unanswered'),
          );
          return;
        }
        startResponse = outcome;
      } catch (err) {
        // A `turn/start` that was REFUSED or never sent leaves nothing running: the
        // outer handler renders it as an ordinary failure and the connection stays
        // usable. Anything else — a timeout, a transport that died mid-flight — means
        // the turn may be running right now with no way to name or cancel it.
        if (requestDeliveryOf(err) !== 'unknown') throw err;
        yield* this.quarantineUncertainStart(manager, threadId, turnId, err);
        return;
      }

      // ── the response names the turn ──────────────────────────────────────────
      //
      // `TurnStartResponse` is `{ turn: Turn }` with a required id, so the turn is
      // nameable the moment the call returns — before `turn/started` arrives, and even
      // if it never does. Cancellation depends on this: without it, an abort that beat
      // the notification had nothing to interrupt and reported success anyway.
      try {
        const ref = parseTurnRef(startResponse, 'turn/start');
        if (sink.turnId !== null && sink.turnId !== ref.id) {
          // A turn/started for a different turn bound us first. We cannot tell which
          // one is ours, and interrupting the wrong turn is worse than neither.
          throw new Error(`turn/start returned turn ${ref.id} but turn/started already bound ${sink.turnId}`);
        }
        turnId = ref.id;
        sink.turnId = ref.id;
        logger.debug({ threadId, turnId, status: ref.status }, 'codex_turn_started');
      } catch (err) {
        yield* this.quarantineUnnameableTurn(manager, threadId, err);
        return;
      }

      // Drain until terminal, abort, transport failure, or a broken budget.
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (terminal || transportFailure || policyViolation) break;
        if (signal?.aborted) break;
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          logger.error(
            { capabilityMode: profile.mode, threadId, turnId, deadlineMs },
            'codex_turn_deadline_exceeded',
          );
          policyViolation = `OpenAI (Codex) turn stopped: it ran past the ${deadlineMs}ms deadline `
            + `this capability profile allows, so it was cancelled.`;
          break;
        }
        // ONE settled callback for all three ways this wait ends — a notification, the
        // poll timer, the caller aborting. Whichever fires clears the timer and detaches
        // the listener, and it cannot fire twice. A turn of any length runs this loop
        // several times a second, so a listener left on the signal or a timer left
        // running is a leak that grows with the turn.
        await new Promise<void>((resolve) => {
          let settled = false;
          let timer: NodeJS.Timeout | undefined;
          const settle = (): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', settle);
            wake = null;
            resolve();
          };
          wake = settle;
          signal?.addEventListener('abort', settle, { once: true });
          // Bounded so a lost terminal notification cannot hang a turn forever, and
          // never past the deadline — otherwise a 50ms budget would go unnoticed for
          // 250ms.
          const remaining = deadlineAt === null ? 250 : Math.max(0, Math.min(250, deadlineAt - Date.now()));
          timer = setTimeout(settle, remaining);
          timer.unref?.();
        });
      }
      while (queue.length > 0) yield queue.shift()!;

      // A dead transport is checked first: the child is gone, so the turn cannot
      // outlive it. Trying to interrupt over a closed pipe and then quarantining a
      // corpse would report "could not confirm cancellation" about a turn that has
      // demonstrably ended.
      if (transportFailure) {
        yield* this.terminalError(friendlyAppServerError(transportFailure));
        return;
      }
      if (policyViolation) {
        // The turn broke its own budget. Stopping it goes through the SAME cancellation
        // path a caller's abort takes — interrupt the exact turn, wait for the terminal
        // that confirms it, quarantine if that cannot be established — because an
        // unstoppable turn is no less dangerous for having been stopped on policy
        // grounds. Only the message the caller sees differs.
        if (terminal) {
          yield* this.reportTerminal(
            threadId, { status: 'failed', error: null }, usage, model, startedAt, finalText(), policyViolation,
          );
        } else {
          yield* this.cancelTurn(
            manager, client, threadId, turnId as string, queue, () => terminal,
            usage, model, startedAt, finalText(), policyViolation,
          );
        }
        return;
      }
      if (signal?.aborted && !terminal) {
        yield* this.cancelTurn(
          manager, client, threadId, turnId as string, queue, () => terminal,
          usage, model, startedAt, finalText(),
        );
        return;
      }

      yield* this.reportTerminal(
        threadId,
        terminal as { status: string; error: string | null } | null,
        usage, model, startedAt, finalText(),
      );
    } finally {
      manager.removeSink(sink);
    }
  }

  /**
   * Turn a turn's terminal into engine events.
   *
   * Shared with the cancellation path deliberately. A turn that was interrupted, one
   * that finished first, and one that failed are three different outcomes, and a
   * cancellation request does not change which of them happened — reporting every
   * confirmed terminal as `aborted` threw away a completed turn's answer and hid a
   * failure behind a cancellation the caller merely asked for.
   */
  private async *reportTerminal(
    threadId: string,
    result: { status: string; error: string | null } | null,
    usage: TurnUsage,
    model: string,
    startedAt: number,
    text: string | null,
    /**
     * A failure message to report INSTEAD of deriving one from the terminal. Used when
     * ClaudeClaw itself ended the turn on policy grounds: attributing that to OpenAI
     * through `friendlyAppServerError` would misplace the decision.
     */
    failureOverride?: string,
  ): AsyncGenerator<AgentEngineEvent> {
    const turnUsage = usage.toEngineUsage(model, Date.now() - startedAt);
    if (!usage.received) {
      logger.warn({ threadId }, 'codex_app_server: turn produced no token usage notification');
    }
    yield { type: 'usage', usage: { ...turnUsage } };

    // An override means ClaudeClaw ended the turn, so the terminal's own status is not
    // the outcome the caller needs — the reason it was stopped is.
    if (!failureOverride && result?.status === 'completed') {
      yield { type: 'result', text, usage: turnUsage, stopReason: 'end_turn' };
      return;
    }
    if (!failureOverride && result?.status === 'interrupted') {
      yield { type: 'aborted', text, sessionId: threadId, usage: turnUsage };
      return;
    }
    const failure = failureOverride
      ?? friendlyAppServerError(result?.error ?? 'the turn failed without an error message');
    const combined = text ? `${text}\n\n${failure}` : failure;
    yield { type: 'text_delta', delta: failure, accumulatedText: combined };
    yield { type: 'result', text: combined, usage: turnUsage, stopReason: 'error' };
  }

  /**
   * `turn/start` reached the App Server and never answered. The turn may be active.
   *
   * Three things must NOT happen here. The prompt must not be replayed — a second
   * `turn/start` could repeat every side effect the first one is still producing. The
   * connection must not be reused — an orphaned turn keeps emitting notifications, and
   * the next invocation to take this thread would inherit them as its own. And the
   * thread lock must not be released before the child is gone — `runTurn`'s `finally`
   * releases it, so the quarantine is awaited HERE, while it is still held.
   *
   * The turn id is logged when `turn/started` happened to arrive first, but it does not
   * change the outcome: a server that stopped answering `turn/start` is not one to send
   * a `turn/interrupt` to and believe the answer.
   */
  private async *quarantineUncertainStart(
    manager: CodexAppServerManager,
    threadId: string,
    turnId: string | null,
    err: unknown,
  ): AsyncGenerator<AgentEngineEvent> {
    const cause = err instanceof Error ? err.message : String(err);
    logger.error({ threadId, turnId, err: cause }, 'codex_turn_start_uncertain');
    yield* this.quarantineAndReport(
      manager,
      `turn/start outcome unknown on thread ${threadId}: ${cause}`,
      'OpenAI (Codex) turn stopped: ClaudeClaw lost contact with the Codex App Server while starting this turn, '
      + 'so it cannot tell whether the turn began. The prompt was NOT sent again — repeating it could repeat work '
      + 'that already started.',
      cause,
    );
  }

  /**
   * `turn/start` answered, so a turn EXISTS, but the response did not name it usably.
   *
   * Worse than not knowing whether it started: it definitely did, and it can never be
   * interrupted, tracked, or told apart from a later turn on the same thread. The
   * connection is the only thing that can still stop it.
   */
  private async *quarantineUnnameableTurn(
    manager: CodexAppServerManager,
    threadId: string,
    err: unknown,
  ): AsyncGenerator<AgentEngineEvent> {
    const cause = err instanceof Error ? err.message : String(err);
    logger.error({ threadId, err: cause }, 'codex_turn_start_unnameable');
    yield* this.quarantineAndReport(
      manager,
      `turn/start response did not name its turn on thread ${threadId}: ${cause}`,
      'OpenAI (Codex) turn stopped: the Codex App Server started this turn but did not name it, so ClaudeClaw '
      + 'cannot follow or cancel it. The prompt was NOT sent again.',
      cause,
    );
  }

  /**
   * Cancel one turn without disturbing others. Killing the shared child would abort
   * unrelated missions and chats, so cancellation is always turn-scoped — and the turn
   * is named by the `turn/start` response, so this runs whether or not `turn/started`
   * ever arrived.
   *
   * Cancellation is only reported once it is ESTABLISHED. `turn/interrupt` returning
   * says the server accepted the request, not that the turn stopped; only a terminal
   * for THIS turn says that. Until this landed, an interrupt that failed produced a
   * warning and an `aborted` event for a turn that was still running.
   *
   * When it cannot be established the connection goes, for the same reason an
   * uncertain `turn/start` does: an unstoppable turn on a reusable connection is how
   * one caller's work ends up in another's stream.
   */
  private async *cancelTurn(
    manager: CodexAppServerManager,
    client: { request: (m: string, p?: unknown, t?: number) => Promise<unknown> },
    threadId: string,
    turnId: string,
    queue: AgentEngineEvent[],
    terminal: () => { turnId: string; status: string; error: string | null } | null,
    usage: TurnUsage,
    model: string,
    startedAt: number,
    text: string | null,
    /** Set when POLICY stopped the turn rather than the caller; reported on success. */
    policyFailure?: string,
  ): AsyncGenerator<AgentEngineEvent> {
    // Ask, but do not hang on the answer. `turn/interrupt` returning says the server
    // accepted the request, not that the turn stopped; a terminal for THIS turn says
    // that, and it can arrive while the request is still in flight — or after it
    // failed, because a turn that was already finishing never needed our interrupt.
    let interruptSettled = false;
    let interruptFailure: unknown = null;
    void client
      .request('turn/interrupt', { threadId, turnId }, this.deps.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS)
      .then(
        () => { interruptSettled = true; },
        (err: unknown) => { interruptSettled = true; interruptFailure = err; },
      );

    // Only this turn's terminal counts: the sink drops any other, so what lands here
    // cannot be a different turn's ending standing in for ours.
    const until = Date.now() + (this.deps.interruptDrainMs ?? INTERRUPT_DRAIN_MS);
    while (!terminal() && Date.now() < until) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 25); t.unref?.(); });
    }

    const confirmed = terminal();
    if (confirmed) {
      // The turn has demonstrably ended. Nothing is outstanding, so the connection
      // stays — whatever became of the interrupt request. Its real status is reported
      // as-is: `interrupted` is an abort, but a turn that completed or failed first
      // did so on its own terms and the caller is owed that answer.
      logger.info(
        { threadId, turnId, status: confirmed.status, interruptSettled, interruptFailed: interruptFailure !== null },
        'codex_turn_cancel_confirmed',
      );
      while (queue.length > 0) yield queue.shift()!;
      yield* this.reportTerminal(threadId, confirmed, usage, model, startedAt, text, policyFailure);
      return;
    }

    if (interruptFailure !== null || !interruptSettled) {
      const cause = interruptFailure instanceof Error
        ? interruptFailure.message
        : interruptFailure !== null
          ? String(interruptFailure)
          : 'turn/interrupt was never answered';
      logger.error({ threadId, turnId, err: cause }, 'codex_turn_interrupt_failed');
      yield* this.quarantineAndReport(
        manager,
        `turn/interrupt failed for turn ${turnId} on thread ${threadId}: ${cause}`,
        'OpenAI (Codex) turn stopped: ClaudeClaw asked the Codex App Server to cancel this turn and the request '
        + 'failed, so the turn may still be running.',
        cause,
      );
      return;
    }

    logger.error({ threadId, turnId }, 'codex_turn_interrupt_unconfirmed');
    yield* this.quarantineAndReport(
      manager,
      `no terminal confirmed the interrupt of turn ${turnId} on thread ${threadId}`,
      'OpenAI (Codex) turn stopped: the Codex App Server accepted the cancellation but never confirmed the turn '
      + 'ended, so it may still be running.',
      `no turn/completed for ${turnId} within the wait`,
    );
  }

  /**
   * Discard the connection, then say so once, in terms of what the user should do.
   *
   * Shared by every "a turn may still be running and we cannot stop it" path so they
   * cannot drift apart on the part that matters: whether a retry is safe.
   */
  private async *quarantineAndReport(
    manager: CodexAppServerManager,
    reason: string,
    lede: string,
    cause: string,
  ): AsyncGenerator<AgentEngineEvent> {
    const replaceable = await manager.quarantine(reason);
    yield* this.terminalError(
      `${lede} `
      + (replaceable
        ? 'The connection was discarded and the next message starts a fresh one; send it again if nothing happened.'
        : 'The Codex process could not be terminated, so no new turns will start — restart ClaudeClaw.')
      + ` (${cause})`,
    );
  }

  /** Surface failures as text + result: agent.ts does not render bare `error` events. */
  private async *terminalError(message: string): AsyncGenerator<AgentEngineEvent> {
    yield { type: 'text_delta', delta: message, accumulatedText: message };
    yield { type: 'result', text: message, usage: emptyUsage(), stopReason: 'error' };
  }
}

/** Translate one item notification into zero or more engine events. */
function mapItem(
  method: string,
  item: ReturnType<typeof parseThreadItem> & object,
  messageText: Map<string, string>,
): AgentEngineEvent[] {
  const completed = method === 'item/completed';
  switch (item.type) {
    case 'agentMessage':
      // Item snapshots are AUTHORITATIVE for terminal text; deltas are for live
      // display and can drift on a non-prefix rewrite.
      messageText.set(item.id, item.text);
      return [];
    case 'reasoning': {
      // Reasoning is the ONLY signal a turn emits while the model thinks, and on a
      // complex turn that window is long. Dropping it (as `other` did) left the chat
      // showing a bare "Typing…" with nothing behind it. Reasoning text is a summary,
      // not chain-of-thought, but it is still model-authored: surface a fixed label on
      // start and only the item's own first line on completion.
      if (!completed) {
        return [{ type: 'progress', progress: { type: 'tool_active', description: 'Thinking', kind: 'thinking', toolCallId: item.id } }];
      }
      const summary = firstLine(item.text);
      if (!summary) return [];
      return [{ type: 'progress', progress: { type: 'tool_active', description: truncate(summary, 160), kind: 'thinking', toolCallId: item.id } }];
    }
    case 'commandExecution': {
      if (!completed) {
        return [{ type: 'progress', progress: { type: 'tool_active', description: summarizeCommand(item.command), kind: 'execute', toolCallId: item.id } }];
      }
      const nonZero = !(item.exitCode === 0 || item.status === 'completed');
      if (!nonZero) return []; // successful commands stay quiet, as on the SDK path
      // A non-zero exit is an OBSERVATION, not a verdict. `rg` exits 1 when it finds
      // no match, and plenty of probes end non-zero by design; the turn carries on
      // regardless, and if it genuinely could not, the TURN reports that itself. Calling
      // each one a failure turned an ordinary run of search misses into a scroll of
      // warnings that read as a broken agent — the exact false positive this avoids.
      //
      // So: advisory severity, and the exit code goes in the text. We know the number;
      // we do not know whether it mattered, and the reader can tell the difference
      // between `exit 1` from a grep and `exit 127` from a missing binary.
      const suffix = item.exitCode === null ? '' : ` · exit ${item.exitCode}`;
      return [{
        type: 'progress',
        progress: {
          type: 'task_completed',
          description: `${summarizeCommand(item.command, 140)}${suffix}`,
          status: 'notice',
          kind: 'execute',
          toolCallId: item.id,
        },
      }];
    }
    case 'fileChange': {
      if (!completed) return [];
      const paths = item.changes.map((c) => c.path);
      // Full paths blow the width budget and the leading directories are identical
      // across the list anyway; the file names are the information.
      const names = paths.map((p) => p.split(/[\\/]/).pop() || p);
      return [{
        type: 'progress',
        progress: {
          type: 'task_completed',
          description: `Edited ${paths.length} file${paths.length === 1 ? '' : 's'}: ${truncate(names.join(', '), 120)}`,
          status: item.status,
          kind: 'edit',
          toolCallId: item.id,
          locations: paths.map((p) => ({ path: p })),
        },
      }];
    }
    case 'mcpToolCall': {
      const description = `${item.server} · ${item.tool}`;
      return [{
        type: 'progress',
        progress: completed
          ? { type: 'task_completed', description, status: item.status, kind: 'mcp', toolCallId: item.id }
          : { type: 'tool_active', description, kind: 'mcp', toolCallId: item.id },
      }];
    }
    case 'webSearch': {
      const description = `Web search: ${truncate(item.query, 160)}`;
      return [{
        type: 'progress',
        progress: completed
          ? { type: 'task_completed', description, status: 'completed', kind: 'search', toolCallId: item.id }
          : { type: 'tool_active', description, kind: 'search', toolCallId: item.id },
      }];
    }
    case 'contextCompaction':
      return completed ? [{ type: 'compact', preCompactTokens: null, trigger: 'contextCompaction' }] : [];
    default:
      // Logged, not silent: this is how an unrecognized item type gets noticed. The
      // reasoning item was invisible here for exactly this reason.
      logger.debug({ method, itemType: item.raw }, 'codex_app_server: unmapped thread item');
      return [];
  }
}

/**
 * Put one turn's structured user question to the host's interactive resolver.
 *
 * Two translations, in opposite directions. Codex identifies questions by `id` and
 * wants answers keyed by it; `AskUserQuestionResolver` — the same interface the Claude
 * SDK path uses, unchanged — identifies them by header and question text. So the ids
 * are held aside and matched back afterwards, in order, rather than trusting the
 * resolver to preserve anything.
 *
 * Returns null to decline. Nothing here can grant authority: the answer is text the
 * user chose, and an unanswered question is simply omitted.
 */
export async function askUserQuestion(
  resolve: AskUserQuestionResolver,
  request: ToolUserInputRequest,
  signal: AbortSignal | undefined,
  questionSignal?: AbortSignal,
): Promise<Record<string, string[]> | null> {
  // A secret never goes to a chat UI. The answer would land in message history, in a
  // transcript, and in whatever the host logs — which is the one place a credential
  // must not end up. Declining leaves the model to find another way.
  const askable = request.questions.filter((q) => !q.isSecret);
  if (askable.length < request.questions.length) {
    logger.warn(
      { threadId: request.threadId, turnId: request.turnId, secretQuestions: request.questions.length - askable.length },
      'codex_ask_user_question_secret_declined',
    );
  }
  if (askable.length === 0) return null;

  // TWO ways this stops mattering, and both end the wait. The caller cancelling the
  // turn is one. The other is the question's own lifecycle: the manager settles the
  // App Server response on a deadline, a sink removal, a transport failure — and
  // without that signal this side would stay pending until a human eventually answered
  // a question nobody is listening to. The watch is disposed whichever branch wins, so
  // neither signal accumulates listeners across a turn that asks many questions.
  const watch = cancellationWatch(signal, questionSignal);
  let answered: AskUserQuestionAnswer | null;
  try {
    answered = await Promise.race([
      resolve({ questions: askable.map((q) => ({ header: q.header, question: q.question, options: q.options })) }),
      watch.cancelled,
    ]);
  } finally {
    watch.dispose();
  }
  if (!answered) return null;

  // Match by the pair we sent, consuming duplicates in order so two questions sharing
  // a header cannot both collect the first answer.
  const pending = new Map<string, string[]>();
  for (const q of askable) {
    const key = JSON.stringify([q.header, q.question]);
    const ids = pending.get(key);
    if (ids) ids.push(q.id);
    else pending.set(key, [q.id]);
  }
  const out: Record<string, string[]> = {};
  for (const item of answered.answers) {
    const id = pending.get(JSON.stringify([item.header, item.question]))?.shift();
    if (id && item.selected.length > 0) out[id] = item.selected;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A one-shot cancellation promise over SEVERAL signals — whichever fires first.
 *
 * `dispose()` is what stops the losing branch outliving the race: without it every
 * question leaves an abort listener on each signal, and those signals live as long as
 * the turn. Detaching from all of them, not just the one that won, is the point.
 */
function cancellationWatch(...signals: Array<AbortSignal | undefined>): { cancelled: Promise<null>; dispose: () => void } {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return { cancelled: new Promise<null>(() => {}), dispose: () => {} };

  const attached: Array<{ signal: AbortSignal; onAbort: () => void }> = [];
  const cancelled = new Promise<null>((resolve) => {
    for (const signal of live) {
      if (signal.aborted) { resolve(null); return; }
      const onAbort = (): void => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      attached.push({ signal, onAbort });
    }
  });
  return {
    cancelled,
    dispose: () => {
      for (const { signal, onAbort } of attached) signal.removeEventListener('abort', onAbort);
      attached.length = 0;
    },
  };
}

/**
 * Await `pending`, but once the caller cancels give it only `graceMs` more.
 *
 * Cancellation cannot un-send a request. Abandoning `turn/start` the moment the signal
 * fires would leave a turn running under a name we never learned, so the wait
 * continues — bounded, because after cancellation the caller is owed an answer and a
 * server that has gone quiet is not going to provide one.
 *
 * Resolves the request's value, rejects with its rejection, or resolves
 * `CANCEL_GRACE_EXPIRED` when cancellation came first and nothing arrived in time. The
 * rejection is always observed, so a late failure cannot surface as an unhandled one.
 */
async function settleBeforeCancelGrace<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  graceMs: number,
): Promise<T | typeof CANCEL_GRACE_EXPIRED> {
  if (!signal) return pending;
  const settled = pending.then(() => 'settled' as const, () => 'settled' as const);
  let onAbort = (): void => {};
  const cancelled = new Promise<'cancelled'>((resolve) => {
    onAbort = (): void => resolve('cancelled');
    if (signal.aborted) { resolve('cancelled'); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  });

  // Both losing branches are torn down before returning: the listener in the `finally`
  // and the grace timer as soon as the request beats it. Each is only one per turn, but
  // the signal outlives them and a turn is not the only thing attached to it.
  const grace = cancellableDelay(graceMs);
  try {
    if (await Promise.race([settled, cancelled]) === 'settled') return pending;
    if (await Promise.race([settled, grace.expired]) === 'expired') return CANCEL_GRACE_EXPIRED;
    return pending;
  } finally {
    signal.removeEventListener('abort', onAbort);
    grace.cancel();
  }
}

/** A timer that can be stood down when something else settles the race first. */
function cancellableDelay(ms: number): { expired: Promise<'expired'>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), ms);
    // Never hold the process open just to finish a grace period.
    timer.unref?.();
  });
  return { expired, cancel: () => { if (timer) clearTimeout(timer); } };
}

function canonicalize(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

/** Scrubbed child env with the isolated CODEX_HOME pinned. Mirrors the SDK path. */
function buildEnv(input: AgentTurnInput, codexHome: string): Record<string, string> {
  const source = input.env ?? getScrubbedSdkEnv();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(key) || /^CLAUDE_CODE_/i.test(key)) delete env[key];
  }
  if (OPENAI_API_KEY) env.OPENAI_API_KEY = OPENAI_API_KEY;
  env.CODEX_HOME = codexHome;
  return env;
}
