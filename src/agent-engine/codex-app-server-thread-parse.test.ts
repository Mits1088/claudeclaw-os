// Runtime validation of thread/start and thread/resume results.
//
// The transport returns `unknown`, and a TypeScript interface asserts nothing about
// the bytes on the wire. Without this parser a drifted or hostile response would be
// compared field-by-field against `undefined` and could pass effective-policy
// verification while the real policy is unknown — the one failure mode verification
// exists to prevent.

import { describe, expect, it } from 'vitest';
import path from 'path';

import {
  ASK_USER_QUESTION_METHOD,
  CONSUMED_NOTIFICATIONS,
  SERVER_REQUEST_METHODS,
  consumedNotificationIdentity,
  deniedServerRequestResult,
  isPinnedServerRequestMethod,
  notificationRoute,
  parseEffectiveThreadPolicy,
  parseMcpServerStatusPage,
  parseThreadItem,
  parseToolUserInputRequest,
  parseWindowsSandboxReadiness,
  refusedServerRequestReason,
} from './codex-app-server-protocol.js';
import { verifyEffectivePolicy } from './codex-app-server-policy-verify.js';

const AGENT_CWD = path.resolve('work', 'agent');

/**
 * The shape observed from the account-free pinned-binary probe (0.144.6,
 * Windows), with filesystem paths adapted to the host running the test.
 */
const PROBE_RESULT = {
  thread: { id: '019f9824-72a4-78b3-b5c8-8f9ddf684324', sessionId: 's1', turns: [] },
  model: 'gpt-5.5',
  modelProvider: 'openai',
  serviceTier: null,
  cwd: AGENT_CWD,
  runtimeWorkspaceRoots: [AGENT_CWD],
  instructionSources: [],
  approvalPolicy: 'never',
  approvalsReviewer: 'none',
  sandbox: { type: 'readOnly', networkAccess: false },
  activePermissionProfile: null,
  reasoningEffort: 'high',
  multiAgentMode: 'explicitRequestOnly',
};

describe('Windows sandbox readiness', () => {
  it.each(['ready', 'notConfigured', 'updateRequired'] as const)('accepts %s', (status) => {
    expect(parseWindowsSandboxReadiness({ status })).toEqual({ status });
  });

  it.each([undefined, null, 'not-ready', 'unelevated'])('rejects unknown status %s', (status) => {
    expect(() => parseWindowsSandboxReadiness({ status })).toThrow(/unknown status/);
  });

  it('rejects a non-object response', () => {
    expect(() => parseWindowsSandboxReadiness(null)).toThrow(/result is not an object/);
  });
});

describe('parses the real pinned-binary response', () => {
  it('accepts the probe result and keeps only the consumed fields', () => {
    const parsed = parseEffectiveThreadPolicy(PROBE_RESULT);
    expect(parsed.thread.id).toBe('019f9824-72a4-78b3-b5c8-8f9ddf684324');
    expect(parsed.sandbox).toEqual({ type: 'readOnly', networkAccess: false });
    expect(parsed.reasoningEffort).toBe('high');
    expect(parsed.activePermissionProfile).toBeNull();
  });

  it('ignores unconsumed fields so new optional fields never break a turn', () => {
    const parsed = parseEffectiveThreadPolicy({ ...PROBE_RESULT, brandNewField: { nested: true } });
    expect(parsed.model).toBe('gpt-5.5');
    expect(parsed as unknown as Record<string, unknown>).not.toHaveProperty('brandNewField');
  });

  it('accepts an explicit null reasoningEffort', () => {
    expect(parseEffectiveThreadPolicy({ ...PROBE_RESULT, reasoningEffort: null }).reasoningEffort).toBeNull();
  });

  it('parses each sandbox variant', () => {
    const ws = parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      sandbox: { type: 'workspaceWrite', writableRoots: [AGENT_CWD], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
    expect(ws.sandbox).toMatchObject({ type: 'workspaceWrite', excludeSlashTmp: true });
    expect(parseEffectiveThreadPolicy({ ...PROBE_RESULT, sandbox: { type: 'dangerFullAccess' } }).sandbox.type).toBe('dangerFullAccess');
    // externalSandbox parses so verification can report it by name as a mismatch,
    // rather than the parser masking it as a generic protocol error.
    expect(parseEffectiveThreadPolicy({ ...PROBE_RESULT, sandbox: { type: 'externalSandbox', networkAccess: 'restricted' } }).sandbox.type)
      .toBe('externalSandbox');
  });

  it('parses a well-formed granular approval variant so verification can reject it', () => {
    const parsed = parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      approvalPolicy: { granular: { sandbox_approval: true, rules: false } },
    });
    expect(parsed.approvalPolicy).toEqual({ granular: { sandbox_approval: true, rules: false } });
  });

  it('REJECTS a malformed granular flag rather than dropping it', () => {
    // Silently discarding a non-boolean flag would let a turn proceed against an
    // approval policy we only partly understood.
    expect(() => parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      approvalPolicy: { granular: { sandbox_approval: true, junk: 'not-a-bool' } },
    })).toThrow(/approvalPolicy\.granular\.junk is not a boolean/);
  });

  it('REJECTS a malformed activePermissionProfile.extends rather than nulling it', () => {
    // Coercing it to null would erase the fact that this profile inherits from
    // something we could not identify.
    expect(() => parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      activePermissionProfile: { id: 'p', extends: { nested: true } },
    })).toThrow(/activePermissionProfile\.extends is neither a string nor null/);
  });

  it('parses a labelled permission profile', () => {
    const parsed = parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      activePermissionProfile: { id: 'built-in-default', extends: null },
    });
    expect(parsed.activePermissionProfile).toEqual({ id: 'built-in-default', extends: null });
  });
});

