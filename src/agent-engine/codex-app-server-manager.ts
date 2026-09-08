import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import { logger } from '../logger.js';
import { CodexAppServerClient, METHOD_NOT_FOUND, resolveCodexLauncher } from './codex-app-server-client.js';
import {
  ASK_USER_QUESTION_METHOD,
  SERVER_REQUEST_REFUSED,
  consumedNotificationIdentity,
  deniedServerRequestResult,
  isPinnedServerRequestMethod,
  notificationRoute,
  parseToolUserInputRequest,
  refusedServerRequestReason,
  toolUserInputResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type ToolUserInputRequest,
} from './codex-app-server-protocol.js';

/**
 * Process-scoped state above the raw App Server transport: one warm child, per-thread
 * turn serialization, notification routing, and launch-environment fingerprinting.
 *
 * Why this is a SINGLETON and not adapter state: `EngineFactory` builds a new adapter
 * for every call, so a child held on an adapter instance would silently restore the
 * per-turn process model App Server exists to remove.
 *
 * Cancellation and restart policy live here too, because they are turn-aware and the
 * transport deliberately is not.
 */

/** A sink receives every notification routed to its thread (and later, its turn). */
export interface TurnSink {
  threadId: string;
  /** Bound once `turn/started` names the turn; until then the sink is provisional. */
  turnId: string | null;
  deliver: (notification: JsonRpcNotification) => void;
  /**
   * Answers a structured user question for THIS turn, or resolves null to decline.
   *
   * Lives on the sink so it inherits the sink's lifetime exactly: registered before
   * `turn/start`, bound to the one turn, and gone before the thread lock is released.
   * The manager is process-scoped, so a resolver captured anywhere else would outlive
   * the invocation that owns it and could answer a later caller's question.
   *
   * Absent when the host supplied no interactive resolver — the request is then
   * declined rather than left unanswered.
   *
   * `signal` aborts the moment the question is settled by ANY outcome — an answer, the
   * deadline, the sink going away, a failure. The resolver must use it to stop waiting
   * and drop whatever it attached; settling the App Server response is not enough on
   * its own, because the losing side of that race would otherwise stay pending until a
   * human finally answered a question nobody is listening to.
   */
  askUserQuestion?: (
    request: ToolUserInputRequest,
    signal: AbortSignal,
  ) => Promise<Record<string, string[]> | null>;
}

export interface ManagerOptions {
  /** Scrubbed child environment, already carrying the isolated CODEX_HOME. */
  env: Record<string, string>;
  expectedCodexHome: string;
  clientVersion: string;
  /**
   * Non-secret identity of the file-backed credential state the isolated home will hold —
   * `CodexAuthPlan.identity`, a mode plus a digest.
   *
   * A launch input like any other, because a running child cannot adopt a new login. It is
   * an IDENTITY rather than the credential: raw contents must never reach ManagerOptions,
   * the fingerprint material, a log line, or an error, and a digest is all that is needed to
   * notice a rotation.
   *
   * Additive. It does not replace the environment credentials, CA settings, proxy set,
   * executable identity, isolated home or client version the fingerprint already covers.
   */
  authIdentity?: string;
  /**
   * Non-secret identity of the native Windows sandbox setup mirrored into the
   * isolated home. A changed setup version or credential pair rotates the warm
   * child before the new state is installed.
   */
  sandboxIdentity?: string;
  /**
   * Bring the isolated home's credentials and sandbox metadata into the states
   * named by the launch identities, immediately before this manager's child is built.
   *
   * A hook rather than something the manager does itself, so the manager keeps knowing
   * nothing about config or credential storage. The TIMING is the point: `shared()` has
   * already drained the outgoing generation and observed its child exit by the time a
   * replacement exists, so the first `ready()` on that replacement is the first moment the
   * shared home is nobody's to read. Mutating any earlier would swap credentials out from
   * under turns still running on the old child.
   *
   * Synchronous and called exactly once per child. Throwing means no child is built and the
   * turn fails closed.
   */
  prepareLaunch?: () => void;
  /** Test seam: build a client (real or fake) instead of spawning. */
  createClient?: (options: ConstructorParameters<typeof CodexAppServerClient>[0]) => CodexAppServerClient;
  /** Test seam: replace the manager's own server-request policy wholesale. */
  onServerRequest?: (request: JsonRpcRequest) => Promise<
    { result: unknown } | { error: { code: number; message: string; data?: unknown } }
  >;
  /** Test seam: shorten the ceiling on an interactive question. */
  askUserQuestionTimeoutMs?: number;
  /**
   * Process-wide ceiling on concurrent turns. Defaults to 8 — the same default the
   * config exposes — so a manager built without one is still bounded.
   */
  maxConcurrentTurns?: number;
  /**
   * How long a retirement waits for the turns already running to FINISH before it fails
   * them explicitly. Defaults to 60s.
   *
   * Deliberately NOT part of the launch fingerprint, for the same reason
   * `maxConcurrentTurns` is not: changing the grace does not require a new child, and
   * rotating a manager that is happily serving turns in order to apply it would be the
   * very overlap the grace exists to prevent.
   */
  rotationDrainMs?: number;
}

/** Matches the CODEX_APP_SERVER_MAX_CONCURRENT_TURNS default. */
const DEFAULT_MAX_CONCURRENT_TURNS = 8;

/**
 * How long a retiring manager waits for its active turns before failing them.
 *
 * Generous on purpose. A launch-environment change is rare — a rotated credential, a new
 * CA bundle — and the caller that triggers it is a single message waiting a little
 * longer, whereas the alternative is killing turns that were minutes into real work. It
 * is BOUNDED all the same: a turn blocked on a question nobody will answer would
 * otherwise hold every later invocation for as long as it kept waiting.
 */
const ROTATION_DRAIN_MS = 60_000;

/** How often the drain re-checks. Short: the wait normally ends well inside the grace. */
const DRAIN_POLL_MS = 10;

/**
 * The refusal for the one case with no safe move: the old child is still running and will
 * not die.
 *
 * Raised by BOTH paths that would otherwise free the shared slot — a rotation and a reset
 * — so neither can quietly become the exception. Each leaves the retired manager published,
 * so every later caller fails closed the same way instead of one of them finding an empty
 * slot and starting a second child beside the first.
 */
const UNKILLABLE_CHILD_REFUSAL =
  'the previous codex app-server child could not be terminated, so ClaudeClaw will not run a replacement '
  + 'beside it; restart ClaudeClaw.';

/**
 * Bump when the SHAPE of the launch inputs changes.
 *
 * A digest is only comparable against one that was built the same way. Without this, a
 * structure change that happened to hash to the same value as an older one would reuse a
 * child launched under inputs nobody checked.
 */
const LAUNCH_FINGERPRINT_VERSION = 5;

