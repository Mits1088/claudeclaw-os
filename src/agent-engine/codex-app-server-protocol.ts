/**
 * The NARROW App Server protocol surface ClaudeClaw consumes — deliberately not a
 * port of the generated bindings.
 *
 * `codex app-server generate-ts --experimental` emits 96 files for features we do
 * not touch (realtime audio, marketplace, fs/*, remote control, plugins, …).
 * Committing that would make every Codex upgrade a mass-rename exercise and would
 * imply we validate far more than we do. Instead this file declares only the
 * request/response/notification shapes we actually send or read, and
 * `scripts/check-codex-app-server-schema.ts` regenerates the real schema from the
 * PINNED binary and asserts every method and field named here still exists.
 *
 * Baseline: `@openai/codex` 0.153.2 (direct, exact-pinned dependency).
 *
 * Trust rules for anything arriving from the child (see `isJsonRpcMessage`):
 *  - every inbound line is `unknown` until its envelope is checked;
 *  - an unknown notification method or item type is logged at debug and ignored;
 *  - a NEW optional field must never break a turn;
 *  - a MISSING required field on a method we consume is a protocol error.
 *
 * Verified against the generated 0.153.2 bindings, where the RFC's prose was
 * wrong or incomplete:
 *  - `InitializeCapabilities` requires BOTH `experimentalApi` and
 *    `requestAttestation`; the RFC example sends only the former, which would
 *    fail to deserialize.
 *  - `ClientNotification` for `initialized` is `{ method: "initialized" }` with NO
 *    `params` member; the RFC example sends `params: {}`.
 */

import path from 'path';

/** JSON-RPC id. The generated `RequestId` is `string | number`; we only ever mint numbers. */
export type RequestId = string | number;

/** Methods ClaudeClaw sends. Kept as a const so the schema check can iterate them. */
export const CONSUMED_REQUEST_METHODS = [
  'initialize',
  // Native Windows must prove the elevated containment boundary is ready before
  // ClaudeClaw may create or resume a thread.
  'windowsSandbox/readiness',
  'thread/start',
  'thread/resume',
  // Sent before every resume, and read after it: a thread already loaded in the
  // App Server process is REJOINED by `thread/resume` — which ignores the resume
  // parameters — so the loaded copy is dropped first and the resulting MCP
  // inventory is then read back. See `parseMcpServerStatusPage`.
  'thread/unsubscribe',
  'mcpServerStatus/list',
  'turn/start',
  'turn/interrupt',
] as const;

export type ConsumedRequestMethod = (typeof CONSUMED_REQUEST_METHODS)[number];

/** The only notification ClaudeClaw sends. */
export const CONSUMED_CLIENT_NOTIFICATION = 'initialized' as const;

// ── initialize ───────────────────────────────────────────────────────────────

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

/**
 * Both fields are REQUIRED by the 0.153.2 schema — `requestAttestation` is not
 * optional, so it must be sent explicitly even though the first release declines
 * attestation. Omitting it is a deserialization failure, not a default.
 */
export interface InitializeCapabilities {
  /** Experimental methods/fields (structured user input needs this). */
  experimentalApi: boolean;
  /** `attestation/generate` requests. Always false: we do not implement it. */
  requestAttestation: boolean;
  /** Optional: notification methods the server should suppress for this connection. */
  optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  userAgent: string;
  /** Absolute path to the server's $CODEX_HOME — verified to be our isolated home. */
  codexHome: string;
  /** e.g. "unix" | "windows". */
  platformFamily: string;
  /** e.g. "macos" | "linux" | "windows". */
  platformOs: string;
}

// ── JSON-RPC envelopes ───────────────────────────────────────────────────────

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  id: RequestId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  id: RequestId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * Anything the child may send us: a response to our request, a server-initiated
 * request awaiting our response, or a notification.
 */
export type InboundMessage = JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;

// ── envelope validation ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * Classify one parsed inbound line into exactly one legal shape, or return null.
 *
 * STRICT and mutually exclusive by design. The three legal shapes are:
 *  - response:     `id` + exactly one of `result` | `error`, and no `method`
 *  - request:      `id` + `method`, and neither `result` nor `error`
 *  - notification: `method`, and no `id`
 *
 * Anything else is protocol corruption and the caller must treat it as such. In
 * particular an id-only envelope (`{"id":1}`) must NOT be read as a successful
 * response: that would resolve a pending request with `undefined` and let a
 * caller proceed as though a method it depends on had returned a value. A message
 * we cannot classify may equally be a terminal event we would otherwise drop, so
 * guessing is never the safe option.
 *
 * A server that returns nothing sends `result: null`; presence of the key is
 * therefore required, not optional.
 */