describe('a missing or wrongly-typed consumed field is a protocol error', () => {
  const CASES: Array<{ name: string; result: unknown; expect: RegExp }> = [
    { name: 'not an object', result: 'nope', expect: /result is not an object/ },
    { name: 'null', result: null, expect: /result is not an object/ },
    { name: 'missing thread', result: { ...PROBE_RESULT, thread: undefined }, expect: /thread\.id is missing/ },
    { name: 'empty thread id', result: { ...PROBE_RESULT, thread: { id: '' } }, expect: /thread\.id is missing/ },
    { name: 'numeric model', result: { ...PROBE_RESULT, model: 5 }, expect: /model is missing or not a non-empty string/ },
    { name: 'missing modelProvider', result: { ...PROBE_RESULT, modelProvider: undefined }, expect: /modelProvider is missing/ },
    { name: 'empty cwd', result: { ...PROBE_RESULT, cwd: '' }, expect: /cwd is missing/ },
    { name: 'runtimeWorkspaceRoots not an array', result: { ...PROBE_RESULT, runtimeWorkspaceRoots: 'C:\\x' }, expect: /runtimeWorkspaceRoots is not a string\[\]/ },
    { name: 'runtimeWorkspaceRoots with a non-string', result: { ...PROBE_RESULT, runtimeWorkspaceRoots: ['ok', 7] }, expect: /runtimeWorkspaceRoots is not a string\[\]/ },
    { name: 'instructionSources not an array', result: { ...PROBE_RESULT, instructionSources: null }, expect: /instructionSources is not a string\[\]/ },
    { name: 'numeric reasoningEffort', result: { ...PROBE_RESULT, reasoningEffort: 3 }, expect: /reasoningEffort is neither a string nor null/ },
    { name: 'profile without an id', result: { ...PROBE_RESULT, activePermissionProfile: { extends: 'base' } }, expect: /activePermissionProfile is neither null nor an object with a string id/ },
    { name: 'unknown approvalPolicy string', result: { ...PROBE_RESULT, approvalPolicy: 'sometimes' }, expect: /unknown approvalPolicy "sometimes"/ },
    { name: 'approvalPolicy of the wrong shape', result: { ...PROBE_RESULT, approvalPolicy: 42 }, expect: /approvalPolicy is neither a known string nor a granular object/ },
    { name: 'sandbox not an object', result: { ...PROBE_RESULT, sandbox: 'readOnly' }, expect: /sandbox is not an object/ },
    { name: 'unknown sandbox tag', result: { ...PROBE_RESULT, sandbox: { type: 'quantumSandbox' } }, expect: /unknown sandbox type "quantumSandbox"/ },
    { name: 'readOnly without networkAccess', result: { ...PROBE_RESULT, sandbox: { type: 'readOnly' } }, expect: /readOnly sandbox is missing boolean networkAccess/ },
    { name: 'readOnly with a non-boolean networkAccess', result: { ...PROBE_RESULT, sandbox: { type: 'readOnly', networkAccess: 'no' } }, expect: /missing boolean networkAccess/ },
    {
      name: 'workspaceWrite without writableRoots',
      result: { ...PROBE_RESULT, sandbox: { type: 'workspaceWrite', networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } },
      expect: /missing string\[\] writableRoots/,
    },
    {
      name: 'workspaceWrite without the temp flags',
      result: { ...PROBE_RESULT, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } },
      expect: /missing boolean excludeTmpdirEnvVar/,
    },
  ];

  for (const { name, result, expect: pattern } of CASES) {
    it(`rejects ${name}`, () => {
      expect(() => parseEffectiveThreadPolicy(result, 'thread/start')).toThrow(pattern);
    });
  }

  it('names the call site in the error so start and resume are distinguishable', () => {
    expect(() => parseEffectiveThreadPolicy({}, 'thread/resume')).toThrow(/^thread\/resume:/);
  });
});

