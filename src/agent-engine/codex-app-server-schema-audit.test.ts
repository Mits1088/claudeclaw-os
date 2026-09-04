// Tests for the App Server schema drift check itself.
//
// A check that has never failed is decoration. These prove `auditBindings()` accepts
// the real pinned 0.153.2 shapes and REJECTS each drift we care about — especially
// the silent widenings a prefix match would have waved through
// (`string | null`, `string[]`, `boolean | null`).
//
// Fixtures are representative copies of the 0.153.2 `generate-ts` output for the
// bindings the audit reads, so a passing baseline here means the same thing as a
// passing run against the binary.

import { describe, expect, it } from 'vitest';

import { auditBindings, type BindingReader } from './codex-app-server-schema-audit.js';

/** The real generated shapes, comments included (the audit must strip them). */
const BASELINE: Record<string, string> = {
  InitializeCapabilities: `
/**
 * Client-declared capabilities negotiated during initialize.
 */
export type InitializeCapabilities = {
/**
 * Opt into receiving experimental API methods and fields.
 */
experimentalApi: boolean,
/**
 * Opt into \`attestation/generate\` requests for upstream \`x-oai-attestation\`.
 */
requestAttestation: boolean,
mcpServerOpenaiFormElicitation?: boolean,
optOutNotificationMethods?: Array<string> | null, };
`,
  InitializeResponse: `
import type { AbsolutePathBuf } from "./AbsolutePathBuf";

export type InitializeResponse = { userAgent: string,
/**
 * Absolute path to the server's $CODEX_HOME directory.
 */
codexHome: AbsolutePathBuf,
platformFamily: string,
platformOs: string, };
`,
  AbsolutePathBuf: `
/**
 * A path that is guaranteed to be absolute and normalized.
 */
export type AbsolutePathBuf = string;
`,
  ClientInfo: 'export type ClientInfo = { name: string, title: string | null, version: string, };\n',
  ClientRequest: `
export type ClientRequest = { "method": "initialize", id: RequestId, params: InitializeParams, } | { "method": "windowsSandbox/readiness", id: RequestId, params: undefined, } | { "method": "thread/start", id: RequestId, params: ThreadStartParams, } | { "method": "thread/resume", id: RequestId, params: ThreadResumeParams, } | { "method": "thread/unsubscribe", id: RequestId, params: ThreadUnsubscribeParams, } | { "method": "mcpServerStatus/list", id: RequestId, params: ListMcpServerStatusParams, } | { "method": "turn/start", id: RequestId, params: TurnStartParams, } | { "method": "turn/steer", id: RequestId, params: TurnSteerParams, } | { "method": "turn/interrupt", id: RequestId, params: TurnInterruptParams, };
`,
  ClientNotification: 'export type ClientNotification = { "method": "initialized" };\n',
  RequestId: 'export type RequestId = string | number;\n',
  'v2/WindowsSandboxReadiness': 'export type WindowsSandboxReadiness = "ready" | "notConfigured" | "updateRequired";\n',
  'v2/WindowsSandboxReadinessResponse': 'export type WindowsSandboxReadinessResponse = { status: WindowsSandboxReadiness, };\n',

  // ── server-initiated requests (Phase 2, finding 8) ────────────────────────
  // All ELEVEN variants, exactly as the pinned 0.153.2 generator emits them. The audit
  // compares this union against the classification table in both directions, so a
  // partial fixture would hide the very drift the check exists to catch.
  ServerRequest: `
export type ServerRequest = { "method": "item/commandExecution/requestApproval", id: RequestId, params: CommandExecutionRequestApprovalParams, } | { "method": "item/fileChange/requestApproval", id: RequestId, params: FileChangeRequestApprovalParams, } | { "method": "item/tool/requestUserInput", id: RequestId, params: ToolRequestUserInputParams, } | { "method": "mcpServer/elicitation/request", id: RequestId, params: McpServerElicitationRequestParams, } | { "method": "item/permissions/requestApproval", id: RequestId, params: PermissionsRequestApprovalParams, } | { "method": "item/tool/call", id: RequestId, params: DynamicToolCallParams, } | { "method": "account/chatgptAuthTokens/refresh", id: RequestId, params: ChatgptAuthTokensRefreshParams, } | { "method": "attestation/generate", id: RequestId, params: AttestationGenerateParams, } | { "method": "currentTime/read", id: RequestId, params: CurrentTimeReadParams, } | { "method": "applyPatchApproval", id: RequestId, params: ApplyPatchApprovalParams, } | { "method": "execCommandApproval", id: RequestId, params: ExecCommandApprovalParams, };
`,
  'v2/AppToolApproval': 'export type AppToolApproval = "auto" | "prompt" | "writes" | "approve";\n',
  'v2/DynamicToolCallResponse': 'export type DynamicToolCallResponse = { contentItems: Array<DynamicToolCallOutputContentItem>, success: boolean, };\n',
  // Every variant TAG (what the non-tool classification is checked against), with the
  // verbatim 0.153.2 MEMBERS for the seven ClaudeClaw translates into engine events —
  // those are what finding 11's field-level checks read. Variants we never map keep an
  // abridged body: their names are all the tool-less backstop needs.
  'v2/ThreadItem': `
export type ThreadItem = { "type": "userMessage", id: string, clientId: string | null, content: Array<UserInput>, } | { "type": "hookPrompt", id: string, fragments: Array<HookPromptFragment>, } | { "type": "agentMessage", id: string, text: string, phase: MessagePhase | null, memoryCitation: MemoryCitation | null, } | { "type": "plan", id: string, text: string, } | { "type": "reasoning", id: string, summary: Array<string>, content: Array<string>, } | { "type": "commandExecution", id: string, command: string, cwd: LegacyAppPathString, processId: string | null, source: CommandExecutionSource, status: CommandExecutionStatus, commandActions: Array<CommandAction>, aggregatedOutput: string | null, exitCode: number | null, durationMs: number | null, } | { "type": "fileChange", id: string, changes: Array<FileUpdateChange>, status: PatchApplyStatus, } | { "type": "mcpToolCall", id: string, server: string, tool: string, status: McpToolCallStatus, arguments: JsonValue, appContext: McpToolCallAppContext | null, mcpAppResourceUri?: string, pluginId: string | null, result: McpToolCallResult | null, error: McpToolCallError | null, durationMs: number | null, } | { "type": "dynamicToolCall", id: string, } | { "type": "collabAgentToolCall", id: string, } | { "type": "subAgentActivity", id: string, } | { "type": "webSearch" } & WebSearchItem | { "type": "imageView", id: string, } | { "type": "sleep", id: string, } | { "type": "imageGeneration" } & ImageGenerationItem | { "type": "enteredReviewMode", id: string, } | { "type": "exitedReviewMode", id: string, } | { "type": "contextCompaction", id: string, };
`,
  'v2/ToolRequestUserInputParams': 'export type ToolRequestUserInputParams = { threadId: string, turnId: string, itemId: string, questions: Array<ToolRequestUserInputQuestion>, autoResolutionMs: number | null, };\n',
  'v2/ToolRequestUserInputQuestion': 'export type ToolRequestUserInputQuestion = { id: string, header: string, question: string, isOther: boolean, isSecret: boolean, options: Array<ToolRequestUserInputOption> | null, };\n',
  'v2/ToolRequestUserInputResponse': 'export type ToolRequestUserInputResponse = { answers: { [key in string]?: ToolRequestUserInputAnswer }, };\n',
  'v2/ToolRequestUserInputAnswer': 'export type ToolRequestUserInputAnswer = { answers: Array<string>, };\n',
  'v2/CommandExecutionApprovalDecision': 'export type CommandExecutionApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";\n',
  'v2/FileChangeApprovalDecision': 'export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";\n',
  'v2/McpServerElicitationAction': 'export type McpServerElicitationAction = "accept" | "decline" | "cancel";\n',
  ReviewDecision: 'export type ReviewDecision = "approved" | "approved_for_session" | "denied" | "timed_out" | "abort";\n',
  'v2/PermissionGrantScope': 'export type PermissionGrantScope = "turn" | "session";\n',
  'v2/GrantedPermissionProfile': 'export type GrantedPermissionProfile = { network?: AdditionalNetworkPermissions, fileSystem?: AdditionalFileSystemPermissions, };\n',

  // ── v2 thread/turn surface (Phase 2) ──────────────────────────────────────
  // Verbatim 0.153.2 shapes for the bindings effective-policy verification reads.
  'v2/ThreadStartResponse': `
export type ThreadStartResponse = { thread: Thread, model: string, modelProvider: string, serviceTier: string | null, cwd: AbsolutePathBuf,
runtimeWorkspaceRoots: Array<AbsolutePathBuf>,
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval,
approvalsReviewer: ApprovalsReviewer,
sandbox: SandboxPolicy,
activePermissionProfile: ActivePermissionProfile | null, reasoningEffort: ReasoningEffort | null,
multiAgentMode: MultiAgentMode, };
`,
  'v2/ThreadResumeResponse': `
export type ThreadResumeResponse = { thread: Thread, model: string, modelProvider: string, serviceTier: string | null, cwd: AbsolutePathBuf,
runtimeWorkspaceRoots: Array<AbsolutePathBuf>,
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval,
approvalsReviewer: ApprovalsReviewer,
sandbox: SandboxPolicy,
activePermissionProfile: ActivePermissionProfile | null, reasoningEffort: ReasoningEffort | null,
multiAgentMode: MultiAgentMode,
initialTurnsPage: TurnsPage | null, };
`,
  'v2/SandboxMode': 'export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";\n',
  'v2/SandboxPolicy': `
export type SandboxPolicy = { "type": "dangerFullAccess" } | { "type": "readOnly", networkAccess: boolean, } | { "type": "externalSandbox", networkAccess: NetworkAccess, } | { "type": "workspaceWrite", writableRoots: Array<AbsolutePathBuf>, networkAccess: boolean, excludeTmpdirEnvVar: boolean, excludeSlashTmp: boolean, };
`,
  'v2/AskForApproval': `
export type AskForApproval = "untrusted" | "on-request" | { "granular": { sandbox_approval: boolean, rules: boolean } } | "never";
`,
  'v2/UserInput': `
export type UserInput = { "type": "text", text: string,
text_elements: Array<TextElement>, } | { "type": "image", detail?: ImageDetail, url: string, };
`,
  'v2/TurnInterruptParams': 'export type TurnInterruptParams = { threadId: string, turnId: string, };\n',
  'v2/TurnInterruptResponse': 'export type TurnInterruptResponse = Record<string, never>;\n',
  'v2/TurnStartResponse': 'export type TurnStartResponse = { turn: Turn, };\n',
  'v2/Turn': 'export type Turn = { id: string, items: Array<ThreadItem>, status: TurnStatus, error: TurnError | null, };\n',

  // ── the INBOUND surface (finding 11) ──────────────────────────────────────
  // Verbatim 0.153.2 shapes for everything the manager routes and the adapter maps.
  // The eight consumed variants are what the routing-identity check reads: `turn/started`
  // and `turn/completed` carry their id NESTED in `turn`, the other six top-level.
  ServerNotification: `
export type ServerNotification = { "method": "account/updated", "params": AccountUpdatedNotification } | { "method": "account/loginCompleted", "params": AccountLoginCompletedNotification } | { "method": "thread/tokenUsage/updated", "params": ThreadTokenUsageUpdatedNotification } | { "method": "thread/compacted", "params": ContextCompactedNotification } | { "method": "turn/started", "params": TurnStartedNotification } | { "method": "turn/completed", "params": TurnCompletedNotification } | { "method": "turn/plan/updated", "params": TurnPlanUpdatedNotification } | { "method": "item/started", "params": ItemStartedNotification } | { "method": "item/completed", "params": ItemCompletedNotification } | { "method": "item/agentMessage/delta", "params": AgentMessageDeltaNotification } | { "method": "commandExec/outputDelta", "params": CommandExecOutputDeltaNotification };
`,
  'v2/TurnStartedNotification': 'export type TurnStartedNotification = { threadId: string, turn: Turn, };\n',
  'v2/TurnCompletedNotification': 'export type TurnCompletedNotification = { threadId: string, turn: Turn, };\n',
  'v2/TurnPlanUpdatedNotification': 'export type TurnPlanUpdatedNotification = { threadId: string, turnId: string, explanation: string | null, plan: Array<TurnPlanStep>, };\n',
  'v2/ItemStartedNotification': `
export type ItemStartedNotification = { item: ThreadItem, threadId: string, turnId: string,
/**
 * Unix timestamp (in milliseconds) when this item lifecycle started.
 */
startedAtMs: number, };
`,
  'v2/ItemCompletedNotification': `
export type ItemCompletedNotification = { item: ThreadItem, threadId: string, turnId: string,
completedAtMs: number, };
`,
  'v2/AgentMessageDeltaNotification': 'export type AgentMessageDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string, };\n',
  'v2/ContextCompactedNotification': `
/**
 * Deprecated: Use \`ContextCompaction\` item type instead.
 */
export type ContextCompactedNotification = { threadId: string, turnId: string, };
`,
  'v2/ThreadTokenUsageUpdatedNotification': 'export type ThreadTokenUsageUpdatedNotification = { threadId: string, turnId: string, tokenUsage: ThreadTokenUsage, };\n',
  'v2/TurnPlanStep': 'export type TurnPlanStep = { step: string, status: TurnPlanStepStatus, };\n',
  'v2/TurnStatus': 'export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";\n',
  'v2/TurnError': 'export type TurnError = { message: string, codexErrorInfo: CodexErrorInfo | null, additionalDetails: string | null, };\n',
  'v2/ThreadTokenUsage': 'export type ThreadTokenUsage = { total: TokenUsageBreakdown, last: TokenUsageBreakdown, modelContextWindow: number | null, };\n',
  'v2/TokenUsageBreakdown': 'export type TokenUsageBreakdown = { totalTokens: number, inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningOutputTokens: number, };\n',
  'v2/FileUpdateChange': 'export type FileUpdateChange = { path: string, kind: PatchChangeKind, diff: string, };\n',
  'v2/CommandExecutionStatus': 'export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";\n',
  WebSearchItem: 'export type WebSearchItem = { id: string, query: string, action: WebSearchAction | null, };\n',
  // Aliases and member types the policy fields resolve THROUGH. `sandbox:
  // SandboxPolicy` means nothing if SandboxPolicy changed shape; the same is true of
  // these.
  ReasoningEffort: 'export type ReasoningEffort = string;\n',
  LegacyAppPathString: 'export type LegacyAppPathString = string;\n',
  'v2/Thread': `
export type Thread = {
id: string,
sessionId: string,
cwd: AbsolutePathBuf,
turns: Array<Turn>, };
`,
  'v2/ActivePermissionProfile': `
export type ActivePermissionProfile = {
id: string,
extends: string | null, };
`,
  'v2/ThreadStartParams': `
export type ThreadStartParams = { model?: string | null, modelProvider?: string | null,
allowProviderModelFallback?: boolean, serviceTier?: string | null | null, cwd?: string | null,
runtimeWorkspaceRoots?: Array<AbsolutePathBuf> | null, approvalPolicy?: AskForApproval | null,
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null,
permissions?: string | null, config?: { [key in string]?: JsonValue } | null, serviceName?: string | null, baseInstructions?: string | null, developerInstructions?: string | null, personality?: Personality | null, };
`,
  'v2/ThreadResumeParams': `
export type ThreadResumeParams = { threadId: string,
history?: Array<ResponseItem> | null,
model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null,
runtimeWorkspaceRoots?: Array<AbsolutePathBuf> | null, approvalPolicy?: AskForApproval | null,
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null,
permissions?: string | null, config?: { [key in string]?: JsonValue } | null, baseInstructions?: string | null, developerInstructions?: string | null,
excludeTurns?: boolean, };
`,

  // ── the MCP-authority surface a resume is verified through ────────────────
  'v2/ThreadUnsubscribeParams': 'export type ThreadUnsubscribeParams = { threadId: string, };\n',
  'v2/ThreadUnsubscribeResponse': `
import type { ThreadUnsubscribeStatus } from "./ThreadUnsubscribeStatus";

export type ThreadUnsubscribeResponse = { status: ThreadUnsubscribeStatus, };
`,
  'v2/ThreadUnsubscribeStatus': 'export type ThreadUnsubscribeStatus = "notLoaded" | "notSubscribed" | "unsubscribed";\n',
  'v2/ListMcpServerStatusParams': `
import type { McpServerStatusDetail } from "./McpServerStatusDetail";

export type ListMcpServerStatusParams = {
/**
 * Opaque pagination cursor returned by a previous call.
 */
cursor?: string | null,
/**
 * Optional page size; defaults to a server-defined value.
 */
limit?: number | null,
/**
 * Controls how much MCP inventory data to fetch for each server.
 * Defaults to \`Full\` when omitted.
 */
detail?: McpServerStatusDetail | null, threadId?: string | null, };
`,
  'v2/McpServerStatusDetail': 'export type McpServerStatusDetail = "full" | "toolsAndAuthOnly";\n',
  'v2/ListMcpServerStatusResponse': `
import type { McpServerStatus } from "./McpServerStatus";

export type ListMcpServerStatusResponse = { data: Array<McpServerStatus>,
/**
 * Opaque cursor to pass to the next call to continue after the last item.
 * If None, there are no more items to return.
 */
nextCursor: string | null, };
`,
  'v2/McpServerStatus': `
export type McpServerStatus = { name: string, serverInfo: McpServerInfo | null, tools: { [key in string]?: Tool }, resources: Array<Resource>, resourceTemplates: Array<ResourceTemplate>, authStatus: McpAuthStatus, };
`,
};

