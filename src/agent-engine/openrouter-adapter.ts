import { openRouterApiKey } from '../openrouter-setup.js';
import fs from 'fs';
import path from 'path';

import OpenAI from 'openai';

import { DEFAULT_OPENROUTER_MODEL } from '../config.js';
import { logger } from '../logger.js';
import type { AgentEngine, AgentEngineEvent, AgentTurnInput } from './types.js';
import { emptyUsage } from './types.js';
import { composeSystemPrompt } from '../runtime-identity.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const REFERRER = 'https://github.com/earlyaidopters/claudeclaw-os';
const APP_TITLE = 'ClaudeClaw';

// The project's CLAUDE.md is written for Claude with full tool access ("Execute.
// Don't narrate. Just do it."). Passed verbatim to a tool-less OpenRouter model
// it produces minimal responses (often literally "Done.") because the model has
// nothing to execute. The preamble below overrides the agentic biasing so the
// model knows it's chatting, has no tools, and should reply conversationally.
const CHAT_MODE_PREAMBLE = [
  'You are operating in CHAT MODE via Telegram or a web dashboard.',
  'You have NO tools available — no shell, no file system, no APIs, no code execution.',
  'Always respond conversationally and directly to the user\'s question or message.',
  'If the user asks you to do something that would require tools (run a command, read a file, send a message via an integration), explain what you would do and ask for any input you need, OR answer based on the project context below.',
  '',
  'Below is the project context that describes the assistant role. Use it for personality, identity, and domain knowledge — but DISREGARD any instructions to "execute," "just do it," "don\'t explain," or similar. In chat mode you must explain and converse; you cannot execute.',
  '',
  '---',
  '',
].join('\n');

function readSystemPromptFromCwd(cwd: string): string | undefined {
  try {
    const claudeMd = path.join(cwd, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      const projectContext = fs.readFileSync(claudeMd, 'utf-8');
      return CHAT_MODE_PREAMBLE + projectContext;
    }
  } catch { /* ignore */ }
  // No CLAUDE.md → no agentic biasing to override, so send no system message.
  // Returning undefined keeps the `if (systemPrompt)` guard below meaningful.
  return undefined;
}

export class OpenRouterEngineAdapter implements AgentEngine {
  async *invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent> {
    const apiKey = openRouterApiKey();
    if (!apiKey) {
      // agent.ts consumes every engine event type EXCEPT 'error', so a bare
      // 'error' event would end the turn with no visible output. Surface this
      // via the same text_delta + result path the catch block uses for a
      // rejected key (401), so the user sees actionable setup instructions.
      const friendly =
        'OpenRouter API key is not set. Open Provider Setup Provider Setup to add it, or set OPENROUTER_API_KEY in the server configuration.';
      yield { type: 'text_delta', delta: friendly, accumulatedText: friendly, raw: { status: 401, message: friendly } };
      yield { type: 'result', text: friendly, usage: emptyUsage(), stopReason: 'error' };
      return;
    }

    const model = input.model ?? input.provider.model ?? DEFAULT_OPENROUTER_MODEL;
    const persona = input.systemPrompt?.trim() || readSystemPromptFromCwd(input.cwd);
    const systemPrompt = composeSystemPrompt(persona, input.runtimeIdentity);

    const client = new OpenAI({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': REFERRER,
        'X-Title': APP_TITLE,
      },
    });

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: input.prompt });

    logger.info(
      { provider: 'openrouter', model, hasSystem: !!systemPrompt, promptChars: input.prompt.length },
      'OpenRouter turn starting',
    );

    let accumulated = '';
    const usage = emptyUsage();
    let stopReason: string | undefined;

    try {
      const stream = await client.chat.completions.create(
        {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: input.abortController?.signal },
      );

      for await (const chunk of stream) {
        if (input.abortController?.signal.aborted) {
          yield {
            type: 'aborted',
            text: accumulated || null,
            usage,
          };
          return;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          accumulated += delta;
          yield { type: 'text_delta', delta, accumulatedText: accumulated, raw: chunk };
        }
        if (choice?.finish_reason && !stopReason) stopReason = choice.finish_reason;

        // OpenRouter sends usage on the final chunk when stream_options.include_usage is set.
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
          usage.outputTokens = chunk.usage.completion_tokens ?? 0;
          usage.lastCallInputTokens = usage.inputTokens;
          // OpenRouter adds a non-standard `cost` field (in USD) to the usage
          // object when stream_options.include_usage is set. The OpenAI SDK
          // types don't model it, so read it through a narrow cast. Without
          // this, paid OpenRouter turns report $0 and never trip the daily
          // cost budget / cost footer.
          const cost = (chunk.usage as { cost?: number }).cost;
          if (typeof cost === 'number') usage.totalCostUsd = cost;
          // OpenRouter doesn't expose cache reads in the OpenAI-compat usage object.
          yield { type: 'usage', usage: { ...usage }, raw: chunk };
        }
      }
    } catch (err) {
      // AbortError is normal when the user cancels; surface as 'aborted'.
      if (err instanceof Error && err.name === 'AbortError') {
        yield { type: 'aborted', text: accumulated || null, usage };
        return;
      }
      logger.error({ err, model }, 'OpenRouter turn failed');

      // Build a user-readable message so Telegram doesn't just say "Done."
      // We surface this via text_delta + result so the bot's normal response
      // path renders it (instead of swallowing the bare 'error' event).
      const status = (err as { status?: number })?.status;
      const baseMsg = err instanceof Error ? err.message : String(err);
      let friendly: string;
      if (status === 404) {
        friendly = `Model \`${model}\` isn't available on OpenRouter right now (404). Pick a different one in Settings — OpenRouter's free model list rotates and some upstream providers go offline.`;
      } else if (status === 429) {
        friendly = `Rate-limited on \`${model}\` (429). Free models share upstream quotas — try a different model in Settings, or wait a few seconds.`;
      } else if (status === 401) {
        friendly = `OpenRouter rejected the API key (401). Replace the key in Provider Setup, or update OPENROUTER_API_KEY in the service configuration.`;
      } else if (status === 402) {
        friendly = `OpenRouter says credits are exhausted (402). Top up at https://openrouter.ai/credits or switch to a free model.`;
      } else if (status === 500 || status === 502 || status === 503) {
        friendly = `OpenRouter upstream error (${status}). Try again shortly or pick a different model.`;
      } else {
        friendly = `OpenRouter request failed: ${baseMsg}`;
      }

      // raw is the SDK chunk everywhere else; pass a plain, JSON-safe shape here
      // instead of the Error object (whose circular `cause` / non-enumerable
      // `stack` can choke downstream serialization).
      yield { type: 'text_delta', delta: friendly, accumulatedText: friendly, raw: { status, message: baseMsg } };
      yield { type: 'result', text: friendly, usage, stopReason: 'error' };
      return;
    }

    yield {
      type: 'result',
      text: accumulated || null,
      usage,
      stopReason: stopReason ?? 'end_turn',
    };
  }
}