describe('required-but-nullable fields: ABSENT is not the same as null', () => {
  // In 0.144.6 both are required members with nullable types. Treating an absent key
  // as null would let a response that simply omits the profile bypass the mandatory
  // "activePermissionProfile must be null" verification rule entirely.
  it('rejects an absent reasoningEffort', () => {
    const { reasoningEffort, ...without } = PROBE_RESULT;
    expect(() => parseEffectiveThreadPolicy(without)).toThrow(/reasoningEffort is absent \(it is required, and nullable/);
  });

  it('rejects an absent activePermissionProfile', () => {
    const { activePermissionProfile, ...without } = PROBE_RESULT;
    expect(() => parseEffectiveThreadPolicy(without)).toThrow(/activePermissionProfile is absent \(it is required, and nullable/);
  });

  it('rejects an absent activePermissionProfile.extends', () => {
    expect(() => parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      activePermissionProfile: { id: 'p' },
    })).toThrow(/activePermissionProfile\.extends is absent \(it is required, and nullable\)/);
  });

  it('accepts explicit nulls for all three', () => {
    const parsed = parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      reasoningEffort: null,
      activePermissionProfile: { id: 'p', extends: null },
    });
    expect(parsed.reasoningEffort).toBeNull();
    expect(parsed.activePermissionProfile).toEqual({ id: 'p', extends: null });
  });
});