export function classifyInbound(
  value: unknown,
): { kind: 'response'; message: JsonRpcResponse }
  | { kind: 'request'; message: JsonRpcRequest }
  | { kind: 'notification'; message: JsonRpcNotification }
  | null {
  if (!isRecord(value)) return null;
  // A PRESENT but invalid id (`{"id":null,...}`) is corruption, not an absent id.
  // Treating it as a notification would silently reclassify a malformed response or
  // request as fire-and-forget, so the peer would wait forever for an answer.
  if ('id' in value && !isRequestId(value.id)) return null;
  // Same for method: a PRESENT but non-string method (`{"id":1,"method":null,...}`)
  // is corruption. Treating it as absent silently promoted such a message to a valid
  // response, settling a pending request from an envelope we do not understand.
  if ('method' in value && typeof value.method !== 'string') return null;
  const hasId = 'id' in value;
  const hasMethod = 'method' in value;
  const hasResult = 'result' in value;
  const hasError = 'error' in value;

  // request: id + method, and no response payload
  if (hasId && hasMethod) {
    if (hasResult || hasError) return null; // ambiguous: request and response fields
    return { kind: 'request', message: { id: value.id as RequestId, method: value.method as string, params: value.params } };
  }

  // response: id + EXACTLY one of result/error
  if (hasId) {
    if (hasResult === hasError) return null; // neither, or both
    if (hasError) {
      // JSON-RPC requires both members. Inventing a code for a malformed error body
      // would hide the fact that we no longer understand the peer's framing.
      if (!isRecord(value.error)) return null;
      if (typeof value.error.message !== 'string') return null;
      // JSON-RPC error codes are integers; 1.5 or NaN means we are not reading the
      // framing we think we are.
      const code = value.error.code;
      if (typeof code !== 'number' || !Number.isInteger(code)) return null;
      return {
        kind: 'response',
        message: {
          id: value.id as RequestId,
          error: { code, message: value.error.message, data: value.error.data },
        },
      };
    }
    return { kind: 'response', message: { id: value.id as RequestId, result: value.result } };
  }

  // notification: method only
  if (hasMethod) {
    if (hasResult || hasError) return null; // ambiguous
    return { kind: 'notification', message: { method: value.method as string, params: value.params } };
  }
  return null;
}

export function isErrorResponse(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return 'error' in response;
}

/**
 * Validate an `initialize` result. A missing required field on a method we consume
 * is a protocol error: the handshake is where we confirm the runtime is the one we
 * pinned and that it is using OUR isolated CODEX_HOME, so we must not proceed on a
 * half-understood response.
 */
export function parseInitializeResponse(result: unknown): InitializeResponse {
  if (!isRecord(result)) throw new Error('initialize: result is not an object');
  const missing = (['userAgent', 'codexHome', 'platformFamily', 'platformOs'] as const)
    .filter((k) => typeof result[k] !== 'string');
  if (missing.length > 0) {
    throw new Error(`initialize: response missing required string field(s): ${missing.join(', ')}`);
  }
  return {
    userAgent: result.userAgent as string,
    codexHome: result.codexHome as string,
    platformFamily: result.platformFamily as string,
    platformOs: result.platformOs as string,
  };
}

// ── thread + turn lifecycle (v2) ─────────────────────────────────────────────
//
// Verified against the generated 0.153.2 v2 bindings. Two asymmetries matter and
// are easy to get wrong:
//
//  1. The REQUEST takes a sandbox MODE (`sandbox?: SandboxMode`, kebab-case, the
//     same values our capability profile uses) while the RESPONSE returns a
//     tagged sandbox POLICY (`sandbox: SandboxPolicy`, camelCase tags). Requested
//     and effective are therefore different types and must be compared through an
//     explicit mapping, never by string equality.
//  2. `ThreadStartParams` has NO reasoning-effort field. Effort reaches the thread
//     through `config.model_reasoning_effort`, and the response reports it back as
//     `reasoningEffort`. Setting it on `turn/start` instead would place it after
//     the verification point, defeating verify-then-start.

/** Request-side sandbox selector. Same spelling as `CodexCapabilityProfile.sandboxMode`. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Native Windows App Server containment readiness, reported before a thread starts. */
export type WindowsSandboxReadiness = 'ready' | 'notConfigured' | 'updateRequired';

export interface WindowsSandboxStatus {
  status: WindowsSandboxReadiness;
}

/**
 * Response-side effective sandbox. A TAGGED union with camelCase tags — note the
 * fourth variant, `externalSandbox`, which the RFC's three-mode table does not
 * mention: a host applying it has applied something we never requested, so
 * verification must reject it rather than treat it as "close enough".
 */
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: unknown }
  | {
    type: 'workspaceWrite';
    writableRoots: string[];
    networkAccess: boolean;
    excludeTmpdirEnvVar: boolean;
    excludeSlashTmp: boolean;
  };

/**
 * Effective approval policy. `"never"` is the only value ClaudeClaw accepts: there
 * is no interactive approval channel above the engine seam, and the `granular`
 * object variant would silently reintroduce prompts we cannot answer.
 */
export type AskForApproval =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | { granular: Record<string, boolean> };

/** Reasoning effort is a plain string alias in this baseline, not an enum. */
export type ReasoningEffort = string;

export interface ActivePermissionProfile {
  id: string;
  extends: string | null;
}

/** The `thread/start` and `thread/resume` fields ClaudeClaw sends. */
export interface ThreadConfigParams {
  model: string;
  modelProvider: 'openai';
  cwd: string;
  sandbox: SandboxMode;
  approvalPolicy: 'never';
  developerInstructions?: string;
  /** Version-pinned Codex config overrides (hardening, MCP, features, effort). */
  config?: Record<string, unknown>;
}

export interface ThreadStartParams extends ThreadConfigParams {}

export interface ThreadResumeParams extends ThreadConfigParams {
  threadId: string;
  /** ClaudeClaw does not need the historical transcript. */
  excludeTurns: true;
}

/** The identity subset of the returned `thread` object we consume. */
export interface ThreadRef {
  id: string;
}

/**
 * The effective-policy subset of `ThreadStartResponse` / `ThreadResumeResponse`.
 * These are the fields verification reads; the responses carry more (serviceTier,
 * approvalsReviewer, multiAgentMode, …) which the first release does not consume.
 */
export interface EffectiveThreadPolicy {
  thread: ThreadRef;
  model: string;
  modelProvider: string;
  cwd: string;
  runtimeWorkspaceRoots: string[];
  instructionSources: string[];
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
  activePermissionProfile: ActivePermissionProfile | null;
  reasoningEffort: ReasoningEffort | null;
}