/** A reader over a copy of the baseline with `edits` applied. */
function readerWith(edits: Record<string, string | null> = {}): BindingReader {
  const files: Record<string, string | null> = { ...BASELINE, ...edits };
  return (typeName) => (typeName in files ? files[typeName] : null);
}

/** Replace a fragment in one baseline binding. */
function mutate(typeName: string, from: string, to: string): Record<string, string> {
  const source = BASELINE[typeName];
  if (!source.includes(from)) throw new Error(`test fixture anchor missing in ${typeName}: ${from}`);
  return { [typeName]: source.replace(from, to) };
}

describe('the pinned 0.153.2 baseline passes', () => {
  it('reports no failures and checks everything we consume', () => {
    const result = auditBindings(readerWith());
    expect(result.failures).toEqual([]);
    // Both handshake invariants, all five methods, the notification, and RequestId.
    expect(result.checks.length).toBeGreaterThanOrEqual(13);
    expect(result.checks.join('\n')).toMatch(/requestAttestation is required/);
    expect(result.checks.join('\n')).toMatch(/"initialized" still carries no params/);
  });

  it('exercises the INBOUND surface from the fixtures, not only from the binary', () => {
    // The fixtures must cover every inbound binding the audit reads. If one were missing
    // the audit would report it absent, so a green run here is also proof the baseline is
    // complete — the same thing a green run against the real generator means.
    const checks = auditBindings(readerWith()).checks.join('\n');
    for (const expected of [
      // routing identity, both locations
      /TurnCompletedNotification.turn is required and typed Turn \(the turn id is NESTED\)/,
      /TurnCompletedNotification still carries no turnId member/,
      /ItemStartedNotification.turnId is required and typed string \(the turn id is TOP-LEVEL\)/,
      /ItemStartedNotification still carries no turn member/,
      // terminal payload
      /TurnStatus is still exactly completed \| interrupted \| failed \| inProgress/,
      /TurnError.message is required and typed string/,
      /TurnInterruptResponse is still an empty record/,
      // usage
      /ThreadTokenUsageUpdatedNotification.tokenUsage is required and typed ThreadTokenUsage/,
      /TokenUsageBreakdown.reasoningOutputTokens is required and typed number/,
      // mapped items
      /ThreadItem.commandExecution.exitCode is required and typed number \| null/,
      /ThreadItem.webSearch.query is required and typed string/,
      /FileUpdateChange.path is required and typed string/,
    ]) {
      expect(checks).toMatch(expected);
    }
  });

  it('is deterministic and offline', () => {
    // Same reader in, identical findings out — the check must not depend on ordering, a
    // clock, or anything it did not read through the BindingReader.
    const first = auditBindings(readerWith());
    const second = auditBindings(readerWith());
    expect(second.checks).toEqual(first.checks);
    expect(second.failures).toEqual(first.failures);
  });
});

