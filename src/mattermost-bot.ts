import fs from 'fs';
import path from 'path';

import { runAgentWithRetry, AgentProgressEvent } from './agent.js';
import { AgentError } from './errors.js';
import { chatToolProfileFor } from './chat-tool-policy.js';
import type { ProviderConfig } from './provider.js';
import { defaultModelForProvider, getSelectedProviderConfig } from './active-provider.js';
import { updateAgentProvider } from './config.js';
import { loadAgentConfig } from './agent-config.js';
import {
  AGENT_ID,
  AGENT_TIMEOUT_MS,
  DASHBOARD_PORT,
  DASHBOARD_TOKEN,
  DASHBOARD_URL,
  EXFILTRATION_GUARD_ENABLED,
  MODEL_FALLBACK_CHAIN,
  PROJECT_ROOT,
  PROTECTED_ENV_VARS,
  SHOW_COST_FOOTER,
  SMART_ROUTING_CHEAP_MODEL,
  SMART_ROUTING_ENABLED,
  CLAUDE_MODEL_OPUS,
  CLAUDE_MODEL_SONNET,
  CLAUDE_MODEL_HAIKU,
  agentDefaultModel,
  agentMcpAllowlist,
  agentSystemPrompt,
} from './config.js';
import {
  MATTERMOST_ALLOWED_FILE_TYPES,
  MATTERMOST_CHANNEL_AGENT_MAP,
  MATTERMOST_DEFAULT_AGENT,
  MATTERMOST_MAX_FILES,
  MATTERMOST_MAX_FILE_MB,
  MATTERMOST_MENTION_ONLY_CHANNELS,
  MATTERMOST_OWNER_USER,
  MATTERMOST_TEAM,
  MATTERMOST_TOKEN,
  MATTERMOST_URL,
  assertOwnerConfigured,
  ownsChannel,
} from './mattermost-config.js';
// Config-driven model registry. Aliased to keep the call sites compact.
const LATEST_OPUS_MODEL = CLAUDE_MODEL_OPUS;
const LATEST_SONNET_MODEL = CLAUDE_MODEL_SONNET;
const LATEST_HAIKU_MODEL = CLAUDE_MODEL_HAIKU;
import { buildCostFooter } from './cost-footer.js';
import {
  clearSession,
  getRecentMemories,
  getRecentTaskOutputs,
  getSession,
  pinMemory,
  saveTokenUsage,
  setSession,
  unpinMemory,
} from './db.js';
import { scanForSecrets, redactSecrets } from './exfiltration-guard.js';
import { logger } from './logger.js';
import {
  MEMORY_NUDGE_TEXT,
  buildMemoryContext,
  evaluateMemoryRelevance,
  saveConversationTurn,
  shouldNudgeMemory,
} from './memory.js';
import { classifyMessageComplexity } from './message-classifier.js';
import { messageQueue } from './message-queue.js';
import { delegateToAgent, parseDelegation } from './orchestrator.js';
import {
  MattermostIncomingMessage,
  MattermostFileInfo,
  MattermostRpcClient,
} from './mattermost-rpc.js';
import { buildPhotoMessage, buildDocumentMessage, buildMediaGroupMessage, UPLOADS_DIR } from './media.js';
import {
  makeMattermostAskUserQuestionResolver,
  feedPendingMattermostQuestion,
} from './mattermost-askuserquestion.js';
import {
  audit,
  checkKillPhrase,
  executeEmergencyKill,
  getSecurityStatus,
  isLocked,
  lock,
  touchActivity,
  unlock,
} from './security.js';
import { emitChatEvent, setActiveAbort, setProcessing } from './state.js';

// Mattermost has a generous post length (default ~16k chars). Split very long
// replies for readability, but the limit is far above Signal/Telegram.
const MATTERMOST_MAX_MESSAGE_LENGTH = 16_000;

// Typing indicators expire after ~3-5s; repeat while the agent works.
const MATTERMOST_TYPING_REFRESH_MS = 2_500;

const chatModelOverride = new Map<string, string>();

const AVAILABLE_MODELS: Record<string, string> = {
  opus: LATEST_OPUS_MODEL,
  sonnet: LATEST_SONNET_MODEL,
  haiku: LATEST_HAIKU_MODEL,
};

/**
 * Mattermost renders Markdown natively (unlike Signal, which needs HTML/Markdown
 * stripped). So formatting is a near-passthrough — we only normalise excessive
 * blank lines. Telegram-style <b>/<pre> would be wrong here; the agent already
 * emits Markdown, which Mattermost displays correctly.
 */
export function formatForMattermost(text: string): string {
  // Mattermost renders Markdown natively and the agent emits Markdown, so this
  // is mostly a passthrough. The one exception is the scheduler/status path,
  // which hands us the limited Telegram HTML subset (formatForTelegram) — convert
  // those tags back to Markdown so they don't render as literal <b>/<pre>.
  let out = text
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/gi, '[$2]($1)')
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, (_m, c: string) => '```\n' + c + '\n```')
    .replace(/<\/?(?:b|strong)>/gi, '**')
    .replace(/<\/?(?:i|em)>/gi, '*')
    .replace(/<\/?code>/gi, '`')
    .replace(/<[^>]+>/g, ''); // strip any remaining tags
  // Unescape the HTML entities formatForTelegram emits (&amp; last).
  out = out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return out.replace(/\n{4,}/g, '\n\n\n').trimEnd();
}

