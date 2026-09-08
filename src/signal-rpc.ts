import { outboundText } from './outbound-payload.js';
import net from 'net';
import { EventEmitter } from 'events';

import { logger } from './logger.js';

// signal-cli's JSON-RPC daemon speaks newline-delimited JSON over a TCP
// socket. Each line is either a JSON-RPC request, response, or a server-
// pushed notification (most importantly `receive`, which fires for every
// incoming Signal message). Protocol docs:
// https://github.com/AsamK/signal-cli/wiki/JSON-RPC-service

export interface SignalIncomingMessage {
  /** Sender's phone number in E.164 form (e.g. "+491701234567"). */
  sourceNumber: string;
  /** Sender's display name, if provided. */
  sourceName?: string;
  /** Unix ms when Signal received the message. */
  timestamp: number;
  /** Plain-text body. Empty string if the message is media-only. */
  text: string;
  /** Attachment descriptors (if any). */
  attachments: SignalAttachment[];
  /**
   * MINDFIELD (Signal-Gruppen 2026-07-16): base64 group id when the message
   * was posted in a group — from dataMessage.groupInfo (someone else wrote in
   * the group) or syncMessage.sentMessage.groupInfo (Q wrote in the group from
   * another linked device; those syncs carry NO destinationNumber, the group
   * itself is the destination). Undefined for 1:1 messages.
   */
  groupId?: string;
  /**
   * True if the envelope came in as a syncMessage rather than a direct
   * dataMessage. Sync messages fire when the same account sends a message
   * from any of its linked devices — Signal then mirrors that outbound
   * message to every other linked device so the conversation view stays
   * consistent. For a "Note to Self" on the phone, the Mac-side daemon
   * receives it as a sync with `destinationNumber` = own number.
   */
  isSync: boolean;
  /**
   * For sync messages, the recipient of the original outbound message.
   * Useful to distinguish a Note-to-Self (= our own number) from a sync
   * of a message Q sent to someone else. Undefined for direct messages.
   */
  destinationNumber?: string;
  /** Raw envelope for debugging / advanced use. */
  raw: unknown;
}

export interface SignalAttachment {
  id: string;
  contentType?: string;
  filename?: string;
  size?: number;
  /**
   * Local file path where signal-cli has stored the downloaded attachment
   * blob (typically under `~/.local/share/signal-cli/attachments/` or a
   * platform-appropriate equivalent). Present on inbound attachments.
   */
  path?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export interface SignalRpcOptions {
  host: string;
  port: number;
  /** The daemon's bound account — passed implicitly; not needed per call. */
  account?: string;
  /** Timeout for a single JSON-RPC call. */
  callTimeoutMs?: number;
  /**
   * Fire a one-shot `version` probe after each connect to warn on signal-cli
   * versions with the known inbound-dropping NPE. Default true; tests that
   * assert on the request stream can disable it.
   */
  probeVersionOnConnect?: boolean;
}

export class SignalRpcClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private stopped = false;
  private reconnectDelayMs = 500;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // PR #111 review #7: cap the receive buffer. A well-behaved daemon sends
  // newline-delimited JSON; an ever-growing partial line means a corrupt or
  // hostile stream, so we force a clean reconnect rather than leak memory.
  private static readonly MAX_RECEIVE_BUFFER_BYTES = 8 * 1024 * 1024; // 8 MB

  constructor(private readonly opts: SignalRpcOptions) {
    super();
  }