describe('consumed notification drift', () => {
  // The manager's routing contract (finding 7): every consumed notification must still
  // exist and must still carry its turn identity where the router looks for it.

  it('rejects a consumed notification method disappearing', () => {
    const result = auditBindings(readerWith(mutate('ServerNotification', '"method": "turn/completed"', '"method": "turn/finished"')));
    expect(result.failures.join('\n')).toMatch(/ServerNotification declares "turn\/completed"/);
    expect(result.failures.join('\n')).toMatch(/every turn waiting on it would spin/);
  });

  it('rejects a MOVED turn id — nested becoming top-level', () => {
    // The sharpest drift there is: `turn/completed` losing its nested turn would make
    // every terminal look thread-scoped, so it would land on whichever sink holds the
    // thread rather than on the turn that actually ended.
    const result = auditBindings(readerWith(mutate(
      'v2/TurnCompletedNotification',
      '{ threadId: string, turn: Turn, }',
      '{ threadId: string, turnId: string, }',
    )));
    // Two failures, and both matter: the nested `turn` is gone AND a top-level `turnId`
    // has appeared where the router does not expect one.
    expect(result.failures.join('\n')).toMatch(/TurnCompletedNotification\.turn: Turn \(the turn id is NESTED\)/);
    expect(result.failures.join('\n')).toMatch(/carries no turnId member/);
  });

  it('rejects a MOVED turn id — top-level becoming nested', () => {
    const result = auditBindings(readerWith(mutate(
      'v2/ItemStartedNotification',
      'threadId: string, turnId: string,',
      'threadId: string, turn: Turn,',
    )));
    expect(result.failures.join('\n')).toMatch(/ItemStartedNotification\.turnId: string \(the turn id is TOP-LEVEL\)/);
    expect(result.failures.join('\n')).toMatch(/carries no turn member/);
  });

  it('rejects a notification losing its threadId', () => {
    const result = auditBindings(readerWith(mutate(
      'v2/AgentMessageDeltaNotification',
      'threadId: string, turnId: string,',
      'turnId: string,',
    )));
    expect(result.failures.join('\n')).toMatch(/AgentMessageDeltaNotification\.threadId/);
  });

  it('rejects a threadId becoming optional', () => {
    const result = auditBindings(readerWith(mutate('v2/ContextCompactedNotification', 'threadId: string,', 'threadId?: string,')));
    expect(result.failures.join('\n')).toMatch(/ContextCompactedNotification\.threadId is required/);
    expect(result.failures.join('\n')).toMatch(/now OPTIONAL/);
  });

  it('rejects a missing params binding', () => {
    const result = auditBindings(readerWith({ 'v2/TurnStartedNotification': null }));
    expect(result.failures.join('\n')).toMatch(/v2\/TurnStartedNotification exists/);
    expect(result.failures.join('\n')).toMatch(/routing ids are unverifiable/);
  });

  // The item payload is the only carrier of structured items. Routing ids passing while
  // `item` vanished would be the audit's own false green: parseThreadItem(undefined)
  // returns null and the sink reads null as "nothing to display", not as a fault, so every
  // command, edit, MCP call and reasoning line would quietly stop rendering.
  it.each(['v2/ItemStartedNotification', 'v2/ItemCompletedNotification'] as const)(
    'rejects %s losing its item payload',
    (binding) => {
      const result = auditBindings(readerWith(mutate(binding, 'item: ThreadItem, ', '')));
      expect(result.failures.join('\n')).toMatch(new RegExp(`${binding.replace('v2/', '')}\\.item`));
    },
  );

  it.each(['v2/ItemStartedNotification', 'v2/ItemCompletedNotification'] as const)(
    'rejects %s making its item OPTIONAL',
    (binding) => {
      const result = auditBindings(readerWith(mutate(binding, 'item: ThreadItem,', 'item?: ThreadItem,')));
      expect(result.failures.join('\n')).toMatch(new RegExp(`${binding.replace('v2/', '')}\\.item is required`));
      expect(result.failures.join('\n')).toMatch(/now OPTIONAL/);
    },
  );

  it.each(['v2/ItemStartedNotification', 'v2/ItemCompletedNotification'] as const)(
    'rejects %s carrying an incompatible item type',
    (binding) => {
      // An array of items, a nullable item, or an unrelated type: each would make
      // parseThreadItem read something it cannot narrow.
      for (const replacement of ['item: Array<ThreadItem>,', 'item: ThreadItem | null,', 'item: string,']) {
        const result = auditBindings(readerWith(mutate(binding, 'item: ThreadItem,', replacement)));
        expect(result.failures.join('\n'), replacement).toMatch(new RegExp(`${binding.replace('v2/', '')}\\.item`));
      }
    },
  );

  it('rejects a plan step losing the fields the progress event reads', () => {
    const result = auditBindings(readerWith(mutate('v2/TurnPlanStep', 'step: string,', 'label: string,')));
    expect(result.failures.join('\n')).toMatch(/TurnPlanStep\.step/);
  });
});

