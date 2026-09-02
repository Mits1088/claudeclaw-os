// ── AskUserQuestion → Mattermost numbered-reply bridge ─────────────────────────
// Mattermost has no inline keyboards (unlike Telegram's callback_query wizard),
// so the built-in AskUserQuestion tool is bridged as a Markdown text stepper:
// each question is posted with numbered options, and the user's NEXT message in
// that channel is captured as the answer. The agent engine intercepts the tool
// call and invokes the resolver built by makeMattermostAskUserQuestionResolver();
// mattermost-bot's onMessage routes the reply in via feedPendingMattermostQuestion()
// instead of starting a new agent turn.
//
// Self-contained (no dependency on the Signal bridge) so it can travel upstream
// as a standalone Mattermost contribution.
import type {
  AskUserQuestionRequest,
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  AskUserQuestionResolver,
} from './agent-engine/index.js';
import { logger } from './logger.js';

const AUQ_TIMEOUT_MS = 10 * 60 * 1000; // 10 min to reply before giving up

const PROCEED_DIRECTIVE =
  'The user has ended the clarifying-question flow and wants you to proceed. ' +
  'Use any answers gathered so far plus your best judgment. Do NOT open further ' +
  'AskUserQuestion prompts for the rest of this turn. If meaningful ambiguity ' +
  'remains, continue with reasonable assumptions, then at the end briefly ' +
  'summarize what you did and ask in plain text whether they want to change ' +
  'anything or take a different direction.';

interface PendingReply {
  resolve: (text: string | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// One in-flight free-text wait per channel. A new wait supersedes any prior one.
const pendingByChannel = new Map<string, PendingReply>();

/** True if an AskUserQuestion in this channel is awaiting the user's reply. */
export function hasPendingMattermostQuestion(channelId: string): boolean {
  return pendingByChannel.has(channelId);
}

/**
 * Route an inbound message to a waiting question. Returns true if it was
 * consumed as an answer (caller must then NOT start a new agent turn).
 */
export function feedPendingMattermostQuestion(channelId: string, text: string): boolean {
  const p = pendingByChannel.get(channelId);
  if (!p) return false;
  clearTimeout(p.timeout);
  pendingByChannel.delete(channelId);
  p.resolve(text);
  return true;
}

function waitForReply(channelId: string, abortController?: AbortController): Promise<string | null> {
  const prior = pendingByChannel.get(channelId);
  if (prior) {
    clearTimeout(prior.timeout);
    pendingByChannel.delete(channelId);
    prior.resolve(null);
  }
  return new Promise<string | null>((resolve) => {
    if (abortController?.signal.aborted) {
      resolve(null);
      return;
    }
    const timeout = setTimeout(() => {
      if (pendingByChannel.get(channelId) === entry) pendingByChannel.delete(channelId);
      resolve(null);
    }, AUQ_TIMEOUT_MS);
    const entry: PendingReply = { resolve, timeout };
    pendingByChannel.set(channelId, entry);
    abortController?.signal.addEventListener(
      'abort',
      () => {
        if (pendingByChannel.get(channelId) === entry) {
          clearTimeout(timeout);
          pendingByChannel.delete(channelId);
          resolve(null);
        }
      },
      { once: true },
    );
  });
}

/** Render one question with numbered options + reply hint. Mattermost Markdown. */
export function renderQuestion(q: AskUserQuestionItem, idx: number, total: number): string {
  const prefix = total > 1 ? `(${idx + 1}/${total}) ` : '';
  const lines = [`❓ **${prefix}${q.question}**`];
  q.options.forEach((opt, i) => {
    lines.push(`  **${i + 1}.** ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
  });
  lines.push('');
  const multi = q.multiSelect ? ' (mehrere mit Komma, z.B. `1,3`)' : '';
  lines.push(
    `↳ Antworte mit der Nummer${multi}, eigenem Text, \`go\` (mit bisherigen Antworten weitermachen) oder \`stop\` (abbrechen).`,
  );
  return lines.join('\n');
}

export type ParsedReply =
  | { control: 'stop' }
  | { control: 'go' }
  | { selected: string[] };

/** Parse a free-text reply into selected option labels or a control action. */
export function parseReply(reply: string, q: AskUserQuestionItem): ParsedReply {
  const t = reply.trim();
  const lower = t.toLowerCase();
  if (lower === 'stop' || lower === '/stop' || lower === 'abbrechen' || lower === 'cancel') {
    return { control: 'stop' };
  }
  if (lower === 'go' || lower === 'weiter' || lower === 'proceed' || lower === 'los') {
    return { control: 'go' };
  }
  const tokens = t.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const allNumeric = tokens.length > 0 && tokens.every((n) => /^\d+$/.test(n));
  if (allNumeric) {
    const picked = tokens
      .map((n) => parseInt(n, 10) - 1)
      .filter((i) => i >= 0 && i < q.options.length)
      .map((i) => q.options[i].label);
    if (picked.length > 0) return { selected: q.multiSelect ? picked : [picked[0]] };
  }
  return { selected: [t] };
}

/**
 * Build the resolver handed to the agent for one Mattermost channel. Walks the
 * questions one at a time, posting each as numbered Markdown and awaiting the
 * user's reply. "stop" aborts the turn; "go" proceeds with the proceed
 * directive; a timeout returns whatever was gathered (or null if nothing).
 */
export function makeMattermostAskUserQuestionResolver(
  channelId: string,
  sendMessage: (channelId: string, text: string) => Promise<void>,
  abortController?: AbortController,
): AskUserQuestionResolver {
  let stopAsking = false;
  return async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer | null> => {
    if (abortController?.signal.aborted) return null;
    if (stopAsking) return { answers: [], directive: PROCEED_DIRECTIVE };

    const total = request.questions.length;
    const answers: AskUserQuestionAnswerItem[] = [];

    for (let i = 0; i < total; i++) {
      const q = request.questions[i];
      try {
        await sendMessage(channelId, renderQuestion(q, i, total));
      } catch (err) {
        logger.warn({ err }, 'Failed to post AskUserQuestion to Mattermost');
        return answers.length ? { answers } : null;
      }

      const reply = await waitForReply(channelId, abortController);
      if (reply === null) {
        if (!abortController?.signal.aborted) {
          await sendMessage(channelId, '⏳ Keine Antwort — ich mache mit meiner besten Einschätzung weiter.').catch(() => {});
        }
        return answers.length ? { answers } : null;
      }

      const parsed = parseReply(reply, q);
      if ('control' in parsed && parsed.control === 'stop') {
        await sendMessage(channelId, '✖ Abgebrochen.').catch(() => {});
        abortController?.abort();
        return null;
      }
      if ('control' in parsed && parsed.control === 'go') {
        stopAsking = true;
        return { answers, directive: PROCEED_DIRECTIVE };
      }
      answers.push({ header: q.header, question: q.question, selected: (parsed as { selected: string[] }).selected });
    }

    return { answers };
  };
}