  /** Connect and keep the socket alive. Auto-reconnects with exponential backoff. */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30_000);

      const onError = (err: Error) => {
        sock.removeAllListeners();
        reject(err);
      };

      sock.once('error', onError);
      sock.connect(this.opts.port, this.opts.host, () => {
        sock.off('error', onError);
        // PR #111 review #5: stop() may have been called while this (reconnect)
        // connect was in flight — don't resurrect a live socket after shutdown.
        if (this.stopped) {
          sock.destroy();
          resolve();
          return;
        }
        this.attachSocket(sock);
        this.reconnectDelayMs = 500;
        resolve();
        // Best-effort: warn loudly if the daemon is an old signal-cli with the
        // known getServerGuid / getSender NPE that silently drops inbound
        // note-to-self + sealed-sender envelopes (fixed in 0.14.5). Non-blocking.
        if (this.opts.probeVersionOnConnect !== false) void this.checkDaemonVersion();
      });
    });
  }

  /**
   * Connect for the INITIAL attempt (from Messenger.start). If the daemon
   * isn't up yet — a real boot race when signal-cli is a separate service that
   * may start slower than the bot — a bare `connect()` would reject, no socket
   * attaches, no 'close' fires, and the rejection propagates up to
   * bootMessenger's process.exit(1), killing the agent instead of retrying.
   * This mirrors the retry path's catch: on failure, log and hand off to the
   * self-rescheduling backoff loop, then resolve so boot continues. Outbound
   * sends before the socket is up fail gracefully ('not connected') until the
   * background reconnect succeeds.
   */
  async connectWithRetry(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'signal-rpc initial connect failed; scheduling background reconnect');
      this.scheduleReconnect();
    }
  }

  private attachSocket(sock: net.Socket): void {
    this.socket = sock;
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('error', (err) => logger.warn({ err }, 'signal-rpc socket error'));
    sock.on('close', () => {
      this.socket = null;
      // PR #111 review #6: drop any partial frame. A mid-line drop (exactly the
      // daemon-restart case this targets) would otherwise leave a dangling
      // fragment that corrupts — or silently swallows — the first line after
      // reconnect.
      this.buffer = '';
      this.failAllPending(new Error('signal-cli socket closed'));
      this.scheduleReconnect();
    });
  }

  /**
   * Reconnect with exponential backoff. Reschedules itself when an attempt
   * fails — a failed `connect()` never attaches a socket, so no `close` event
   * fires to retry. Without self-rescheduling the client would give up after a
   * single failed attempt (e.g. while the daemon is mid-restart).
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.reconnectDelayMs, 30_000);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    logger.warn({ delayMs: delay }, 'signal-rpc reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect().catch((err) => {
        logger.error({ err }, 'signal-rpc reconnect attempt failed, retrying');
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * One-shot daemon version probe. signal-cli < 0.14.5 has a getServerGuid /
   * getSender NullPointerException that drops certain inbound envelopes
   * (note-to-self, sealed sender) before they reach JSON-RPC clients — the bot
   * then silently never receives them. Surfacing this at connect time turns a
   * baffling "bot ignores my messages" into an actionable log line.
   */
  private async checkDaemonVersion(): Promise<void> {
    try {
      const res = await this.call<{ version?: string }>('version', {});
      const v = res?.version;
      if (typeof v === 'string' && isSignalCliVersionBelow(v, [0, 14, 5])) {
        logger.warn(
          { version: v, recommended: '0.14.5' },
          'signal-cli is older than 0.14.5 — known getServerGuid/getSender NPE can silently drop inbound messages. Upgrade: brew upgrade signal-cli',
        );
      }
    } catch {
      // version RPC unavailable on very old daemons — best-effort only.
    }
  }

  /** Graceful shutdown. Blocks in-flight calls from being retried. */
  stop(): void {
    this.stopped = true;
    // PR #111 review #5: cancel a pending reconnect so a late timer can't
    // resurrect the client after shutdown.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPending(new Error('signal-rpc client stopped'));
    try { this.socket?.end(); } catch { /* ok */ }
    this.socket = null;
    this.buffer = '';
  }

  private failAllPending(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    // Daemon sends newline-delimited JSON; consume as many complete lines as we have.
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse & { method?: string; params?: unknown };
        if (msg.method === 'receive') {
          const incoming = this.parseReceive(msg.params);
          if (incoming) this.emit('message', incoming);
        } else if (typeof msg.id === 'number') {
          const pending = this.pending.get(msg.id);
          if (!pending) continue;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(`signal-cli error ${msg.error.code}: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch (err) {
        logger.warn({ err, line: line.slice(0, 200) }, 'signal-rpc could not parse line');
      }
    }
    // PR #111 review #7: after consuming every complete line, whatever remains
    // is a single incomplete frame. If it has grown past the cap the stream is
    // corrupt/hostile — reset and destroy the socket to force a clean reconnect.
    if (this.buffer.length > SignalRpcClient.MAX_RECEIVE_BUFFER_BYTES) {
      logger.error(
        { bufferLen: this.buffer.length },
        'signal-rpc receive buffer exceeded cap without a newline; destroying socket to force reconnect',
      );
      this.buffer = '';
      this.socket?.destroy();
    }
  }

  /** Low-level JSON-RPC call. Most callers should use `send` / `sendTyping`. */
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.socket) return Promise.reject(new Error('signal-rpc not connected'));
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`signal-cli call '${method}' timed out after ${this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS}ms`));
      }, this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.socket!.write(body, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Send a plain-text message to one recipient (phone number or `group.<id>`). */
  async send(recipient: string, text: string): Promise<void> {
    await this.call('send', buildSendParams(recipient, { message: outboundText(text, 'signal.send') }));
  }

  /** Send a message with attachments (file paths on local disk). */
  async sendWithAttachments(recipient: string, text: string, attachmentPaths: string[]): Promise<void> {
    await this.call('send', buildSendParams(recipient, {
      message: outboundText(text, 'signal.attachments'),
      attachment: attachmentPaths,
    }));
  }

  /** Send a typing indicator (appears for ~10s in the receiver's Signal UI). */
  async sendTyping(recipient: string): Promise<void> {
    // signal-cli's `sendTyping` RPC — not all daemon versions expose it;
    // silently swallow "method not found" so it stays best-effort.
    try {
      await this.call('sendTyping', buildSendParams(recipient, {}));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/method.*not.*found|-32601/i.test(msg)) throw err;
    }
  }

  /** Parse a `receive` notification payload from the daemon. */
  private parseReceive(params: unknown): SignalIncomingMessage | null {
    return parseReceiveEnvelope(params);
  }
}

// ── Group recipients (MINDFIELD, Signal-Gruppen 2026-07-16) ────────────────
// A recipient string is either an E.164 phone number ("+4915…") or a group
// reference "group.<base64GroupId>". The prefix cannot collide with phone
// numbers (those start with "+") and survives being used as an opaque chatId
// throughout sessions/audit/memory. signal-cli group ids are base64 and may
// contain "/", "+", "=" — always encodeURIComponent() when embedding in URLs.

export const SIGNAL_GROUP_RECIPIENT_PREFIX = 'group.';

export function isGroupRecipient(recipient: string): boolean {
  return recipient.startsWith(SIGNAL_GROUP_RECIPIENT_PREFIX);
}

export function groupRecipient(groupId: string): string {
  return SIGNAL_GROUP_RECIPIENT_PREFIX + groupId;
}

export function groupIdFromRecipient(recipient: string): string {
  return recipient.slice(SIGNAL_GROUP_RECIPIENT_PREFIX.length);
}

/**
 * Build the JSON-RPC params targeting either a single recipient or a group.
 * Pure function so the group/1:1 dispatch is unit-testable without a daemon.
 */
export function buildSendParams(
  recipient: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return isGroupRecipient(recipient)
    ? { groupId: groupIdFromRecipient(recipient), ...extra }
    : { recipient: [recipient], ...extra };
}

/**
 * Compare a signal-cli version string ("0.14.2" / "0.14.5-SNAPSHOT") against a
 * [major, minor, patch] tuple. Returns true if `version` is strictly older.
 * Tolerant of suffixes and missing components; unparseable → false (don't warn).
 */
export function isSignalCliVersionBelow(version: string, min: [number, number, number]): boolean {
  const m = version.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const cur: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  for (let i = 0; i < 3; i++) {
    if (cur[i] < min[i]) return true;
    if (cur[i] > min[i]) return false;
  }
  return false;
}

/**
 * Parse a `receive` notification payload from the signal-cli daemon into a
 * normalized message, or null if it isn't a user-visible message (receipt,
 * typing indicator, read marker, empty sync, etc.). Exported as a pure function
 * so the full envelope matrix (direct dataMessage, note-to-self sync, sealed
 * sender, attachments-only) is unit-testable without a live daemon.
 */
export function parseReceiveEnvelope(params: unknown): SignalIncomingMessage | null {
  {
    if (!params || typeof params !== 'object') return null;
    const p = params as Record<string, unknown>;
    const envelope = (p.envelope ?? p) as Record<string, unknown>;
    if (!envelope || typeof envelope !== 'object') return null;

    const sourceNumber =
      (envelope.sourceNumber as string | undefined) ??
      (envelope.source as string | undefined) ??
      '';
    const sourceName = envelope.sourceName as string | undefined;
    const timestamp = typeof envelope.timestamp === 'number' ? envelope.timestamp : Date.now();

    // The actual message body lives in one of: dataMessage (incoming),
    // syncMessage.sentMessage.dataMessage (sync from a linked device).
    // Signal also sends receipts, typing, etc. — we only care about ones
    // with a text body or attachments.
    let dataMessage: Record<string, unknown> | undefined;
    let isSync = false;
    let destinationNumber: string | undefined;
    if (envelope.dataMessage && typeof envelope.dataMessage === 'object') {
      dataMessage = envelope.dataMessage as Record<string, unknown>;
    } else if (envelope.syncMessage && typeof envelope.syncMessage === 'object') {
      const syncMessage = envelope.syncMessage as Record<string, unknown>;
      const sentMessage = syncMessage.sentMessage as Record<string, unknown> | undefined;
      if (sentMessage?.message !== undefined || (sentMessage?.attachments as unknown[] | undefined)?.length) {
        // Sync messages look slightly different — the text is under
        // syncMessage.sentMessage.message (no nested dataMessage).
        dataMessage = sentMessage;
        isSync = true;
        destinationNumber =
          (sentMessage?.destinationNumber as string | undefined) ??
          (sentMessage?.destination as string | undefined);
      }
    }
    if (!dataMessage) return null;

    // MINDFIELD (Signal-Gruppen): group context lives in groupInfo on both
    // shapes — dataMessage.groupInfo for messages from others, and
    // sentMessage.groupInfo for syncs of Q's own posts from another device.
    const groupInfo = dataMessage.groupInfo as Record<string, unknown> | undefined;
    const groupId = typeof groupInfo?.groupId === 'string' ? (groupInfo.groupId as string) : undefined;

    const text =
      (dataMessage.message as string | undefined) ??
      (dataMessage.body as string | undefined) ??
      '';
    const rawAttachments = (dataMessage.attachments as unknown[] | undefined) ?? [];
    const attachments: SignalAttachment[] = rawAttachments
      .filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object')
      .map((a) => ({
        id: (a.id as string | undefined) ?? (a.contentType as string | undefined) ?? String(Date.now()),
        contentType: a.contentType as string | undefined,
        filename: a.filename as string | undefined,
        size: a.size as number | undefined,
        path: (a.path as string | undefined) ?? (a.file as string | undefined),
      }));

    if (!text && attachments.length === 0) return null;

    return {
      sourceNumber,
      sourceName,
      timestamp,
      text,
      attachments,
      groupId,
      isSync,
      destinationNumber,
      raw: envelope,
    };
  }
}

/** Typed helper for code that only wants the message event. */
export interface SignalRpcClient {
  on(event: 'message', listener: (msg: SignalIncomingMessage) => void): this;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}