/** Split a very long response so a single post doesn't get truncated. */
export function splitMessage(text: string): string[] {
  if (text.length <= MATTERMOST_MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > MATTERMOST_MAX_MESSAGE_LENGTH) {
    const chunk = remaining.slice(0, MATTERMOST_MAX_MESSAGE_LENGTH);
    const lastNewline = chunk.lastIndexOf('\n');
    const splitAt = lastNewline > MATTERMOST_MAX_MESSAGE_LENGTH / 2 ? lastNewline : MATTERMOST_MAX_MESSAGE_LENGTH;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

interface FileMarker {
  type: 'document' | 'photo';
  filePath: string;
  caption?: string;
}

/** Extract [SEND_FILE:...] and [SEND_PHOTO:...] markers. Same shape as bot.ts/signal-bot.ts. */
export function extractFileMarkers(text: string): { text: string; files: FileMarker[] } {
  const files: FileMarker[] = [];
  const pattern = /\[SEND_(FILE|PHOTO):([^\]\|]+)(?:\|([^\]]*))?\]/g;
  const cleaned = text.replace(pattern, (_, kind: string, filePath: string, caption?: string) => {
    files.push({
      type: kind === 'PHOTO' ? 'photo' : 'document',
      filePath: filePath.trim(),
      caption: caption?.trim() || undefined,
    });
    return '';
  });
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), files };
}

/**
 * The `/help` body. Pure + exported so the command list — including the
 * multi-agent fan-out commands, which otherwise stay invisible — is testable
 * and can't silently drift out of sync with the handled commands.
 */