/** One `turn/start` input element. `text_elements` is snake_case and required. */
export type UserInput = { type: 'text'; text: string; text_elements: [] };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/** Build the single text input element for a prompt. */
export function textInput(prompt: string): UserInput[] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

// ── runtime validation of thread start/resume results ────────────────────────

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Validate the exact `windowsSandbox/readiness` response consumed by ClaudeClaw. */
export function parseWindowsSandboxReadiness(
  result: unknown,
  where = 'windowsSandbox/readiness',
): WindowsSandboxStatus {
  if (!isRecord(result)) throw new Error(`${where}: result is not an object`);
  if (
    result.status !== 'ready'
    && result.status !== 'notConfigured'
    && result.status !== 'updateRequired'
  ) {
    throw new Error(`${where}: unknown status "${String(result.status)}"`);
  }
  return { status: result.status };
}

/**
 * Every path the host reports must be ABSOLUTE.
 *
 * A relative value like `"."` would be resolved by the comparison helpers against the
 * ClaudeClaw process's own working directory — not the agent's — so a response could
 * name one directory and be verified against another. The schema declares these as
 * `AbsolutePathBuf`; this enforces it on the wire.
 */
function assertAbsolutePaths(paths: string[], where: string): void {
  const relative = paths.filter((p) => !path.isAbsolute(p));
  if (relative.length > 0) {
    throw new Error(`${where}: contains non-absolute path(s): ${relative.join(', ')}`);
  }
}

function parseSandboxPolicy(value: unknown, where: string): SandboxPolicy {
  if (!isRecord(value)) throw new Error(`${where}: sandbox is not an object`);
  const tag = value.type;
  if (typeof tag !== 'string') throw new Error(`${where}: sandbox.type is not a string`);
  switch (tag) {
    case 'dangerFullAccess':
      return { type: 'dangerFullAccess' };
    case 'readOnly': {
      if (typeof value.networkAccess !== 'boolean') {
        throw new Error(`${where}: readOnly sandbox is missing boolean networkAccess`);
      }
      return { type: 'readOnly', networkAccess: value.networkAccess };
    }
    case 'workspaceWrite': {
      if (!isStringArray(value.writableRoots)) {
        throw new Error(`${where}: workspaceWrite sandbox is missing string[] writableRoots`);
      }
      assertAbsolutePaths(value.writableRoots, `${where}: workspaceWrite writableRoots`);
      for (const field of ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'] as const) {
        if (typeof value[field] !== 'boolean') {
          throw new Error(`${where}: workspaceWrite sandbox is missing boolean ${field}`);
        }
      }
      return {
        type: 'workspaceWrite',
        writableRoots: value.writableRoots,
        networkAccess: value.networkAccess as boolean,
        excludeTmpdirEnvVar: value.excludeTmpdirEnvVar as boolean,
        excludeSlashTmp: value.excludeSlashTmp as boolean,
      };
    }
    case 'externalSandbox':
      // Never requested by ClaudeClaw. Parsed (rather than rejected here) so that
      // verification can report it as the policy mismatch it is, with the tag named.
      return { type: 'externalSandbox', networkAccess: value.networkAccess };
    default:
      throw new Error(`${where}: unknown sandbox type "${tag}"`);
  }
}

function parseApprovalPolicy(value: unknown, where: string): AskForApproval {
  if (typeof value === 'string') {
    if (value === 'untrusted' || value === 'on-request' || value === 'never') return value;
    throw new Error(`${where}: unknown approvalPolicy "${value}"`);
  }
  if (isRecord(value) && isRecord(value.granular)) {
    const granular: Record<string, boolean> = {};
    for (const [key, flag] of Object.entries(value.granular)) {
      // Reject rather than drop: a non-boolean flag means we are not reading the
      // approval shape we think we are, and silently discarding it would let a turn
      // proceed against a policy we only partly understood.
      if (typeof flag !== 'boolean') {
        throw new Error(`${where}: approvalPolicy.granular.${key} is not a boolean`);
      }
      granular[key] = flag;
    }
    return { granular };
  }
  throw new Error(`${where}: approvalPolicy is neither a known string nor a granular object`);
}

/**
 * Validate a `thread/start` / `thread/resume` result at RUNTIME.
 *
 * The transport returns `unknown`, and a TypeScript interface asserts nothing about
 * the bytes on the wire. Every field effective-policy verification depends on is
 * checked here, because a drifted or hostile response that merely *looks* close
 * enough would otherwise be compared field-by-field against `undefined` and could
 * pass verification while the real policy is unknown.
 *
 * A missing or wrongly-typed consumed field is a protocol error, not a warning.
 * Fields we do not consume (serviceTier, approvalsReviewer, multiAgentMode, …) are
 * ignored, so new optional fields never break a turn.
 */