describe('terminal status and error drift', () => {
  it('rejects a REMOVED turn status', () => {
    const result = auditBindings(readerWith(mutate('v2/TurnStatus', ' | "interrupted"', '')));
    expect(result.failures.join('\n')).toMatch(/TurnStatus is exactly/);
    expect(result.failures.join('\n')).toMatch(/missing: interrupted/);
  });

  it('rejects an ADDED turn status, which breaks turns just as badly', () => {
    // parseTurnRef throws on an unrecognized status, the throw becomes a protocol fault,
    // and the fault kills the generation — so a new value is not a graceful addition.
    const result = auditBindings(readerWith(mutate('v2/TurnStatus', '"inProgress";', '"inProgress" | "cancelled";')));
    expect(result.failures.join('\n')).toMatch(/unexpected: cancelled/);
    expect(result.failures.join('\n')).toMatch(/kills the generation/);
  });

  it('rejects Turn.error losing its nullability', () => {
    const result = auditBindings(readerWith(mutate('v2/Turn', 'error: TurnError | null,', 'error: TurnError,')));
    expect(result.failures.join('\n')).toMatch(/Turn\.error: TurnError \| null/);
  });

  it('rejects a moved error message', () => {
    const result = auditBindings(readerWith(mutate('v2/TurnError', 'message: string,', 'detail: string,')));
    expect(result.failures.join('\n')).toMatch(/TurnError\.message/);
  });

  it('notices the interrupt response gaining a payload', () => {
    const result = auditBindings(readerWith(mutate(
      'v2/TurnInterruptResponse',
      'Record<string, never>;',
      '{ interrupted: boolean, };',
    )));
    expect(result.failures.join('\n')).toMatch(/TurnInterruptResponse is still an empty record/);
    expect(result.failures.join('\n')).toMatch(/may carry a confirmation worth using/);
  });
});

describe('token usage drift', () => {
  it('rejects a moved tokenUsage nesting location', () => {
    const result = auditBindings(readerWith(mutate(
      'v2/ThreadTokenUsageUpdatedNotification',
      'tokenUsage: ThreadTokenUsage,',
      'usage: ThreadTokenUsage,',
    )));
    expect(result.failures.join('\n')).toMatch(/ThreadTokenUsageUpdatedNotification\.tokenUsage/);
  });

  it('rejects losing the `last` breakdown that seeds a turn', () => {
    const result = auditBindings(readerWith(mutate('v2/ThreadTokenUsage', 'last: TokenUsageBreakdown,', '')));
    expect(result.failures.join('\n')).toMatch(/ThreadTokenUsage\.last/);
  });

  it('rejects a usage bucket becoming nullable', () => {
    // parseBreakdown rejects the whole report, so the turn is billed as though the model
    // had done nothing.
    const result = auditBindings(readerWith(mutate('v2/TokenUsageBreakdown', 'cachedInputTokens: number,', 'cachedInputTokens: number | null,')));
    expect(result.failures.join('\n')).toMatch(/TokenUsageBreakdown\.cachedInputTokens: number/);
  });

  it('rejects modelContextWindow losing its nullability', () => {
    const result = auditBindings(readerWith(mutate('v2/ThreadTokenUsage', 'modelContextWindow: number | null,', 'modelContextWindow: number,')));
    expect(result.failures.join('\n')).toMatch(/ThreadTokenUsage\.modelContextWindow/);
  });
});