export function buildMattermostHelpText(): string {
  return (
    '**ClaudeClaw — Commands (Mattermost)**\n\n' +
    '`/newchat` — Start a new Claude session\n' +
    '`/forget` — Clear session\n' +
    '`/memory` — View recent memories\n' +
    '`/pin <id>` / `/unpin <id>` — Pin/unpin a memory\n' +
    '`/model <opus|sonnet|haiku>` — Switch model\n' +
    '`/agents` — List available agents\n' +
    '`/delegate <agent> <prompt>` — Delegate to one agent\n' +
    '`/await <agent,agent,…> <prompt>` — Fan out to agents, wait for one combined answer\n' +
    '`/gather <agent,agent,…> <prompt>` — Fan out to agents, get pinged with a summary when all finish\n' +
    '`/dashboard` — Get dashboard link (DM only)\n' +
    '`/lock` / `/status` — Security\n' +
    '`/stop` — Stop current processing\n\n' +
    'Everything else goes straight to Claude.'
  );
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tiff', 'tif', 'svg']);

/**
 * True if an attachment is an image (→ Vision / buildPhotoMessage) rather than a
 * document (→ buildDocumentMessage). Prefers the metadata `extension`; falls back
 * to the filename's extension. Unknown/extensionless files default to document.
 */
/**
 * Single-operator gate, pure so it is unit-testable: does this inbound message
 * come from the owner's CANONICAL 26-char user ID? The configured
 * MATTERMOST_OWNER_USER (username or id) is resolved to that ID once at boot
 * (resolveUserWithRetry); authorization then compares userId ONLY — a display
 * name or username can never authorize. Everything else is rejected before
 * routing, state, attachments, commands, or tools — Business OS runs on the
 * owner's personal provider credentials.
 */
export function isOwnerMessage(
  msg: { userId: string },
  ownerUserId: string,
): boolean {
  if (!ownerUserId) return false; // unresolved owner rejects everyone (fail-closed)
  return msg.userId === ownerUserId;
}

/**
 * Team boundary for channel messages, pure so it is unit-testable. The bot
 * resolves its configured team at boot and ignores every event from another
 * team (a bot invited elsewhere must not widen the gateway). Direct messages
 * carry no team_id and stay allowed; a CHANNEL event without a team_id fails
 * closed.
 */
export function passesTeamBoundary(
  msg: { channelType?: string; teamId?: string },
  teamBoundaryId: string,
): boolean {
  if (msg.channelType === 'D') return true;
  if (!teamBoundaryId) return false; // unresolved boundary rejects channel events
  return msg.teamId === teamBoundaryId;
}

export function isImageAttachment(file: MattermostFileInfo): boolean {
  const ext = (file.extension ?? file.name?.split('.').pop() ?? '').toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export interface SavedAttachment { path: string; name: string; isImage: boolean }

/**
 * Pure attachment-bounds decision (count + extension), so the inbound Vision
 * path is unit-testable. Size is checked after download (REST gives no
 * reliable Content-Length up front) — see handleAttachments.
 */
export function filterInboundFiles(
  files: MattermostFileInfo[],
  opts: { maxFiles: number; allowedExtensions: string[] },
): { accepted: MattermostFileInfo[]; rejections: string[] } {
  const allowed = new Set(opts.allowedExtensions.map((e) => e.toLowerCase()));
  const accepted: MattermostFileInfo[] = [];
  const rejections: string[] = [];
  for (const file of files.slice(0, opts.maxFiles)) {
    const ext = (file.extension ?? '').toLowerCase();
    // Extensionless attachments are rejected: the allowlist can only trust the
    // server-reported extension — a missing one cannot be verified, and the
    // filename must not decide the type.
    if (!ext) {
      rejections.push(`${file.name ?? file.id}: no file extension — cannot verify type against the allowlist`);
    } else if (!allowed.has(ext)) {
      rejections.push(`${file.name ?? file.id}: type ".${ext}" not allowed`);
    } else {
      accepted.push(file);
    }
  }
  if (files.length > opts.maxFiles) {
    rejections.push(`${files.length - opts.maxFiles} more file(s) skipped: max ${opts.maxFiles} per message`);
  }
  return { accepted, rejections };
}

/**
 * Turn one or more downloaded attachments into the single prompt string Claude
 * receives. Reuses the transport-agnostic media builders: one image → analyze,
 * one document → read, several together → one grouped set (Mattermost has no
 * album concept — multiple files simply arrive in one post's file_ids).
 */
export function buildMattermostAttachmentMessage(items: SavedAttachment[], caption?: string): string {
  if (items.length === 1) {
    const it = items[0];
    return it.isImage
      ? buildPhotoMessage(it.path, caption)
      : buildDocumentMessage(it.path, it.name, caption);
  }
  return buildMediaGroupMessage(items.map((it) => ({ path: it.path, label: it.name })), caption);
}

export interface MattermostBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** For outside code (scheduler / memory callbacks) to push messages to a channel. */
  sendTo(channelId: string, text: string): Promise<void>;
}

/**
 * Create the Mattermost bot for the agent running this process. Does NOT connect
 * yet — call `start()`. Each agent process subscribes to the WebSocket but only
 * acts on the channels it owns (see ownsChannel / the gateway plan).
 */
export function createMattermostBot(): MattermostBot {
  if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
    throw new Error('MATTERMOST_URL / MATTERMOST_TOKEN not set in .env. See docs/mattermost.md.');
  }
  assertOwnerConfigured();

  const rpc = new MattermostRpcClient({ baseUrl: MATTERMOST_URL, token: MATTERMOST_TOKEN });

  // Routing works on immutable channel IDs (the posted event always carries
  // broadcast.channel_id), so no name cache is needed; start() only validates
  // the configured routing map against the channels the bot actually sees.


  // The bot's own user id, set after getMe() — used for echo + mention checks.
  let selfUserId = '';

  // Append-only audit log of every outbound message (mirrors the Signal bot).
  const auditPath = path.join(PROJECT_ROOT, 'logs', `mattermost-sent-${AGENT_ID}.log`);
  try { fs.mkdirSync(path.dirname(auditPath), { recursive: true }); } catch { /* ok */ }

  const sendMessage = async (channelId: string, text: string, rootId?: string): Promise<void> => {
    const formatted = formatForMattermost(text);
    try {
      const entry = `[${new Date().toISOString()}] agent=${AGENT_ID} channel=${channelId} len=${formatted.length}\n${formatted}\n---\n`;
      fs.appendFileSync(auditPath, entry);
    } catch (auditErr) {
      logger.warn({ err: auditErr }, 'mattermost audit log write failed');
    }
    logger.info({ channel: channelId, len: formatted.length, preview: formatted.slice(0, 120) }, 'mattermost send');

    for (const part of splitMessage(formatted)) {
      try {
        await rpc.postMessage(channelId, part, rootId);
      } catch (err) {
        logger.error({ err, channelId }, 'mattermost send failed');
        // Don't throw — a dropped message must not crash the receive loop.
      }
    }
  };

  const sendFile = async (channelId: string, filePath: string, caption?: string, rootId?: string): Promise<void> => {
    if (!fs.existsSync(filePath)) {
      await sendMessage(channelId, `Could not send file: ${filePath} (not found)`, rootId);
      return;
    }
    try {
      const fileId = await rpc.uploadFile(channelId, filePath);
      await rpc.postMessage(channelId, caption ?? '', rootId, [fileId]);
    } catch (err) {
      logger.error({ err, filePath }, 'mattermost file send failed');
      await sendMessage(channelId, `Failed to send file: ${filePath}`, rootId);
    }
  };

  // Canonical owner user id — resolved once at boot (see start()). Until the
  // resolution completes the gate rejects everyone (fail-closed by ordering:
  // onMessage only fires after start() has connected the socket).
  let ownerUserId = '';
  // Canonical team id the gateway serves; channel events from any other team
  // are ignored (see passesTeamBoundary).
  let teamBoundaryId = '';

  const isOwner = (msg: MattermostIncomingMessage): boolean => isOwnerMessage(msg, ownerUserId);

  // Gated drops used to log a WARN per message — with nine agent processes
  // subscribed and bots cross-posting status updates all day, that produced a
  // permanent log flood. Aggregate instead: log the first drop per sender,
  // then at most one summary per sender every 10 minutes.
  const dropCounts = new Map<string, { n: number; lastLog: number }>();
  const DROP_LOG_INTERVAL_MS = 10 * 60 * 1000;

  function logUnauthorisedDrop(msg: MattermostIncomingMessage, now = Date.now()): void {
    const sender = msg.senderName ?? msg.userId;
    const state = dropCounts.get(sender);
    if (!state) {
      dropCounts.set(sender, { n: 1, lastLog: now });
      logger.warn({ sender, channel: msg.channelId }, 'Dropped non-owner Mattermost message (owner gate)');
      return;
    }
    state.n += 1;
    if (now - state.lastLog >= DROP_LOG_INTERVAL_MS) {
      logger.warn({ sender, channel: msg.channelId, count: state.n, windowMin: Math.round((now - state.lastLog) / 60000) }, 'Dropped non-owner Mattermost messages (owner gate, throttled)');
      state.n = 0;
      state.lastLog = now;
    }
  }

  /**
   * Core message handler — ported from signal-bot.ts handleTextMessage(),
   * keyed on channel_id instead of a phone number.
   */
  async function handleTextMessage(msg: MattermostIncomingMessage, message: string): Promise<void> {
    const chatId = msg.channelId;
    const rootId = msg.rootId || msg.postId; // reply in-thread under the user's message

    if (checkKillPhrase(message)) {
      audit({ agentId: AGENT_ID, chatId, action: 'kill', detail: 'Emergency kill via Mattermost', blocked: false });
      await sendMessage(chatId, 'EMERGENCY KILL activated. All agents stopping.', rootId);
      executeEmergencyKill();
      return;
    }

    if (isLocked()) {
      if (unlock(message)) {
        audit({ agentId: AGENT_ID, chatId, action: 'unlock', detail: 'PIN accepted', blocked: false });
        await sendMessage(chatId, 'Unlocked. Session active.', rootId);
      } else {
        audit({ agentId: AGENT_ID, chatId, action: 'blocked', detail: 'Session locked, wrong PIN', blocked: true });
        await sendMessage(chatId, 'Session locked. Send your PIN to unlock.', rootId);
      }
      return;
    }

    touchActivity();
    audit({ agentId: AGENT_ID, chatId, action: 'message', detail: message.slice(0, 200), blocked: false });
    emitChatEvent({ type: 'user_message', chatId, content: message, source: 'mattermost' });

    // Delegation (@agent or /delegate) — same parser as the other bots.
    const delegation = parseDelegation(message);
    if (delegation) {
      setProcessing(chatId, true);
      rpc.sendTyping(chatId);
      try {
        const result = await delegateToAgent(delegation.agentId, delegation.prompt, chatId, AGENT_ID);
        const ackText = result.text ?? `${delegation.agentId} queued.`;
        emitChatEvent({ type: 'assistant_message', chatId, content: ackText, source: 'mattermost' });
        await sendMessage(chatId, ackText, rootId);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.error({ err, agentId: delegation.agentId }, 'Delegation failed');
        await sendMessage(chatId, `Delegation to ${delegation.agentId} failed: ${m}`, rootId);
      } finally {
        setProcessing(chatId, false);
      }
      return;
    }

    const sessionId = getSession(chatId, AGENT_ID);
    const { contextText: memCtx, surfacedMemoryIds, surfacedMemorySummaries } = await buildMemoryContext(chatId, message, AGENT_ID);

    const parts: string[] = [];
    if (agentSystemPrompt && !sessionId) {
      parts.push(`[Agent role — follow these instructions]\n${agentSystemPrompt}\n[End agent role]`);
    }
    if (memCtx) parts.push(memCtx);

    const recentTasks = getRecentTaskOutputs(AGENT_ID, 30);
    if (recentTasks.length > 0) {
      const taskLines = recentTasks.map((t) => {
        const ago = Math.round((Date.now() / 1000 - t.last_run) / 60);
        return `[Scheduled task ran ${ago}m ago]\nTask: ${t.prompt}\nOutput:\n${t.last_result}`;
      });
      parts.push(`[Recent scheduled task context]\n${taskLines.join('\n\n')}\n[End task context]`);
    }

    if (shouldNudgeMemory(chatId, AGENT_ID)) parts.push(MEMORY_NUDGE_TEXT);
    parts.push(message);

    // Canonical agent resolution (review #112): the turn's provider comes from
    // the same gated resolver every other execution path uses — persisted
    // agent.yaml provider refreshed per turn, then getSelectedProviderConfig()
    // — so engine and model always come from ONE decision, and the tool policy
    // follows the provider profile (non-Claude chat providers get their
    // sandbox, unknown types get the strictest one).
    let provider: ProviderConfig;
    try {
      const persisted = AGENT_ID === 'main'
        ? (await import('./provider.js')).getMainProviderConfig()
        : loadAgentConfig(AGENT_ID).provider;
      updateAgentProvider(persisted);
    } catch (err) {
      // Keep the last known-good in-memory provider if yaml is transiently
      // unreadable; a config refresh failure must not silently change engines.
      logger.warn({ err, agentId: AGENT_ID }, 'Could not refresh provider config from agent.yaml');
    }
    provider = getSelectedProviderConfig();

    const userModel = chatModelOverride.get(chatId) ?? agentDefaultModel;
    const useCheap = SMART_ROUTING_ENABLED && !userModel && classifyMessageComplexity(message) === 'simple';
    // Same provider-aware model decision as Signal's turns (resolveSignalTurnModel):
    // a non-Claude provider keeps its own model instead of being handed a Claude id.
    const effectiveModel = provider.type === 'claude' && useCheap
      ? SMART_ROUTING_CHEAP_MODEL
      : defaultModelForProvider(provider, userModel ?? LATEST_OPUS_MODEL);

    rpc.sendTyping(chatId);
    const typingInterval = setInterval(() => rpc.sendTyping(chatId), MATTERMOST_TYPING_REFRESH_MS);
    setProcessing(chatId, true);

    try {
      const onProgress = (event: AgentProgressEvent): void => {
        emitChatEvent({ type: 'progress', chatId, description: event.description });
        // Mattermost has no message-edit via REST post, so each progress note is
        // a new post. Suppress the SDK's generic per-tool 'Tool result' to avoid
        // spam; keep real sub-agent lifecycle.
        if (!event.description || event.description === 'Tool result') return;
        if (event.type === 'task_started') void sendMessage(chatId, `🔄 ${event.description}`, rootId);
        if (event.type === 'task_completed') void sendMessage(chatId, `✓ ${event.description}`, rootId);
      };

      const abortCtrl = new AbortController();
      setActiveAbort(chatId, abortCtrl);
      const timeoutId = setTimeout(() => {
        logger.warn({ chatId, timeoutMs: AGENT_TIMEOUT_MS }, 'Agent query timed out (Mattermost)');
        abortCtrl.abort();
      }, AGENT_TIMEOUT_MS);

      const fullMessage = parts.join('\n\n');

      const result = await runAgentWithRetry(
        fullMessage,
        sessionId,
        () => rpc.sendTyping(chatId),
        onProgress,
        effectiveModel,
        abortCtrl,
        /* onStreamText */ undefined,
        async (attempt, error) => {
          await sendMessage(chatId, `${error.recovery.userMessage} (retry ${attempt}/2)`, rootId);
        },
        MODEL_FALLBACK_CHAIN.length > 0 ? MODEL_FALLBACK_CHAIN : undefined,
        agentMcpAllowlist,
        provider,
        chatToolProfileFor(provider),
        // AskUserQuestion → Mattermost numbered-reply bridge. The reply is routed
        // back in via feedPendingMattermostQuestion() in onMessage.
        makeMattermostAskUserQuestionResolver(chatId, (cid, t) => sendMessage(cid, t, rootId), abortCtrl),
      );

      clearTimeout(timeoutId);
      clearInterval(typingInterval);
      setActiveAbort(chatId, null);

      if (result.aborted) {
        setProcessing(chatId, false);
        const m = result.text === null
          ? `Timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s. Raise AGENT_TIMEOUT_MS in .env (default 1800000 = 30 min) and restart, or split the task.`
          : 'Stopped.';
        emitChatEvent({ type: 'assistant_message', chatId, content: m, source: 'mattermost' });
        await sendMessage(chatId, m, rootId);
        return;
      }

      if (result.newSessionId) setSession(chatId, result.newSessionId, AGENT_ID);

      let rawResponse = result.text?.trim() || 'Done.';

      if (EXFILTRATION_GUARD_ENABLED) {
        const protectedValues = PROTECTED_ENV_VARS
          .map((key) => process.env[key])
          .filter((v): v is string => !!v && v.length > 8);
        const matches = scanForSecrets(rawResponse, protectedValues);
        if (matches.length > 0) {
          rawResponse = redactSecrets(rawResponse, matches);
          logger.warn({ matchCount: matches.length }, 'Exfiltration guard: redacted secrets (Mattermost)');
        }
      }

      const { text: responseText, files: fileMarkers } = extractFileMarkers(rawResponse);
      const costFooter = buildCostFooter(SHOW_COST_FOOTER, result.usage, effectiveModel);

      saveConversationTurn(chatId, message, rawResponse, result.newSessionId ?? sessionId, AGENT_ID);

      if (result.usage) {
        try {
          saveTokenUsage(
            chatId,
            result.newSessionId ?? sessionId,
            result.usage.inputTokens,
            result.usage.outputTokens,
            result.usage.lastCallCacheRead,
            result.usage.lastCallCacheRead + result.usage.lastCallInputTokens,
            result.usage.totalCostUsd,
            result.usage.didCompact,
            AGENT_ID,
          );
        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Failed to save token usage (Mattermost)');
        }
      }

      if (surfacedMemoryIds.length > 0) {
        void evaluateMemoryRelevance(surfacedMemoryIds, surfacedMemorySummaries, message, rawResponse).catch(() => {});
      }
      emitChatEvent({ type: 'assistant_message', chatId, content: rawResponse, source: 'mattermost' });

      const textWithFooter = responseText ? responseText + costFooter : '';
      if (textWithFooter) await sendMessage(chatId, textWithFooter, rootId);

      for (const file of fileMarkers) {
        await sendFile(chatId, file.filePath, file.caption, rootId);
      }
    } catch (err) {
      clearInterval(typingInterval);
      setActiveAbort(chatId, null);
      const errMsg = err instanceof AgentError
        ? err.recovery.userMessage
        : err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Agent run failed (Mattermost)');
      await sendMessage(chatId, `Error: ${errMsg}`, rootId);
    } finally {
      setProcessing(chatId, false);
    }
  }

  /** Dispatch a bare /command. Returns true if handled. */
  async function handleCommand(msg: MattermostIncomingMessage, text: string): Promise<boolean> {
    const chatId = msg.channelId;
    const rootId = msg.rootId || msg.postId;
    const match = text.match(/^\/(\w+)(?:\s+(.*))?$/s);
    if (!match) return false;
    const cmd = match[1].toLowerCase();
    const arg = (match[2] ?? '').trim();

    switch (cmd) {
      case 'start':
        await sendMessage(chatId, `ClaudeClaw online via Mattermost. Agent: ${AGENT_ID}.\n\nSend /help for commands.`, rootId);
        return true;

      case 'help':
        await sendMessage(chatId, buildMattermostHelpText(), rootId);
        return true;

      case 'newchat':
      case 'forget':
        clearSession(chatId, AGENT_ID);
        await sendMessage(chatId, 'Session cleared. Next message starts fresh.', rootId);
        return true;

      case 'memory': {
        const memories = getRecentMemories(chatId, 10);
        if (memories.length === 0) {
          await sendMessage(chatId, 'No recent memories.', rootId);
        } else {
          const lines = memories.map((m) => `#${m.id} [${m.importance.toFixed(1)}] ${m.summary.slice(0, 150)}`);
          await sendMessage(chatId, `Recent memories:\n\n${lines.join('\n')}`, rootId);
        }
        return true;
      }

      case 'pin': {
        const id = parseInt(arg, 10);
        if (!id) { await sendMessage(chatId, 'Usage: /pin <memory_id>', rootId); return true; }
        pinMemory(id);
        await sendMessage(chatId, `Memory #${id} pinned.`, rootId);
        return true;
      }

      case 'unpin': {
        const id = parseInt(arg, 10);
        if (!id) { await sendMessage(chatId, 'Usage: /unpin <memory_id>', rootId); return true; }
        unpinMemory(id);
        await sendMessage(chatId, `Memory #${id} unpinned.`, rootId);
        return true;
      }

      case 'model': {
        const key = arg.toLowerCase();
        if (!key) {
          const current = chatModelOverride.get(chatId) ?? agentDefaultModel ?? LATEST_OPUS_MODEL;
          await sendMessage(chatId, `Current model: ${current}\n\nUsage: /model <opus|sonnet|haiku>`, rootId);
          return true;
        }
        const target = AVAILABLE_MODELS[key];
        if (!target) { await sendMessage(chatId, 'Unknown model. Use opus, sonnet, or haiku.', rootId); return true; }
        chatModelOverride.set(chatId, target);
        await sendMessage(chatId, `Model switched to ${target}.`, rootId);
        return true;
      }

      case 'dashboard': {
        if (!DASHBOARD_TOKEN) { await sendMessage(chatId, 'Dashboard not configured (DASHBOARD_TOKEN missing).', rootId); return true; }
        // The dashboard link embeds a bearer token for the full dashboard API.
        // Unlike Signal (1:1 only), a Mattermost bot can sit in shared team
        // channels — so only hand the token out in a direct message, never post
        // it into a channel other members can read.
        if (msg.channelType !== 'D') {
          await sendMessage(chatId, 'For security, `/dashboard` only works in a direct message with the bot — the link carries an access token. DM me and run it again.', rootId);
          return true;
        }
        const base = DASHBOARD_URL || `http://localhost:${DASHBOARD_PORT}`;
        const url = `${base}/?token=${DASHBOARD_TOKEN}&chatId=${encodeURIComponent(chatId)}`;
        await sendMessage(chatId, `Dashboard:\n${url}`, rootId);
        return true;
      }

      case 'agents': {
        const agentsDir = path.join(PROJECT_ROOT, 'agents');
        let ids: string[] = [];
        try {
          ids = fs.readdirSync(agentsDir).filter((d) => fs.statSync(path.join(agentsDir, d)).isDirectory());
        } catch { /* no agents dir */ }
        await sendMessage(chatId, ids.length ? `Agents: ${ids.join(', ')}` : 'No additional agents configured.', rootId);
        return true;
      }

      case 'delegate': {
        if (!arg) { await sendMessage(chatId, 'Usage: /delegate <agent> <prompt>', rootId); return true; }
        await handleTextMessage(msg, `/delegate ${arg}`);
        return true;
      }

      // Multi-agent fan-out. The orchestration itself runs inside the agent turn
      // (mission-cli create/gather) — transport-agnostic — so these commands just
      // guard against empty args and forward the raw text, exactly like /delegate.
      case 'await': {
        if (!arg) { await sendMessage(chatId, 'Usage: /await <agent,agent,…> <prompt>\n\nSends the prompt to each agent and waits for one combined answer.', rootId); return true; }
        await handleTextMessage(msg, `/await ${arg}`);
        return true;
      }

      case 'gather': {
        if (!arg) { await sendMessage(chatId, 'Usage: /gather <agent,agent,…> <prompt>\n\nSends the prompt to each agent and pings you with one consolidated summary once the last one finishes.', rootId); return true; }
        await handleTextMessage(msg, `/gather ${arg}`);
        return true;
      }

      case 'lock':
        lock();
        await sendMessage(chatId, 'Session locked. Send your PIN to unlock.', rootId);
        return true;

      case 'status': {
        const s = getSecurityStatus();
        const lines = [
          `PIN lock: ${s.pinEnabled ? (s.locked ? 'locked' : 'unlocked') : 'disabled'}`,
          `Kill phrase: ${s.killPhraseEnabled ? 'enabled' : 'disabled'}`,
          `Idle lock: ${s.idleLockMinutes > 0 ? `${s.idleLockMinutes} min` : 'disabled'}`,
        ];
        await sendMessage(chatId, lines.join('\n'), rootId);
        return true;
      }

      case 'stop': {
        const { abortActiveQuery } = await import('./state.js');
        abortActiveQuery(chatId);
        await sendMessage(chatId, 'Stopping.', rootId);
        return true;
      }

      default:
        return false;
    }
  }

  /** Should this process act on a message in the given channel? */
  function shouldHandle(msg: MattermostIncomingMessage): boolean {
    // Team boundary first: the gateway serves exactly one team; events from
    // any other team (or channel events without a team_id) are ignored.
    if (!passesTeamBoundary(msg, teamBoundaryId)) return false;
    // Direct messages (channel_type 'D') → default agent.
    if (msg.channelType === 'D') return AGENT_ID === MATTERMOST_DEFAULT_AGENT;
    // Route by the immutable 26-char channel ID the posted event always
    // carries — never by the renameable name slug (see mattermost-config.ts).
    if (!ownsChannel(msg.channelId, AGENT_ID)) return false;
    // Mention-only channels: the owning (default) agent replies only when @mentioned.
    if (MATTERMOST_MENTION_ONLY_CHANNELS.includes(msg.channelId)) {
      return !!selfUserId && msg.mentions.includes(selfUserId);
    }
    return true;
  }

  /**
   * Download each attachment to UPLOADS_DIR and dispatch one turn describing
   * them (image → analyze, document → read, several → one grouped set). A file
   * whose download fails is skipped, not fatal; if nothing downloads we fall
   * back to the text so the turn isn't silently lost.
   */
  async function handleAttachments(msg: MattermostIncomingMessage, caption: string): Promise<void> {
    const maxBytes = MATTERMOST_MAX_FILE_MB * 1024 * 1024;
    const { accepted, rejections } = filterInboundFiles(msg.files, {
      maxFiles: MATTERMOST_MAX_FILES,
      allowedExtensions: MATTERMOST_ALLOWED_FILE_TYPES,
    });
    const saved: SavedAttachment[] = [];
    for (const file of accepted) {
      try {
        const buf = await rpc.downloadFile(file.id);
        if (buf.length > maxBytes) {
          rejections.push(`${file.name ?? file.id}: ${Math.round(buf.length / 1024 / 1024)} MB exceeds the ${MATTERMOST_MAX_FILE_MB} MB limit`);
          continue;
        }
        const safeBase = file.name ? path.basename(file.name) : `${file.id}.${file.extension || 'bin'}`;
        const localPath = path.join(UPLOADS_DIR, `${file.id}-${safeBase}`);
        fs.writeFileSync(localPath, buf);
        saved.push({ path: localPath, name: file.name ?? safeBase, isImage: isImageAttachment(file) });
      } catch (err) {
        logger.error({ err, fileId: file.id }, 'Mattermost attachment download failed; skipping file');
      }
    }
    if (saved.length === 0) {
      const notes = rejections.length > 0 ? ` (rejected: ${rejections.join('; ')})` : '';
      if (caption || notes) await handleTextMessage(msg, caption + notes);
      return;
    }
    // Model-egress disclosure: attachment contents leave this machine and are
    // processed by the configured model provider. Say so in the log AND in the
    // agent prompt so the operator sees what a file post implies.
    const providerType = getSelectedProviderConfig().type;
    logger.info(
      { files: saved.map((f) => f.name), provider: providerType },
      'Mattermost attachments accepted — contents will be sent to the model provider',
    );
    const egressNote = `[Attachment notice: the file contents below are being processed by the "${providerType}" model provider.]`;
    const body = buildMattermostAttachmentMessage(saved, caption || undefined);
    await handleTextMessage(msg, rejections.length > 0 ? `${body}\n\n[Rejected attachments: ${rejections.join('; ')}]\n${egressNote}` : `${body}\n${egressNote}`);
  }

  const onMessage = async (msg: MattermostIncomingMessage): Promise<void> => {
    // Single-operator gate — FIRST check, before routing, state access,
    // attachments, commands, or tools. Everyone but the configured owner is
    // rejected here (see mattermost-config.ts: the gateway must never become
    // a shared-subscription gateway on the owner's personal credentials).
    if (!isOwner(msg)) {
      logUnauthorisedDrop(msg);
      return;
    }
    if (!shouldHandle(msg)) return; // another agent process owns this channel

    const text = msg.message.trim();
    // A file-only post carries no text but must still be handled (Vision).
    if (!text && msg.files.length === 0) return;

    if (text.startsWith('/')) {
      const handled = await handleCommand(msg, text);
      if (handled) return;
    }

    // If an AskUserQuestion is awaiting a reply in this channel, consume this
    // message as the answer instead of starting a new turn. Runs outside the
    // message queue because the resolver promise is awaiting it mid-turn.
    if (text && feedPendingMattermostQuestion(msg.channelId, text)) return;

    // Attachments (images/documents): download, persist, and hand Claude a
    // path-based prompt (Read tool opens them). The text becomes the caption.
    if (msg.files.length > 0) {
      messageQueue.enqueue(msg.channelId, () => handleAttachments(msg, text));
      return;
    }

    messageQueue.enqueue(msg.channelId, () => handleTextMessage(msg, text));
  };

  return {
    async start(): Promise<void> {
      // Resolve the bot's own identity for echo + mention filtering. Uses the
      // retrying variant: getMe runs before connect, and a bare failure would
      // re-throw to bootMessenger's process.exit(1) — crash-looping the agent
      // whenever the Mattermost server is briefly unreachable at boot.
      const me = await rpc.getMeWithRetry();
      selfUserId = me.id;
      rpc.selfUserId = me.id;
      logger.info({ botUserId: me.id, botUsername: me.username, isBot: me.is_bot }, 'Mattermost bot identity resolved');

      // Resolve the configured owner to a canonical user ID once (username or
      // 26-char id both accepted; a mistyped owner fails the boot instead of
      // silently authorizing nobody — or worse, matching by display name).
      const owner = await rpc.resolveUserWithRetry(MATTERMOST_OWNER_USER);
      ownerUserId = owner.id;
      logger.info({ ownerUserId: owner.id, ownerUsername: owner.username }, 'Mattermost owner resolved');

      // Resolve the team boundary (required): the gateway serves exactly one
      // team; channel events from any other team are ignored in shouldHandle.
      if (!MATTERMOST_TEAM) {
        throw new Error('MATTERMOST_TEAM is not set. The gateway serves exactly one team — set it (slug or 26-char id, see docs/mattermost.md).');
      }
      const team = /^[a-z0-9]{26}$/.test(MATTERMOST_TEAM)
        ? await rpc.getTeamById(MATTERMOST_TEAM)
        : await rpc.getTeamByName(MATTERMOST_TEAM);
      teamBoundaryId = team.id;

      // Validate the routing map against the channels the bot actually sees:
      // a mapped-but-unknown channel ID would otherwise silently fall back to
      // the default agent. Fail-closed — a config typo must stop the boot, not
      // reroute traffic.
      const mapKeys = Object.keys(MATTERMOST_CHANNEL_AGENT_MAP);
      const mentionOnlyIds = MATTERMOST_MENTION_ONLY_CHANNELS;
      if (mapKeys.length > 0 || mentionOnlyIds.length > 0) {
        const channels = await rpc.getMyChannels(teamBoundaryId);
        const visible = new Set(channels.map((ch) => ch.id));
        const unknown = [
          ...mapKeys.filter((id) => !visible.has(id)),
          ...mentionOnlyIds.filter((id) => !visible.has(id)),
        ];
        if (unknown.length > 0) {
          throw new Error(
            `Mattermost routing map references channels the bot cannot see: ${unknown.join(', ')}. ` +
            `Check the IDs and the bot's channel memberships (see docs/mattermost.md).`,
          );
        }
        logger.info({ team: team.name, channels: channels.length, mapped: mapKeys.length }, 'Mattermost routing map validated');
      }

      // Every agent process subscribes, but onMessage drops channels it does not
      // own — so each channel is handled by exactly one process (disjoint
      // partition). This mirrors the per-agent-process model; unlike Signal
      // (one shared phone number, only main subscribes), Mattermost's channel
      // partition lets specialists handle their own channels directly.
      rpc.on('message', (m) => void onMessage(m).catch((err) => logger.error({ err }, 'onMessage threw')));

      // connectWithRetry (not bare connect): a boot-time server outage schedules
      // a background reconnect instead of rejecting into process.exit(1).
      await rpc.connectWithRetry();
      logger.info({ url: MATTERMOST_URL, agentId: AGENT_ID }, 'Mattermost bot started (connecting)');
    },
    async stop(): Promise<void> {
      rpc.stop();
    },
    async sendTo(channelId: string, text: string): Promise<void> {
      await sendMessage(channelId, text);
    },
  };
}
