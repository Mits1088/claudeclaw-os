import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createRequire } from 'module';

import { logger } from '../logger.js';
import { redactString } from '../log-redact.js';
import {
  CONSUMED_CLIENT_NOTIFICATION,
  classifyInbound,
  isErrorResponse,
  parseInitializeResponse,
  type InitializeCapabilities,
  type InitializeResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './codex-app-server-protocol.js';

/**
 * Transport for one `codex app-server` child process: spawn, the initialization
 * handshake, JSONL framing, request/response correlation, notification fan-out,
 * server-initiated request delivery, and shutdown.
 *
 * Deliberately TRANSPORT-ONLY. It knows nothing about Telegram, missions,
 * providers, capability profiles, or `AgentEngineEvent`. Threads, turns, per-thread
 * serialization, restart policy and event translation live above it
 * (manager/adapter, Phase 2) so this layer stays testable against a fake child.
 *
 * Not a singleton: `CodexAppServerManager` owns the process-scoped instance.
 * `EngineFactory` builds adapters per call, so an adapter-held child would
 * silently restore the per-turn process model App Server exists to remove.
 *
 * ## Generations
 *
 * This object outlives its child: a crash is followed by a lazy restart, so a
 * second (third, …) child can exist over one client's lifetime. Every spawn gets a
 * monotonically increasing GENERATION, and every callback and deferred continuation
 * captures the generation it belongs to. Anything from a superseded generation is
 * logged and dropped. Without that, a dying child's exit handler clears the state
 * of its healthy replacement, and a slow server-request handler answers generation
 * N-1's request down generation N's stdin — where the id means something else
 * entirely.
 */

/** Startup ceiling. A timeout kills the child and leaves the client restartable. */
const STARTUP_TIMEOUT_MS = 10_000;

/** Default control-request timeout. A turn's lifetime is NOT bounded by this. */
const CONTROL_TIMEOUT_MS = 30_000;

/**
 * Cap for ONE inbound line, in UTF-8 BYTES. Applied to EVERY complete line before it
 * is parsed, and to the pending unterminated segment afterwards. A burst of many
 * small messages in one chunk is normal traffic and must not trip a single-line
 * limit, but no individual line may reach JSON.parse over budget.
 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/**
 * Cap for the outbound queue, in UTF-8 bytes. Exceeding it fails the write
 * VISIBLY rather than letting Node's internal buffer grow without bound: a client
 * that cannot keep up must surface that, not accumulate silently until the process
 * dies of memory pressure.
 */
const MAX_QUEUED_WRITE_BYTES = 8 * 1024 * 1024;

/** Grace periods for an orderly shutdown. */
const SHUTDOWN_TERMINAL_WAIT_MS = 5_000;
const SHUTDOWN_EXIT_WAIT_MS = 2_000;

/** How long a quarantine waits for the child to die, per escalation step. */
const QUARANTINE_EXIT_WAIT_MS = 5_000;

export type ClientState = 'stopped' | 'starting' | 'ready' | 'failed' | 'exited';

/**
 * What we can honestly say about a failed request's fate AT THE SERVER.
 *
 * This is the difference between a turn that provably never started and one that may
 * be running right now with nobody listening. Callers with side effects (`turn/start`)
 * must branch on it: replaying an `unknown` request can repeat the side effects, and
 * reusing the connection can let an orphaned turn write into someone else's stream.
 */
export type RequestDelivery =
  /** Never enqueued or written. The child cannot have seen it. */
  | 'not-sent'
  /** The server answered with a JSON-RPC error: it saw the request and refused it. */
  | 'refused'
  /** Written, or possibly written, with no answer. The outcome is UNKNOWN. */
  | 'unknown';

/** A request failure that carries what we know about how far it got. */
export class CodexAppServerRequestError extends Error {
  constructor(message: string, readonly delivery: RequestDelivery, readonly method: string) {
    super(message);
    this.name = 'CodexAppServerRequestError';
  }
}

/**
 * Classify any thrown value from `request()`.
 *
 * Fails CLOSED: anything we did not tag ourselves is `unknown`, because an
 * unrecognized failure at a side-effecting boundary is exactly the case where
 * assuming "it never happened" is unsafe.
 */
export function requestDeliveryOf(err: unknown): RequestDelivery {
  return err instanceof CodexAppServerRequestError ? err.delivery : 'unknown';
}

export interface CodexAppServerClientOptions {
  /** Environment for the child. Must already be scrubbed and carry CODEX_HOME. */
  env: Record<string, string>;
  /** The isolated CODEX_HOME the child MUST report back; verified at handshake. */
  expectedCodexHome: string;
  clientVersion: string;
  /**
   * Notification methods the server should suppress for this connection.
   *
   * This is the ONLY part of the handshake a caller may influence. `experimentalApi`
   * and `requestAttestation` are fixed invariants of the release (see the RFC):
   * making them injectable would let a caller silently turn off the experimental
   * API the adapter depends on, or advertise an attestation capability nothing
   * implements.
   */
  optOutNotificationMethods?: string[];
  /** Notification sink. May throw; the read loop is protected. */
  onNotification?: (notification: JsonRpcNotification) => void;
  /**
   * Server-initiated request handler. MUST resolve exactly one response per
   * request — including for methods we do not support, which get a
   * method-not-found error. Leaving one pending until timeout stalls the turn.
   */
  onServerRequest?: (request: JsonRpcRequest) => Promise<
    { result: unknown } | { error: { code: number; message: string; data?: unknown } }
  >;
  /**
   * Called once when a child exits. `expected` distinguishes a deliberate
   * `shutdown()` from a crash or kill — the manager's restart policy depends on
   * that difference, so it must not have to infer it.
   */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;
  /** Test seam: spawn a fake child instead of the pinned Codex binary. */
  spawnChild?: () => ChildProcessWithoutNullStreams;
  /** Test seam: shrink the outbound queue cap to exercise overflow. */
  maxQueuedWriteBytes?: number;
  /** Test seam: shrink the single-line cap so oversize handling is cheap to test. */
  maxLineBytes?: number;
  /** Test seam: shorten each quarantine exit-wait step so escalation is cheap to test. */
  quarantineExitWaitMs?: number;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One outbound line awaiting the writer. */
interface QueuedWrite {
  line: string;
  bytes: number;
}

/** JSON-RPC method-not-found, for unsupported server-initiated requests. */
export const METHOD_NOT_FOUND = -32601;

/** Everything scoped to a single child process. Replaced wholesale on restart. */
interface ChildGeneration {
  id: number;
  child: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  /** Outbound queue + writer state (one ordered writer per generation). */
  writeQueue: QueuedWrite[];
  queuedBytes: number;
  pumping: boolean;
  /** stderr is drained but NOT logged as content; these are the metrics we keep. */
  stderrBytes: number;
  stderrLines: number;
  /**
   * stderr text retained ONLY until the handshake completes, to make a startup
   * failure diagnosable (auth/config messages, before any prompt exists). Cleared
   * on ready so no turn content is ever held or surfaced.
   */
  earlyStderr: string;
  ready: boolean;
}

/**
 * Resolve the pinned `@openai/codex` launcher.
 *
 * Resolved from OUR dependency graph, never from a global install or the caller's
 * PATH: the runtime version must be the same one the schema-compatibility check
 * ran against, or we would validate one binary and execute another.
 */
export function resolveCodexLauncher(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('@openai/codex/package.json');
  const launcher = path.join(path.dirname(pkgJson), 'bin', 'codex.js');
  if (!fs.existsSync(launcher)) {
    throw new Error(`@openai/codex launcher not found at ${launcher}; run npm install to restore the pinned dependency.`);
  }
  return launcher;
}

export class CodexAppServerClient {
  private state: ClientState = 'stopped';
  private generation: ChildGeneration | null = null;
  private nextGenerationId = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private startPromise: Promise<InitializeResponse> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private initializeResult: InitializeResponse | null = null;
  /** Set when the transport is no longer trustworthy (protocol corruption, exit). */
  private unhealthyReason: string | null = null;
  /** True only while a deliberate shutdown is in flight; reset on every start. */
  private shuttingDown = false;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  getState(): ClientState {
    return this.state;
  }

  /**
    * Ready means ready to CARRY WORK: a generation that has been poisoned is not
    * ready even though its child has not finished dying yet. Reporting health from
    * `state` alone left a window where a caller saw `ready` for a connection whose
    * pending requests had already been rejected.
    */
  isReady(): boolean {
    return this.state === 'ready' && this.unhealthyReason === null;
  }

  getInitializeResult(): InitializeResponse | null {
    return this.initializeResult;
  }

  /**
   * Whether a child of this client is still alive.
   *
   * `state` cannot answer this: `shutdown()` commits 'stopped' whether or not the
   * process actually died, so a caller reading state alone would conclude the child was
   * gone while it still held the pipes. `generation` is cleared by `onChildExit` and
   * nowhere else, which makes `null` the one honest proof that the exit was OBSERVED.
   *
   * The manager needs that proof before it publishes a replacement: two children
   * serving one shared slot is the failure a launch-environment rotation must not
   * produce, and "we asked it to stop" is not evidence that it did.
   */
  hasLiveChild(): boolean {
    return this.generation !== null;
  }

  /**
   * Start the child and complete the handshake. Concurrent callers arriving during
   * `starting` await the SAME promise — they must never spawn a second child.
   *
   * Rejects while a shutdown is in flight: the RFC's shutdown sequence stops
   * accepting work, and racing a spawn against a teardown is exactly how two
   * children end up alive at once. Once shutdown completes, a later start()
   * succeeds and begins a fresh generation.
   */
  async start(): Promise<InitializeResponse> {
    if (this.shutdownPromise) {
      throw new Error('codex app-server is shutting down; not starting a new child');
    }
    // A poisoned generation whose child is still alive must neither be reused nor
    // replaced yet: spawning now would leave two children running, and the dying one
    // still owns the pipes. Wait for its exit, then a later call starts cleanly.
    if (this.unhealthyReason && this.generation) {
      throw new Error(
        `codex app-server generation is failing (${this.unhealthyReason}); waiting for it to exit before restarting`,
      );
    }
    if (this.isReady() && this.initializeResult) return this.initializeResult;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().catch((err) => {
      // Leave the client restartable: a later invocation may succeed (e.g. after
      // the operator fixes auth), so failure must not be terminal for the object.
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<InitializeResponse> {
    this.state = 'starting';
    this.unhealthyReason = null;
    // A fresh generation is not shutting down, whatever happened to the last one.
    this.shuttingDown = false;

    const child = this.options.spawnChild
      ? this.options.spawnChild()
      : spawn(process.execPath, [resolveCodexLauncher(), 'app-server', '--listen', 'stdio://', '--strict-config'], {
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

    const gen: ChildGeneration = {
      id: ++this.nextGenerationId,
      child,
      stdoutBuffer: '',
      writeQueue: [],
      queuedBytes: 0,
      pumping: false,
      stderrBytes: 0,
      stderrLines: 0,
      earlyStderr: '',
      ready: false,
    };
    this.generation = gen;

    logger.info({ pid: child.pid, generation: gen.id }, 'codex_app_server_starting');

    // Drain stderr immediately: an undrained pipe blocks the child once the OS
    // buffer fills, which presents as a hang rather than a diagnostic problem.
    //
    // Content is NOT logged. Codex stderr can echo prompts, tool arguments, and
    // tool output (we have observed apply_patch failures quoting file contents),
    // and the RFC forbids logging those by default. Counters only.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (this.generation?.id !== gen.id) return;
      gen.stderrBytes += Buffer.byteLength(chunk, 'utf8');
      gen.stderrLines += (chunk.match(/\n/g) ?? []).length;
      // Retained only pre-handshake, for startup diagnostics; never after ready.
      if (!gen.ready) gen.earlyStderr = `${gen.earlyStderr}${chunk}`.slice(-4000);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.generation?.id !== gen.id) return;
      this.onStdout(gen, chunk);
    });

    // Process-level and stdin-level errors both invalidate the connection: after
    // either, we cannot know which writes the peer actually received.
    child.on('error', (err) => {
      if (this.generation?.id !== gen.id) return;
      this.failGeneration(gen, `process error: ${err.message}`);
    });
    child.stdin.on('error', (err: Error) => {
      if (this.generation?.id !== gen.id) return;
      // EPIPE here is the normal shape of "the child went away mid-write".
      this.failGeneration(gen, `stdin error: ${err.message}`);
    });
    child.on('exit', (code, signal) => this.onChildExit(gen, code, signal));

    const timer = setTimeout(() => {
      if (this.generation?.id !== gen.id) return;
      this.failAll(`codex app-server did not complete initialization within ${STARTUP_TIMEOUT_MS}ms`);
      this.killChild(gen);
    }, STARTUP_TIMEOUT_MS);

    try {
      const capabilities: InitializeCapabilities = {
        // Structured user input (`item/tool/requestUserInput`) is experimental in
        // this baseline, so it must be opted into.
        experimentalApi: true,
        // REQUIRED by the 0.149.1 schema — not optional, no default. False because
        // ClaudeClaw does not implement `attestation/generate`. Neither field is
        // caller-overridable; both are release invariants.
        requestAttestation: false,
        ...(this.options.optOutNotificationMethods
          ? { optOutNotificationMethods: this.options.optOutNotificationMethods }
          : {}),
      };
      const result = await this.request('initialize', {
        clientInfo: { name: 'claudeclaw', title: 'ClaudeClaw', version: this.options.clientVersion },
        capabilities,
      }, STARTUP_TIMEOUT_MS);

      const initialized = parseInitializeResponse(result);
      this.verifyCodexHome(initialized.codexHome);

      // The handshake spans an await: a shutdown may have begun, or this child may
      // have been superseded, while the initialize response was in flight. Committing
      // 'ready' now would resurrect a connection teardown has already decided to
      // drop, and resolve start() for a child nobody will use.
      this.assertGenerationLive(gen, 'initialization');

      // No `params` member: the 0.149.1 ClientNotification variant has none.
      this.send(gen, { method: CONSUMED_CLIENT_NOTIFICATION });

      // Re-checked after the write as well: shutdown() may have raced the send.
      this.assertGenerationLive(gen, 'initialization');

      gen.ready = true;
      gen.earlyStderr = ''; // past startup: never retain turn-era stderr
      this.initializeResult = initialized;
      this.state = 'ready';
      logger.info(
        {
          pid: child.pid,
          generation: gen.id,
          userAgent: initialized.userAgent,
          platformOs: initialized.platformOs,
          platformFamily: initialized.platformFamily,
        },
        'codex_app_server_ready',
      );
      return initialized;
    } catch (err) {
      this.state = 'failed';
      // Pre-handshake stderr is config/auth diagnostics — no turn has run, so it
      // cannot contain prompt or tool content. Surfacing it here is what makes a
      // startup failure actionable.
      // Pre-handshake stderr cannot contain turn content, but a config or auth
      // failure can still quote a credential or a sensitive path — so it goes through
      // the project's redactor, not just whitespace normalization, before appearing
      // in an error that will be logged.
      const detail = redactString(gen.earlyStderr).trim();
      this.killChild(gen);
      const base = err instanceof Error ? err.message : String(err);
      throw new Error(detail ? `${base} (codex stderr: ${truncate(detail, 500)})` : base);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Throw when this generation must not continue — superseded by a newer child, or
   * overtaken by a deliberate shutdown.
   */
  private assertGenerationLive(gen: ChildGeneration, phase: string): void {
    if (this.generation?.id !== gen.id) {
      throw new Error(`codex app-server ${phase} abandoned: child generation ${gen.id} was superseded`);
    }
    if (this.shuttingDown) {
      throw new Error(`codex app-server ${phase} abandoned: shutdown began while it was in flight`);
    }
    // Health matters as much as identity. A fault raised inside the writer — e.g. the
    // `initialized` notification failing to reach a child that just broke — poisons
    // the generation without changing its id, so an identity-only check would let the
    // handshake overwrite 'failed' with 'ready' and resolve start() for a connection
    // whose handshake never actually completed.
    if (this.unhealthyReason) {
      throw new Error(`codex app-server ${phase} abandoned: ${this.unhealthyReason}`);
    }
  }

  /**
   * The child must be using OUR isolated CODEX_HOME. If it is not, the operator's
   * global `~/.codex/config.toml` — with its own MCP servers and sandbox settings —
   * may be in force, so fail CLOSED rather than run a turn against a boundary we
   * cannot vouch for.
   */
  private verifyCodexHome(reported: string): void {
    const canon = (p: string): string => {
      try { return fs.realpathSync(p); } catch { return path.resolve(p); }
    };
    if (canon(reported) !== canon(this.options.expectedCodexHome)) {
      throw new Error(
        `codex app-server reported CODEX_HOME ${reported}, expected the isolated ${this.options.expectedCodexHome}; refusing to run un-isolated.`,
      );
    }
  }

  /**
   * Send a request and await its response. `timeoutMs` bounds CONTROL requests
   * only — an active turn's lifetime belongs to the caller's AbortController, not
   * to this timeout.
   */
  async request(method: string, params?: unknown, timeoutMs: number = CONTROL_TIMEOUT_MS): Promise<unknown> {
    // Every pre-flight refusal is 'not-sent': nothing has been enqueued, so the child
    // provably never saw this request and the caller may safely give up on it.
    if (this.unhealthyReason) {
      throw new CodexAppServerRequestError(`codex app-server transport unhealthy: ${this.unhealthyReason}`, 'not-sent', method);
    }
    const gen = this.generation;
    if (!gen) throw new CodexAppServerRequestError('codex app-server is not running', 'not-sent', method);
    if (this.shuttingDown) {
      throw new CodexAppServerRequestError('codex app-server is shutting down; not accepting new requests', 'not-sent', method);
    }
    // Only `initialize` may precede readiness; everything else waits for the
    // handshake, per the protocol.
    if (this.state !== 'ready' && method !== 'initialize') {
      throw new CodexAppServerRequestError(`codex app-server not ready (state: ${this.state}); cannot send ${method}`, 'not-sent', method);
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove the entry exactly once, then reject. A timed-out control request
        // does NOT prove the server skipped it, so callers must not replay blindly —
        // hence 'unknown' rather than a bare Error.
        this.pending.delete(id);
        reject(new CodexAppServerRequestError(
          `codex app-server request '${method}' timed out after ${timeoutMs}ms`,
          'unknown',
          method,
        ));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send(gen, { id, method, ...(params === undefined ? {} : { params }) });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        // `send()` throws BEFORE anything is queued (superseded generation, queue over
        // budget), so this line never reached stdin.
        reject(new CodexAppServerRequestError(err instanceof Error ? err.message : String(err), 'not-sent', method));
      }
    });
  }

  /**
   * Enqueue one compact JSON line for this generation's ordered writer.
   *
   * Throws synchronously when the queue is over budget, so the caller's request
   * rejects instead of the backlog growing invisibly. stdin is reserved for
   * protocol JSONL — never write application logs here.
   */
  private send(gen: ChildGeneration, message: Record<string, unknown>): void {
    if (this.generation?.id !== gen.id) {
      throw new Error('codex app-server generation superseded; not writing to a replaced child');
    }
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    const cap = this.options.maxQueuedWriteBytes ?? MAX_QUEUED_WRITE_BYTES;
    if (gen.queuedBytes + bytes > cap) {
      throw new Error(
        `codex app-server outbound queue is full (${gen.queuedBytes + bytes} > ${cap} bytes); the server is not draining stdin`,
      );
    }
    gen.writeQueue.push({ line, bytes });
    gen.queuedBytes += bytes;
    void this.pump(gen);
  }

  /**
   * The single ordered writer for a generation. One pump at a time, strictly FIFO,
   * and it honours backpressure: when `write()` reports the buffer is full it waits
   * for 'drain' before the next line, so message order is preserved and Node's
   * queue does not balloon.
   */
  private async pump(gen: ChildGeneration): Promise<void> {
    if (gen.pumping) return;
    gen.pumping = true;
    try {
      while (gen.writeQueue.length > 0) {
        if (this.generation?.id !== gen.id) return; // superseded mid-drain
        const entry = gen.writeQueue[0];
        let flushed: boolean;
        try {
          flushed = gen.child.stdin.write(entry.line);
        } catch (err) {
          // A failed write means the peer may have missed a request we believe we
          // sent. Clearing the queue and carrying on would leave callers waiting for
          // responses that can never arrive, so fail the generation outright.
          this.failGeneration(gen, `stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        gen.writeQueue.shift();
        gen.queuedBytes -= entry.bytes;
        if (!flushed) await this.waitForDrain(gen);
      }
    } finally {
      gen.pumping = false;
    }
  }

  /** Resolve on 'drain', or immediately if the child goes away (never hang). */
  private waitForDrain(gen: ChildGeneration): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        gen.child.stdin.off('drain', done);
        gen.child.off('exit', done);
        gen.child.off('error', done);
        resolve();
      };
      gen.child.stdin.once('drain', done);
      gen.child.once('exit', done);
      gen.child.once('error', done);
    });
  }

  private onStdout(gen: ChildGeneration, chunk: string): void {
    // A poisoned generation stops reading, full stop. The per-line loop below already
    // bailed mid-chunk, but each new 'data' event re-entered here and carried on
    // parsing — so a fault raised by one message did not stop the next one in the
    // following chunk from being acted on by a connection we had already given up on.
    if (this.unhealthyReason) return;
    gen.stdoutBuffer += chunk;
    let newlineAt: number;
    while ((newlineAt = gen.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = gen.stdoutBuffer.slice(0, newlineAt);
      gen.stdoutBuffer = gen.stdoutBuffer.slice(newlineAt + 1);
      // Every COMPLETE line is measured BEFORE it is parsed. Checking only the
      // unterminated remainder would let a newline-terminated 33 MiB message reach
      // JSON.parse, which is exactly the allocation the cap exists to prevent.
      if (this.exceedsLineCap(gen, line)) return;
      const trimmed = line.trim();
      if (trimmed) this.handleLine(gen, trimmed);
      if (this.unhealthyReason || this.generation?.id !== gen.id) return;
    }
    // Then the pending (unterminated) segment, so an unbounded line that has not yet
    // seen a newline is caught before it can grow further.
    this.exceedsLineCap(gen, gen.stdoutBuffer);
  }

  /** True when `text` is over the single-line byte cap; fails the generation if so. */
  private exceedsLineCap(gen: ChildGeneration, text: string): boolean {
    const cap = this.options.maxLineBytes ?? MAX_LINE_BYTES;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= cap) return false;
    gen.stdoutBuffer = '';
    this.failGeneration(gen, `inbound line exceeded ${cap} bytes (${bytes})`);
    return true;
  }

  private handleLine(gen: ChildGeneration, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A malformed non-empty line is protocol corruption, not a warning: we can no
      // longer trust that we are seeing every terminal event. Routed through
      // failGeneration so queued writes are cleared on this path too.
      this.failGeneration(gen, 'malformed JSON on stdout');
      return;
    }

    const classified = classifyInbound(parsed);
    if (!classified) {
      this.failGeneration(gen, 'inbound message matched no legal JSON-RPC envelope');
      return;
    }

    if (classified.kind === 'response') {
      const { message } = classified;
      // We only ever mint NUMERIC ids, so a string id cannot be one of ours.
      // Coercing it (Number("5") === 5) would let a foreign or malformed response
      // settle an unrelated pending request.
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!pending) {
        // Unknown or duplicate id: log and ignore. Not fatal — a late response to a
        // timed-out request is expected, and killing the transport would punish
        // healthy concurrent turns.
        logger.debug({ id: message.id, generation: gen.id }, 'codex_app_server: response for unknown request id');
        return;
      }
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (isErrorResponse(message)) {
        // An error RESPONSE is a definite answer: the server processed the request and
        // refused it, so no side effect is outstanding.
        pending.reject(new CodexAppServerRequestError(
          `${pending.method} failed: ${message.error.message}`,
          'refused',
          pending.method,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (classified.kind === 'request') {
      void this.handleServerRequest(gen, classified.message);
      return;
    }

    try {
      this.options.onNotification?.(classified.message);
    } catch (err) {
      // A notification we could not hand to anyone is a PROTOCOL fault, not a warning.
      // Logging and reading on left the connection healthy while a terminal event went
      // nowhere, so the turn waiting on it spun until the child happened to die. The
      // sink layer decides what is fatal; reaching here means it already has.
      this.failGeneration(
        gen,
        `notification '${classified.message.method}' could not be handled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Every server-initiated request gets exactly one response — including
   * unsupported methods, which get method-not-found.
   *
   * The handler is async, so the child that asked may be gone by the time we have
   * an answer. Responding down a REPLACEMENT child's stdin would answer whatever
   * unrelated request now holds that id, so a superseded generation's answer is
   * dropped instead.
   */
  private async handleServerRequest(gen: ChildGeneration, request: JsonRpcRequest): Promise<void> {
    let response: Record<string, unknown>;
    try {
      if (!this.options.onServerRequest) {
        logger.warn({ method: request.method }, 'codex_server_request_unexpected: no handler registered');
        response = { id: request.id, error: { code: METHOD_NOT_FOUND, message: `unsupported method: ${request.method}` } };
      } else {
        const handled = await this.options.onServerRequest(request);
        response = { id: request.id, ...handled };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ method: request.method, err: message }, 'codex_app_server: server-request handler failed');
      response = { id: request.id, error: { code: -32603, message } };
    }
    if (this.generation?.id !== gen.id) {
      logger.debug(
        { method: request.method, generation: gen.id },
        'codex_app_server: dropping server-request response for a superseded child',
      );
      return;
    }
    try {
      this.send(gen, response);
    } catch (err) {
      // App Server blocks on its own request until it gets a response. Logging and
      // carrying on leaves it waiting forever, so an unanswerable request is a
      // connection-level failure, not a warning.
      this.failGeneration(
        gen,
        `could not answer server request '${request.method}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Mark this generation unusable, reject its in-flight work, and terminate it.
   * The single path for every unrecoverable transport fault, so none of them can
   * leave the client looking healthy with requests pending.
   */
  private failGeneration(gen: ChildGeneration, reason: string): void {
    if (this.generation?.id !== gen.id) return;
    gen.writeQueue.length = 0;
    gen.queuedBytes = 0;
    this.markUnhealthy(reason);
    this.killChild(gen);
  }

  /**
   * Poison the current generation over a fault raised ABOVE the transport — a
   * notification the sink layer could not honour.
   *
   * Exposed so the sink layer can order the two halves of that failure correctly: the
   * generation must already be unhealthy when the first sink callback runs, or a
   * callback could look at the connection, see `ready`, and start work on a child that
   * is being killed. Letting the exception unwind into `handleLine` would poison it
   * only AFTER every sink had been told.
   *
   * Idempotent, and safe to follow with the throw that reaches `handleLine`.
   */
  failProtocol(reason: string): void {
    const gen = this.generation;
    if (!gen) return;
    this.failGeneration(gen, reason);
  }

  private markUnhealthy(reason: string): void {
    if (this.unhealthyReason) return;
    this.unhealthyReason = reason;
    // Demote NOW, not when the child's exit event eventually arrives. Until this
    // landed, isReady() stayed true and start() handed back the old successful
    // handshake, so recovery could not tell a healthy child from a dying one.
    this.state = 'failed';
    this.initializeResult = null;
    this.startPromise = null;
    logger.error({ reason, pid: this.generation?.child.pid }, 'codex_protocol_error');
    this.failAll(`transport unhealthy: ${reason}`);
  }

  /**
   * Reject every in-flight request exactly once.
   *
   * Always 'unknown': a request rejected because the transport died may already have
   * been written and acted on. Only the pre-flight guards in `request()` can promise
   * a line never left this process.
   */
  private failAll(reason: string): void {
    for (const [id, pending] of [...this.pending.entries()]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerRequestError(`${pending.method}: ${reason}`, 'unknown', pending.method));
    }
  }

  /**
   * A child exited. A STALE generation's exit is logged and otherwise ignored: it
   * must not clear the current child, reject its requests, or overwrite its state.
   */
  private onChildExit(gen: ChildGeneration, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.generation?.id !== gen.id) {
      logger.debug({ code, signal, generation: gen.id }, 'codex_app_server_exit: stale generation, ignoring');
      return;
    }
    const wasReady = this.state === 'ready';
    const expected = this.shuttingDown;
    // A deliberate shutdown ends 'stopped'; anything else is an unexpected exit the
    // manager may lazily restart from. Collapsing the two would make an intentional
    // stop look like a crash.
    this.state = expected ? 'stopped' : 'exited';
    this.generation = null;
    this.startPromise = null;
    this.initializeResult = null;
    gen.writeQueue.length = 0;
    gen.queuedBytes = 0;
    logger.info({ code, signal, wasReady, expected, generation: gen.id }, 'codex_app_server_exit');
    this.failAll(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
    try {
      this.options.onExit?.({ code, signal, expected });
    } catch (err) {
      logger.warn({ err }, 'codex_app_server: exit handler threw');
    }
  }

  private killChild(gen: ChildGeneration, signal?: NodeJS.Signals): void {
    try { gen.child.kill(signal); } catch (err) {
      logger.warn({ err, generation: gen.id, signal }, 'codex_app_server: kill failed');
    }
  }

  /**
   * Quarantine the current generation and WAIT for its child to exit.
   *
   * For the case where a request with SIDE EFFECTS may or may not have been carried
   * out — a `turn/start` that timed out, say. The turn may be running right now, and
   * this connection can neither cancel it (no reliable turn id) nor safely carry
   * anything else: its notifications would arrive with no sink that owns them, and the
   * next caller to take the thread would inherit another turn's output.
   *
   * Routed through `failGeneration` so it is the SAME lifecycle-failure path as
   * protocol corruption: pending requests rejected, queued writes dropped, the
   * generation marked unhealthy so `isReady()` can never report ready again. Then the
   * child is terminated and awaited, because `start()` refuses to replace a poisoned
   * generation whose child is still alive — two children would both own the pipes.
   *
   * Returns true when the child was observed to exit. False means the process outlived
   * even SIGKILL, and the client stays refusing to start: an unkillable child holding
   * an unknown turn is not something to paper over with a fresh one.
   */
  async quarantine(reason: string): Promise<boolean> {
    const gen = this.generation;
    if (!gen) {
      // Nothing to poison: the child is already gone (its exit ran the same cleanup),
      // so there is no live generation an orphaned turn could speak to.
      logger.warn({ reason }, 'codex_app_server_quarantine: no live generation');
      return true;
    }
    logger.error({ reason, pid: gen.child.pid, generation: gen.id }, 'codex_app_server_quarantine');
    const wait = this.options.quarantineExitWaitMs ?? QUARANTINE_EXIT_WAIT_MS;
    const exited = new Promise<void>((resolve) => gen.child.once('exit', () => resolve()));

    this.failGeneration(gen, reason);
    await Promise.race([exited, delay(wait)]);
    if (this.generation?.id !== gen.id) return true; // its exit handler already ran

    logger.warn({ pid: gen.child.pid, generation: gen.id }, 'codex_app_server_quarantine: child ignored termination; escalating');
    this.killChild(gen, 'SIGKILL');
    await Promise.race([exited, delay(wait)]);
    if (this.generation?.id === gen.id) {
      logger.error({ pid: gen.child.pid, generation: gen.id }, 'codex_app_server_quarantine: child survived SIGKILL; refusing to start a replacement');
      return false;
    }
    return true;
  }

  /**
   * Orderly shutdown: stop accepting requests, let in-flight terminal
   * notifications land, close stdin, then terminate if the child outlives its
   * grace period. Interrupting active TURNS is the manager's job — this layer does
   * not know what a turn is.
   *
   * Idempotent, and mutually exclusive with `start()`: concurrent callers share one
   * shutdown, and a start() arriving mid-teardown is refused rather than racing a
   * second child into existence.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown().finally(() => {
      this.shutdownPromise = null;
      // Cleared so a later start() is a clean generation, not "still shutting down".
      this.shuttingDown = false;
    });
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    this.shuttingDown = true;
    const gen = this.generation;
    if (!gen) {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopped';
    const child = gen.child;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    // Give terminal notifications a moment to arrive before closing the pipe.
    await Promise.race([exited, delay(SHUTDOWN_TERMINAL_WAIT_MS)]);
    try { child.stdin.end(); } catch { /* already closed */ }
    await Promise.race([exited, delay(SHUTDOWN_EXIT_WAIT_MS)]);

    if (this.generation?.id === gen.id) {
      logger.warn({ pid: child.pid, generation: gen.id }, 'codex_app_server: child outlived shutdown grace period; terminating');
      this.killChild(gen);
      await Promise.race([exited, delay(SHUTDOWN_EXIT_WAIT_MS)]);
    }
    this.failAll('codex app-server shut down');
  }
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open just to finish a shutdown grace period.
    timer.unref?.();
  });
}
