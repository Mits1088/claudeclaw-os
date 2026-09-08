import { outboundText } from './outbound-payload.js';
import { EventEmitter } from 'events';

import { logger } from './logger.js';

// Low-level Mattermost client for a long-running bot daemon. Uses Node's native
// global WebSocket + fetch (Node >= 22; this repo runs on 25.x) — no `ws` or
// `@mattermost/client` dependency, which avoids the well-known `window`-polyfill
// breakage of @mattermost/client in Node and keeps the dep surface minimal.
//
// Protocol references (verified 2026):
//   WS   wss://<host>/api/v4/websocket — send {action:'authentication_challenge',
//        seq, data:{token}} right after open; server pushes {event:'posted', ...}
//        where data.post is a DOUBLE-encoded JSON string.
//   REST GET  /api/v4/users/me, /api/v4/teams/name/{name},
//        GET  /api/v4/users/me/teams/{team}/channels?per_page=200 (paginate),
//        POST /api/v4/posts {channel_id, message, root_id?}.
//   Typing is WS-only: {action:'user_typing', seq, data:{channel_id, parent_id}}.

/** A file attached to an incoming post (from post.metadata.files / file_ids). */
export interface MattermostFileInfo {
  /** Mattermost file id — download via GET /api/v4/files/{id}. */
  id: string;
  /** Original filename, if the event carried metadata.files. */
  name?: string;
  /** Lowercase extension without the dot (e.g. "jpg"), if known. */
  extension?: string;
}

export interface MattermostIncomingMessage {
  /** Channel the post was made in. */
  channelId: string;
  /** Channel slug (e.g. "town-square"), if the event carried it. */
  channelName?: string;
  /** O=public, P=private, D=direct, G=group. */
  channelType?: string;
  /** Author of the post. */
  userId: string;
  /** Sender's @username from the event (e.g. "@alice"), if present. */
  senderName?: string;
  /** Plain-text / Markdown body. */
  message: string;
  /** Post ID (used as root_id for threaded replies). */
  postId: string;
  /** Empty string for a top-level post; otherwise the thread root's post ID. */
  rootId: string;
  /** Team the channel belongs to, if present. */
  teamId?: string;
  /** User IDs mentioned in the post (parsed from data.mentions). */
  mentions: string[];
  /** File attachments on the post ([] for a text-only post). */
  files: MattermostFileInfo[];
  /** Raw decoded event for debugging. */
  raw: unknown;
}

export interface MattermostUser {
  id: string;
  username: string;
  is_bot?: boolean;
}

export interface MattermostChannel {
  id: string;
  name: string;
  display_name: string;
  type: string; // O | P | D | G
  team_id: string;
}

export interface MattermostTeam {
  id: string;
  name: string;
  display_name: string;
}

export interface MattermostRpcOptions {
  /** Base URL, e.g. https://chat.example.com (no trailing slash). */
  baseUrl: string;
  /** Bot personal access token. */
  token: string;
  /**
   * If set, inbound posts authored by this user id are dropped before emit
   * (echo suppression). Normally the bot's own user id, set after getMe().
   */
  selfUserId?: string;
  /** WS staleness watchdog: reconnect if no frame for this long. */
  staleTimeoutMs?: number;
}

const DEFAULT_STALE_TIMEOUT_MS = 90_000;

class MattermostHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    detail: string,
  ) {
    super(`Mattermost ${method} ${path} → ${status}: ${detail}`);
    this.name = 'MattermostHttpError';
  }
}

class MattermostNetworkError extends Error {
  constructor(cause: unknown) {
    super('Mattermost request failed before receiving an HTTP response', { cause });
    this.name = 'MattermostNetworkError';
  }
}

/**
 * Parse a Mattermost WebSocket `posted` event into a normalized message, or
 * null if it is not a user-visible post we should act on. Exported as a pure
 * function so the double-encoding and edge cases are unit-testable without a
 * live server.
 *
 * @param selfUserId  When provided, posts authored by this id return null
 *                    (echo suppression for the bot's own messages).
 */