export function parseEffectiveThreadPolicy(result: unknown, where = 'thread policy'): EffectiveThreadPolicy {
  if (!isRecord(result)) throw new Error(`${where}: result is not an object`);

  if (!isRecord(result.thread) || typeof result.thread.id !== 'string' || result.thread.id === '') {
    throw new Error(`${where}: thread.id is missing or not a non-empty string`);
  }
  for (const field of ['model', 'modelProvider', 'cwd'] as const) {
    if (typeof result[field] !== 'string' || result[field] === '') {
      throw new Error(`${where}: ${field} is missing or not a non-empty string`);
    }
  }
  if (!isStringArray(result.runtimeWorkspaceRoots)) {
    throw new Error(`${where}: runtimeWorkspaceRoots is not a string[]`);
  }
  assertAbsolutePaths(result.runtimeWorkspaceRoots, `${where}: runtimeWorkspaceRoots`);
  if (!isStringArray(result.instructionSources)) {
    throw new Error(`${where}: instructionSources is not a string[]`);
  }

  // `reasoningEffort` and `activePermissionProfile` are REQUIRED members with nullable
  // types in 0.153.2, so an absent key is not the same as an explicit null. Treating
  // it as null would let a response that simply omits the profile bypass the
  // mandatory "must be null" verification rule.
  if (!('reasoningEffort' in result)) {
    throw new Error(`${where}: reasoningEffort is absent (it is required, and nullable — send null, not nothing)`);
  }
  const reasoningEffort = result.reasoningEffort;
  if (reasoningEffort !== null && typeof reasoningEffort !== 'string') {
    throw new Error(`${where}: reasoningEffort is neither a string nor null`);
  }

  if (!('activePermissionProfile' in result)) {
    throw new Error(`${where}: activePermissionProfile is absent (it is required, and nullable — send null, not nothing)`);
  }
  const profileRaw = result.activePermissionProfile;
  let activePermissionProfile: ActivePermissionProfile | null = null;
  if (profileRaw !== null) {
    if (!isRecord(profileRaw) || typeof profileRaw.id !== 'string') {
      throw new Error(`${where}: activePermissionProfile is neither null nor an object with a string id`);
    }
    // `extends` is likewise required and nullable. Coercing an absent or malformed
    // value to null would erase the fact that this profile inherits from something we
    // could not identify.
    if (!('extends' in profileRaw)) {
      throw new Error(`${where}: activePermissionProfile.extends is absent (it is required, and nullable)`);
    }
    if (profileRaw.extends !== null && typeof profileRaw.extends !== 'string') {
      throw new Error(`${where}: activePermissionProfile.extends is neither a string nor null`);
    }
    activePermissionProfile = { id: profileRaw.id, extends: profileRaw.extends };
  }

  const cwd = result.cwd as string;
  if (!path.isAbsolute(cwd)) {
    throw new Error(`${where}: cwd "${cwd}" is not absolute`);
  }

  return {
    thread: { id: result.thread.id },
    model: result.model as string,
    modelProvider: result.modelProvider as string,
    cwd,
    runtimeWorkspaceRoots: result.runtimeWorkspaceRoots,
    instructionSources: result.instructionSources,
    approvalPolicy: parseApprovalPolicy(result.approvalPolicy, where),
    sandbox: parseSandboxPolicy(result.sandbox, where),
    activePermissionProfile,
    reasoningEffort,
  };
}

// ── effective MCP inventory (mcpServerStatus/list) ───────────────────────────
//
// The only thread-scoped view of which MCP servers a thread can actually reach.
// `thread/start` and `thread/resume` report the effective SANDBOX policy but say
// nothing about MCP, so this is what closes that gap: `{ threadId }` scopes the
// answer to one thread (without it the reply describes the config-file set, which
// is empty in our isolated CODEX_HOME).
//
// `detail: 'toolsAndAuthOnly'` is deliberate — the names are all verification
// needs, and the heavier `full` detail additionally pulls resources and templates.

/** Params for one page of `mcpServerStatus/list`. */
export interface McpServerStatusListParams {
  threadId: string;
  detail: 'toolsAndAuthOnly';
  cursor?: string;
}

/** One page of effective MCP server names, plus the cursor to continue from. */
export interface McpServerStatusPage {
  names: string[];
  nextCursor: string | null;
}

/**
 * Validate one `mcpServerStatus/list` page at RUNTIME.
 *
 * STRICT on purpose: this response is the evidence a resumed thread carries only
 * the MCP servers the current caller authorized. An entry we cannot read is not a
 * server we may ignore — silently dropping it would turn an unreadable inventory
 * into an apparently clean one, which is the exact failure this check exists to
 * prevent. Same for `nextCursor`: a page we cannot continue from is a partial
 * inventory, so its absence is an error rather than "no more pages".
 *
 * `null` is the ONLY end-of-inventory signal. An empty string is rejected rather
 * than accepted as falsy: `""` is a cursor the caller cannot continue from, and
 * reading it as "last page" would silently turn a truncated inventory into a
 * complete-looking one — a check that passes while proving nothing.
 */
export function parseMcpServerStatusPage(result: unknown, where = 'mcpServerStatus/list'): McpServerStatusPage {
  if (!isRecord(result)) throw new Error(`${where}: result is not an object`);
  if (!Array.isArray(result.data)) throw new Error(`${where}: data is not an array`);
  const names: string[] = [];
  for (const entry of result.data) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') {
      throw new Error(`${where}: an entry has no non-empty string name; the effective MCP inventory cannot be read`);
    }
    names.push(entry.name);
  }
  if (!('nextCursor' in result)) {
    throw new Error(`${where}: nextCursor is absent (it is required, and nullable — send null, not nothing)`);
  }
  const cursor = result.nextCursor;
  if (cursor !== null && typeof cursor !== 'string') {
    throw new Error(`${where}: nextCursor is neither a string nor null`);
  }
  if (cursor === '') {
    throw new Error(
      `${where}: nextCursor is an empty string; only null ends the inventory, `
      + 'and an empty cursor cannot be continued from',
    );
  }
  return { names, nextCursor: cursor };
}

/**
 * Read the status off a `thread/unsubscribe` reply for logging only.
 *
 * Deliberately lenient: the unsubscribe is a best-effort step before a resume, and
 * the MCP inventory read AFTER the resume is what actually gates the turn. An
 * unreadable status must not fail a turn that is then proven safe anyway.
 */