describe('every reported path must be ABSOLUTE', () => {
  // A relative value like "." would be resolved by the comparison helpers against the
  // ClaudeClaw process's own working directory rather than the agent's, so a response
  // could name one directory and be verified against another.
  it('rejects a relative cwd', () => {
    expect(() => parseEffectiveThreadPolicy({ ...PROBE_RESULT, cwd: '.' }))
      .toThrow(/cwd "\." is not absolute/);
  });

  it('rejects a relative runtimeWorkspaceRoot', () => {
    expect(() => parseEffectiveThreadPolicy({ ...PROBE_RESULT, runtimeWorkspaceRoots: [AGENT_CWD, './nested'] }))
      .toThrow(/runtimeWorkspaceRoots: contains non-absolute path\(s\): \.\/nested/);
  });

  it('rejects a relative workspaceWrite writableRoot', () => {
    expect(() => parseEffectiveThreadPolicy({
      ...PROBE_RESULT,
      sandbox: { type: 'workspaceWrite', writableRoots: ['..'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    })).toThrow(/writableRoots: contains non-absolute path\(s\): \.\./);
  });

  it('a relative cwd cannot slip through verification by resolving to our own directory', () => {
    // Before the parser enforced this, "." plus a requested cwd equal to the process
    // directory would have compared equal and passed.
    expect(() => parseEffectiveThreadPolicy({ ...PROBE_RESULT, cwd: '.', runtimeWorkspaceRoots: ['.'] }))
      .toThrow(/not absolute|non-absolute/);
  });
});

describe('the parser is what stops an unknown policy from passing verification', () => {
  it('a response with NO policy fields cannot reach verification at all', () => {
    // Without the parser, `{}` would be compared field-by-field against undefined:
    // sandbox.type undefined !== 'readOnly' would mismatch by luck, but a response
    // missing only `sandbox` would have thrown a TypeError deep inside verification
    // instead of failing cleanly and loudly here.
    expect(() => parseEffectiveThreadPolicy({})).toThrow(/thread\.id is missing/);
  });

  it('a hostile response claiming full access is parsed and then REJECTED', () => {
    const parsed = parseEffectiveThreadPolicy({ ...PROBE_RESULT, sandbox: { type: 'dangerFullAccess' } });
    const mismatches = verifyEffectivePolicy(
      { model: 'gpt-5.5', cwd: AGENT_CWD, sandboxMode: 'read-only', networkAccess: false, reasoningEffort: 'high' },
      parsed,
    );
    expect(mismatches.blocking.join('\n')).toMatch(/sandbox type is "dangerFullAccess", requested "read-only"/);
  });
});

describe('the MCP inventory page is the evidence, so it is parsed strictly', () => {
  // Shape observed from the pinned-binary probe (0.144.6): one server, tools keyed
  // by name, and a null cursor on the last page.
  const PAGE = {
    data: [{
      name: 'claudeclaw-dispatch',
      serverInfo: { name: 'claudeclaw-dispatch', version: '1.0.0' },
      tools: { dispatch_send: {} },
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    }],
    nextCursor: null,
  };

  it('reads the names off the real shape', () => {
    expect(parseMcpServerStatusPage(PAGE)).toEqual({ names: ['claudeclaw-dispatch'], nextCursor: null });
  });

  it('accepts an empty inventory', () => {
    expect(parseMcpServerStatusPage({ data: [], nextCursor: null })).toEqual({ names: [], nextCursor: null });
  });

  it('keeps a real cursor so the caller can continue', () => {
    expect(parseMcpServerStatusPage({ ...PAGE, nextCursor: 'page-2' }).nextCursor).toBe('page-2');
  });

  it('rejects an EMPTY cursor: only null ends the inventory', () => {
    // Accepting "" as falsy would stop the walk early and report a truncated
    // inventory as complete — a verification that passes while proving nothing.
    expect(() => parseMcpServerStatusPage({ ...PAGE, nextCursor: '' }))
      .toThrow(/nextCursor is an empty string; only null ends the inventory/);
  });

  it('rejects an ABSENT cursor rather than assuming there are no more pages', () => {
    expect(() => parseMcpServerStatusPage({ data: [] })).toThrow(/nextCursor is absent/);
  });

  it('rejects a cursor that is neither a string nor null', () => {
    expect(() => parseMcpServerStatusPage({ data: [], nextCursor: 7 })).toThrow(/neither a string nor null/);
  });

  it('rejects an entry with no readable name instead of skipping it', () => {
    // A server we cannot name is not a server we may ignore.
    expect(() => parseMcpServerStatusPage({ data: [{ tools: {} }], nextCursor: null }))
      .toThrow(/effective MCP inventory cannot be read/);
    expect(() => parseMcpServerStatusPage({ data: [{ name: '' }], nextCursor: null }))
      .toThrow(/effective MCP inventory cannot be read/);
  });

  it('rejects a response that is not a page at all', () => {
    expect(() => parseMcpServerStatusPage(null)).toThrow(/result is not an object/);
    expect(() => parseMcpServerStatusPage({ nextCursor: null })).toThrow(/data is not an array/);
  });
});

describe('notification routing identity', () => {
  // The identity table is the schema-of-record for what each consumed notification
  // must carry on pinned 0.144.6. Routing fails closed against it, so a wrong entry
  // here either strands turns or kills healthy connections.

  it('consumes exactly these eight methods, each requiring a top-level threadId', () => {
    expect([...CONSUMED_NOTIFICATIONS].sort()).toEqual([
      'item/agentMessage/delta',
      'item/completed',
      'item/started',
      'thread/compacted',
      'thread/tokenUsage/updated',
      'turn/completed',
      'turn/plan/updated',
      'turn/started',
    ]);
  });

  it('requires a turn id from all eight, and records where each one carries it', () => {
    // The lifecycle pair nests it as turn.id; every other consumed method uses the
    // top-level turnId. notificationRoute() normalizes the two forms.
    expect(consumedNotificationIdentity('turn/started')).toBe('nested');
    expect(consumedNotificationIdentity('turn/completed')).toBe('nested');
    expect(consumedNotificationIdentity('item/started')).toBe('top');
    expect(consumedNotificationIdentity('item/completed')).toBe('top');
    expect(consumedNotificationIdentity('item/agentMessage/delta')).toBe('top');
    expect(consumedNotificationIdentity('turn/plan/updated')).toBe('top');
    // Named for the thread, turn-scoped in the generated types. Treating these two as
    // thread-scoped let one turn's compaction or token report be attributed to another.
    expect(consumedNotificationIdentity('thread/compacted')).toBe('top');
    expect(consumedNotificationIdentity('thread/tokenUsage/updated')).toBe('top');
  });

  it('does NOT consume thread/started, which identifies its thread as params.thread.id', () => {
    // Listing it would demand a top-level threadId it does not have, making every one
    // of them a protocol fault. Add it back only alongside handling that reads
    // thread.id.
    expect(consumedNotificationIdentity('thread/started')).toBeNull();
    expect(consumedNotificationIdentity('remoteControl/status/changed')).toBeNull();
  });

  it('reads the turn id from either the top level or the nested turn', () => {
    expect(notificationRoute({ threadId: 'th', turnId: 't1' })).toEqual({ threadId: 'th', turnId: 't1', malformed: false });
    expect(notificationRoute({ threadId: 'th', turn: { id: 't1' } })).toEqual({ threadId: 'th', turnId: 't1', malformed: false });
    expect(notificationRoute({ threadId: 'th' })).toEqual({ threadId: 'th', turnId: null, malformed: false });
  });

  it('flags identity that is present and unusable rather than reading it as absent', () => {
    // Absent demotes a notification to thread-scoped routing; unusable must not.
    expect(notificationRoute({ threadId: 'th', turnId: 7 }).malformed).toBe(true);
    expect(notificationRoute({ threadId: 'th', turnId: '' }).malformed).toBe(true);
    expect(notificationRoute({ threadId: 'th', turn: {} }).malformed).toBe(true);
    expect(notificationRoute({ threadId: 'th', turn: { id: '' } }).malformed).toBe(true);
    expect(notificationRoute({ threadId: 'th', turn: 'not an object' }).malformed).toBe(true);
  });

  it('flags two ids that name DIFFERENT turns, and yields neither', () => {
    const route = notificationRoute({ threadId: 'th', turnId: 't1', turn: { id: 't2' } });
    expect(route).toEqual({ threadId: 'th', turnId: null, malformed: true });
  });

  it('accepts two ids that agree', () => {
    expect(notificationRoute({ threadId: 'th', turnId: 't1', turn: { id: 't1' } }))
      .toEqual({ threadId: 'th', turnId: 't1', malformed: false });
  });

  it('treats an empty threadId as absent, and a non-record payload as empty', () => {
    expect(notificationRoute({ threadId: '' }).threadId).toBeNull();
    expect(notificationRoute(null)).toEqual({ threadId: null, turnId: null, malformed: false });
    expect(notificationRoute('nope')).toEqual({ threadId: null, turnId: null, malformed: false });
  });
});

describe('the structured user question is parsed strictly', () => {
  // This is the one server-initiated method ClaudeClaw claims to implement, so a
  // payload it cannot read is corruption, not a question to decline. Nothing defaults,
  // coerces, or filters: a half-understood question gets put to a human in words the
  // model did not choose, and a malformed isSecret decides whether a credential
  // reaches a chat UI.

  const ok = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    threadId: 'thread-1',
    turnId: 't1',
    itemId: 'item-1',
    autoResolutionMs: null,
    questions: [{
      id: 'q1', header: 'Approach', question: 'Which one?',
      isOther: false, isSecret: false,
      options: [{ label: 'A', description: 'first' }],
    }],
    ...over,
  });

  /** Replace one field of the single question. */
  const q = (over: Record<string, unknown>): Record<string, unknown> => ok({
    questions: [{
      id: 'q1', header: 'Approach', question: 'Which one?',
      isOther: false, isSecret: false, options: [{ label: 'A', description: 'first' }],
      ...over,
    }],
  });

  it('accepts the shape the pinned binary sends', () => {
    expect(parseToolUserInputRequest(ok())).toEqual({
      threadId: 'thread-1',
      turnId: 't1',
      itemId: 'item-1',
      autoResolutionMs: null,
      questions: [{
        id: 'q1', header: 'Approach', question: 'Which one?',
        isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'first' }],
      }],
    });
  });

  it('accepts null options as "free text only", and a finite autoResolutionMs', () => {
    const parsed = parseToolUserInputRequest(ok({
      autoResolutionMs: 30_000,
      questions: [{ id: 'q1', header: 'H', question: 'Q', isOther: true, isSecret: false, options: null }],
    }));
    expect(parsed.autoResolutionMs).toBe(30_000);
    expect(parsed.questions[0].options).toEqual([]);
    expect(parsed.questions[0].isOther).toBe(true);
  });

  it.each([
    ['params that are not an object', 'not an object', /params is not an object/],
    ['a missing threadId', ok({ threadId: undefined }), /threadId is missing/],
    ['a non-string turnId', ok({ turnId: 7 }), /turnId is missing/],
    ['an empty itemId', ok({ itemId: '' }), /itemId is missing/],
    ['questions that are not an array', ok({ questions: {} }), /questions is not an array/],
  ])('rejects %s', (_label, params, expected) => {
    expect(() => parseToolUserInputRequest(params)).toThrow(expected);
  });

  it.each([
    ['a question that is not an object', ok({ questions: ['nope'] }), /questions\[0\] is not an object/],
    ['a missing id', q({ id: undefined }), /questions\[0\]\.id is missing/],
    ['a non-string header', q({ header: 42 }), /questions\[0\]\.header is not a string/],
    ['a missing header', q({ header: undefined }), /questions\[0\]\.header is not a string/],
    ['a non-string question', q({ question: null }), /questions\[0\]\.question is not a string/],
    ['a non-boolean isOther', q({ isOther: 'yes' }), /questions\[0\]\.isOther is not a boolean/],
    ['a missing isOther', q({ isOther: undefined }), /questions\[0\]\.isOther is not a boolean/],
    ['a non-boolean isSecret', q({ isSecret: 1 }), /questions\[0\]\.isSecret is not a boolean/],
    ['a MISSING isSecret', q({ isSecret: undefined }), /questions\[0\]\.isSecret is not a boolean/],
    ['options that are neither array nor null', q({ options: 'A,B' }), /options is neither an array nor null/],
    ['absent options', q({ options: undefined }), /options is neither an array nor null/],
    ['an option that is not an object', q({ options: ['A'] }), /options\[0\] is not an object/],
    ['a non-string option label', q({ options: [{ label: 1, description: 'd' }] }), /options\[0\]\.label is not a string/],
    ['a missing option description', q({ options: [{ label: 'A' }] }), /options\[0\]\.description is not a string/],
  ])('rejects %s', (_label, params, expected) => {
    expect(() => parseToolUserInputRequest(params)).toThrow(expected);
  });

  it.each([
    ['a non-numeric autoResolutionMs', ok({ autoResolutionMs: '30s' }), /autoResolutionMs is neither a finite number nor null/],
    ['an infinite autoResolutionMs', ok({ autoResolutionMs: Infinity }), /autoResolutionMs is neither a finite number nor null/],
    ['a NaN autoResolutionMs', ok({ autoResolutionMs: NaN }), /autoResolutionMs is neither a finite number nor null/],
    ['an ABSENT autoResolutionMs', ok({ autoResolutionMs: undefined }), /autoResolutionMs is neither a finite number nor null/],
  ])('rejects %s rather than reading it as "no deadline"', (_label, params, expected) => {
    expect(() => parseToolUserInputRequest(params)).toThrow(expected);
  });

  it('rejects duplicate question ids', () => {
    // Answers come back keyed by id, so duplicates make the mapping ambiguous in both
    // directions and there is no answer that is certainly right.
    expect(() => parseToolUserInputRequest(ok({
      questions: [
        { id: 'q1', header: 'A', question: 'first?', isOther: false, isSecret: false, options: null },
        { id: 'q1', header: 'B', question: 'second?', isOther: false, isSecret: false, options: null },
      ],
    }))).toThrow(/duplicate question id "q1"/);
  });

  it('names the offending question by index so a malformed payload is diagnosable', () => {
    expect(() => parseToolUserInputRequest(ok({
      questions: [
        { id: 'q1', header: 'A', question: 'first?', isOther: false, isSecret: false, options: null },
        { id: 'q2', header: 'B', question: 'second?', isOther: false, isSecret: 'no', options: null },
      ],
    }))).toThrow(/questions\[1\]\.isSecret/);
  });
});

