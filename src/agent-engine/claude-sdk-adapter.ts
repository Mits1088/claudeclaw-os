import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '../logger.js';
import { authError, isAuthErrorText } from '../errors.js';
import { composeSystemPrompt } from '../runtime-identity.js';

import type {
  AgentEngine,
  AgentEngineEvent,
  AgentTurnInput,
  AskUserQuestionRequest,
} from './types.js';

// Locate a system-installed `claude` on PATH, or undefined if none is found.
function findSystemClaude(): string | undefined {
  try {
    const found = execSync('command -v claude', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

// Detect older Intel Macs whose CPU lacks AVX. The SDK's bundled Bun binary
// hangs silently (rather than crashing) on these, stalling every agent query
// until the turn timeout fires. macOS reports AVX as "AVX1.0" in
// machdep.cpu.features — the base CPU-features key, present on every x86 Mac.
// We deliberately do NOT query machdep.cpu.leaf7_features (AVX2): it is absent
// on exactly the pre-AVX CPUs we target, so bundling it would make sysctl exit
// nonzero and skip the fallback for the machines that need it. Only meaningful
// on darwin/x64 — Apple Silicon and non-Mac platforms return false.
function isIntelMacWithoutAvx(): boolean {
  if (process.platform !== 'darwin' || process.arch !== 'x64') return false;
  try {
    const features = execSync('sysctl -n machdep.cpu.features', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return !/\bAVX/i.test(features);
  } catch {
    // sysctl unavailable — can't confirm, so don't force an override.
    return false;
  }
}

// Pick the `claude` binary to run only when we must override the SDK default.
// The SDK's bundled binary can't run in two known cases, and returns undefined
// everywhere else (leaving the SDK's own resolution untouched):
//   - NixOS: the bundled Linux binary can't exec (no ld-linux) and crashes.
//   - Older Intel Macs without AVX: the bundled Bun hangs silently, stalling
//     every query to the timeout instead of crashing.
// In both cases we point the SDK at the system `claude` instead.
function resolveClaudeExecutableOverride(): string | undefined {
  const override = process.env.CLAUDECLAW_CLAUDE_EXECUTABLE_PATH?.trim();
  if (override) {
    logger.info({ path: override }, 'Using CLAUDECLAW_CLAUDE_EXECUTABLE_PATH override for claude CLI');
    return override;
  }
  if (process.platform === 'linux' && existsSync('/etc/NIXOS')) {
    const found = findSystemClaude();
    if (found) {
      logger.info({ path: found }, 'NixOS detected — using the system claude CLI (bundled binary cannot run on Nix)');
      return found;
    }
    logger.warn('NixOS detected but no `claude` on PATH. Install claude-code or set CLAUDECLAW_CLAUDE_EXECUTABLE_PATH.');
  }
  if (isIntelMacWithoutAvx()) {
    const found = findSystemClaude();
    if (found) {
      logger.info(
        { path: found },
        'Intel Mac without AVX detected — using the system claude CLI (bundled Bun binary hangs silently on non-AVX CPUs)',
      );
      return found;
    }
    logger.warn(
      'Intel Mac without AVX detected and no `claude` on PATH. The SDK\'s bundled binary will hang silently until the ' +
        'turn timeout. Install claude-code or set CLAUDECLAW_CLAUDE_EXECUTABLE_PATH to your system claude (e.g. /usr/local/bin/claude).',
    );
  }
  return undefined;
}

const CLAUDE_EXECUTABLE_OVERRIDE = resolveClaudeExecutableOverride();

// The CLI dumps its full minified bundle into stderr on some errors (a failing
// hook callback produced 777 × ~5 KB lines in one day). Relay a bounded snippet
// and squelch repeats: identical messages log once, then every REPEAT_EVERYth
// occurrence with the count. Factory exported for tests.
const STDERR_SNIPPET_CHARS = 500;
const STDERR_REPEAT_EVERY = 50;
export function makeStderrRelay(
  log: (obj: Record<string, unknown>, msg: string) => void,
): (data: string) => void {
  let lastKey = '';
  let repeats = 0;
  return (data: string) => {
    const snippet =
      data.length > STDERR_SNIPPET_CHARS
        ? `${data.slice(0, STDERR_SNIPPET_CHARS)}… [truncated, ${data.length} chars total]`
        : data;
    const key = snippet.slice(0, 100);
    if (key === lastKey) {
      repeats++;
      if (repeats % STDERR_REPEAT_EVERY !== 0) return;
      log({ stderr: snippet, repeats }, 'claude subprocess stderr (repeating)');
      return;
    }
    lastKey = key;
    repeats = 0;
    log({ stderr: snippet }, 'claude subprocess stderr');
  };
}
const relayStderr = makeStderrRelay((obj, msg) => logger.error(obj, msg));

// `claude --resume` scopes its session lookup to the current project directory
// (derived from cwd) in the SDK's bundled CLI. When an agent's cwd changes
// between turns — e.g. the main agent's cwd moves from the repo root to
// agents/main/ once its CLAUDE.md appears — every session saved under the old
// cwd becomes unresumable: the CLI reports the miss only on stderr and ends the
// turn as an `error_during_execution` result that carries no text, which chat
// surfaces would otherwise render as an empty success ("Done."), and the stale
// mapping makes every following turn fail the same way. Watch stderr for the
// signature so `invoke` can abandon the doomed attempt and rerun the turn on a
// fresh session.
const SESSION_NOT_FOUND_RE = /No conversation found with session ID/;

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  WebSearch: 'Web search',
  WebFetch: 'Fetching page',
  Agent: 'Sub-agent',
  NotebookEdit: 'Editing notebook',
  AskUserQuestion: 'User question',
};

const TOOL_COMPLETION_LABELS: Record<string, string> = {
  Write: 'Wrote file',
  Edit: 'Edited file',
  Grep: 'Searched code',
  Glob: 'Found files',
  WebSearch: 'Web search',
  WebFetch: 'Fetched page',
  NotebookEdit: 'Edited notebook',
};

interface ClaudeToolActivity {
  description: string;
  completionDescription: string;
  kind: string;
  persistCompletion: boolean;
}

function toolActivity(toolName: string): ClaudeToolActivity {
  let description = TOOL_LABELS[toolName] ?? toolName;
  let kind = 'thinking';
  let persistCompletion = false;

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    description = parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join(' ')}` : toolName;
    kind = 'mcp';
    persistCompletion = true;
  } else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    kind = 'edit';
    persistCompletion = true;
  } else if (toolName === 'Grep' || toolName === 'Glob' || toolName === 'WebSearch' || toolName === 'WebFetch') {
    kind = 'search';
    persistCompletion = true;
  } else if (toolName === 'Read') {
    kind = 'read';
  } else if (toolName === 'Bash') {
    kind = 'execute';
  } else if (toolName === 'Agent') {
    kind = 'subagent';
  }

  return {
    description,
    completionDescription: TOOL_COMPLETION_LABELS[toolName] ?? description,
    kind,
    persistCompletion,
  };
}

/**
 * Pull the active model's real context window from the result's `modelUsage`
 * map (`Record<modelId, { contextWindow }>`). Prefer the requested model's
 * entry; otherwise take the largest window (the primary model dominates any
 * sub-agent models). Returns null when nothing reports a window.
 */
function pickContextWindow(modelUsage: unknown, model: string | undefined): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const entries = Object.entries(modelUsage as Record<string, { contextWindow?: number }>);
  if (model) {
    const exact = (modelUsage as Record<string, { contextWindow?: number }>)[model]?.contextWindow;
    if (typeof exact === 'number' && exact > 0) return exact;
  }
  let max: number | null = null;
  for (const [, v] of entries) {
    if (typeof v?.contextWindow === 'number' && v.contextWindow > 0 && (max === null || v.contextWindow > max)) {
      max = v.contextWindow;
    }
  }
  return max;
}

/**
 * Pick the model that did the bulk of the work this turn from `modelUsage`
 * (`Record<modelId, { inputTokens, outputTokens }>`) — the key with the most
 * input+output tokens. A single-model turn has one key; multi-model turns
 * (e.g. a sub-agent on a cheaper model) resolve to the dominant one. Null when
 * no usable entry exists. Used only for telemetry attribution.
 */
function pickModel(modelUsage: unknown): string | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const entries = Object.entries(modelUsage as Record<string, { inputTokens?: number; outputTokens?: number }>);
  let best: string | null = null;
  let bestTokens = -1;
  for (const [id, v] of entries) {
    const t = (v?.inputTokens ?? 0) + (v?.outputTokens ?? 0);
    if (t > bestTokens) { bestTokens = t; best = id; }
  }
  return best;
}

/**
 * Build a `canUseTool` callback that bridges the built-in AskUserQuestion tool
 * to an interactive resolver (e.g. a Telegram inline keyboard).
 *
 * The headless SDK has no UI to collect an answer, so an allowed AskUserQuestion
 * auto-resolves to "The user did not answer the questions." To inject the real
 * choice we intercept here, await the resolver, then DENY the tool with the
 * answer as the message — the model reads that message as the tool result and
 * proceeds. This is the documented limitation of the permission channel (it
 * carries no success-result path); the deny payload is the pragmatic bridge.
 *
 * All other tools are allowed unchanged, preserving bypassPermissions behavior.
 */
function buildAskUserQuestionCanUseTool(input: AgentTurnInput) {
  const resolver = input.onAskUserQuestion;
  if (!resolver) return undefined;
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    if (toolName !== 'AskUserQuestion') {
      return { behavior: 'allow', updatedInput: toolInput };
    }
    try {
      const request = toolInput as unknown as AskUserQuestionRequest;
      const answer = await resolver(request);
      if (!answer) {
        return { behavior: 'deny', message: 'The user did not answer the questions.' };
      }
      const answered = answer.answers.filter((a) => a.selected.length > 0);
      const parts: string[] = [];
      if (answered.length > 0) {
        parts.push(
          'The user answered your AskUserQuestion via the Telegram inline keyboard. ' +
            'Treat the following selections as the answer (this is NOT an error):',
        );
        for (const a of answered) parts.push(`- ${a.header || a.question}: ${a.selected.join(', ')}`);
      }
      if (answer.directive) parts.push(answer.directive);
      if (parts.length === 0) {
        return { behavior: 'deny', message: 'The user did not answer the questions.' };
      }
      return { behavior: 'deny', message: parts.join('\n') };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'AskUserQuestion resolver failed; reporting unanswered',
      );
      return { behavior: 'deny', message: 'The user did not answer the questions.' };
    }
  };
}

async function* singleTurn(text: string, sessionId?: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  };
}

export class ClaudeSdkEngineAdapter implements AgentEngine {
  async *invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent> {
    const firstAttempt = { unresumableSession: false };
    yield* this.runTurn(input, firstAttempt);
    if (firstAttempt.unresumableSession) {
      logger.warn(
        { sessionId: input.sessionId },
        'Saved session not found on resume; rerunning the turn on a fresh session',
      );
      yield* this.runTurn({ ...input, sessionId: undefined }, null);
    }
  }

  /**
   * One SDK query attempt. `resumeRecovery` is non-null only on the first
   * attempt of a resumed turn: when the CLI reports the saved session as
   * missing, the attempt is abandoned (no usage/result yielded), the flag is
   * set, and `invoke` reruns the turn on a fresh session. The rerun passes
   * null so any second failure surfaces normally.
   */
  private async *runTurn(
    input: AgentTurnInput,
    resumeRecovery: { unresumableSession: boolean } | null,
  ): AsyncIterable<AgentEngineEvent> {
    let didCompact = false;
    let preCompactTokens: number | null = null;
    let lastCallCacheRead = 0;
    let lastCallCacheCreation = 0;
    let lastCallInputTokens = 0;
    let streamedText = '';
    // A turn is many assistant messages (text, tool_use, tool_result, more
    // text…). The SDK emits a fresh `message_start` per message, but the bot's
    // stream throttle tracks ONE monotonically growing accumulator per turn, so
    // resetting here made every post-first-tool message arrive with a shrinking
    // length that the bot read as a negative delta and dropped — text only
    // reappeared in the final result. Instead we accumulate across the whole
    // turn and mark a paragraph break at each new message so `accumulatedText`
    // grows monotonically and mirrors the final `turnTextBlocks.join('\n\n')`.
    let pendingStreamSeparator = false;
    let emittedResult = false;
    // Accumulate every top-level assistant text block across the turn. The SDK's
    // final `result` field only carries the LAST assistant text block, so a turn
    // shaped `text → tool_use → short text` (e.g. "Logged to hive mind.") would
    // truncate to that trailing fragment and drop the real answer. Joining all
    // top-level text blocks reconstructs the full response. Subagent text is
    // excluded (parent_tool_use_id != null) so it never leaks into the reply.
    const turnTextBlocks: string[] = [];
    const activeTools = new Map<string, ClaudeToolActivity>();

    // SDK 0.3.x requires `allowDangerouslySkipPermissions: true` whenever
    // `permissionMode` is 'bypassPermissions'. Resolve the mode first, then default
    // the flag to true for the bypass path when the caller didn't specify one — this
    // preserves prior bypass behavior and keeps the adapter's own default self-consistent.
    // An explicit `false` from the caller is respected (?? only fills nullish values).
    const permissionMode = input.permissionMode ?? 'bypassPermissions';
    const allowDangerouslySkipPermissions =
      input.allowDangerouslySkipPermissions ??
      (permissionMode === 'bypassPermissions' ? true : undefined);

    // Only wired when the host supplies an AskUserQuestion resolver (the
    // Telegram interactive path). Other paths leave it undefined, so their
    // tool handling is unchanged.
    const canUseTool = buildAskUserQuestionCanUseTool(input);

    // Armed only on the first attempt of a resumed turn (see SESSION_NOT_FOUND_RE).
    const watchResume = resumeRecovery !== null && !!input.sessionId;
    let sawSessionNotFound = false;
    const stderrHook = (data: string) => {
      if (watchResume && SESSION_NOT_FOUND_RE.test(data)) sawSessionNotFound = true;
      relayStderr(data);
    };

    try {
      for await (const event of query({
        prompt: singleTurn(input.prompt, input.sessionId),
        options: {
          cwd: input.cwd,
          resume: input.sessionId,
          settingSources: input.settingSources ?? ['project', 'user'],
          // Plain string system prompt (no claude_code preset). Stable persona
          // plus the resolved per-turn runtime identity are present every turn
          // and survive compaction.
          ...(composeSystemPrompt(input.systemPrompt, input.runtimeIdentity)
            ? { systemPrompt: composeSystemPrompt(input.systemPrompt, input.runtimeIdentity) }
            : {}),
          permissionMode,
          ...(allowDangerouslySkipPermissions !== undefined
            ? { allowDangerouslySkipPermissions }
            : {}),
          ...(canUseTool ? { canUseTool } : {}),
          ...(input.maxTurns && input.maxTurns > 0 ? { maxTurns: input.maxTurns } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.mcpServers && Object.keys(input.mcpServers).length ? { mcpServers: input.mcpServers } : {}),
          ...(input.includePartialMessages ? { includePartialMessages: true } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
          ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
          ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
          ...(input.abortController ? { abortController: input.abortController } : {}),
          ...(CLAUDE_EXECUTABLE_OVERRIDE ? { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE_OVERRIDE } : {}),
          stderr: stderrHook,
          // TODO(#72): the SDK Options type (@anthropic-ai/claude-agent-sdk) lags
          // some fields we pass conditionally (effort, thinking, model overrides),
          // so the whole object is cast. Narrow to the SDK Options type and cast
          // only the lagging fields once they're typed upstream.
        } as any,
      })) {
      const ev = event as Record<string, unknown>;

      if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
        yield { type: 'session', sessionId: ev.session_id, raw: ev };
      }

      if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
        didCompact = true;
        const meta = ev.compact_metadata as { trigger?: string; pre_tokens?: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        yield { type: 'compact', preCompactTokens, trigger: meta?.trigger, raw: ev };
      }

      if (ev.type === 'assistant') {
        const msg = ev.message as Record<string, unknown> | undefined;
        const msgUsage = msg?.usage as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.cache_read_input_tokens ?? 0;
        const callCacheCreation = msgUsage?.cache_creation_input_tokens ?? 0;
        const callInputTokens = msgUsage?.input_tokens ?? 0;
        if (callCacheRead > 0) lastCallCacheRead = callCacheRead;
        if (callCacheCreation > 0) lastCallCacheCreation = callCacheCreation;
        if (callInputTokens > 0) lastCallInputTokens = callInputTokens;

        const content = msg?.content as Array<{ type: string; id?: string; name?: string; text?: string }> | undefined;
        if (Array.isArray(content)) {
          // Only collect text from top-level assistant messages; subagent
          // output (parent_tool_use_id set) must not bleed into the reply.
          if (ev.parent_tool_use_id == null) {
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                turnTextBlocks.push(block.text);
              }
            }
          }
          for (const block of content) {
            if (block.type === 'tool_use' && block.name) {
              // When AskUserQuestion is handled interactively (the keyboard is
              // the surface), skip the redundant "User question..." tool label.
              if (block.name === 'AskUserQuestion' && input.onAskUserQuestion) continue;
              const activity = toolActivity(block.name);
              if (block.id) activeTools.set(block.id, activity);
              yield {
                type: 'progress',
                progress: {
                  type: 'tool_active',
                  description: activity.description,
                  kind: activity.kind,
                  toolCallId: block.id,
                },
                raw: ev,
              };
            }
          }
        }
      }

      if (ev.type === 'user') {
        const msg = ev.message as Record<string, unknown> | undefined;
        const content = msg?.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;
            const activity = activeTools.get(block.tool_use_id);
            activeTools.delete(block.tool_use_id);
            if (!activity) continue;
            // Sub-agent lifecycle has richer task_started/task_progress/task_notification
            // events. Routine reads and successful shell commands remain transient.
            if (activity.kind === 'subagent') continue;
            if (!activity.persistCompletion && block.is_error !== true) continue;
            yield {
              type: 'progress',
              progress: {
                type: 'task_completed',
                description: activity.completionDescription,
                status: block.is_error === true ? 'failed' : 'completed',
                kind: activity.kind,
                toolCallId: block.tool_use_id,
              },
              raw: ev,
            };
          }
        }
      }

      if (ev.type === 'system' && ev.subtype === 'task_started') {
        yield {
          type: 'progress',
          progress: {
            type: 'task_started',
            description: (ev.description as string) ?? 'Sub-agent started',
            kind: 'subagent',
            toolCallId: ev.task_id as string,
          },
          raw: ev,
        };
      }

      if (ev.type === 'system' && ev.subtype === 'task_progress') {
        const description = (ev.summary as string) || (ev.description as string) || 'Sub-agent working';
        yield {
          type: 'progress',
          progress: {
            type: 'tool_active',
            description,
            kind: 'subagent',
            toolCallId: ev.task_id as string,
          },
          raw: ev,
        };
      }

      if (ev.type === 'system' && ev.subtype === 'task_notification') {
        const summary = (ev.summary as string) ?? 'Sub-agent finished';
        const status = (ev.status as string) ?? 'completed';
        yield {
          type: 'progress',
          progress: {
            type: 'task_completed',
            description: status === 'failed' ? `Failed: ${summary}` : summary,
            status,
            kind: 'subagent',
            toolCallId: ev.task_id as string,
          },
          raw: ev,
        };
      }

      if (ev.type === 'stream_event' && ev.parent_tool_use_id === null) {
        const streamEvent = ev.event as Record<string, unknown> | undefined;
        // Don't reset on a new message — defer a paragraph break until the next
        // text actually arrives, so a message that emits only tool calls adds no
        // stray separator.
        if (streamEvent?.type === 'message_start' && streamedText) pendingStreamSeparator = true;
        if (streamEvent?.type === 'content_block_delta') {
          const delta = streamEvent.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            const separator = pendingStreamSeparator ? '\n\n' : '';
            pendingStreamSeparator = false;
            streamedText += separator + delta.text;
            yield { type: 'text_delta', delta: separator + delta.text, accumulatedText: streamedText, raw: ev };
          }
        }
      }

      if (ev.type === 'result') {
        // The resume target does not exist in this cwd's project directory.
        // Abandon the attempt without yielding usage or a result — invoke()
        // reruns the turn on a fresh session.
        if (resumeRecovery && sawSessionNotFound && ev.is_error === true) {
          resumeRecovery.unresumableSession = true;
          return;
        }

        // Prefer the full assembled turn text over the SDK's `result` field,
        // which only holds the final assistant text block. Fall back to
        // `ev.result` when no top-level text was captured.
        const assembledText = turnTextBlocks.join('\n\n').trim();
        const sdkResult = (ev.result as string | null | undefined) ?? null;
        const resultText = assembledText || sdkResult;

        // An unauthenticated Claude CLI does NOT throw — it returns a result
        // with is_error:true and text like "Not logged in · Please run /login"
        // (verified locally), then exits 1. Without this, that text either gets
        // surfaced as a normal assistant reply or (on SDKs that throw a bare
        // "exited with code 1") loops on subprocess_crash. Raise a proper auth
        // error (no retry, deploy-aware message) at the source. (#48)
        if (ev.is_error === true && typeof resultText === 'string' && isAuthErrorText(resultText)) {
          throw authError();
        }

        const evUsage = ev.usage as Record<string, number> | undefined;
        const usage = evUsage ? {
          inputTokens: evUsage.input_tokens ?? 0,
          outputTokens: evUsage.output_tokens ?? 0,
          cacheReadInputTokens: evUsage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: evUsage.cache_creation_input_tokens ?? 0,
          totalCostUsd: (ev.total_cost_usd as number) ?? 0,
          didCompact,
          preCompactTokens,
          lastCallCacheRead,
          lastCallCacheCreation,
          lastCallInputTokens,
          contextWindow: pickContextWindow(ev.modelUsage, input.model),
          model: pickModel(ev.modelUsage) ?? input.model ?? null,
          durationMs: (ev.duration_ms as number) ?? 0,
          durationApiMs: (ev.duration_api_ms as number) ?? 0,
          numTurns: (ev.num_turns as number) ?? 0,
          stopReasonDetail: (typeof ev.stop_reason === 'string' ? ev.stop_reason : null),
          isError: ev.is_error === true,
        } : null;
        if (usage) yield { type: 'usage', usage, raw: ev };
        yield {
          type: 'result',
          text: resultText,
          usage,
          stopReason: typeof ev.subtype === 'string' ? ev.subtype : undefined,
          raw: ev,
        };
        emittedResult = true;
      }
      }
    } catch (err) {
      if (resumeRecovery?.unresumableSession) {
        // Teardown of the abandoned resume attempt: the SDK may rethrow the
        // "No conversation found" error once iteration stops. Swallow it —
        // invoke() is about to rerun the turn on a fresh session.
        return;
      }
      if (emittedResult) {
        logger.warn(
          { err: err instanceof Error ? err.message : err },
          'Claude SDK process errored after final result; keeping completed turn',
        );
        return;
      }
      throw err;
    }
  }
}