export function unsubscribeStatus(result: unknown): string {
  if (isRecord(result) && typeof result.status === 'string') return result.status;
  return 'unknown';
}

// ── server-initiated requests ────────────────────────────────────────────────
//
// The pinned 0.153.2 `ServerRequest` union has ELEVEN variants. ClaudeClaw answers
// exactly one of them with real content — the structured user question — and every
// other one with a schema-valid refusal. Answering nothing was the previous behaviour
// and it is not neutral: App Server blocks on its own request until a response
// arrives, and a generic method-not-found for an approval is a different thing from
// a considered denial.
//
// The table below is transcribed from the generated types, not from method names in
// newer Codex releases. Each entry names the response type it satisfies.

/** The one server-initiated method ClaudeClaw implements. */
export const ASK_USER_QUESTION_METHOD = 'item/tool/requestUserInput';

/** JSON-RPC application error for a request we refuse on principle. */
export const SERVER_REQUEST_REFUSED = -32000;

/**
 * Every method the pinned 0.153.2 `ServerRequest` union can deliver, in schema order.
 *
 * ALL of them are classified below — supported, denied, or refused. That completeness
 * is the point: a variant nobody decided about would fall through to method-not-found,
 * which for an authority-bearing request is a shrug dressed as a refusal. The schema
 * audit compares this list against the generated union in both directions, so a new
 * variant fails the check rather than quietly acquiring a default.
 */
export const SERVER_REQUEST_METHODS: readonly string[] = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
];

const SERVER_REQUEST_METHOD_SET: ReadonlySet<string> = new Set(SERVER_REQUEST_METHODS);

/** True for a method the pinned union declares. Anything else is genuinely unknown. */
export function isPinnedServerRequestMethod(method: string): boolean {
  return SERVER_REQUEST_METHOD_SET.has(method);
}

/**
 * Schema-valid REFUSALS, keyed by method. Each value satisfies that method's response
 * type while granting nothing:
 *
 *  - `item/commandExecution/requestApproval` → `CommandExecutionRequestApprovalResponse`
 *    `{ decision: CommandExecutionApprovalDecision }`, and `"decline"` is a variant.
 *  - `item/fileChange/requestApproval` → `FileChangeRequestApprovalResponse`, same shape
 *    with `FileChangeApprovalDecision`.
 *  - `item/permissions/requestApproval` → `PermissionsRequestApprovalResponse`
 *    `{ permissions: GrantedPermissionProfile, scope: PermissionGrantScope }`. This one
 *    has NO decline variant, so the refusal is an EMPTY grant: both members of
 *    `GrantedPermissionProfile` are optional, and `"turn"` is the narrowest scope.
 *  - `mcpServer/elicitation/request` → `McpServerElicitationRequestResponse`
 *    `{ action, content, _meta }`, and `"decline"` is an `McpServerElicitationAction`.
 *  - `item/tool/call` → `DynamicToolCallResponse` `{ contentItems, success }`. ClaudeClaw
 *    declares no dynamic tools, so the denial is an empty, unsuccessful result: the
 *    model is told the call did not happen rather than the connection erroring.
 *  - `applyPatchApproval` / `execCommandApproval` are the LEGACY approval methods; both
 *    answer `{ decision: ReviewDecision }`, where `"denied"` is a variant.
 *
 * Every one is a denial. The turn runs under `approvalPolicy: "never"` and a sandbox
 * the adapter verified before the prompt was sent; a callback that could say yes would
 * be a second, unverified way to grant exactly the authority that verification exists
 * to pin down.
 */
const SERVER_REQUEST_DENIALS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['item/commandExecution/requestApproval', { decision: 'decline' }],
  ['item/fileChange/requestApproval', { decision: 'decline' }],
  ['item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
  ['mcpServer/elicitation/request', { action: 'decline', content: null, _meta: null }],
  ['item/tool/call', { contentItems: [], success: false }],
  ['applyPatchApproval', { decision: 'denied' }],
  ['execCommandApproval', { decision: 'denied' }],
]);

/**
 * Methods answered with a JSON-RPC ERROR because no honest result exists.
 *
 * Their response types demand something we cannot produce without either fabricating
 * it or handing out a credential: `ChatgptAuthTokensRefreshResponse` requires a real
 * `accessToken`, and `AttestationGenerateResponse` a real `token`. There is no empty
 * or negative variant of either, so a result would be a lie. The messages are written
 * for an operator reading a log — they never carry token material.
 */
const SERVER_REQUEST_REFUSALS: ReadonlyMap<string, string> = new Map([
  [
    'account/chatgptAuthTokens/refresh',
    'ClaudeClaw does not hold ChatGPT auth tokens and cannot refresh them. '
    + 'Run `codex login` on the host, or set OPENAI_API_KEY, then restart ClaudeClaw.',
  ],
  [
    'attestation/generate',
    'ClaudeClaw declared requestAttestation: false at initialize and does not implement attestation.',
  ],
  [
    // Known, harmless, and deliberately not implemented. An APPLICATION refusal, not
    // method-not-found: the method exists in the pinned union and this is a decision,
    // not a gap. Supporting it is a small, separate change.
    'currentTime/read',
    'ClaudeClaw does not implement currentTime/read on the App Server transport.',
  ],
]);

/** The schema-valid denial for `method`, or undefined if it is not one we deny. */
export function deniedServerRequestResult(method: string): unknown | undefined {
  return SERVER_REQUEST_DENIALS.get(method);
}