/**
 * Environment values that decide WHO the child authenticates as.
 *
 * Hashed per key, and never carried as plaintext in the fingerprint material: that
 * material is an ordinary string that can reach a stack trace or a debugger, and a
 * credential must not be in it. The digest still moves when the value rotates, which is
 * the point — tracking only whether a key was PRESENT meant replacing one API key with
 * another reused a child still holding the old credential.
 *
 * Every name was read out of the pinned 0.144.6 binary, not assumed. `OPENAI_API_KEY`,
 * `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` sit adjacent in its string table as one
 * credential lookup sequence; `GH_TOKEN`/`GITHUB_TOKEN` form a second pair; and
 * `CODEX_REFRESH_TOKEN`, `CODEX_CONNECTORS_TOKEN` and
 * `CODEX_GITHUB_PERSONAL_ACCESS_TOKEN` are read individually.
 *
 * `getScrubbedSdkEnv()` already drops `*_TOKEN` and `*_API_KEY` before the child env is
 * built, so most of these are normally absent and contribute a constant. They are listed
 * anyway: a caller may supply `input.env` directly, and a fingerprint that is only correct
 * because something upstream happens to filter its inputs is not a guarantee.
 *
 * NOT listed: `CODEX_AUTH`, which occurs in the binary only as a fixture in its own
 * secret-name validator ("CODEX_AUTH should be a valid secret name") rather than as an
 * environment lookup, and `CODEX_AUTH_API_BASE_URL`, which does not occur at all — the two
 * adjacent strings `CODEX_AUTH` and `API_BASE_URL` merely read as one.
 */
const LAUNCH_SECRET_ENV_KEYS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_REFRESH_TOKEN',
  'CODEX_CONNECTORS_TOKEN',
  'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
] as const;

/**
 * The CA-trust lookup sequence, in the order the pinned 0.144.6 binary consults it.
 *
 * Kept as its own list because it IS a sequence, and a partial one is worse than useless:
 * the first name that resolves decides which roots the child trusts, so omitting later
 * entries means a change to whichever one is actually in force cannot rotate the process.
 * The original list carried only the first three plus `NODE_EXTRA_CA_CERTS`, which left an
 * operator swapping a corporate bundle in through `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`,
 * `PIP_CERT`, `BUNDLE_SSL_CA_CERT` or either casing of the npm cafile silently reusing a
 * child that still trusted the old roots.
 */
const LAUNCH_CA_ENV_KEYS = [
  'CODEX_CA_CERTIFICATE',
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'PIP_CERT',
  'BUNDLE_SSL_CA_CERT',
  'npm_config_cafile',
  'NPM_CONFIG_CAFILE',
  // Not part of the sequence above — a directory of roots rather than a bundle file — but
  // read by the same binary and just as launch-fixed.
  'SSL_CERT_DIR',
] as const;

/**
 * Non-secret environment values the child reads ONCE, when it launches.
 *
 * Four categories, because a launch answers four questions and nothing else here is
 * fixed by it: what we RUN (PATH, CODEX_HOME, CODEX_MANAGED_PACKAGE_ROOT), what we
 * TRUST (`LAUNCH_CA_ENV_KEYS`, spliced in below), where we CONNECT (the proxy set,
 * CODEX_URL), and which account we connect under (OPENAI_ORGANIZATION, plus the
 * credentials above). Provider names were read out of the pinned 0.144.6 executable.
 * Host execution-scope variables are also launch-fixed because native tool children
 * inherit them from this process rather than receiving them in protocol requests.
 *
 * Both letter cases of each proxy variable are listed because POSIX honours both and
 * they can hold different values; on Windows the case-insensitive lookup below collapses
 * them to the one variable that actually exists. The npm cafile pair in the CA list is
 * there for the same reason.
 *
 * Deliberately EXCLUDED, because changing any of them cannot make a RUNNING child wrong:
 * `RUST_LOG` / `RUST_BACKTRACE` (child log verbosity only), `CODEX_SANDBOX` (set BY codex
 * for its own children — an output, not an input), and the undocumented `CODEX_*`
 * internals ClaudeClaw never sets. Excluded for a stronger reason still: every per-TURN
 * setting — model, sandbox mode, reasoning effort, persona, the MCP table, trusted MCP
 * provenance, turn budgets — which travels in protocol requests and must never rotate a
 * process.
 */
const LAUNCH_ENV_KEYS = [
  // Native shell children inherit these from the long-lived App Server process,
  // not from per-turn protocol requests. Rotate on scope changes (including
  // removal) so interactive turns cannot inherit a completed mission's identity.
  'CLAUDECLAW_AGENT_ID',
  'CLAUDECLAW_MISSION_TASK_ID',
  'CLAUDECLAW_MISSION_ACTOR',
  'CLAUDECLAW_MISSION_ENTRY_KEY',
  'CODEX_HOME',
  'PATH',
  'CODEX_MANAGED_PACKAGE_ROOT',
  ...LAUNCH_CA_ENV_KEYS,
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'CODEX_URL',
  'OPENAI_ORGANIZATION',
] as const;

/** The ordered launch inputs a fingerprint is taken over. Never logged as values. */
interface LaunchInputs {
  version: number;
  codexHome: string;
  clientVersion: string;
  executable: Record<string, string | number>;
  authMode: string;
  /** Non-secret identity of the file-backed credential state; '' when unmanaged. */
  authIdentity: string;
  /** Non-secret identity of the native sandbox setup state; '' when unmanaged. */
  sandboxIdentity: string;
  /** Credential key → SHA-256 of its value, or '' when the key is absent. */
  credentials: Record<string, string>;
  environment: Record<string, string>;
}

/**
 * Case-insensitive environment lookup.
 *
 * Windows environment blocks are case-insensitive and Node reports them in the OS's own
 * casing, so a plain object copied out of `process.env` there holds `Path`, not `PATH`.
 * Reading `env.PATH` off that copy returned undefined — which made PATH, the variable
 * deciding which executables the sandboxed shell can find, invisible to the fingerprint
 * on the platform ClaudeClaw actually runs on.
 */
function launchEnvValue(env: Record<string, string>, key: string): string {
  const direct = env[key];
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === lower) return value;
  }
  return '';
}

/** The credential CATEGORY in force, for logs and diffs. A name, never a value. */
function authModeOf(env: Record<string, string>): string {
  if (launchEnvValue(env, 'OPENAI_API_KEY')) return 'api-key';
  if (launchEnvValue(env, 'CODEX_API_KEY')) return 'codex-api-key';
  if (launchEnvValue(env, 'CODEX_ACCESS_TOKEN')) return 'access-token';
  return 'subscription';
}