export function parsePostedEvent(
  raw: unknown,
  selfUserId?: string,
): MattermostIncomingMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const evt = raw as Record<string, unknown>;
  if (evt.event !== 'posted') return null;
  const data = evt.data as Record<string, unknown> | undefined;
  if (!data || typeof data.post !== 'string') return null;

  // data.post is a JSON string (single-encoded inside the already-parsed event).
  let post: Record<string, unknown>;
  try {
    post = JSON.parse(data.post) as Record<string, unknown>;
  } catch {
    return null;
  }

  const userId = (post.user_id as string | undefined) ?? '';
  if (!userId) return null;
  if (selfUserId && userId === selfUserId) return null; // echo

  // Ignore system/join/leave posts — they carry a non-empty `type`.
  const postType = (post.type as string | undefined) ?? '';
  if (postType) return null;

  const message = (post.message as string | undefined) ?? '';
  const channelId = (post.channel_id as string | undefined) ?? '';
  if (!channelId) return null;

  let mentions: string[] = [];
  if (typeof data.mentions === 'string') {
    try {
      const arr = JSON.parse(data.mentions);
      if (Array.isArray(arr)) mentions = arr.filter((m): m is string => typeof m === 'string');
    } catch {
      /* mentions is best-effort */
    }
  }

  // Attachments. metadata.files carries id + name + extension (preferred, so we
  // can name the download and tell image from document); post.file_ids is the
  // reliable id-only fallback when metadata is absent.
  let files: MattermostFileInfo[] = [];
  const metaFiles = (post.metadata as Record<string, unknown> | undefined)?.files;
  if (Array.isArray(metaFiles)) {
    files = metaFiles
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).id === 'string')
      .map((f) => ({
        id: f.id as string,
        ...(typeof f.name === 'string' ? { name: f.name } : {}),
        ...(typeof f.extension === 'string' ? { extension: (f.extension as string).toLowerCase() } : {}),
      }));
  } else if (Array.isArray(post.file_ids)) {
    files = (post.file_ids as unknown[])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => ({ id }));
  }

  return {
    channelId,
    channelName: data.channel_name as string | undefined,
    channelType: data.channel_type as string | undefined,
    userId,
    senderName: data.sender_name as string | undefined,
    message,
    postId: (post.id as string | undefined) ?? '',
    rootId: (post.root_id as string | undefined) ?? '',
    teamId: data.team_id as string | undefined,
    mentions,
    files,
    raw: evt,
  };
}

/** Derive the websocket URL from an http(s) base URL. */
export function toWebsocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const wsBase = trimmed.replace(/^http/i, 'ws'); // http→ws, https→wss
  return `${wsBase}/api/v4/websocket`;
}