/** Why `method` is refused with an error, or undefined if it is not one we refuse. */
export function refusedServerRequestReason(method: string): string | undefined {
  return SERVER_REQUEST_REFUSALS.get(method);
}

/** One selectable option on a structured user question. */
export interface ToolUserInputOption {
  label: string;
  description: string;
}

/** One question from `ToolRequestUserInputQuestion`. */
export interface ToolUserInputQuestion {
  id: string;
  header: string;
  question: string;
  /** The question invites free text beyond the listed options. */
  isOther: boolean;
  /** The answer is sensitive. ClaudeClaw never routes one of these to a chat UI. */
  isSecret: boolean;
  options: ToolUserInputOption[];
}

/** `ToolRequestUserInputParams`, validated. */
export interface ToolUserInputRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolUserInputQuestion[];
  /** The server's own deadline, when it set one. */
  autoResolutionMs: number | null;
}

/**
 * Parse `ToolRequestUserInputParams` STRICTLY.
 *
 * This is the one server-initiated method ClaudeClaw claims to implement, so a payload
 * it cannot read is protocol corruption rather than a question to decline: routing it
 * would mean guessing which turn asked, and answering it would mean inventing question
 * ids. Throws, and the caller routes that through the generation-failure lifecycle.
 */
export function parseToolUserInputRequest(params: unknown): ToolUserInputRequest {
  const where = ASK_USER_QUESTION_METHOD;
  if (!isRecord(params)) throw new Error(`${where}: params is not an object`);
  const threadId = nonEmptyString(params.threadId);
  const turnId = nonEmptyString(params.turnId);
  const itemId = nonEmptyString(params.itemId);
  if (!threadId) throw new Error(`${where}: threadId is missing or not a non-empty string`);
  if (!turnId) throw new Error(`${where}: turnId is missing or not a non-empty string`);
  if (!itemId) throw new Error(`${where}: itemId is missing or not a non-empty string`);
  if (!Array.isArray(params.questions)) throw new Error(`${where}: questions is not an array`);

  // Nothing below defaults, coerces, or filters. A question we half-understand is one
  // we would put to a human in words the model did not choose, and a malformed
  // `isSecret` in particular decides whether a credential reaches a chat UI. Every
  // field is required by the generated type, so anything else is corruption.
  const seen = new Set<string>();
  const questions = params.questions.map((raw, index) => {
    const at = `${where}: questions[${index}]`;
    if (!isRecord(raw)) throw new Error(`${at} is not an object`);
    const id = nonEmptyString(raw.id);
    if (!id) throw new Error(`${at}.id is missing or not a non-empty string`);
    // Answers come back keyed by id. Duplicates make the mapping ambiguous in both
    // directions, so there is no answer we could return that is certainly right.
    if (seen.has(id)) throw new Error(`${where}: duplicate question id "${id}"`);
    seen.add(id);
    if (typeof raw.header !== 'string') throw new Error(`${at}.header is not a string`);
    if (typeof raw.question !== 'string') throw new Error(`${at}.question is not a string`);
    if (typeof raw.isOther !== 'boolean') throw new Error(`${at}.isOther is not a boolean`);
    if (typeof raw.isSecret !== 'boolean') throw new Error(`${at}.isSecret is not a boolean`);
    // Nullable in the schema: a question with no options is free-text only.
    if (raw.options !== null && !Array.isArray(raw.options)) {
      throw new Error(`${at}.options is neither an array nor null`);
    }
    const options = (raw.options ?? []).map((option: unknown, oi: number) => {
      if (!isRecord(option)) throw new Error(`${at}.options[${oi}] is not an object`);
      if (typeof option.label !== 'string') throw new Error(`${at}.options[${oi}].label is not a string`);
      if (typeof option.description !== 'string') throw new Error(`${at}.options[${oi}].description is not a string`);
      return { label: option.label, description: option.description };
    });
    return { id, header: raw.header, question: raw.question, isOther: raw.isOther, isSecret: raw.isSecret, options };
  });

  const auto = params.autoResolutionMs;
  if (auto !== null && !(typeof auto === 'number' && Number.isFinite(auto))) {
    // Required and nullable. Reading a bad value as "no deadline" would silently
    // extend a question the server means to auto-resolve.
    throw new Error(`${where}: autoResolutionMs is neither a finite number nor null`);
  }

  return { threadId, turnId, itemId, questions, autoResolutionMs: auto };
}

/**
 * A `ToolRequestUserInputResponse` carrying the given answers, keyed by QUESTION ID.
 *
 * An empty map is the decline: the response type is
 * `{ answers: { [id]?: { answers: string[] } } }` with optional values, so omitting a
 * question is how "not answered" is expressed. There is no separate cancel variant,
 * which is why every failure path here — no resolver, timeout, cancellation, a
 * callback that threw — collapses to the same shape.
 */
export function toolUserInputResponse(answers: Record<string, string[]> = {}): {
  answers: Record<string, { answers: string[] }>;
} {
  const out: Record<string, { answers: string[] }> = {};
  for (const [id, selected] of Object.entries(answers)) out[id] = { answers: selected };
  return { answers: out };
}

// ── notifications ────────────────────────────────────────────────────────────
//
// Item type tags are camelCase here (`agentMessage`, `commandExecution`), unlike the
// SDK transport's snake_case (`agent_message`, `command_execution`). Translating one
// adapter's mapping table across to the other would silently drop every progress
// event, so the two stay separate.