describe('server-request classification', () => {
  it('classifies every one of the pinned eleven', () => {
    // A variant nobody decided about would fall through to method-not-found, which for
    // an authority-bearing request is a shrug dressed as a refusal.
    expect(SERVER_REQUEST_METHODS).toHaveLength(11);
    for (const method of SERVER_REQUEST_METHODS) {
      const classified = method === ASK_USER_QUESTION_METHOD
        || deniedServerRequestResult(method) !== undefined
        || refusedServerRequestReason(method) !== undefined;
      expect(classified, `${method} is unclassified`).toBe(true);
    }
  });

  it('denies item/tool/call with an empty, unsuccessful DynamicToolCallResponse', () => {
    // ClaudeClaw declares no dynamic tools, so the model is told the call did not
    // happen rather than the connection erroring.
    expect(deniedServerRequestResult('item/tool/call')).toEqual({ contentItems: [], success: false });
  });

  it('refuses currentTime/read at the application level rather than denying it', () => {
    expect(deniedServerRequestResult('currentTime/read')).toBeUndefined();
    expect(refusedServerRequestReason('currentTime/read')).toMatch(/does not implement/);
  });

  it('knows which methods are outside the pinned union', () => {
    expect(isPinnedServerRequestMethod('item/tool/call')).toBe(true);
    expect(isPinnedServerRequestMethod('currentTime/read')).toBe(true);
    expect(isPinnedServerRequestMethod('something/entirely/new')).toBe(false);
  });

  it('never refuses with anything a credential could hide in', () => {
    for (const method of ['account/chatgptAuthTokens/refresh', 'attestation/generate']) {
      const reason = refusedServerRequestReason(method)!;
      expect(reason).not.toMatch(/Bearer|sk-|eyJ/);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe('the reasoning item exposes its SUMMARY and never its content', () => {
  // The pinned 0.144.6 variant is `{ id, summary: string[], content: string[] }`. This
  // parser used to read a `text` member that the union does not declare, so the reasoning
  // detail resolved to '' and never rendered for any turn — only the fixed "Thinking"
  // label did. The schema audit now pins `summary`, so the two cannot drift apart again.

  const reasoning = (over: Record<string, unknown> = {}): unknown => ({
    type: 'reasoning',
    id: 'r1',
    summary: ['**Checking the config**'],
    content: ['THE FULL TRACE MUST NOT BE SHOWN'],
    ...over,
  });

  it('derives display text from summary', () => {
    const item = parseThreadItem(reasoning());
    expect(item).toEqual({ type: 'reasoning', id: 'r1', text: '**Checking the config**' });
  });

  it('never surfaces content, even when there is no summary at all', () => {
    // Content is the fuller trace and the summary is what is meant for display. An empty
    // summary means "nothing to show", not "fall back to the detail".
    for (const over of [{ summary: [] }, { summary: undefined }, { summary: null }, { summary: 'not-an-array' }]) {
      const item = parseThreadItem(reasoning(over)) as { text: string };
      expect(item.text, JSON.stringify(over)).toBe('');
      expect(item.text).not.toMatch(/MUST NOT BE SHOWN/);
    }
    // And with content as the ONLY member present.
    expect(parseThreadItem({ type: 'reasoning', id: 'r1', content: ['secret'] }))
      .toEqual({ type: 'reasoning', id: 'r1', text: '' });
  });

  it('joins a multi-part summary in order', () => {
    const item = parseThreadItem(reasoning({ summary: ['First thought', 'Second thought'] })) as { text: string };
    expect(item.text).toBe('First thought\nSecond thought');
  });

  it('drops non-string summary parts rather than stringifying them', () => {
    // An unexpected shape must read as "no summary", not put [object Object] in a chat.
    const item = parseThreadItem(reasoning({ summary: [{ nested: 'x' }, 'Real text', 42, null] })) as { text: string };
    expect(item.text).toBe('Real text');
    expect(item.text).not.toMatch(/object|42/);
  });

  it('reads the same way under every accepted spelling of the type', () => {
    for (const type of ['reasoning', 'agentReasoning', 'agent_reasoning']) {
      const item = parseThreadItem(reasoning({ type })) as { type: string; text: string };
      expect(item.type, type).toBe('reasoning');
      expect(item.text, type).toBe('**Checking the config**');
    }
  });

  it('ignores a `text` member, which the pinned union does not declare', () => {
    // Reading it was the original defect. A payload carrying both must still take the
    // summary, so the audited contract and the parser stay the same contract.
    const item = parseThreadItem(reasoning({ text: 'a field that does not exist upstream' })) as { text: string };
    expect(item.text).toBe('**Checking the config**');
  });
});