describe('mapped thread item drift', () => {
  // These variants become AgentEngineEvents. A renamed field never throws — it just
  // renders blank, which is why it needs an upgrade-time check.

  it('rejects a renamed field on a mapped variant', () => {
    const result = auditBindings(readerWith(mutate(
      'v2/ThreadItem',
      '{ "type": "commandExecution", id: string, command: string,',
      '{ "type": "commandExecution", id: string, commandLine: string,',
    )));
    expect(result.failures.join('\n')).toMatch(/ThreadItem\.commandExecution\.command/);
  });

  it('rejects an exitCode that stopped being nullable', () => {
    const result = auditBindings(readerWith(mutate('v2/ThreadItem', 'exitCode: number | null,', 'exitCode: number,')));
    expect(result.failures.join('\n')).toMatch(/ThreadItem\.commandExecution\.exitCode: number \| null/);
  });

  it('rejects a mapped variant disappearing entirely', () => {
    const result = auditBindings(readerWith(mutate(
      'v2/ThreadItem',
      '{ "type": "mcpToolCall", id: string, server: string,',
      '{ "type": "mcpInvocation", id: string, server: string,',
    )));
    expect(result.failures.join('\n')).toMatch(/ThreadItem still declares the "mcpToolCall" variant/);
  });

  it('rejects a changed element type behind a mapped field', () => {
    const result = auditBindings(readerWith(mutate('v2/ThreadItem', 'changes: Array<FileUpdateChange>,', 'changes: Array<string>,')));
    expect(result.failures.join('\n')).toMatch(/ThreadItem\.fileChange\.changes/);
  });

  it('rejects FileUpdateChange losing the path the edit summary lists', () => {
    const result = auditBindings(readerWith(mutate('v2/FileUpdateChange', 'path: string,', 'filePath: string,')));
    expect(result.failures.join('\n')).toMatch(/FileUpdateChange\.path/);
  });

  it('rejects the intersected webSearch binding going missing', () => {
    const result = auditBindings(readerWith({ WebSearchItem: null }));
    expect(result.failures.join('\n')).toMatch(/WebSearchItem exists/);
    expect(result.failures.join('\n')).toMatch(/intersected with it/);
  });

  it('rejects CommandExecutionStatus losing "completed"', () => {
    // Every successful command would then be reported as a failure.
    const result = auditBindings(readerWith(mutate('v2/CommandExecutionStatus', '"completed" | ', '')));
    expect(result.failures.join('\n')).toMatch(/CommandExecutionStatus still accepts completed/);
    expect(result.failures.join('\n')).toMatch(/surface every successful command as failed/);
  });

  it('does not confuse one variant\'s members with another\'s', () => {
    // The union is brace-matched, not regex-delimited. Deleting `text` from agentMessage
    // must be caught even though `plan` — the next variant along — still has one.
    const result = auditBindings(readerWith(mutate(
      'v2/ThreadItem',
      '{ "type": "agentMessage", id: string, text: string,',
      '{ "type": "agentMessage", id: string,',
    )));
    expect(result.failures.join('\n')).toMatch(/ThreadItem\.agentMessage\.text/);
  });
});

describe('silent type WIDENING is rejected (a prefix match would accept these)', () => {
  const WIDENINGS: Array<{ name: string; edits: Record<string, string>; expect: RegExp }> = [
    {
      name: 'userAgent: string -> string | null',
      edits: mutate('InitializeResponse', 'userAgent: string,', 'userAgent: string | null,'),
      expect: /InitializeResponse\.userAgent: string[\s\S]*string \| null/,
    },
    {
      name: 'platformOs: string -> string[]',
      edits: mutate('InitializeResponse', 'platformOs: string, }', 'platformOs: string[], }'),
      expect: /InitializeResponse\.platformOs: string[\s\S]*string\[\]/,
    },
    {
      name: 'experimentalApi: boolean -> boolean | null',
      edits: mutate('InitializeCapabilities', 'experimentalApi: boolean,', 'experimentalApi: boolean | null,'),
      expect: /InitializeCapabilities\.experimentalApi: boolean[\s\S]*boolean \| null/,
    },
    {
      name: 'platformFamily: string -> Array<string>',
      edits: mutate('InitializeResponse', 'platformFamily: string,', 'platformFamily: Array<string>,'),
      expect: /InitializeResponse\.platformFamily: string[\s\S]*Array<string>/,
    },
    {
      name: 'title: string | null -> string (nullability contract moved)',
      edits: mutate('ClientInfo', 'title: string | null,', 'title: string,'),
      expect: /ClientInfo\.title: string \| null/,
    },
  ];

  for (const { name, edits, expect: pattern } of WIDENINGS) {
    it(`rejects ${name}`, () => {
      const result = auditBindings(readerWith(edits));
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.failures.join('\n')).toMatch(pattern);
    });
  }
});

describe('required fields becoming optional is rejected', () => {
  it('rejects requestAttestation?: boolean', () => {
    const result = auditBindings(readerWith(mutate('InitializeCapabilities', 'requestAttestation: boolean,', 'requestAttestation?: boolean,')));
    expect(result.failures.join('\n')).toMatch(/requestAttestation is required[\s\S]*now OPTIONAL/);
  });

  it('rejects a removed requestAttestation', () => {
    const result = auditBindings(readerWith(mutate('InitializeCapabilities', 'requestAttestation: boolean,', '')));
    expect(result.failures.join('\n')).toMatch(/InitializeCapabilities\.requestAttestation/);
  });
});

describe('codexHome and its alias', () => {
  it('fails when codexHome names AbsolutePathBuf but the alias is MISSING', () => {
    // Without the alias we cannot prove the field is a comparable path string, so the
    // isolation check would be comparing against an unknown type.
    const result = auditBindings(readerWith({ AbsolutePathBuf: null }));
    expect(result.failures.join('\n')).toMatch(/AbsolutePathBuf binding exists[\s\S]*alias is missing/);
  });

  it('fails when the alias is no longer a plain string', () => {
    const result = auditBindings(readerWith({ AbsolutePathBuf: 'export type AbsolutePathBuf = { path: string };\n' }));
    expect(result.failures.join('\n')).toMatch(/AbsolutePathBuf = string[\s\S]*no longer a plain string/);
  });

  it('does NOT require the alias when codexHome is declared as a bare string', () => {
    const edits = mutate('InitializeResponse', 'codexHome: AbsolutePathBuf,', 'codexHome: string,');
    const result = auditBindings(readerWith({ ...edits, AbsolutePathBuf: null }));
    expect(result.failures).toEqual([]);
  });
});

describe('method and envelope drift', () => {
  it('rejects a renamed consumed method', () => {
    const result = auditBindings(readerWith(mutate('ClientRequest', '"turn/interrupt"', '"turn/cancel"')));
    expect(result.failures.join('\n')).toMatch(/ClientRequest accepts "turn\/interrupt"[\s\S]*method-not-found/);
  });

  it('rejects `initialized` gaining a params member', () => {
    const result = auditBindings(readerWith(mutate('ClientNotification', '{ "method": "initialized" }', '{ "method": "initialized", params: object }')));
    expect(result.failures.join('\n')).toMatch(/carries no params member[\s\S]*must start sending params/);
  });

  it('rejects RequestId narrowing to number', () => {
    const result = auditBindings(readerWith({ RequestId: 'export type RequestId = number;\n' }));
    expect(result.failures.join('\n')).toMatch(/RequestId = string \| number/);
  });

  it('accepts the reversed union order number | string', () => {
    const result = auditBindings(readerWith({ RequestId: 'export type RequestId = number | string;\n' }));
    expect(result.failures).toEqual([]);
  });
});