/**
 * Where each notification the adapter consumes carries its turn id, per the pinned
 * 0.153.2 generated types:
 *
 *  - `'nested'` — as `turn.id`, with NO top-level `turnId` (the lifecycle pair);
 *  - `'top'` — as the top-level `turnId`.
 *
 * Every one of the eight requires BOTH a top-level `threadId` and a turn id. Despite
 * their names, `thread/compacted` and `thread/tokenUsage/updated` are turn-scoped too:
 * their generated types require `turnId`, so treating them as thread-scoped would let
 * one turn's compaction or token report be attributed to another.
 * `notificationRoute()` normalizes 'nested' and 'top', so routing only has to ask
 * WHETHER a turn id is required — but the distinction is recorded because it is the
 * schema fact behind the requirement.
 *
 * `thread/started` is deliberately absent. It identifies its thread as
 * `params.thread.id` rather than a top-level `threadId`, and the adapter does not act
 * on it — listing it would demand a routing identity it does not have and make every
 * one of them fatal. Add it back only alongside handling that reads `thread.id`.
 */
const CONSUMED_NOTIFICATION_IDENTITY: ReadonlyMap<string, 'nested' | 'top'> = new Map([
  ['turn/started', 'nested'],
  ['turn/completed', 'nested'],
  ['turn/plan/updated', 'top'],
  ['item/started', 'top'],
  ['item/completed', 'top'],
  ['item/agentMessage/delta', 'top'],
  ['thread/compacted', 'top'],
  ['thread/tokenUsage/updated', 'top'],
]);

/** Notification methods the adapter consumes. Anything else is logged and ignored. */
export const CONSUMED_NOTIFICATIONS: readonly string[] = [...CONSUMED_NOTIFICATION_IDENTITY.keys()];

/**
 * The routing identity this notification must carry, or `null` if we do not consume it.
 *
 * This is the line between "we depend on this" and "we ignore this", and it decides
 * whether an unusable payload is a protocol fault or a shrug.
 * `remoteControl/status/changed` turning up in a shape we do not recognize costs
 * nothing; a `turn/completed` we cannot route means we no longer know whether the turn
 * ended, and the turn waiting on it never finds out either.
 */
export function consumedNotificationIdentity(method: string): 'nested' | 'top' | null {
  return CONSUMED_NOTIFICATION_IDENTITY.get(method) ?? null;
}

/**
 * `ThreadItem` variants that are NOT tool use, per the pinned 0.153.2 union.
 *
 * Stated as an EXCLUSION list on purpose. This backs the `maxToolItems: 0` backstop,
 * where the question is "did a turn that authorized no tools use one" — so a variant
 * nobody has classified must read as a tool, not as harmless. An inclusion list would
 * silently stop enforcing the moment Codex added a new way to act on the world; this
 * way a new variant fails a tool-less turn closed and the mistake is visible.
 *
 * What is here and why: `userMessage` and `hookPrompt` are input echoed back;
 * `agentMessage` is assistant text; `plan` and `reasoning` are the model narrating;
 * `enteredReviewMode`/`exitedReviewMode` are mode transitions; `contextCompaction` is
 * housekeeping. Everything else in the union — shell, file changes, MCP and dynamic
 * tool calls, sub-agent spawning, web search, image view and generation, sleep —
 * reaches outside the conversation.
 */
const NON_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
]);

/** Exported for the schema audit, which checks this against the generated union. */
export const NON_TOOL_THREAD_ITEM_TYPES: readonly string[] = [...NON_TOOL_ITEM_TYPES];

/**
 * True when a thread item is the turn ACTING rather than talking.
 *
 * Reads the raw wire tag, not a parsed item: an item type this build does not model
 * still counts, which is the whole point of the exclusion list above.
 *
 * A tag that is MISSING, empty, or not a string counts too. Every variant of the
 * pinned union carries a string `type`, so such a payload is invalid — and an item we
 * cannot identify is not evidence that nothing happened. Returning false there would
 * let the one payload shape we understand least walk straight past the tool-less
 * backstop.
 */
export function isToolBearingItem(itemType: unknown): boolean {
  if (typeof itemType !== 'string' || itemType.length === 0) return true;
  return !NON_TOOL_ITEM_TYPES.has(itemType);
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  /** Thread-CUMULATIVE. Per-turn usage is derived by differencing successive values. */
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

/** The item fields the adapter maps onto progress events. */
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  // `text` is DERIVED display text, not a wire field: the pinned variant carries
  // `summary` and `content` arrays, and this is the summary joined. See
  // `reasoningSummaryText` for why content never reaches it.
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; status: string; exitCode: number | null }
  | { type: 'fileChange'; id: string; changes: Array<{ path: string }>; status: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string }
  | { type: 'webSearch'; id: string; query: string }
  | { type: 'contextCompaction'; id: string }
  | { type: 'other'; id: string; raw: string };