/**
 * What we are about to RUN, as far as it can be cheaply established.
 *
 * The Node that hosts the launcher, the resolved launcher path, the pinned package
 * version, and the launcher file's size and mtime. An in-place upgrade of
 * `@openai/codex` under a running ClaudeClaw is precisely the change an
 * environment-only fingerprint cannot see, and it swaps the protocol baseline the schema
 * check ran against.
 *
 * Size and mtime rather than a content hash because the executable this launcher reaches
 * is a ~400 MB vendored binary, and hashing it per invocation is not a thing to do for a
 * value that moves about once a month. A reinstall that restores an identical launcher
 * costs one drained restart, which is the cheap side of that trade.
 *
 * A resolution failure is RECORDED, not thrown: a missing launcher already fails at
 * spawn with the actionable message `resolveCodexLauncher()` produces, and raising it
 * from a fingerprint would move that diagnosis somewhere far less obvious.
 *
 * Exported so a test can show these are REAL resolved values rather than the fallback —
 * the difference between a fingerprint that notices an upgrade and one that hashes a
 * constant.
 */
export function executableIdentity(): Record<string, string | number> {
  try {
    const launcher = resolveCodexLauncher();
    const stat = fs.statSync(launcher);
    const require = createRequire(import.meta.url);
    const pkg = require('@openai/codex/package.json') as { version?: string };
    return {
      node: process.execPath,
      launcher,
      codexVersion: pkg.version ?? '<unknown>',
      launcherBytes: stat.size,
      launcherMtimeMs: stat.mtimeMs,
    };
  } catch (err) {
    return {
      node: process.execPath,
      launcher: '<unresolved>',
      codexVersion: '<unresolved>',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Which parts of the launch environment moved, by NAME only.
 *
 * A pair of digests says a rotation happened and nothing about why, which is the one
 * thing an operator needs from the log line. Group and key names are safe to record;
 * values are not, and credentials are compared through their digests so no branch here
 * can reach one.
 */
function changedLaunchGroups(before: LaunchInputs, after: LaunchInputs): string[] {
  const changed: string[] = [];
  if (before.version !== after.version) changed.push('fingerprintVersion');
  if (before.codexHome !== after.codexHome) changed.push('codexHome');
  if (before.clientVersion !== after.clientVersion) changed.push('clientVersion');
  if (JSON.stringify(before.executable) !== JSON.stringify(after.executable)) changed.push('executable');
  if (before.authMode !== after.authMode) changed.push('authMode');
  if (before.authIdentity !== after.authIdentity) changed.push('authIdentity');
  if (before.sandboxIdentity !== after.sandboxIdentity) changed.push('sandboxIdentity');
  for (const key of LAUNCH_SECRET_ENV_KEYS) {
    if (before.credentials[key] !== after.credentials[key]) changed.push(`credential:${key}`);
  }
  for (const key of LAUNCH_ENV_KEYS) {
    if (before.environment[key] !== after.environment[key]) changed.push(`env:${key}`);
  }
  return changed;
}

/**
 * Ceiling on a structured user question.
 *
 * Generous because the thing on the other end is a person, and App Server blocks only
 * this request while it waits — other threads keep running. A shorter
 * `autoResolutionMs` from the server wins, so we never answer after it has given up.
 */
const ASK_USER_QUESTION_TIMEOUT_MS = 10 * 60_000;

/** Sentinel for the question deadline elapsing. */
const QUESTION_TIMED_OUT = Symbol('question-timed-out');

/** Sentinel for the asking turn going away while its question was still open. */
const QUESTION_ABANDONED = Symbol('question-abandoned');

interface QueueEntry {
  run: () => void;
  abandon: (reason: Error) => void;
  signal?: AbortSignal;
}

/**
 * Abort-aware FIFO lock, one queue per thread.
 *
 * App Server allows one active turn per thread, and two concurrent `invoke()` calls on
 * the same thread would make notification routing ambiguous. Different threads still
 * run in parallel, so missions, war-room agents and chats are unaffected.
 */
class ThreadLocks {
  private readonly held = new Set<string>();
  private readonly queues = new Map<string, QueueEntry[]>();

  async acquire(threadId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new AbortError('aborted before acquiring the thread lock');

    if (!this.held.has(threadId)) {
      this.held.add(threadId);
      return () => this.release(threadId);
    }

    return new Promise<() => void>((resolve, reject) => {
      const queue = this.queues.get(threadId) ?? [];
      const entry: QueueEntry = {
        run: () => {
          cleanup();
          resolve(() => this.release(threadId));
        },
        abandon: (reason) => {
          cleanup();
          reject(reason);
        },
        signal,
      };
      const onAbort = (): void => {
        // A caller aborted while queued is removed WITHOUT starting a turn — no
        // request is ever sent, so there is nothing to interrupt or replay.
        const q = this.queues.get(threadId);
        if (q) this.queues.set(threadId, q.filter((e) => e !== entry));
        entry.abandon(new AbortError('aborted while queued for the thread lock'));
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(entry);
      this.queues.set(threadId, queue);
    });
  }

  private release(threadId: string): void {
    const queue = this.queues.get(threadId);
    const next = queue?.shift();
    if (!next) {
      this.held.delete(threadId);
      this.queues.delete(threadId);
      return;
    }
    // Lock stays held; ownership transfers to the next waiter.
    next.run();
  }

  /** Visible for diagnostics: threads currently running a turn. */
  activeCount(): number {
    return this.held.size;
  }
}

/**
 * Process-wide cap on concurrent turns, as an abort-aware FIFO semaphore.
 *
 * Per-thread locking bounds one conversation; this bounds the PROCESS. One warm child
 * serves every thread, so without a ceiling a burst of unrelated missions, war-room
 * agents and chats all reach it at once and the cost lands on the host rather than on
 * the caller that caused it.
 *
 * Acquired BEFORE the per-thread lock, never after. A slot holder may wait on a thread
 * lock, because whoever holds that lock already has a slot and will finish. Reversing
 * it — taking the thread lock and then queueing for a slot — lets a lock holder wait on
 * slot holders who are waiting on that same lock.
 */
class TurnSlots {
  private inUse = 0;
  private closed = false;
  private readonly queue: QueueEntry[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) throw new Error('codex app-server manager is shut down; not starting a new turn');
    if (signal?.aborted) throw new AbortError('aborted before acquiring a turn slot');

    if (this.inUse < this.limit) {
      this.inUse += 1;
      return this.releaser();
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        run: () => {
          cleanup();
          resolve(this.releaser());
        },
        abandon: (reason) => {
          cleanup();
          reject(reason);
        },
        signal,
      };
      const onAbort = (): void => {
        // Queued, so no slot was ever taken and nothing is running: dropping the
        // waiter is the whole of the cleanup.
        const at = this.queue.indexOf(entry);
        if (at >= 0) this.queue.splice(at, 1);
        entry.abandon(new AbortError('aborted while queued for a turn slot'));
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  /**
   * Retire the semaphore: the manager is shutting down or being replaced.
   *
   * Every queued caller is rejected rather than left pending. Without this a waiter
   * outlives the manager it queued on, and the next active holder to finish hands it
   * ownership — at which point a turn belonging to a retired manager runs, and its
   * `ready()` starts a child on a connection nobody is managing any more.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.abandon(new Error('codex app-server manager shut down while this turn was queued for a slot'));
    }
  }

  /** One-shot by construction: a turn's terminal path may run more than once. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // After closure the queue is empty and `acquire` refuses, so there is nobody to
      // hand it to and nobody who could join. The release simply decrements.
      const next = this.closed ? undefined : this.queue.shift();
      // Ownership TRANSFERS rather than the count dropping and being retaken, so a
      // waiter cannot be overtaken by a fresh caller between the two.
      if (next) next.run();
      else this.inUse -= 1;
    };
  }

  /** Visible for diagnostics: turns holding a slot right now. */
  activeCount(): number {
    return this.inUse;
  }

  /** Visible for diagnostics: callers waiting for one. */
  waitingCount(): number {
    return this.queue.length;
  }
}

export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * A notification the sink layer could not honour. Thrown out of the notification
 * callback so the TRANSPORT poisons its generation through the one lifecycle-failure
 * path, rather than the manager reaching into the client to do it by hand.
 */
export class CodexProtocolFault extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CodexProtocolFault';
  }
}

export class CodexAppServerManager {
  private static current: CodexAppServerManager | null = null;

  /**
   * Serializes every `shared()` and `resetShared()` call.
   *
   * The bug this closes: `shared()` used to fire `void current.shutdown()` and publish
   * the replacement in the same tick, so two children were briefly alive at once and the
   * old one's active turns were dropped with no terminal at all. A transition has to be
   * AWAITED, which makes `shared()` async — and that in turn means two callers arriving
   * during one transition must not each start one. They queue here instead: the first
   * performs the rotation, and the rest then find `current` already carrying the
   * fingerprint they asked for and return it. One rotation, one replacement, no overlap.
   *
   * `resetShared()` shares the gate because a reset that raced a rotation was the other
   * half of the same asymmetry — it could null `current` mid-transition and leave the
   * replacement published with nothing pointing at it.
   *
   * Never rejects. A caller's failure is that caller's to handle, and a rejected gate
   * would strand every caller queued behind it.
   */
  private static gate: Promise<void> = Promise.resolve();

  private client: CodexAppServerClient | null = null;
  private readonly locks = new ThreadLocks();
  private readonly slots: TurnSlots;
  /** Provisional sinks keyed by thread, promoted to turn-bound once turn/started. */
  private readonly sinks = new Map<string, TurnSink[]>();
  /**
   * Questions still waiting on a human, keyed by the sink that owns them.
   *
   * A pending question outlives nothing: the moment its turn's sink goes — normal
   * completion, interruption, quarantine, transport failure, shutdown — the request is
   * settled with an empty answer. Otherwise App Server stays blocked on a turn that no
   * longer exists, and an answer tapped afterwards would be delivered to it.
   */
  private readonly questionWaiters = new Map<TurnSink, Set<() => void>>();
  private readonly launchInputs: LaunchInputs;
  private readonly fingerprint: string;
  /**
   * Set the moment a retirement begins, before anything is awaited.
   *
   * A retired manager admits no new turn and builds no new child. Both halves matter
   * during a rotation: the turns already draining must be able to finish on the child
   * they have, and nothing may spawn a second one alongside it.
   */
  private retired = false;
  /** One teardown per manager: the first caller owns it, the rest await this. */
  private shutdownPromise: Promise<void> | null = null;
  /**
   * Whether this manager's child is provably gone.
   *
   * A replacement may not be published while it is false — "we asked it to stop" is not
   * evidence that it stopped, and two children serving one shared slot is the failure
   * rotation exists to prevent.
   */
  private childExited = false;

  constructor(private readonly options: ManagerOptions) {
    this.launchInputs = CodexAppServerManager.launchInputsOf(options);
    this.fingerprint = CodexAppServerManager.digestOf(this.launchInputs);
    this.slots = new TurnSlots(Math.max(1, options.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS));
  }

  /**
   * The process-wide instance.
   *
   * A change to any LAUNCH-CRITICAL input — the isolated home, PATH, a rotated
   * credential, the CA bundle, the proxy set, the executable itself — cannot be applied
   * to a running child, so the instance is replaced rather than left serving turns under
   * an environment it was not built for.
   *
   * ASYNC, and that is the fix rather than an inconvenience. The replacement is not built
   * until the outgoing generation has drained its turns and its child has been observed
   * to exit, so the two never overlap; and every caller arriving during that transition
   * waits on the same rotation instead of racing a competing one. A caller blocked here
   * is a turn that has not started yet, which is exactly the turn that should wait.
   */
  static shared(options: ManagerOptions): Promise<CodexAppServerManager> {
    const queued = CodexAppServerManager.gate.then(() => CodexAppServerManager.rotateShared(options));
    CodexAppServerManager.gate = queued.then(() => {}, () => {});
    return queued;
  }

  /** Test seam + shutdown hook: forget the process-wide instance. */
  static resetShared(): Promise<void> {
    const queued = CodexAppServerManager.gate.then(() => CodexAppServerManager.doResetShared());
    CodexAppServerManager.gate = queued.then(() => {}, () => {});
    return queued;
  }

  /**
   * One transition, start to finish. Runs only under the gate, so it is the only thing
   * touching `current` at any moment.
   */
  private static async rotateShared(options: ManagerOptions): Promise<CodexAppServerManager> {
    const wanted = CodexAppServerManager.fingerprintOf(options);
    const live = CodexAppServerManager.current;

    // The ordinary case: the launch environment has not moved, so the warm child stays.
    // A RETIRED instance never qualifies, whatever its fingerprint says — its child is
    // being torn down and its semaphore is closed.
    if (live && live.fingerprint === wanted && !live.retired) return live;

    if (live) {
      if (live.retired) {
        logger.info({ reason: 'the published manager is already retired' }, 'codex_app_server_restart');
      } else {
        logger.info(
          {
            reason: 'launch environment changed',
            changed: changedLaunchGroups(live.launchInputs, CodexAppServerManager.launchInputsOf(options)),
            activeTurns: live.activeTurnCount(),
            queuedTurns: live.queuedTurnCount(),
          },
          'codex_app_server_restart',
        );
      }
      // AWAITED. The drain, the sink terminals and the child's exit all happen inside
      // this call, and the replacement below is not constructed until they have.
      await live.shutdown();
      // The old child outlived even a forced kill. Publishing a replacement now is the one
      // thing that must not happen, so the slot stays retired — still pointing at `live` —
      // and every later caller gets this same refusal rather than a second child.
      if (!live.childExited) throw new Error(UNKILLABLE_CHILD_REFUSAL);
    }

    CodexAppServerManager.current = new CodexAppServerManager(options);
    return CodexAppServerManager.current;
  }

  /**
   * Release the shared slot.
   *
   * The order here is the same guarantee `rotateShared` makes, and for the same reason.
   * Clearing `current` before confirming the exit was the one way round it: a child that
   * outlived SIGKILL left an EMPTY slot, so the next `shared()` saw nothing published,
   * took the fresh-start path, and spawned a second child beside the one still running.
   *
   * So the teardown is awaited first, and the slot is released only on proof of exit.
   * Otherwise the retired manager stays published and this rejects, which keeps every
   * later caller failing closed in exactly the way a rotation would.
   */
  private static async doResetShared(): Promise<void> {
    const existing = CodexAppServerManager.current;
    if (!existing) return;
    await existing.shutdown();
    if (!existing.childExited) throw new Error(UNKILLABLE_CHILD_REFUSAL);
    CodexAppServerManager.current = null;
  }

  /**
   * Non-secret digest of everything that is fixed when the child launches.
   *
   * Taken over an ORDERED structure via `JSON.stringify`, not a delimiter-joined string.
   * The previous version joined its fields with a literal NUL byte to escape the ambiguity
   * a printable separator carries (`a` + `bc` and `ab` + `c` joining identically) — which
   * worked, and made this file binary to git and grep. JSON gives the same separation for
   * free, since every field is delimited and every value escaped, and leaves the source
   * diffable.
   *
   * No secret reaches the material: credential values are replaced by their own digests
   * first, so a rotation is still detected while the key itself is never in the string.
   *
   * Visible for tests, because the guarantees worth proving are properties of this
   * function — that a rotated key changes the digest, that unchanged inputs do not, and
   * that no credential can be recovered from either.
   */
  static fingerprintOf(options: ManagerOptions): string {
    return CodexAppServerManager.digestOf(CodexAppServerManager.launchInputsOf(options));
  }

  private static digestOf(inputs: LaunchInputs): string {
    // 128 bits. The digest gates nothing but process reuse, and widening it from the
    // previous 64 costs nothing.
    return crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 32);
  }

  private static launchInputsOf(options: ManagerOptions): LaunchInputs {
    const credentials: Record<string, string> = {};
    for (const key of LAUNCH_SECRET_ENV_KEYS) {
      const value = launchEnvValue(options.env, key);
      // Absent and empty collapse to '' deliberately: neither authenticates anything, so
      // they must not read as two different launch environments.
      credentials[key] = value ? crypto.createHash('sha256').update(value).digest('hex') : '';
    }
    const environment: Record<string, string> = {};
    for (const key of LAUNCH_ENV_KEYS) environment[key] = launchEnvValue(options.env, key);
    return {
      version: LAUNCH_FINGERPRINT_VERSION,
      codexHome: options.expectedCodexHome,
      // Travels in the `initialize` handshake as clientInfo.version, so it is fixed for
      // the life of a child in the same way the environment is.
      clientVersion: options.clientVersion,
      executable: executableIdentity(),
      authMode: authModeOf(options.env),
      // Already a non-secret mode-plus-digest when present; '' when the caller does not
      // manage file-backed credentials at all.
      authIdentity: options.authIdentity ?? '',
      sandboxIdentity: options.sandboxIdentity ?? '',
      credentials,
      environment,
    };
  }

  /** Start (or reuse) the warm child. Concurrent callers share one startup. */
  async ready(): Promise<CodexAppServerClient> {
    if (!this.client) {
      // A retired manager NEVER builds a child. A turn still draining keeps using the
      // client it already has — that is precisely what the drain is waiting for — but
      // once that child is gone there is nothing left to finish on, and spawning one
      // here is the overlapping generation rotation exists to prevent.
      if (this.retired) {
        throw new Error('codex app-server manager is shut down; not starting a new child');
      }
      // Credentials are brought into the state the fingerprint names HERE, and nowhere
      // earlier. `shared()` published this manager only after the outgoing generation had
      // drained and its child had been observed to exit, so this is the first moment the
      // shared isolated home is nobody's to read — mutating before the drain would swap the
      // credentials out from under turns still running on the old child.
      //
      // Synchronous, and inside the same block that builds the client, so it runs exactly
      // once per child and no second caller can interleave with it. A throw leaves
      // `this.client` null: no child, no turn, and the next invocation tries again.
      this.options.prepareLaunch?.();
      const build = this.options.createClient ?? ((opts) => new CodexAppServerClient(opts));
      this.client = build({
        env: this.options.env,
        expectedCodexHome: this.options.expectedCodexHome,
        clientVersion: this.options.clientVersion,
        onNotification: (n) => this.route(n),
        // ALWAYS registered. Without a handler every server-initiated request got a
        // generic method-not-found, which for an approval is not a refusal so much as
        // a shrug — and App Server blocks on its own request until something answers.
        onServerRequest: this.options.onServerRequest ?? ((r) => this.handleServerRequest(r)),
        onExit: (info) => {
          logger.info(info, 'codex_app_server_exit (manager)');
          // Drop the reference so the NEXT invocation lazily starts a fresh child.
          // Never restart eagerly here: an idle restart loop would hide a persistent
          // startup failure behind endless respawns.
          this.client = null;
          this.failAllSinks('codex app-server exited');
        },
      });
    }
    await this.client.start();
    return this.client;
  }

  /**
   * Route one notification to the sink that owns it.
   *
   * Three cases, in order of how much identity the payload carries:
   *
   *  - MALFORMED turn identity (a `turn` object with no usable id, or a top-level
   *    `turnId` that disagrees with `turn.id`). Falling back to thread-scoped routing
   *    here is precisely how a terminal for one turn ends a different one.
   *  - A KNOWN turn id. It goes to the sink bound to that turn, and nowhere else. The
   *    single exception is `turn/started`, which is the notification that BINDS a
   *    provisional sink; an unmatched id on anything else names a turn this process
   *    does not own and must not be handed to whichever invocation holds the thread.
   *  - No turn id at all. Only methods we IGNORE reach here — all eight consumed ones
   *    are turn-scoped — so it goes to the thread's sink, which will log it as
   *    unhandled.
   *
   * Whether a routing failure is FATAL turns on the payload, not on the outcome. A
   * notification we consume that arrives WITHOUT the identity the pinned schema
   * requires — or with identity that contradicts itself — is corruption: we can no
   * longer trust that we are seeing every terminal event, and pretending otherwise is
   * what left turns spinning until the child died.
   *
   * A well-formed notification for a turn nobody owns is a different thing entirely.
   * It is the ordinary trace of an abandoned turn on a connection that is on its way
   * out, so it is logged and dropped — never delivered to whichever invocation holds
   * the thread now, and never fatal.
   */
  private route(notification: JsonRpcNotification): void {
    // null for a method we ignore, which may be any shape it likes.
    const identity = consumedNotificationIdentity(notification.method);
    const { threadId, turnId, malformed } = notificationRoute(notification.params);

    if (malformed) {
      if (identity !== null) {
        this.protocolFault(`${notification.method}: turn identity is unusable or self-contradictory`);
      }
      logger.debug({ method: notification.method }, 'codex_app_server: unusable turn identity on an ignored notification');
      return;
    }
    if (!threadId) {
      // All eight consumed methods carry a top-level threadId in 0.144.6. One that
      // does not is not the notification we think it is.
      if (identity !== null) {
        this.protocolFault(`${notification.method} arrived without the threadId its schema requires`);
      }
      logger.debug({ method: notification.method }, 'codex_app_server: notification without a threadId, ignoring');
      return;
    }
    if (identity !== null && !turnId) {
      // All eight are turn-scoped in 0.144.6 — `thread/compacted` and
      // `thread/tokenUsage/updated` included, despite their names. Routing one by
      // thread alone is how one turn's output ends up attributed to another.
      this.protocolFault(`${notification.method} arrived without the turn id its schema requires`);
    }

    const sinks = this.sinks.get(threadId);
    if (!sinks || sinks.length === 0) {
      // NOT a fault. A thread with no sink is the ordinary shape of a turn that has
      // already finished and gone, or of a thread this process is not running.
      logger.debug({ method: notification.method, threadId }, 'codex_app_server: notification for an unknown thread, ignoring');
      return;
    }

    let target: TurnSink | undefined;
    if (turnId) {
      target = sinks.find((s) => s.turnId === turnId);
      if (!target && notification.method === 'turn/started') {
        // Binding. The sink was registered before `turn/start` was sent precisely so
        // this — and the items that follow it — cannot be lost while the response is
        // still in flight. Ambiguous only if the thread somehow holds two unbound
        // sinks, which per-thread serialization does not allow; refuse rather than
        // guess.
        const provisional = sinks.filter((s) => s.turnId === null);
        if (provisional.length === 1) {
          target = provisional[0];
          // Bound HERE, not left to the sink's own handler: routing correctness must
          // not depend on what a sink chooses to do with the notification.
          target.turnId = turnId;
        }
      }
      if (!target) {
        // Well-formed, and for a turn this process does not own — a late terminal or
        // item from a turn that was abandoned. Dropped, with NO thread fallback: the
        // invocation holding the thread now must not inherit it. Not fatal, because a
        // connection being wound down produces exactly this and killing it again
        // would turn routine cleanup into a failed turn for somebody else.
        logger.warn(
          { method: notification.method, threadId, turnId },
          'codex_app_server: notification for a turn no sink owns, dropping',
        );
        return;
      }
    } else {
      // Reachable only for methods we IGNORE: every consumed one is turn-scoped and
      // was already required to name its turn above. Such a notification is handed to
      // the thread's sink so an unrecognized method still shows up in its log, and
      // per-thread serialization means there is normally exactly one to hand it to.
      target = sinks.length === 1
        ? sinks[0]
        : (sinks.find((s) => s.turnId === null) ?? sinks[sinks.length - 1]);
    }

    // The binding must hold in both directions before anything is delivered: the sink
    // we picked has to be the one this notification names, not merely one we found
    // under that key.
    if (target.threadId !== threadId || (turnId !== null && target.turnId !== null && target.turnId !== turnId)) {
      this.protocolFault(
        `${notification.method} (thread ${threadId}, turn ${turnId ?? 'none'}) does not match the sink it routed to `
        + `(thread ${target.threadId}, turn ${target.turnId ?? 'none'})`,
      );
    }

    try {
      target.deliver(notification);
    } catch (err) {
      // The sink rejected it — an unknown terminal status, a turn ref it could not
      // parse. That is the connection telling us something we do not understand about
      // a turn we are running, so it fails the connection rather than the log.
      this.protocolFault(
        `${notification.method} could not be consumed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fail the connection over a notification the sink layer could not honour.
   *
   * The ORDER of the two halves is the whole point:
   *
   *  1. Poison the transport first, synchronously. Every sink callback below runs with
   *     the generation already unhealthy, so none of them can look at the connection,
   *     see `ready`, and start work on a child that is being killed.
   *  2. Only then tell the active turns, once each, with the real reason. Leaving that
   *     to the child's exit would make every turn infer a protocol fault from a
   *     process death.
   *
   * The throw closes the loop: it unwinds into the client's notification callback,
   * which runs the same `failGeneration` path a second time — idempotent by design —
   * and stops the read loop from consuming anything further.
   */
  private protocolFault(reason: string): never {
    logger.error({ reason }, 'codex_notification_protocol_fault');
    this.client?.failProtocol(reason);
    this.failAllSinks(reason);
    throw new CodexProtocolFault(reason);
  }

  /**
   * Answer one server-initiated request. Exactly one response per request id, always.
   *
   * The client contract is that this resolves — never that it succeeds. Every failure
   * mode below collapses to a schema-valid refusal rather than a second response or
   * none: no resolver, the wrong turn, a retired turn, a callback that threw, a
   * deadline, or a cancelled turn.
   */
  private async handleServerRequest(request: JsonRpcRequest): Promise<
    { result: unknown } | { error: { code: number; message: string; data?: unknown } }
  > {
    try {
      return await this.answerServerRequest(request);
    } catch (err) {
      if (err instanceof CodexProtocolFault) {
        // `protocolFault` has already poisoned the generation and told every active
        // turn. The child is going away, so this response is a formality — but the
        // protocol still requires exactly one, so it gets one.
        return { error: { code: SERVER_REQUEST_REFUSED, message: err.message } };
      }
      throw err;
    }
  }

  private async answerServerRequest(request: JsonRpcRequest): Promise<
    { result: unknown } | { error: { code: number; message: string; data?: unknown } }
  > {
    if (request.method === ASK_USER_QUESTION_METHOD) {
      let parsed: ToolUserInputRequest;
      try {
        parsed = parseToolUserInputRequest(request.params);
      } catch (err) {
        // We CLAIM to implement this one. A payload we cannot read is corruption: we
        // would have to guess which turn asked and invent question ids to answer it.
        this.protocolFault(`${request.method}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { result: await this.askExactTurn(parsed) };
    }

    const denial = deniedServerRequestResult(request.method);
    if (denial !== undefined) {
      logger.info({ method: request.method }, 'codex_server_request_denied');
      return { result: denial };
    }

    const refusal = refusedServerRequestReason(request.method);
    if (refusal !== undefined) {
      logger.warn({ method: request.method }, 'codex_server_request_refused');
      return { error: { code: SERVER_REQUEST_REFUSED, message: refusal } };
    }

    if (isPinnedServerRequestMethod(request.method)) {
      // Declared by the pinned union but missing from both tables above. The audit
      // exists to make this unreachable; if it ever fires, an APPLICATION error is the
      // honest answer — method-not-found would claim we do not know the method when in
      // fact nobody decided what to do about it.
      logger.error({ method: request.method }, 'codex_server_request_unclassified');
      return {
        error: {
          code: SERVER_REQUEST_REFUSED,
          message: `ClaudeClaw has no policy for the server request '${request.method}'.`,
        },
      };
    }

    // METHOD-NOT-FOUND is reserved for methods OUTSIDE the pinned eleven — genuinely
    // unknown to this protocol baseline, not merely unimplemented by us.
    logger.warn({ method: request.method }, 'codex_server_request_unknown');
    return { error: { code: METHOD_NOT_FOUND, message: `unsupported method: ${request.method}` } };
  }

  /**
   * Put a question to the resolver of the EXACT turn that asked it.
   *
   * Same fail-closed identity standard as notification routing: thread AND turn must
   * match a live sink that owns a resolver. No latest-turn, thread-only, or
   * sole-active-turn fallback — a question answered by the wrong turn's user is a
   * wrong answer delivered with full confidence.
   */
  private async askExactTurn(request: ToolUserInputRequest): Promise<unknown> {
    const owner = this.sinks.get(request.threadId)?.find((s) => s.turnId === request.turnId && s.askUserQuestion);
    if (!owner?.askUserQuestion) {
      // Retired turn, unknown turn, or a turn whose host offers no interactive UI.
      logger.info(
        { threadId: request.threadId, turnId: request.turnId, questions: request.questions.length },
        'codex_ask_user_question_declined',
      );
      return toolUserInputResponse();
    }

    const ceiling = this.options.askUserQuestionTimeoutMs ?? ASK_USER_QUESTION_TIMEOUT_MS;
    // ANY deadline the server states wins when it is shorter — zero and negative
    // included. Treating a non-positive value as "no deadline" and falling back to the
    // ceiling did the opposite of what the server asked: it held a question open for
    // ten minutes precisely when the server meant to resolve it at once. Clamped at
    // zero so an already-expired deadline reads as immediate rather than negative.
    const budget = request.autoResolutionMs !== null
      ? Math.max(0, Math.min(request.autoResolutionMs, ceiling))
      : ceiling;

    // Three ways this ends, and every losing branch is cleaned up in the `finally`:
    // the timer is cleared so it cannot fire for a settled request, the waiter is
    // unregistered so a later sink removal has nothing stale to settle, and the
    // lifecycle signal is aborted so the resolver side can drop its own listeners
    // instead of waiting for a human who is no longer being asked.
    const lifecycle = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let abandon!: () => void;
    const abandoned = new Promise<typeof QUESTION_ABANDONED>((resolve) => {
      abandon = () => resolve(QUESTION_ABANDONED);
    });
    this.trackQuestion(owner, abandon);

    try {
      const answered = await Promise.race([
        owner.askUserQuestion(request, lifecycle.signal),
        abandoned,
        new Promise<typeof QUESTION_TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(QUESTION_TIMED_OUT), budget);
          timer.unref?.();
        }),
      ]);
      // Whichever of these returns, the request is settled here and now. A human
      // answer arriving afterwards resolves a promise nobody is reading — it cannot
      // produce a second response for this id.
      if (answered === QUESTION_TIMED_OUT) {
        logger.info({ threadId: request.threadId, turnId: request.turnId, budget }, 'codex_ask_user_question_timeout');
        return toolUserInputResponse();
      }
      if (answered === QUESTION_ABANDONED) {
        logger.info({ threadId: request.threadId, turnId: request.turnId }, 'codex_ask_user_question_abandoned');
        return toolUserInputResponse();
      }
      return toolUserInputResponse(answered ?? {});
    } catch (err) {
      // A resolver that throws declines. It must not fail the turn, and it certainly
      // must not leave App Server blocked on an answer that will never come.
      logger.warn(
        { threadId: request.threadId, turnId: request.turnId, err: err instanceof Error ? err.message : String(err) },
        'codex_ask_user_question_failed',
      );
      return toolUserInputResponse();
    } finally {
      // Unconditional: whichever branch won, the question is over. A resolver still
      // holding a UI open, and any listener it attached, learns so here rather than
      // when a human eventually taps or the whole turn aborts.
      lifecycle.abort();
      if (timer) clearTimeout(timer);
      this.untrackQuestion(owner, abandon);
    }
  }

  private trackQuestion(sink: TurnSink, abandon: () => void): void {
    const waiting = this.questionWaiters.get(sink) ?? new Set<() => void>();
    waiting.add(abandon);
    this.questionWaiters.set(sink, waiting);
  }

  private untrackQuestion(sink: TurnSink, abandon: () => void): void {
    const waiting = this.questionWaiters.get(sink);
    if (!waiting) return;
    waiting.delete(abandon);
    if (waiting.size === 0) this.questionWaiters.delete(sink);
  }

  /** Settle every question still open on a sink that is going away. */
  private abandonQuestions(sink: TurnSink): void {
    const waiting = this.questionWaiters.get(sink);
    if (!waiting) return;
    this.questionWaiters.delete(sink);
    for (const abandon of waiting) abandon();
  }

  /** Register a provisional sink BEFORE `turn/start` is sent. */
  addSink(sink: TurnSink): void {
    const sinks = this.sinks.get(sink.threadId) ?? [];
    sinks.push(sink);
    this.sinks.set(sink.threadId, sinks);
  }

  removeSink(sink: TurnSink): void {
    // The turn is over — normally, or by interruption. Any question still on screen
    // for it is settled now rather than left blocking App Server on a turn that has
    // gone; an answer tapped afterwards has nothing to reach.
    this.abandonQuestions(sink);
    const sinks = this.sinks.get(sink.threadId);
    if (!sinks) return;
    const remaining = sinks.filter((s) => s !== sink);
    if (remaining.length === 0) this.sinks.delete(sink.threadId);
    else this.sinks.set(sink.threadId, remaining);
  }

  /**
   * Tell every active sink the connection is gone, exactly once.
   *
   * Snapshotted and CLEARED before the first callback runs, never iterated in place.
   * A callback is arbitrary code: it can register a sink, remove one, or trigger
   * another failure. Iterating the live registry would let a sink added mid-teardown
   * join the round that caused it, and leaving the registry populated would let the
   * child's exit — which follows every protocol fault — hand the same turn a second
   * terminal. Clearing first makes both impossible, and makes the two callers that can
   * fire for one failure collapse into a single delivery.
   */
  private failAllSinks(reason: string): void {
    const snapshot = [...this.sinks.values()].flat();
    this.sinks.clear();
    for (const sink of snapshot) {
      // Before the notice, not after: the connection is gone, so a question waiting on
      // it can never be answered and must not keep the request open.
      this.abandonQuestions(sink);
      try {
        sink.deliver({ method: 'claudeclaw/transportFailed', params: { reason } });
      } catch (err) {
        // Logged, not swallowed: a sink that cannot even accept a failure notice is a
        // turn that will hang, and this line is the only trace of why. Delivery to the
        // others continues regardless.
        logger.error({ err, threadId: sink.threadId, turnId: sink.turnId }, 'codex_app_server: sink rejected its transport failure');
      }
    }
  }

  /**
   * Tear down the whole connection because a turn's fate is UNKNOWN.
   *
   * The caller must still be holding the thread lock: the point is that the poisoned
   * generation is dead and its child has exited BEFORE any other invocation can take
   * the thread, so the unknown turn has nowhere to report to and no successor can
   * inherit its output.
   *
   * The client's exit hook clears `this.client` and tells every remaining sink the
   * transport is gone, so the next `ready()` builds a fresh child. Resolves false when
   * the child could not be killed, in which case `ready()` keeps failing rather than
   * running a second child alongside it.
   */
  async quarantine(reason: string): Promise<boolean> {
    const client = this.client;
    if (!client) return true;
    return client.quarantine(reason);
  }

  /**
   * Take one of the process's turn slots. MUST be acquired before any thread lock.
   *
   * The returned release is one-shot, so a terminal path that runs more than once
   * cannot hand the same slot out twice. Rejects with `AbortError` when the caller
   * cancels — before or while queued — having taken nothing.
   */
  acquireTurnSlot(signal?: AbortSignal): Promise<() => void> {
    return this.slots.acquire(signal);
  }

  /** Serialize turns on one thread; different threads run in parallel. */
  acquireThreadLock(threadId: string, signal?: AbortSignal): Promise<() => void> {
    return this.locks.acquire(threadId, signal);
  }

  activeThreadCount(): number {
    return this.locks.activeCount();
  }

  /** Visible for diagnostics: turns holding a process slot, and callers queued for one. */
  activeTurnCount(): number {
    return this.slots.activeCount();
  }

  queuedTurnCount(): number {
    return this.slots.waitingCount();
  }

  /**
   * Retire this manager: stop admitting turns, let the ones already running finish, then
   * take the child down.
   *
   * Idempotent AND terminal. The first caller owns the teardown and every later one
   * awaits the same promise, so a rotation racing an explicit shutdown cannot produce two
   * teardowns of one child — and a retired manager never comes back.
   *
   * The ORDER is the substance:
   *
   *  1. `retired` first, synchronously, so nothing new can be admitted while the rest of
   *     this runs and `ready()` cannot build a second child.
   *  2. Retire the semaphore. Queued callers are woken with a terminal failure rather
   *     than handed ownership later by the last turn to finish (finding 9), and no slot
   *     is leaked or handed out twice.
   *  3. DRAIN. The turns already running keep going on the still-healthy generation until
   *     they are done. Clearing the sink registry here — which is what this used to do —
   *     dropped them with no terminal at all, so the adapter's loop sat waiting on a
   *     notification that could no longer be routed to it.
   *  4. Only once the grace expires, fail whatever is left through `failAllSinks`: ONE
   *     explicit transport-failure terminal per sink, questions settled first, and the
   *     registry snapshotted-and-cleared so the child's exit cannot deliver a second
   *     (finding 7). Never a silent clear.
   *  5. Then the child: the orderly teardown once, and confirmation of its exit on every
   *     call, escalating to the same forced kill a quarantine uses while it is still
   *     alive. `childExited` records the honest outcome.
   */
  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.doShutdown();
    await this.shutdownPromise;
    // The teardown runs ONCE — draining twice, or asking a child to stop twice, is neither
    // idempotent nor useful. Confirming the exit does not: a kill that failed is worth
    // retrying, because the alternative is a shared slot wedged forever by one unlucky
    // SIGKILL even after the process has since died. `childExited` only moves from false
    // to true, so a caller that already saw success does no work here.
    await this.confirmChildExit();
  }

  private async doShutdown(): Promise<void> {
    this.retired = true;
    this.slots.close();

    if (!(await this.awaitDrain())) {
      logger.warn(
        {
          activeTurns: this.activeTurnCount(),
          strandedSinks: [...this.sinks.values()].flat().length,
          graceMs: this.drainGraceMs(),
        },
        'codex_app_server_drain_expired',
      );
      this.failAllSinks('codex app-server manager was retired before this turn finished');
    }

    if (this.client) await this.client.shutdown();
  }

  /** Establish that no child of this manager is running, forcing the issue if need be. */
  private async confirmChildExit(): Promise<void> {
    if (this.childExited) return;
    const client = this.client;
    if (!client) {
      // Nothing was ever launched, or its exit hook has already cleared the reference:
      // either way no child of this manager is alive.
      this.childExited = true;
      return;
    }
    if (!client.hasLiveChild()) {
      this.childExited = true;
      this.client = null;
      return;
    }
    logger.error({ fingerprint: this.fingerprint }, 'codex_app_server_shutdown_child_alive');
    // The same forced path a quarantine takes — SIGTERM, wait, SIGKILL, wait — and its
    // honest boolean. False means the process outlived even SIGKILL, and neither a
    // replacement nor a released slot may follow while that is true.
    this.childExited = await client.quarantine('child outlived the orderly shutdown');
    if (this.childExited) this.client = null;
  }

  /**
   * Wait for every turn already running to finish. True when they did.
   *
   * BOTH counters matter. A turn holds a process slot from before it registers a sink
   * until after it removes one, so `activeTurnCount()` covers the window where a turn is
   * mid-resume with nothing registered yet, and the sink registry covers anything
   * registered without a slot. Waiting on either alone would call a turn drained while it
   * was still on the wire.
   *
   * Bounded, because the alternative is worse than a forced terminal: a turn blocked on a
   * question nobody will answer would otherwise hold every later invocation forever.
   */
  private async awaitDrain(): Promise<boolean> {
    const until = Date.now() + this.drainGraceMs();
    for (;;) {
      if (this.activeTurnCount() === 0 && this.sinks.size === 0) return true;
      if (Date.now() >= until) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DRAIN_POLL_MS);
        timer.unref?.();
      });
    }
  }

  private drainGraceMs(): number {
    return Math.max(0, this.options.rotationDrainMs ?? ROTATION_DRAIN_MS);
  }
}

/**
 * Re-exported for the adapters that already import it from here.
 *
 * The implementation moved to `codex-home.ts` alongside the credential preparation it
 * belongs with: the SDK adapter had its own near-copy that ALSO prepared auth, and the two
 * had drifted on exactly the thing they must agree about.
 */
export { ensureIsolatedCodexHome } from './codex-home.js';