describe('thread/turn lifecycle drift (Phase 2 surface)', () => {
  it('fails when a response drops ONE effective-policy field, naming just that field', () => {
    // Verification cannot be performed without it, and the release rule is that a
    // turn must not start on an unverified policy.
    const result = auditBindings(readerWith(mutate('v2/ThreadStartResponse', 'sandbox: SandboxPolicy,', '')));
    const text = result.failures.join('\n');
    expect(text).toMatch(/v2\/ThreadStartResponse still reports the effective policy/);
    expect(text).toMatch(/sandbox \(absent, expected SandboxPolicy\)/);
    // Not a cascade naming every field.
    expect(text).not.toMatch(/\bthread \(absent/);
  });

  it('fails when the resume response drops a field even if start still has it', () => {
    const result = auditBindings(readerWith(mutate('v2/ThreadResumeResponse', 'instructionSources: Array<LegacyAppPathString>,', '')));
    expect(result.failures.join('\n')).toMatch(/ThreadResumeResponse[\s\S]*instructionSources \(absent/);
  });

  it('fails when a SandboxPolicy tag is renamed', () => {
    // Every effective-sandbox comparison would mismatch, blocking all turns — better
    // to fail the upgrade than to fail every turn at runtime.
    const result = auditBindings(readerWith(mutate('v2/SandboxPolicy', '"workspaceWrite"', '"workspace_write"')));
    expect(result.failures.join('\n')).toMatch(/SandboxPolicy tags "workspaceWrite"/);
  });

  it('fails when SandboxPolicy stops reporting networkAccess or writableRoots', () => {
    const noNetwork = auditBindings(readerWith({
      'v2/SandboxPolicy': 'export type SandboxPolicy = { "type": "dangerFullAccess" } | { "type": "readOnly" } | { "type": "workspaceWrite", writableRoots: Array<AbsolutePathBuf>, };\n',
    }));
    expect(noNetwork.failures.join('\n')).toMatch(/network confinement can no longer be verified/);

    const noRoots = auditBindings(readerWith({
      'v2/SandboxPolicy': 'export type SandboxPolicy = { "type": "dangerFullAccess" } | { "type": "readOnly", networkAccess: boolean, } | { "type": "workspaceWrite", networkAccess: boolean, };\n',
    }));
    expect(noRoots.failures.join('\n')).toMatch(/root broadening can no longer be verified/);
  });

  it('fails when a requested sandbox MODE disappears', () => {
    const result = auditBindings(readerWith({ 'v2/SandboxMode': 'export type SandboxMode = "read-only" | "danger-full-access";\n' }));
    expect(result.failures.join('\n')).toMatch(/SandboxMode still accepts our three modes[\s\S]*workspace-write/);
  });

  it('fails when AskForApproval loses "never"', () => {
    const result = auditBindings(readerWith({ 'v2/AskForApproval': 'export type AskForApproval = "untrusted" | "on-request";\n' }));
    expect(result.failures.join('\n')).toMatch(/AskForApproval still accepts "never"/);
  });

  it('fails when the text input loses text_elements', () => {
    // Easy to omit and required; turn/start would fail to deserialize.
    const result = auditBindings(readerWith(mutate('v2/UserInput', 'text_elements: Array<TextElement>,', '')));
    expect(result.failures.join('\n')).toMatch(/UserInput text variant: text_elements is an array/);
  });

  it('fails when a REQUEST field changes type', () => {
    // If `sandbox` stopped taking a mode the request would be rejected — or worse,
    // silently accepted with our hardening dropped.
    const result = auditBindings(readerWith(mutate('v2/ThreadStartParams', 'sandbox?: SandboxMode | null,', 'sandbox?: SandboxPolicy | null,')));
    expect(result.failures.join('\n')).toMatch(/ThreadStartParams\.sandbox: SandboxMode \| null[\s\S]*SandboxPolicy/);
  });

  it('fails when the config map disappears from either params type', () => {
    // Every hardening override travels through it: project_doc_max_bytes,
    // features.apps, web_search, sandbox_workspace_write, model_reasoning_effort.
    for (const name of ['v2/ThreadStartParams', 'v2/ThreadResumeParams'] as const) {
      const result = auditBindings(readerWith(mutate(name, 'config?: { [key in string]?: JsonValue } | null,', '')));
      expect(result.failures.join('\n')).toMatch(new RegExp(`${name.replace('/', '\\/')}\\.config: \\{ \\[key in string\\]`));
    }
  });

  it('fails when resume loses threadId or excludeTurns', () => {
    const noThread = auditBindings(readerWith(mutate('v2/ThreadResumeParams', 'threadId: string,', '')));
    expect(noThread.failures.join('\n')).toMatch(/ThreadResumeParams\.threadId: required string/);
    const noExclude = auditBindings(readerWith(mutate('v2/ThreadResumeParams', 'excludeTurns?: boolean,', '')));
    expect(noExclude.failures.join('\n')).toMatch(/ThreadResumeParams\.excludeTurns: optional boolean/);
  });

  it('fails when a root array changes ELEMENT type', () => {
    // "an array" is not enough: the parser rejects non-string elements and requires
    // each to be absolute, so an array of structs would fail every turn at runtime.
    const response = auditBindings(readerWith(mutate(
      'v2/ThreadStartResponse',
      'runtimeWorkspaceRoots: Array<AbsolutePathBuf>,',
      'runtimeWorkspaceRoots: Array<WorkspaceRoot>,',
    )));
    expect(response.failures.join('\n')).toMatch(/runtimeWorkspaceRoots \(now `Array<WorkspaceRoot>`, expected Array<AbsolutePathBuf>\)/);

    const sandbox = auditBindings(readerWith(mutate(
      'v2/SandboxPolicy',
      'writableRoots: Array<AbsolutePathBuf>,',
      'writableRoots: Array<WritableRoot>,',
    )));
    expect(sandbox.failures.join('\n')).toMatch(/writableRoots: Array<AbsolutePathBuf>[\s\S]*Array<WritableRoot>/);

    const sources = auditBindings(readerWith(mutate(
      'v2/ThreadStartResponse',
      'instructionSources: Array<LegacyAppPathString>,',
      'instructionSources: Array<InstructionSource>,',
    )));
    expect(sources.failures.join('\n')).toMatch(/instructionSources \(now `Array<InstructionSource>`/);
  });

  it('fails when an alias the policy fields resolve through stops being a string', () => {
    for (const name of ['ReasoningEffort', 'LegacyAppPathString'] as const) {
      const result = auditBindings(readerWith({ [name]: `export type ${name} = { value: string };\n` }));
      expect(result.failures.join('\n')).toMatch(new RegExp(`${name} is a string alias`));
    }
  });

  it('fails when Thread.id stops being a string', () => {
    // It is the session identifier ClaudeClaw stores and resumes by.
    const result = auditBindings(readerWith(mutate('v2/Thread', 'id: string,', 'id: ThreadId,')));
    expect(result.failures.join('\n')).toMatch(/Thread\.id: string[\s\S]*ThreadId/);
  });

  it('fails when ActivePermissionProfile members change shape', () => {
    // The parser distinguishes absent from null on `extends`, so the required-and-
    // nullable shape must hold.
    const optionalExtends = auditBindings(readerWith(mutate('v2/ActivePermissionProfile', 'extends: string | null,', 'extends?: string,')));
    expect(optionalExtends.failures.join('\n')).toMatch(/ActivePermissionProfile\.extends: required string \| null/);

    const nonNullExtends = auditBindings(readerWith(mutate('v2/ActivePermissionProfile', 'extends: string | null,', 'extends: string,')));
    expect(nonNullExtends.failures.join('\n')).toMatch(/ActivePermissionProfile\.extends: required string \| null/);

    const idGone = auditBindings(readerWith(mutate('v2/ActivePermissionProfile', 'id: string,', 'id: ProfileId,')));
    expect(idGone.failures.join('\n')).toMatch(/ActivePermissionProfile\.id: required string/);
  });

  it('fails when config loses its JsonValue value type or its nullability', () => {
    // A narrower value type would reject the nested objects our hardening sends.
    const narrowed = auditBindings(readerWith(mutate(
      'v2/ThreadStartParams',
      'config?: { [key in string]?: JsonValue } | null,',
      'config?: { [key in string]?: string } | null,',
    )));
    expect(narrowed.failures.join('\n')).toMatch(/ThreadStartParams\.config: \{ \[key in string\]\?: JsonValue \}/);

    const notNullable = auditBindings(readerWith(mutate(
      'v2/ThreadStartParams',
      'config?: { [key in string]?: JsonValue } | null,',
      'config?: { [key in string]?: JsonValue },',
    )));
    expect(notNullable.failures.join('\n')).toMatch(/ThreadStartParams\.config/);
  });

  it('fails when config stops being an open string-keyed MAP', () => {
    // A typed struct would reject our keys — or silently drop them along with the
    // hardening they carry. Presence alone would not notice.
    const result = auditBindings(readerWith(mutate(
      'v2/ThreadStartParams',
      'config?: { [key in string]?: JsonValue } | null,',
      'config?: ThreadConfigStruct | null,',
    )));
    expect(result.failures.join('\n')).toMatch(/ThreadStartParams\.config: \{ \[key in string\]\?: JsonValue \}[\s\S]*ThreadConfigStruct/);
  });

  it('fails when a response policy field changes TYPE rather than disappearing', () => {
    // Presence-only checking would accept this; the runtime parser would then throw on
    // every turn instead of the upgrade failing here.
    const result = auditBindings(readerWith(mutate('v2/ThreadStartResponse', 'sandbox: SandboxPolicy,', 'sandbox: string,')));
    expect(result.failures.join('\n')).toMatch(/sandbox \(now `string`, expected SandboxPolicy\)/);
  });

  it('fails when a response policy field gains nullability', () => {
    const result = auditBindings(readerWith(mutate('v2/ThreadResumeResponse', 'sandbox: SandboxPolicy,', 'sandbox: SandboxPolicy | null,')));
    expect(result.failures.join('\n')).toMatch(/sandbox \(now `SandboxPolicy \| null`/);
  });

  it('fails when resume ids change type rather than disappearing', () => {
    const optionalThread = auditBindings(readerWith(mutate('v2/ThreadResumeParams', 'threadId: string,', 'threadId?: string | null,')));
    expect(optionalThread.failures.join('\n')).toMatch(/ThreadResumeParams\.threadId: required string/);

    const stringExclude = auditBindings(readerWith(mutate('v2/ThreadResumeParams', 'excludeTurns?: boolean,', 'excludeTurns?: TurnsMode,')));
    expect(stringExclude.failures.join('\n')).toMatch(/ThreadResumeParams\.excludeTurns: optional boolean[\s\S]*TurnsMode/);
  });

  it('fails when an interrupt id stops being a required string', () => {
    const result = auditBindings(readerWith(mutate('v2/TurnInterruptParams', 'turnId: string,', 'turnId?: string | null,')));
    expect(result.failures.join('\n')).toMatch(/threadId \+ turnId as required strings[\s\S]*turnId/);
  });

  // ── the MCP-authority surface ─────────────────────────────────────────────
  // Drift here does not break a turn: it breaks the PROOF that a resumed thread
  // reaches only the servers the current caller authorized, which is worse.

  it('fails when mcpServerStatus/list can no longer be scoped to a thread', () => {
    // Without `threadId` the reply describes the config-file set, so the check would
    // read an empty inventory for every thread and pass while proving nothing.
    const result = auditBindings(readerWith(mutate('v2/ListMcpServerStatusParams', 'threadId?: string | null, };', '};')));
    expect(result.failures.join('\n')).toMatch(/ListMcpServerStatusParams\.threadId: string \| null[\s\S]*scoped to one thread/);
  });

  it('fails when the inventory response drops its data array or its cursor', () => {
    const noData = auditBindings(readerWith(mutate('v2/ListMcpServerStatusResponse', 'data: Array<McpServerStatus>,', '')));
    expect(noData.failures.join('\n')).toMatch(/ListMcpServerStatusResponse\.data/);

    const noCursor = auditBindings(readerWith(mutate('v2/ListMcpServerStatusResponse', 'nextCursor: string | null, };', '};')));
    expect(noCursor.failures.join('\n')).toMatch(/ListMcpServerStatusResponse\.nextCursor/);
  });

  it('fails when a status entry stops carrying a plain string name', () => {
    // The name is the whole comparison against the sanitized mcp_servers keys.
    const result = auditBindings(readerWith(mutate('v2/McpServerStatus', 'name: string,', 'name: McpServerName,')));
    expect(result.failures.join('\n')).toMatch(/McpServerStatus\.name: string[\s\S]*McpServerName/);
  });

  it('fails when the lighter detail level disappears', () => {
    const result = auditBindings(readerWith({ 'v2/McpServerStatusDetail': 'export type McpServerStatusDetail = "full";\n' }));
    expect(result.failures.join('\n')).toMatch(/McpServerStatusDetail still accepts "toolsAndAuthOnly"/);
  });

  it('fails when thread/unsubscribe changes shape', () => {
    // It is what makes a resume rebuild the thread from our parameters instead of
    // rejoining it with the previous caller's MCP table.
    const noThreadId = auditBindings(readerWith(mutate('v2/ThreadUnsubscribeParams', 'threadId: string,', 'threadId?: string,')));
    expect(noThreadId.failures.join('\n')).toMatch(/ThreadUnsubscribeParams\.threadId is required/);

    const noStatus = auditBindings(readerWith({ 'v2/ThreadUnsubscribeStatus': 'export type ThreadUnsubscribeStatus = "closed";\n' }));
    expect(noStatus.failures.join('\n')).toMatch(/ThreadUnsubscribeStatus still reports unsubscribed \| notLoaded/);
  });

  it('fails when a method the resume check depends on is renamed', () => {
    for (const method of ['thread/unsubscribe', 'mcpServerStatus/list'] as const) {
      const result = auditBindings(readerWith(mutate('ClientRequest', `"${method}"`, '"gone/away"')));
      expect(result.failures.join('\n')).toMatch(new RegExp(`ClientRequest accepts "${method.replace('/', '\\/')}"`));
    }
  });

  it('fails when text and text_elements live on DIFFERENT variants', () => {
    // Searching the whole union would pass this, yet the shape we send would still
    // fail to deserialize.
    const result = auditBindings(readerWith({
      'v2/UserInput': 'export type UserInput = { "type": "text", text: string, } | { "type": "richText", text_elements: Array<TextElement>, };\n',
    }));
    expect(result.failures.join('\n')).toMatch(/UserInput text variant: text_elements is an array/);
  });

  it('fails when the text variant field types change', () => {
    const result = auditBindings(readerWith(mutate('v2/UserInput', 'text: string,', 'text: TextBody,')));
    expect(result.failures.join('\n')).toMatch(/UserInput text variant: text is a string/);
  });

  it('fails when a temp-exclusion flag stops being boolean', () => {
    // Without a boolean we cannot tell whether temp directories became implicit
    // writable roots, and "writes confined to the workspace" stops being provable.
    const result = auditBindings(readerWith(mutate('v2/SandboxPolicy', 'excludeSlashTmp: boolean,', 'excludeSlashTmp: TmpPolicy,')));
    expect(result.failures.join('\n')).toMatch(/workspaceWrite\.excludeSlashTmp: boolean[\s\S]*implicit writable roots undetected/);
  });

  it('fails when readOnly stops reporting a boolean networkAccess', () => {
    const result = auditBindings(readerWith(mutate('v2/SandboxPolicy', '{ "type": "readOnly", networkAccess: boolean, }', '{ "type": "readOnly", networkAccess: NetworkAccess, }')));
    expect(result.failures.join('\n')).toMatch(/readOnly\.networkAccess: boolean/);
  });

  it('fails when the externalSandbox tag disappears', () => {
    // We never request it, but verification must keep being able to name it when a
    // host applies it.
    const result = auditBindings(readerWith(mutate('v2/SandboxPolicy', '{ "type": "externalSandbox", networkAccess: NetworkAccess, } | ', '')));
    expect(result.failures.join('\n')).toMatch(/SandboxPolicy tags "externalSandbox"/);
  });

  it('fails when turn/interrupt stops taking turnId', () => {
    // Cancellation must stay turn-scoped: killing the shared child to cancel one turn
    // would abort unrelated missions and chats.
    const result = auditBindings(readerWith({ 'v2/TurnInterruptParams': 'export type TurnInterruptParams = { threadId: string, };\n' }));
    expect(result.failures.join('\n')).toMatch(/TurnInterruptParams keeps threadId \+ turnId/);
  });

  it('fails when the turn/start response stops carrying a turn', () => {
    // The adapter names the turn from this response so an abort that beats
    // turn/started still has something to interrupt.
    const result = auditBindings(readerWith({ 'v2/TurnStartResponse': 'export type TurnStartResponse = Record<string, never>;\n' }));
    expect(result.failures.join('\n')).toMatch(/TurnStartResponse carries a required `turn: Turn`/);
  });

  it('fails when Turn.id stops being a required string', () => {
    const result = auditBindings(readerWith(mutate('v2/Turn', 'id: string,', 'id?: string | null,')));
    expect(result.failures.join('\n')).toMatch(/Turn\.id is a required string/);
  });

  it('fails when the structured user question loses its turnId', () => {
    // Without it the question cannot be routed to the exact turn that asked, and the
    // only alternatives are guessing or declining every question.
    const result = auditBindings(readerWith(mutate('v2/ToolRequestUserInputParams', 'turnId: string,', '')));
    expect(result.failures.join('\n')).toMatch(/ToolRequestUserInputParams keeps threadId \+ turnId \+ itemId/);
  });

  it('fails when the user-input answer map stops being optional', () => {
    // An empty map is how ClaudeClaw declines; required values would make declining
    // impossible without inventing answers.
    const result = auditBindings(readerWith({
      'v2/ToolRequestUserInputResponse': 'export type ToolRequestUserInputResponse = { answers: { [key in string]: ToolRequestUserInputAnswer }, };\n',
    }));
    expect(result.failures.join('\n')).toMatch(/answers is a map of OPTIONAL answers/);
  });

  it('fails when isSecret disappears from a question', () => {
    const result = auditBindings(readerWith(mutate('v2/ToolRequestUserInputQuestion', 'isSecret: boolean,', '')));
    expect(result.failures.join('\n')).toMatch(/isSecret is a required boolean/);
  });

  it.each([
    ['v2/CommandExecutionApprovalDecision', '"decline"', /CommandExecutionApprovalDecision still has a "decline"/],
    ['v2/FileChangeApprovalDecision', '"decline"', /FileChangeApprovalDecision still has a "decline"/],
    ['v2/McpServerElicitationAction', '"decline"', /McpServerElicitationAction still has a "decline"/],
    ['ReviewDecision', '"denied"', /ReviewDecision still has a "denied"/],
  ])('fails when %s loses the variant ClaudeClaw refuses with', (type, variant, expected) => {
    const result = auditBindings(readerWith(mutate(type, variant, '"somethingElse"')));
    expect(result.failures.join('\n')).toMatch(expected);
  });

  it('fails when a permission grant member becomes required', () => {
    // A permission approval has no decline variant, so the refusal is an EMPTY grant.
    const result = auditBindings(readerWith({
      'v2/GrantedPermissionProfile': 'export type GrantedPermissionProfile = { network: AdditionalNetworkPermissions, };\n',
    }));
    expect(result.failures.join('\n')).toMatch(/GrantedPermissionProfile members are all optional/);
  });

  it('fails when the structured user question leaves the ServerRequest union', () => {
    const result = auditBindings(readerWith({
      ServerRequest: 'export type ServerRequest = { "method": "attestation/generate", id: RequestId, params: AttestationGenerateParams, };\n',
    }));
    expect(result.failures.join('\n')).toMatch(/ServerRequest still carries item\/tool\/requestUserInput/);
  });

  it('fails when a NEW server-request variant appears that nobody classified', () => {
    // The one that matters most: an unclassified authority-bearing request would get
    // method-not-found by default, which is a shrug rather than a refusal.
    const result = auditBindings(readerWith(mutate(
      'ServerRequest',
      '{ "method": "attestation/generate"',
      '{ "method": "item/filesystem/grantRoot", id: RequestId, params: GrantRootParams, } | { "method": "attestation/generate"',
    )));
    expect(result.failures.join('\n')).toMatch(/unclassified: item\/filesystem\/grantRoot/);
  });

  it('fails when a classified method disappears from the union', () => {
    const result = auditBindings(readerWith(mutate(
      'ServerRequest',
      '{ "method": "currentTime/read", id: RequestId, params: CurrentTimeReadParams, } | ',
      '',
    )));
    expect(result.failures.join('\n')).toMatch(/no longer declared: currentTime\/read/);
  });

  it('fails when a NON-TOOL item variant is renamed out of the union', () => {
    // The classification is by exclusion, so a new variant fails a tool-less turn
    // closed — safe. The dangerous direction is a harmless variant disappearing: a
    // tool-less turn would then fail on its own reply.
    const result = auditBindings(readerWith(mutate('v2/ThreadItem', '"type": "agentMessage"', '"type": "assistantMessage"')));
    expect(result.failures.join('\n')).toMatch(/no longer declared: agentMessage/);
  });

  it('fails when "approve" leaves the tool-approval vocabulary', () => {
    // Trusted MCP servers are pre-approved with that exact value; losing it would
    // silently re-gate the dispatch bridge, whose calls then cancel with no approver.
    const result = auditBindings(readerWith(mutate('v2/AppToolApproval', '"approve"', '"allow"')));
    expect(result.failures.join('\n')).toMatch(/AppToolApproval still has an "approve" variant/);
  });

  it('fails when the dynamic tool response stops fitting the empty denial', () => {
    const result = auditBindings(readerWith({
      'v2/DynamicToolCallResponse': 'export type DynamicToolCallResponse = { output: string, };\n',
    }));
    expect(result.failures.join('\n')).toMatch(/DynamicToolCallResponse still takes contentItems \+ success/);
  });
});

describe('missing bindings are failures, not silent passes', () => {
  for (const name of ['InitializeCapabilities', 'InitializeResponse', 'ClientInfo', 'ClientRequest', 'ClientNotification', 'RequestId']) {
    it(`fails when ${name} is absent`, () => {
      const result = auditBindings(readerWith({ [name]: null }));
      expect(result.failures.join('\n')).toMatch(new RegExp(`${name} exists`));
    });
  }
});

describe('comments cannot satisfy a check', () => {
  it('does not accept a field that appears only inside a doc comment', () => {
    const result = auditBindings(readerWith({
      InitializeResponse: `
export type InitializeResponse = { userAgent: string,
/**
 * platformOs: string, — documented but no longer declared
 */
codexHome: AbsolutePathBuf,
platformFamily: string, };
`,
    }));
    expect(result.failures.join('\n')).toMatch(/InitializeResponse\.platformOs/);
  });
});