export interface TurnRef {
  id: string;
  status: TurnStatus;
  errorMessage: string | null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Display text for a reasoning item: its SUMMARY, and never its content.
 *
 * The pinned 0.153.2 variant is `{ id, summary: Array<string>, content: Array<string> }`.
 * There is no `text` member — which is what this used to read, so the reasoning line
 * resolved to an empty string and the detail never rendered for any turn. The schema audit
 * now pins `summary`, so the two cannot drift apart again.
 *
 * `summary` ONLY. `content` is the fuller reasoning trace; the summary is the part meant
 * for display, and it is deliberately less than the content. Surfacing content would put
 * detail into a chat transcript that the summary was written to leave out — and the caller
 * only ever shows the first line of what it gets, so the extra detail would buy nothing
 * even if it were safe.
 *
 * Elements that are not strings are dropped rather than stringified: an unexpected shape
 * should read as "no summary", not as `[object Object]` in somebody's chat.
 */
function reasoningSummaryText(value: Record<string, unknown>): string {
  if (!Array.isArray(value.summary)) return '';
  return value.summary.filter((part): part is string => typeof part === 'string').join('\n').trim();
}

/**
 * Narrow a notification's item to the shapes we render. Unknown types become
 * `other` rather than throwing: a NEW item type must never break a turn, it just has
 * nothing to display.
 */
export function parseThreadItem(value: unknown): ThreadItem | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  const type = value.type;
  if (typeof type !== 'string' || !id) return null;
  switch (type) {
    case 'agentMessage':
      return { type: 'agentMessage', id, text: asString(value.text) };
    // `reasoning` is the pinned 0.153.2 spelling, confirmed against the generated
    // `ThreadItem` union. The other two are tolerance for a build that uses the SDK's
    // snake_case convention (`web_search` vs `webSearch`); a miss here costs nothing but
    // silence, which is the exact bug this case exists to fix.
    case 'reasoning':
    case 'agentReasoning':
    case 'agent_reasoning':
      return { type: 'reasoning', id, text: reasoningSummaryText(value) };
    case 'commandExecution':
      return {
        type: 'commandExecution',
        id,
        command: asString(value.command),
        status: asString(value.status, 'unknown'),
        exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
      };
    case 'fileChange': {
      const changes = Array.isArray(value.changes)
        ? value.changes.filter(isRecord).map((c) => ({ path: asString(c.path) })).filter((c) => c.path)
        : [];
      return { type: 'fileChange', id, changes, status: asString(value.status, 'unknown') };
    }
    case 'mcpToolCall':
      return {
        type: 'mcpToolCall',
        id,
        server: asString(value.server),
        tool: asString(value.tool),
        status: asString(value.status, 'unknown'),
      };
    case 'webSearch':
      return { type: 'webSearch', id, query: asString(value.query) };
    case 'contextCompaction':
      return { type: 'contextCompaction', id };
    default:
      return { type: 'other', id, raw: type };
  }
}

/** Extract the turn identity + terminal status from a turn/started|completed payload. */
export function parseTurnRef(params: unknown, where: string): TurnRef {
  if (!isRecord(params) || !isRecord(params.turn)) throw new Error(`${where}: missing turn object`);
  const turn = params.turn;
  if (typeof turn.id !== 'string' || !turn.id) throw new Error(`${where}: turn.id is missing`);
  const status = turn.status;
  if (status !== 'completed' && status !== 'interrupted' && status !== 'failed' && status !== 'inProgress') {
    // An unrecognized terminal status must not be guessed at — we would otherwise
    // report a failed turn as success or vice versa.
    throw new Error(`${where}: unknown turn status "${String(status)}"`);
  }
  const error = isRecord(turn.error) ? asString(turn.error.message) : '';
  return { id: turn.id, status, errorMessage: error || null };
}

function parseBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!isRecord(value)) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    totalTokens: num(value.totalTokens),
    inputTokens: num(value.inputTokens),
    cachedInputTokens: num(value.cachedInputTokens),
    outputTokens: num(value.outputTokens),
    reasoningOutputTokens: num(value.reasoningOutputTokens),
  };
}

/** Parse a thread/tokenUsage/updated payload; returns null when unusable. */
export function parseThreadTokenUsage(params: unknown): ThreadTokenUsage | null {
  if (!isRecord(params) || !isRecord(params.tokenUsage)) return null;
  const total = parseBreakdown(params.tokenUsage.total);
  const last = parseBreakdown(params.tokenUsage.last);
  if (!total || !last) return null;
  const window = params.tokenUsage.modelContextWindow;
  return { total, last, modelContextWindow: typeof window === 'number' ? window : null };
}

export interface NotificationRoute {
  threadId: string | null;
  turnId: string | null;
  /**
   * The payload names a turn but no single usable id can be read from it: a `turn`
   * object with no usable `turn.id`, a present-but-unusable top-level `turnId`, or a
   * top-level `turnId` that DISAGREES with `turn.id`.
   *
   * Callers must fail CLOSED. Reading such a payload as "no turn id" demotes it to
   * thread-scoped routing, and a thread-scoped terminal lands on whichever turn holds
   * the thread now — which is how a late terminal for an abandoned turn ends another
   * invocation.
   */
  malformed: boolean;
}

/**
 * Read the routing identity out of any notification payload.
 *
 * Turn identity lives in TWO places on this protocol: `item/*` and
 * `turn/plan/updated` carry a top-level `turnId`, while `turn/started` and
 * `turn/completed` carry it as `turn.id` and no top-level field at all. Reading only
 * the top-level form left every terminal notification looking thread-scoped, so it
 * could be delivered to whatever sink held the thread rather than to the turn that
 * actually ended.
 */
export function notificationRoute(params: unknown): NotificationRoute {
  if (!isRecord(params)) return { threadId: null, turnId: null, malformed: false };
  const threadId = nonEmptyString(params.threadId);
  const top = nonEmptyString(params.turnId);
  // Present but unusable (number, empty string): NOT the same as absent.
  if (params.turnId !== undefined && top === null) return { threadId, turnId: null, malformed: true };

  if (params.turn === undefined) return { threadId, turnId: top, malformed: false };
  if (!isRecord(params.turn)) return { threadId, turnId: top, malformed: true };
  const nested = nonEmptyString(params.turn.id);
  if (nested === null) return { threadId, turnId: top, malformed: true };
  // Two ids that name two different turns. There is no safe way to pick one, and
  // picking wrong routes a terminal to a turn that is still running.
  if (top !== null && top !== nested) return { threadId, turnId: null, malformed: true };
  return { threadId, turnId: nested, malformed: false };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