export class MattermostRpcClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private seq = 1;
  private stopped = false;
  private reconnectDelayMs = 1_000;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly apiBase: string;

  constructor(private readonly opts: MattermostRpcOptions) {
    super();
    this.apiBase = `${opts.baseUrl.replace(/\/+$/, '')}/api/v4`;
  }

  set selfUserId(id: string | undefined) {
    this.opts.selfUserId = id;
  }

  // ── REST ──────────────────────────────────────────────────────────────────

  private async rest<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new MattermostNetworkError(err);
    }
    if (res.status === 429 && attempt < 3) {
      // Respect rate limits: brief backoff then retry, capped at 3 attempts so a
      // sustained 429 surfaces as an error instead of recursing forever.
      const retryAfter = Number(res.headers.get('X-RateLimit-Reset')) || 1;
      await new Promise((r) => setTimeout(r, Math.min(5_000, retryAfter * 1000)));
      return this.rest<T>(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new MattermostHttpError(res.status, method, path, text.slice(0, 200));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** GET /users/me — the bot's own account. */
  getMe(): Promise<MattermostUser> {
    return this.rest<MattermostUser>('GET', '/users/me');
  }

  /**
   * getMe with exponential backoff, for the bot's boot path. getMe() runs before
   * the WebSocket connect and a bare failure re-throws to bootMessenger's
   * process.exit(1) — so if the Mattermost server is still starting, the whole
   * agent crash-loops under launchd. This waits the server out instead (capped
   * 30s backoff), returning once identity resolves. Stops early on stop().
   */
  async getMeWithRetry(): Promise<MattermostUser> {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) throw new Error('mattermost-rpc stopped before getMe succeeded');
      try {
        return await this.getMe();
      } catch (err) {
        const delay = Math.min(1_000 * 2 ** attempt, 30_000);
        logger.warn(
          { err, attempt, delayMs: delay },
          'mattermost-rpc getMe failed at boot; retrying (server may still be starting)',
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** GET /teams/name/{name} — resolve a team slug to its record. */
  getTeamByName(name: string): Promise<MattermostTeam> {
    return this.rest<MattermostTeam>('GET', `/teams/name/${encodeURIComponent(name)}`);
  }

  /** GET /teams/{id} — resolve a team by ID. */
  getTeamById(id: string): Promise<MattermostTeam> {
    return this.rest<MattermostTeam>('GET', `/teams/${encodeURIComponent(id)}`);
  }

  /** GET /users/username/{name} — resolve a username to its user record. */
  getUserByUsername(name: string): Promise<MattermostUser> {
    return this.rest<MattermostUser>('GET', `/users/username/${encodeURIComponent(name)}`);
  }

  /** GET /users/{id} — resolve a user by ID (validates a configured owner id). */
  getUserById(id: string): Promise<MattermostUser> {
    return this.rest<MattermostUser>('GET', `/users/${encodeURIComponent(id)}`);
  }

  /**
   * Resolve a username OR 26-char user id to its canonical user record,
   * retrying like getMeWithRetry: this runs at boot, and a briefly starting
   * server must be waited out, not crash-looped.
   */
  async resolveUserWithRetry(usernameOrId: string): Promise<MattermostUser> {
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) throw new Error('mattermost-rpc stopped before user resolution succeeded');
      try {
        return /^[a-z0-9]{26}$/.test(usernameOrId)
          ? await this.getUserById(usernameOrId)
          : await this.getUserByUsername(usernameOrId);
      } catch (err) {
        const retryable = err instanceof MattermostNetworkError
          || (err instanceof MattermostHttpError && (err.status === 429 || err.status >= 500));
        if (!retryable) throw err;
        const delay = Math.min(1_000 * 2 ** attempt, 30_000);
        logger.warn(
          { err, attempt, delayMs: delay, user: usernameOrId },
          'mattermost-rpc owner resolution failed at boot; retrying (server may still be starting)',
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * GET /users/me/teams/{team}/channels — all channels the bot is a member of
   * in the team, paginated (known Mattermost pagination bug otherwise).
   */
  async getMyChannels(teamId: string): Promise<MattermostChannel[]> {
    const all: MattermostChannel[] = [];
    for (let page = 0; page < 50; page++) {
      const batch = await this.rest<MattermostChannel[]>(
        'GET',
        `/users/me/teams/${encodeURIComponent(teamId)}/channels?page=${page}&per_page=200`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 200) break;
    }
    return all;
  }

  /** POST /posts — send a message, optionally threaded (rootId) and/or with files. */
  async postMessage(channelId: string, message: string, rootId?: string, fileIds?: string[]): Promise<void> {
    await this.rest('POST', '/posts', {
      channel_id: channelId,
      message: outboundText(message, 'mattermost.post'),
      ...(rootId ? { root_id: rootId } : {}),
      ...(fileIds && fileIds.length ? { file_ids: fileIds } : {}),
    });
  }

  /**
   * Upload a local file to a channel and return its file_id (for attaching via
   * postMessage). Uses multipart/form-data; fetch sets the boundary itself, so
   * we must NOT send a Content-Type header here (unlike the JSON rest() path).
   */
  async uploadFile(channelId: string, filePath: string): Promise<string> {
    const fs = await import('fs');
    const path = await import('path');
    const data = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('files', new Blob([data]), path.basename(filePath));
    const res = await fetch(`${this.apiBase}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.token}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mattermost file upload → ${res.status}: ${text.slice(0, 200)}`);
    }
    const j = (await res.json()) as { file_infos?: Array<{ id: string }> };
    const id = j.file_infos?.[0]?.id;
    if (!id) throw new Error('Mattermost file upload returned no file id');
    return id;
  }

  /**
   * Download an attachment's raw bytes by file id (GET /api/v4/files/{id}).
   * Returns the buffer; the caller decides where to persist it. Used for inbound
   * image/document handling (Vision) — the counterpart to uploadFile.
   */
  async downloadFile(fileId: string): Promise<Buffer> {
    const res = await fetch(`${this.apiBase}/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Mattermost file download ${fileId} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  // ── WebSocket ───────────────────────────────────────────────────────────────

  /**
   * Connect for the INITIAL attempt (from the bot's start()). If the Mattermost
   * server isn't reachable at boot, a bare `connect()` rejects (WebSocket ctor
   * throw or 'error'/'close-before-open') and the rejection propagates up to
   * bootMessenger's process.exit(1) — turning a transient outage into a launchd
   * crash-loop. This swallows the failure, hands off to the self-rescheduling
   * backoff loop, and resolves so boot continues. Outbound sends before the
   * socket is up fail gracefully until the background reconnect succeeds.
   * Mirrors Signal's `connectWithRetry`.
   */
  async connectWithRetry(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'mattermost-rpc initial connect failed; scheduling background reconnect');
      this.scheduleReconnect();
    }
  }

  /** Open the socket, authenticate, and begin receiving. Auto-reconnects. */
  async connect(): Promise<void> {
    if (this.stopped) return;
    const wsUrl = toWebsocketUrl(this.opts.baseUrl);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.ws = ws;

      ws.addEventListener('open', () => {
        // Authentication challenge must be the first frame.
        this.sendRaw({
          seq: this.seq++,
          action: 'authentication_challenge',
          data: { token: this.opts.token },
        });
        this.reconnectDelayMs = 1_000;
        this.bumpStaleTimer();
        this.startPingTimer();
        if (!settled) { settled = true; resolve(); }
      });

      ws.addEventListener('message', (ev: MessageEvent) => {
        this.bumpStaleTimer();
        this.onFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
      });

      ws.addEventListener('error', (ev: Event) => {
        logger.warn({ err: (ev as { message?: string })?.message }, 'mattermost-rpc ws error');
        if (!settled) { settled = true; reject(new Error('mattermost websocket error')); }
      });

      ws.addEventListener('close', () => {
        this.clearStaleTimer();
        this.clearPingTimer();
        this.ws = null;
        if (!settled) { settled = true; reject(new Error('mattermost websocket closed before open')); }
        this.scheduleReconnect();
      });
    });
  }

  private onFrame(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.warn({ err, line: text.slice(0, 200) }, 'mattermost-rpc could not parse frame');
      return;
    }
    const evt = parsed as Record<string, unknown>;
    if (evt.event === 'posted') {
      const msg = parsePostedEvent(evt, this.opts.selfUserId);
      if (msg) this.emit('message', msg);
      return;
    }
    if (evt.event === 'user_added') {
      const data = evt.data as Record<string, unknown> | undefined;
      const broadcast = evt.broadcast as Record<string, unknown> | undefined;
      if (data && this.opts.selfUserId && data.user_id === this.opts.selfUserId) {
        this.emit('channel_added', broadcast?.channel_id as string | undefined);
      }
    }
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** Send a typing indicator. Mattermost shows it ~3-5s; caller repeats it. */
  sendTyping(channelId: string, parentId = ''): void {
    this.sendRaw({
      seq: this.seq++,
      action: 'user_typing',
      data: { channel_id: channelId, parent_id: parentId },
    });
  }

  /**
   * App-level keepalive. Mattermost replies to {action:'ping'} with a pong
   * frame, which feeds bumpStaleTimer — so an idle channel (no posts) still
   * proves liveness and the staleness watchdog won't misfire. Node's global
   * WebSocket auto-pongs protocol pings but doesn't surface them to onmessage,
   * which is why an app-level ping is needed.
   */
  private startPingTimer(): void {
    this.clearPingTimer();
    if (this.stopped) return;
    this.pingTimer = setInterval(() => {
      this.sendRaw({ seq: this.seq++, action: 'ping' });
    }, 30_000);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private bumpStaleTimer(): void {
    this.clearStaleTimer();
    if (this.stopped) return;
    const ms = this.opts.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.staleTimer = setTimeout(() => {
      logger.warn({ staleMs: ms }, 'mattermost-rpc connection stale — forcing reconnect');
      try { this.ws?.close(); } catch { /* triggers close → reconnect */ }
    }, ms);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // Guard: on a boot-time close-before-open, connect()'s own close handler AND
    // connectWithRetry's catch both call this — without the guard that starts
    // two parallel backoff loops. Only one reconnect is ever pending at a time.
    if (this.reconnectTimer) return;
    const delay = Math.min(this.reconnectDelayMs, 30_000);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    logger.warn({ delayMs: delay }, 'mattermost-rpc reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect().catch((err) => {
        logger.error({ err }, 'mattermost-rpc reconnect attempt failed, retrying');
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Graceful shutdown. */
  stop(): void {
    this.stopped = true;
    this.clearStaleTimer();
    this.clearPingTimer();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* ok */ }
    this.ws = null;
  }
}

/** Typed event helper. */
export interface MattermostRpcClient {
  on(event: 'message', listener: (msg: MattermostIncomingMessage) => void): this;
  on(event: 'channel_added', listener: (channelId: string | undefined) => void): this;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}
