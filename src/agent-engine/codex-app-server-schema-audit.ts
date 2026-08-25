/**
 * The assertions behind the Codex App Server schema drift check.
 *
 * Pure and I/O-free on purpose: it takes a reader for generated binding sources and
 * returns findings, so the same logic that guards a real version bump can be tested
 * against synthetic drift without a Codex binary. `scripts/check-codex-app-server-schema.ts`
 * is the thin CLI around it (resolve the pinned launcher, generate, print, exit).
 *
 * It lives under `src/` rather than beside the script because `tsconfig.json` only
 * includes `src/**`, so anything in `scripts/` is neither typechecked by
 * `npm run typecheck` nor reachable by vitest — a checker that is itself unchecked
 * is not much of a guarantee.
 *
 * Why this exists: ClaudeClaw keeps a narrow hand-written protocol surface
 * (`codex-app-server-protocol.ts`) instead of committing ~96 generated files for
 * features it never touches. That trade is only safe if a check proves the small
 * part we do consume still has the shape we assume. Both of the corrections this
 * baseline forced — `requestAttestation` being required, and `initialized` carrying
 * no `params` — would otherwise have surfaced as a runtime deserialization error
 * mid-turn.
 */

import {
  CONSUMED_CLIENT_NOTIFICATION,
  CONSUMED_NOTIFICATIONS,
  CONSUMED_REQUEST_METHODS,
  NON_TOOL_THREAD_ITEM_TYPES,
  SERVER_REQUEST_METHODS,
  consumedNotificationIdentity,
} from './codex-app-server-protocol.js';

export interface SchemaAuditResult {
  /** Human-readable descriptions of everything that held. */
  checks: string[];
  /** Human-readable drift findings; empty means the pinned surface is unchanged. */
  failures: string[];
}

/** Reads one generated binding by type name (e.g. `InitializeResponse`), raw. */
export type BindingReader = (typeName: string) => string | null;

/** Strip comments so a doc-comment mentioning a field cannot satisfy a check. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

class Audit {
  readonly checks: string[] = [];
  readonly failures: string[] = [];

  ok(what: string): void {
    this.checks.push(what);
  }

  fail(what: string, detail: string): void {
    this.failures.push(`${what}\n    → ${detail}`);
  }

  /**
   * Assert `typeName.field` is declared, REQUIRED, and typed EXACTLY `typePattern`.
   *
   * Exactness matters more than it looks. A prefix match would accept every one of
   * these silent widenings, each of which breaks a different assumption in the
   * client:
   *  - `userAgent: string | null`   (we treat it as always present)
   *  - `platformOs: string[]`       (we log it as a scalar)
   *  - `experimentalApi: boolean | null`
   *
   * So the pattern must consume the whole type, up to the terminating comma,
   * semicolon or closing brace that ts-rs emits after every member.
   */
  requireField(source: string, typeName: string, field: string, typePattern: RegExp, label: string): void {
    const optional = new RegExp(`\\b${field}\\s*\\?\\s*:`);
    if (optional.test(source)) {
      this.fail(
        `${typeName}.${field} is required`,
        'it is now OPTIONAL in the generated schema; omitting it may have become valid, and our required-field assumption no longer holds',
      );
      return;
    }
    // The lookahead is what makes this exact: the matched type must be followed by a
    // member terminator, not by ` | null`, `[]`, or anything else.
    const exact = new RegExp(`\\b${field}\\s*:\\s*(?:${typePattern.source})\\s*(?=[,;}]|$)`, 'm');
    if (!exact.test(source)) {
      const actual = new RegExp(`\\b${field}\\s*:\\s*([^,;}]+)`).exec(source);
      this.fail(
        `${typeName}.${field}: ${label}`,
        actual
          ? `declared type is now \`${actual[1].trim()}\``
          : `not found in the generated ${typeName}`,
      );
      return;
    }
    this.ok(`${typeName}.${field} is required and typed ${label}`);
  }

  /** Assert `typeName` declares no member called `field` at all. */
  refuseField(source: string, typeName: string, field: string, why: string): void {
    const declared = new RegExp(`\\b${field}\\s*\\??\\s*:`);
    if (declared.test(source)) {
      const actual = new RegExp(`\\b${field}\\s*\\??\\s*:\\s*([^,;}]+)`).exec(source);
      this.fail(`${typeName} carries no ${field} member`, `it now declares \`${actual ? actual[1].trim() : field}\` — ${why}`);
      return;
    }
    this.ok(`${typeName} still carries no ${field} member`);
  }

  /**
   * Assert a string union contains EXACTLY `expected` — no missing values and no extra
   * ones.
   *
   * Set equality, not a subset, and only for unions the runtime REJECTS unknown values
   * from. `TurnStatus` is the case: `parseTurnRef` throws on a status it does not
   * recognize, which escalates to a protocol fault and kills the generation, so a value
   * ADDED upstream is every bit as breaking as one removed. Unions we merely pass
   * through use `requireEnumValues` instead.
   */
  requireExactEnum(source: string, typeName: string, expected: readonly string[], why: string): void {
    const declared = [...source.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const missing = expected.filter((v) => !declared.includes(v));
    const extra = declared.filter((v) => !expected.includes(v));
    if (missing.length === 0 && extra.length === 0) {
      this.ok(`${typeName} is still exactly ${expected.join(' | ')}`);
      return;
    }
    this.fail(
      `${typeName} is exactly ${expected.join(' | ')}`,
      [
        missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
        extra.length > 0 ? `unexpected: ${extra.join(', ')}` : '',
      ].filter(Boolean).join('; ') + ` — ${why}`,
    );
  }

  /** Assert a union contains AT LEAST the values the adapter branches on. */
  requireEnumValues(source: string, typeName: string, needed: readonly string[], why: string): void {
    const missing = needed.filter((v) => !source.includes(`"${v}"`));
    if (missing.length > 0) this.fail(`${typeName} still accepts ${needed.join(' | ')}`, `missing: ${missing.join(', ')} — ${why}`);
    else this.ok(`${typeName} still accepts ${needed.join(' | ')}`);
  }
}

/**
 * Split a ts-rs tagged union into its variants, keyed by `"type"` tag.
 *
 * Brace-matched rather than regex-delimited: several variants embed named types and one
 * (`config`) embeds a mapped type, so a non-greedy `[^}]*` would cut a variant short and
 * then "prove" a field absent that is simply further along. Whitespace is collapsed first
 * so a member split across lines still reads as one declaration.
 */
function unionVariants(source: string): Map<string, string> {
  const flat = source.replace(/\s+/g, ' ');
  const out = new Map<string, string>();
  const start = /\{ "type": "([A-Za-z0-9_]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = start.exec(flat)) !== null) {
    let depth = 0;
    let end = flat.length;
    for (let i = match.index; i < flat.length; i++) {
      if (flat[i] === '{') depth += 1;
      else if (flat[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    out.set(match[1], flat.slice(match.index, end));
  }
  return out;
}

/**
 * Run every drift assertion. Reports ALL findings rather than the first, so one run
 * after a version bump tells the whole story.
 */
export function auditBindings(read: BindingReader): SchemaAuditResult {
  const audit = new Audit();
  const load = (name: string): string | null => {
    const raw = read(name);
    return raw === null ? null : stripComments(raw);
  };

  // ── 1. initialize capabilities: BOTH fields required, exactly boolean ───────
  const caps = load('InitializeCapabilities');
  if (!caps) {
    audit.fail('InitializeCapabilities exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(caps, 'InitializeCapabilities', 'experimentalApi', /boolean/, 'boolean');
    audit.requireField(caps, 'InitializeCapabilities', 'requestAttestation', /boolean/, 'boolean');
  }

  // ── 2. initialize response: the fields we read, still exactly strings ───────
  const initResponse = load('InitializeResponse');
  if (!initResponse) {
    audit.fail('InitializeResponse exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(initResponse, 'InitializeResponse', 'userAgent', /string/, 'string');
    audit.requireField(initResponse, 'InitializeResponse', 'platformFamily', /string/, 'string');
    audit.requireField(initResponse, 'InitializeResponse', 'platformOs', /string/, 'string');

    // codexHome may be declared as the AbsolutePathBuf alias or as a bare string. If
    // it names the alias, that alias must exist AND still be a plain string — the
    // isolation check compares it against our own CODEX_HOME path, so a structural
    // type there would make the comparison meaningless rather than merely noisy.
    const referencesAlias = /\bcodexHome\s*:\s*AbsolutePathBuf\b/.test(initResponse);
    audit.requireField(
      initResponse,
      'InitializeResponse',
      'codexHome',
      /AbsolutePathBuf|string/,
      'AbsolutePathBuf or string',
    );
    if (referencesAlias) {
      const alias = load('AbsolutePathBuf');
      if (!alias) {
        audit.fail(
          'AbsolutePathBuf binding exists',
          'codexHome is declared as AbsolutePathBuf but the alias is missing from the generated schema, so its underlying type is unverifiable',
        );
      } else if (!/=\s*string\s*;/.test(alias)) {
        audit.fail(
          'AbsolutePathBuf = string',
          `the alias is no longer a plain string (${alias.replace(/\s+/g, ' ').trim()}), so the codexHome isolation comparison is unsafe`,
        );
      } else {
        audit.ok('AbsolutePathBuf is still a plain string alias');
      }
    }
  }

  // ── 3. client info ─────────────────────────────────────────────────────────
  const clientInfo = load('ClientInfo');
  if (!clientInfo) {
    audit.fail('ClientInfo exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(clientInfo, 'ClientInfo', 'name', /string/, 'string');
    audit.requireField(clientInfo, 'ClientInfo', 'version', /string/, 'string');
    // Exactly `string | null` — no bare-string fallback. We send an explicit title,
    // and a change here would mean the nullability contract moved.
    audit.requireField(clientInfo, 'ClientInfo', 'title', /string\s*\|\s*null/, 'string | null');
  }

  // ── 4. every request method we send still exists ───────────────────────────
  const clientRequest = load('ClientRequest');
  if (!clientRequest) {
    audit.fail('ClientRequest exists', 'the generated schema no longer contains it');
  } else {
    for (const method of CONSUMED_REQUEST_METHODS) {
      const variant = new RegExp(`"method"\\s*:\\s*"${method.replace(/\//g, '\\/')}"`);
      if (variant.test(clientRequest)) {
        audit.ok(`ClientRequest still accepts "${method}"`);
      } else {
        audit.fail(
          `ClientRequest accepts "${method}"`,
          'the method is gone or renamed; the adapter would get method-not-found at runtime',
        );
      }
    }
  }

  // ── 5. the `initialized` notification still carries NO params ──────────────
  const clientNotification = load('ClientNotification');
  if (!clientNotification) {
    audit.fail('ClientNotification exists', 'the generated schema no longer contains it');
  } else {
    const variant = new RegExp(`\\{[^}]*"method"\\s*:\\s*"${CONSUMED_CLIENT_NOTIFICATION}"[^}]*\\}`);
    const match = clientNotification.match(variant);
    if (!match) {
      audit.fail(`ClientNotification has a "${CONSUMED_CLIENT_NOTIFICATION}" variant`, 'not found in the generated schema');
    } else if (/params/.test(match[0])) {
      audit.fail(
        `"${CONSUMED_CLIENT_NOTIFICATION}" carries no params member`,
        `it now declares one: ${match[0].trim()} — the client must start sending params`,
      );
    } else {
      audit.ok(`"${CONSUMED_CLIENT_NOTIFICATION}" still carries no params member`);
    }
  }

  // ── 6. thread/turn lifecycle: the v2 surface Phase 2 consumes ──────────────
  auditThreadLifecycle(audit, load);

  // ── 6a. native Windows containment readiness ─────────────────────────────
  auditWindowsSandboxReadiness(audit, load);

  // ── 6b. the MCP-authority surface a resume is verified through ─────────────
  auditMcpAuthoritySurface(audit, load);

  // ── 6c. the INBOUND surface: notifications, routing ids, terminals, usage,
  //         and the items translated into engine events ───────────────────────
  auditConsumedNotifications(audit, load);
  auditTurnTerminal(audit, load);
  auditTokenUsage(audit, load);
  auditMappedThreadItems(audit, load);

  // ── 7. envelope discriminant: RequestId shape ──────────────────────────────
  // The strict inbound classifier accepts string|number ids and mints numbers.
  const requestId = load('RequestId');
  if (!requestId) {
    audit.fail('RequestId exists', 'the generated schema no longer contains it');
  } else if (!/=\s*string\s*\|\s*number\s*;|=\s*number\s*\|\s*string\s*;/.test(requestId)) {
    audit.fail('RequestId = string | number', `it is now: ${requestId.replace(/\s+/g, ' ').trim()}`);
  } else {
    audit.ok('RequestId is still string | number');
  }

  return { checks: audit.checks, failures: audit.failures };
}

function auditWindowsSandboxReadiness(audit: Audit, load: (name: string) => string | null): void {
  const response = load('v2/WindowsSandboxReadinessResponse');
  if (!response) {
    audit.fail('WindowsSandboxReadinessResponse exists', 'native Windows turns cannot prove containment readiness');
  } else {
    audit.requireField(
      response,
      'WindowsSandboxReadinessResponse',
      'status',
      /WindowsSandboxReadiness/,
      'WindowsSandboxReadiness',
    );
  }

  const readiness = load('v2/WindowsSandboxReadiness');
  if (!readiness) {
    audit.fail('WindowsSandboxReadiness exists', 'the readiness status union is missing');
  } else {
    audit.requireExactEnum(
      readiness,
      'WindowsSandboxReadiness',
      ['ready', 'notConfigured', 'updateRequired'],
      'the runtime parser rejects unknown values before thread/start',
    );
  }
}

/**
 * Every notification the manager CONSUMES, and — the part that matters — where each one
 * carries its turn identity.
 *
 * This is the schema half of finding 7's routing contract. `notificationRoute()` reads a
 * top-level `turnId` for six of the eight and the NESTED `turn.id` for `turn/started` and
 * `turn/completed`, and treats a payload that carries neither as corruption: a consumed
 * notification without the identity its schema requires poisons the generation rather
 * than being routed by thread alone. That rule is only correct while the schema keeps the
 * ids where we expect them, and the failure mode if it moves is the worst kind — a
 * terminal for one turn ending a different one, or every turn spinning because no
 * terminal ever routes.
 *
 * So each method is checked THREE ways: it still exists on `ServerNotification`, its
 * params still carry a required `threadId`, and its identity location still matches the
 * table `consumedNotificationIdentity()` reads. A `turnId` appearing on a nested variant
 * (or a `turn` object on a top-level one) is a failure even though nothing is missing:
 * both would change which branch of the router runs.
 */
function auditConsumedNotifications(audit: Audit, load: (name: string) => string | null): void {
  const serverNotification = load('ServerNotification');
  if (!serverNotification) {
    audit.fail('ServerNotification exists', 'the generated schema no longer contains it');
    return;
  }

  const declared = new Map<string, string>();
  for (const m of serverNotification.matchAll(/"method"\s*:\s*"([^"]+)"\s*,\s*"params"\s*:\s*([A-Za-z0-9_]+)/g)) {
    declared.set(m[1], m[2]);
  }

  for (const method of CONSUMED_NOTIFICATIONS) {
    const paramsType = declared.get(method);
    if (!paramsType) {
      audit.fail(
        `ServerNotification declares "${method}"`,
        'the method is gone or renamed; the manager would never see it again and every turn waiting on it would '
        + 'spin until its deadline',
      );
      continue;
    }

    const params = load(`v2/${paramsType}`);
    if (!params) {
      audit.fail(`v2/${paramsType} exists`, `"${method}" names it, but the binding is missing so its routing ids are unverifiable`);
      continue;
    }

    // Every consumed notification is thread-scoped, and routing starts from this field.
    audit.requireField(params, paramsType, 'threadId', /string/, 'string');

    const identity = consumedNotificationIdentity(method);
    if (identity === 'nested') {
      audit.requireField(params, paramsType, 'turn', /Turn/, 'Turn (the turn id is NESTED)');
      // A top-level turnId appearing here would be read FIRST and then cross-checked
      // against the nested one; two ids that disagree are treated as corruption.
      audit.refuseField(params, paramsType, 'turnId', 'the router expects this variant to carry its id nested inside `turn`');
    } else {
      audit.requireField(params, paramsType, 'turnId', /string/, 'string (the turn id is TOP-LEVEL)');
      audit.refuseField(params, paramsType, 'turn', 'a nested turn object here would change which id the router trusts');
    }
  }

  // The ITEM payload itself. Routing ids alone are not enough: `item/started` and
  // `item/completed` are the only carriers of structured items, and every progress event
  // the chat renders — commands, edits, MCP calls, reasoning — comes out of this member.
  // Without pinning it the audit would pass while every structured item silently
  // disappeared, because `parseThreadItem(undefined)` returns null and the sink treats
  // null as "nothing to display" rather than as a fault.
  for (const name of ['v2/ItemStartedNotification', 'v2/ItemCompletedNotification'] as const) {
    const source = load(name);
    if (!source) continue; // already reported by the loop above
    audit.requireField(source, name.replace('v2/', ''), 'item', /ThreadItem/, 'ThreadItem');
  }

  // The two payload fields the sink reads off notifications beyond their ids.
  const delta = load('v2/AgentMessageDeltaNotification');
  if (!delta) {
    audit.fail('v2/AgentMessageDeltaNotification exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(delta, 'AgentMessageDeltaNotification', 'delta', /string/, 'string');
    // The item boundary the live display paragraph-breaks on. Losing it would run
    // consecutive messages together in the chat.
    audit.requireField(delta, 'AgentMessageDeltaNotification', 'itemId', /string/, 'string');
  }

  const plan = load('v2/TurnPlanUpdatedNotification');
  if (!plan) {
    audit.fail('v2/TurnPlanUpdatedNotification exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(plan, 'TurnPlanUpdatedNotification', 'plan', /Array<TurnPlanStep>/, 'Array<TurnPlanStep>');
    audit.requireField(plan, 'TurnPlanUpdatedNotification', 'explanation', /string\s*\|\s*null/, 'string | null');
  }

  const planStep = load('v2/TurnPlanStep');
  if (!planStep) {
    audit.fail('v2/TurnPlanStep exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(planStep, 'TurnPlanStep', 'step', /string/, 'string');
    audit.requireField(planStep, 'TurnPlanStep', 'status', /TurnPlanStepStatus/, 'TurnPlanStepStatus');
  }
}

/**
 * The terminal payload, which is the only thing that tells a turn it is over.
 *
 * `TurnStatus` is pinned as an EXACT set rather than a subset, and that is deliberate:
 * `parseTurnRef` throws on a status it does not recognize, the throw becomes a protocol
 * fault, and the fault kills the generation. So a value ADDED upstream is not a graceful
 * degradation — it is every active turn on the connection failing the first time the new
 * status appears. An added status has to be a decision, not a surprise.
 *
 * `turn/interrupt`'s response is pinned alongside it because finding 4 deliberately reads
 * NOTHING from it: an interrupt returning means the server accepted the request, not that
 * the turn stopped, and only a terminal for that exact turn proves it did. If the response
 * ever starts carrying a confirmation, that is worth knowing rather than ignoring.
 */
function auditTurnTerminal(audit: Audit, load: (name: string) => string | null): void {
  const turn = load('v2/Turn');
  if (!turn) {
    audit.fail('v2/Turn exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(turn, 'Turn', 'status', /TurnStatus/, 'TurnStatus');
    // Required AND nullable: the parser distinguishes "no error" from a message it could
    // not read, and reports a turn that failed without one as exactly that.
    audit.requireField(turn, 'Turn', 'error', /TurnError\s*\|\s*null/, 'TurnError | null');
  }

  const turnStatus = load('v2/TurnStatus');
  if (!turnStatus) {
    audit.fail('v2/TurnStatus exists', 'the generated schema no longer contains it');
  } else {
    audit.requireExactEnum(
      turnStatus,
      'TurnStatus',
      ['completed', 'interrupted', 'failed', 'inProgress'],
      'an unrecognized status is a protocol fault that kills the generation, so a NEW value breaks every active '
      + 'turn as surely as a removed one',
    );
  }

  const turnError = load('v2/TurnError');
  if (!turnError) {
    audit.fail('v2/TurnError exists', 'the generated schema no longer contains it');
  } else {
    // The one field the failure path surfaces to the user.
    audit.requireField(turnError, 'TurnError', 'message', /string/, 'string');
  }

  const interruptResponse = load('v2/TurnInterruptResponse');
  if (!interruptResponse) {
    audit.fail('v2/TurnInterruptResponse exists', 'the generated schema no longer contains it');
  } else if (!/=\s*Record<string,\s*never>\s*;/.test(interruptResponse)) {
    audit.fail(
      'TurnInterruptResponse is still an empty record',
      `it is now: ${interruptResponse.replace(/\s+/g, ' ').trim()} — cancellation currently reads nothing from it and `
      + 'waits for the interrupted turn\'s own terminal instead; a payload here may carry a confirmation worth using',
    );
  } else {
    audit.ok('TurnInterruptResponse is still an empty record, so cancellation rightly reads nothing from it');
  }
}

/**
 * The token-usage payload `TurnUsage` differences.
 *
 * Per-turn usage is the component-wise DELTA between successive thread-CUMULATIVE reports,
 * so every one of the five buckets has to stay a plain number.
 *
 * The failure mode is quieter than a rejection, which is exactly why it needs an
 * upgrade-time check. `parseBreakdown` COERCES a bucket it cannot read to zero rather than
 * discarding the report, so a bucket that became nullable or structured would leave the
 * turn reporting a usage figure — just a wrong, silently low one, with the cost estimate
 * derived from it wrong too. Only a `tokenUsage.total`/`.last` that stopped being an object
 * at all discards the report outright.
 */
function auditTokenUsage(audit: Audit, load: (name: string) => string | null): void {
  const notification = load('v2/ThreadTokenUsageUpdatedNotification');
  if (!notification) {
    audit.fail('v2/ThreadTokenUsageUpdatedNotification exists', 'the generated schema no longer contains it');
  } else {
    // The nesting location: the parser reads `params.tokenUsage`, not the params root.
    audit.requireField(notification, 'ThreadTokenUsageUpdatedNotification', 'tokenUsage', /ThreadTokenUsage/, 'ThreadTokenUsage');
  }

  const usage = load('v2/ThreadTokenUsage');
  if (!usage) {
    audit.fail('v2/ThreadTokenUsage exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(usage, 'ThreadTokenUsage', 'total', /TokenUsageBreakdown/, 'TokenUsageBreakdown');
    // `last` is what SEEDS the first report of a turn: seeding from the thread total
    // instead would attribute the whole conversation's history to one turn.
    audit.requireField(usage, 'ThreadTokenUsage', 'last', /TokenUsageBreakdown/, 'TokenUsageBreakdown');
    audit.requireField(usage, 'ThreadTokenUsage', 'modelContextWindow', /number\s*\|\s*null/, 'number | null');
  }

  const breakdown = load('v2/TokenUsageBreakdown');
  if (!breakdown) {
    audit.fail('v2/TokenUsageBreakdown exists', 'the generated schema no longer contains it');
  } else {
    for (const field of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
      audit.requireField(breakdown, 'TokenUsageBreakdown', field, /number/, 'number');
    }
  }
}

/**
 * The `ThreadItem` variants translated into `AgentEngineEvent`, field by field.
 *
 * The existing tool-less check pins these variants' NAMES; this pins the members
 * `mapItem()` actually reads out of them. The two failure modes are different: a renamed
 * variant makes a harmless item look like tool use, while a renamed FIELD makes the item
 * render blank — a command execution with no command, an edit naming no files — which is
 * the kind of drift that never throws and so never gets noticed.
 *
 * Status enums are checked as subsets, not exact sets, because these values are passed
 * through to the progress event rather than branched on. The one exception is
 * `CommandExecutionStatus`, where `"completed"` decides whether a finished command is
 * reported as a failure.
 */
function auditMappedThreadItems(audit: Audit, load: (name: string) => string | null): void {
  const threadItem = load('v2/ThreadItem');
  if (!threadItem) {
    audit.fail('v2/ThreadItem exists', 'the generated schema no longer contains it');
    return;
  }
  const variants = unionVariants(threadItem);

  /**
   * `from` names a binding the variant is intersected with rather than declaring its own
   * members — `{ "type": "webSearch" } & WebSearchItem`, where the fields we read live in
   * `WebSearchItem`.
   */
  const MAPPED: Array<{ tag: string; from?: string; fields: Array<{ name: string; type: RegExp; label: string }> }> = [
    { tag: 'agentMessage', fields: [{ name: 'text', type: /string/, label: 'string' }] },
    {
      // `summary` ONLY, because that is the one member the parser derives its display text
      // from. `content` is deliberately NOT audited: ClaudeClaw never reads it — the
      // summary is the part meant for display and the content carries detail it leaves
      // out — and auditing a field production does not consume would assert a contract
      // nothing depends on.
      tag: 'reasoning',
      fields: [{ name: 'summary', type: /Array<string>/, label: 'Array<string>' }],
    },
    {
      tag: 'commandExecution',
      fields: [
        { name: 'command', type: /string/, label: 'string' },
        { name: 'status', type: /CommandExecutionStatus/, label: 'CommandExecutionStatus' },
        { name: 'exitCode', type: /number\s*\|\s*null/, label: 'number | null' },
      ],
    },
    {
      tag: 'fileChange',
      fields: [
        { name: 'changes', type: /Array<FileUpdateChange>/, label: 'Array<FileUpdateChange>' },
        { name: 'status', type: /PatchApplyStatus/, label: 'PatchApplyStatus' },
      ],
    },
    {
      tag: 'mcpToolCall',
      fields: [
        { name: 'server', type: /string/, label: 'string' },
        { name: 'tool', type: /string/, label: 'string' },
        { name: 'status', type: /McpToolCallStatus/, label: 'McpToolCallStatus' },
      ],
    },
    { tag: 'webSearch', from: 'WebSearchItem', fields: [{ name: 'query', type: /string/, label: 'string' }] },
    { tag: 'contextCompaction', fields: [] },
  ];

  for (const { tag, from, fields } of MAPPED) {
    const variant = variants.get(tag);
    if (!variant) {
      audit.fail(
        `ThreadItem still declares the "${tag}" variant`,
        'ClaudeClaw translates it into an engine event; without it that event silently stops being produced',
      );
      continue;
    }
    // `id` is the toolCallId every progress event is keyed by, so a variant that stopped
    // carrying one would collapse separate tool calls into a single row.
    const body = from ? load(from) : variant;
    if (!body) {
      audit.fail(`${from} exists`, `the "${tag}" ThreadItem variant is intersected with it, so its fields are unverifiable`);
      continue;
    }
    audit.requireField(body, `ThreadItem.${tag}`, 'id', /string/, 'string');
    for (const { name, type, label } of fields) {
      audit.requireField(body, `ThreadItem.${tag}`, name, type, label);
    }
  }

  // Sub-shapes the mapped fields resolve THROUGH. `changes: Array<FileUpdateChange>` says
  // nothing if the element stopped carrying the path the edit summary lists.
  const change = load('v2/FileUpdateChange');
  if (!change) {
    audit.fail('v2/FileUpdateChange exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(change, 'FileUpdateChange', 'path', /string/, 'string');
  }

  const execStatus = load('v2/CommandExecutionStatus');
  if (!execStatus) {
    audit.fail('v2/CommandExecutionStatus exists', 'the generated schema no longer contains it');
  } else {
    audit.requireEnumValues(
      execStatus,
      'CommandExecutionStatus',
      ['completed'],
      'a finished command is reported as a FAILURE unless its status is exactly "completed", so losing the value '
      + 'would surface every successful command as failed',
    );
  }
}

/**
 * The surface that proves a RESUMED thread reaches only the MCP servers the current
 * turn authorized.
 *
 * Neither thread response carries an MCP field, so this is the only evidence there
 * is. Two methods make it work and both are pinned here:
 *
 *  - `thread/unsubscribe` drops the App Server's loaded copy of a thread. Without
 *    it a `thread/resume` REJOINS the loaded thread and ignores the resume
 *    parameters entirely, so `mcp_servers` never replaces anything.
 *  - `mcpServerStatus/list` reports the effective inventory. `threadId` is what
 *    scopes it to one thread — without that field the reply describes the
 *    config-file set instead, and the check would verify the wrong thing while
 *    still appearing to pass. `nextCursor` is what proves a page is the last one.
 */
function auditMcpAuthoritySurface(audit: Audit, load: (name: string) => string | null): void {
  const unsubscribeParams = load('v2/ThreadUnsubscribeParams');
  if (!unsubscribeParams) {
    audit.fail('v2/ThreadUnsubscribeParams exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(unsubscribeParams, 'ThreadUnsubscribeParams', 'threadId', /string/, 'string');
  }

  const unsubscribeResponse = load('v2/ThreadUnsubscribeResponse');
  if (!unsubscribeResponse) {
    audit.fail('v2/ThreadUnsubscribeResponse exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(
      unsubscribeResponse,
      'ThreadUnsubscribeResponse',
      'status',
      /ThreadUnsubscribeStatus/,
      'ThreadUnsubscribeStatus',
    );
  }

  // The status values the adapter reasons about: a thread that was loaded and is now
  // dropped, and a thread that was never loaded (the normal case after a restart).
  const unsubscribeStatus = load('v2/ThreadUnsubscribeStatus');
  if (!unsubscribeStatus) {
    audit.fail('v2/ThreadUnsubscribeStatus exists', 'the generated schema no longer contains it');
  } else {
    const missing = ['unsubscribed', 'notLoaded'].filter((v) => !unsubscribeStatus.includes(`"${v}"`));
    if (missing.length > 0) {
      audit.fail('ThreadUnsubscribeStatus still reports unsubscribed | notLoaded', `missing: ${missing.join(', ')}`);
    } else {
      audit.ok('ThreadUnsubscribeStatus still reports unsubscribed and notLoaded');
    }
  }

  const listParams = load('v2/ListMcpServerStatusParams');
  if (!listParams) {
    audit.fail('v2/ListMcpServerStatusParams exists', 'the generated schema no longer contains it');
  } else {
    for (const { field, type, label, why } of [
      { field: 'threadId', type: /string\s*\|\s*null/, label: 'string | null', why: 'the inventory could no longer be scoped to one thread, so the check would read the config-file set instead' },
      { field: 'detail', type: /McpServerStatusDetail\s*\|\s*null/, label: 'McpServerStatusDetail | null', why: 'the lighter detail level is no longer selectable' },
      { field: 'cursor', type: /string\s*\|\s*null/, label: 'string | null', why: 'a multi-page inventory could no longer be read to the end' },
    ]) {
      const declared = new RegExp(`\\b${field}\\s*\\?\\s*:\\s*(?:${type.source})\\s*(?=[,;}]|$)`, 'm');
      if (declared.test(listParams)) {
        audit.ok(`ListMcpServerStatusParams.${field} still accepts ${label}`);
      } else {
        const actual = new RegExp(`\\b${field}\\s*\\??\\s*:\\s*([^,;}]+)`).exec(listParams);
        audit.fail(
          `ListMcpServerStatusParams.${field}: ${label}`,
          actual ? `declared type is now \`${actual[1].trim()}\` — ${why}` : `not found — ${why}`,
        );
      }
    }
  }

  const detail = load('v2/McpServerStatusDetail');
  if (!detail) {
    audit.fail('v2/McpServerStatusDetail exists', 'the generated schema no longer contains it');
  } else if (!detail.includes('"toolsAndAuthOnly"')) {
    audit.fail('McpServerStatusDetail still accepts "toolsAndAuthOnly"', `it is now: ${detail.replace(/\s+/g, ' ').trim()}`);
  } else {
    audit.ok('McpServerStatusDetail still accepts "toolsAndAuthOnly"');
  }

  const listResponse = load('v2/ListMcpServerStatusResponse');
  if (!listResponse) {
    audit.fail('v2/ListMcpServerStatusResponse exists', 'the generated schema no longer contains it');
  } else {
    audit.requireField(listResponse, 'ListMcpServerStatusResponse', 'data', /Array<McpServerStatus>/, 'Array<McpServerStatus>');
    // Required and nullable: the parser distinguishes "last page" (null) from a
    // response it cannot page through, so an absent member is not "no more pages".
    audit.requireField(listResponse, 'ListMcpServerStatusResponse', 'nextCursor', /string\s*\|\s*null/, 'string | null');
  }

  const status = load('v2/McpServerStatus');
  if (!status) {
    audit.fail('v2/McpServerStatus exists', 'the generated schema no longer contains it');
  } else {
    // The name is the whole comparison: it is matched against the sanitized
    // `mcp_servers` keys this turn sent.
    audit.requireField(status, 'McpServerStatus', 'name', /string/, 'string');
  }
}

/**
 * The v2 thread/turn surface. Named with the `v2/` prefix because that is where
 * `generate-ts` puts them; the reader resolves the subdirectory.
 *
 * Effective-policy verification is a release requirement, so every field it reads is
 * pinned here. Drift in `SandboxPolicy` is the sharpest risk: the request side uses
 * kebab-case MODES and the response a tagged camelCase POLICY, so a renamed tag would
 * make every comparison mismatch (blocking all turns) or, worse, make an unexpected
 * variant look acceptable.
 */
function auditThreadLifecycle(audit: Audit, load: (name: string) => string | null): void {
  // The effective-policy fields verification reads, on BOTH responses — with their
  // TYPES, not merely their names. Presence alone would accept `sandbox: string` or
  // `instructionSources: string`, either of which the runtime parser would then throw
  // on for every turn; an upgrade-time failure is worth far more than a runtime one.
  //
  // NOTE the doubled backslashes throughout: in a template literal `\b` is a BACKSPACE
  // character and `\s` a literal "s", so a single-backslash version matches nothing.
  const POLICY_FIELDS: Array<{ field: string; type: RegExp; label: string }> = [
    { field: 'thread', type: /Thread/, label: 'Thread' },
    { field: 'model', type: /string/, label: 'string' },
    { field: 'modelProvider', type: /string/, label: 'string' },
    { field: 'cwd', type: /AbsolutePathBuf|string/, label: 'AbsolutePathBuf' },
    // Element types are pinned, not just "an array": the parser rejects a non-string
    // element, so an array of structs would fail every turn at runtime instead of
    // failing the upgrade here.
    { field: 'runtimeWorkspaceRoots', type: /Array<AbsolutePathBuf>/, label: 'Array<AbsolutePathBuf>' },
    { field: 'instructionSources', type: /Array<LegacyAppPathString>/, label: 'Array<LegacyAppPathString>' },
    { field: 'approvalPolicy', type: /AskForApproval/, label: 'AskForApproval' },
    { field: 'sandbox', type: /SandboxPolicy/, label: 'SandboxPolicy' },
    { field: 'activePermissionProfile', type: /ActivePermissionProfile\s*\|\s*null/, label: 'ActivePermissionProfile | null' },
    { field: 'reasoningEffort', type: /ReasoningEffort\s*\|\s*null/, label: 'ReasoningEffort | null' },
  ];

  for (const responseName of ['v2/ThreadStartResponse', 'v2/ThreadResumeResponse'] as const) {
    const source = load(responseName);
    if (!source) {
      audit.fail(`${responseName} exists`, 'the generated schema no longer contains it');
      continue;
    }
    const wrong: string[] = [];
    for (const { field, type, label } of POLICY_FIELDS) {
      // Exact through the member terminator: a prefix match would accept
      // `sandbox: SandboxPolicy | null` and hide a new nullability contract.
      const exact = new RegExp(`\\b${field}\\s*:\\s*(?:${type.source})\\s*(?=[,;}]|$)`, 'm');
      if (!exact.test(source)) {
        const actual = new RegExp(`\\b${field}\\s*:\\s*([^,;}]+)`).exec(source);
        wrong.push(actual ? `${field} (now \`${actual[1].trim()}\`, expected ${label})` : `${field} (absent, expected ${label})`);
      }
    }
    if (wrong.length > 0) {
      audit.fail(
        `${responseName} still reports the effective policy`,
        `${wrong.join('; ')} — effective-policy verification cannot be performed on these`,
      );
    } else {
      audit.ok(`${responseName} reports all ${POLICY_FIELDS.length} effective-policy fields with their expected types`);
    }
  }

  // Independently pin the aliases and member types the policy fields resolve THROUGH.
  // `sandbox: SandboxPolicy` means nothing if SandboxPolicy itself changed shape, and
  // `reasoningEffort: ReasoningEffort | null` means nothing if the alias stopped being
  // a string the verifier can compare.
  for (const { name, pattern, label } of [
    { name: 'ReasoningEffort', pattern: /=\s*string\s*;/, label: 'a string alias' },
    { name: 'LegacyAppPathString', pattern: /=\s*string\s*;/, label: 'a string alias' },
  ]) {
    const source = load(name);
    if (!source) {
      audit.fail(`${name} exists`, 'the generated schema no longer contains it');
    } else if (!pattern.test(source)) {
      audit.fail(`${name} is ${label}`, `it is now: ${source.replace(/\s+/g, ' ').trim()}`);
    } else {
      audit.ok(`${name} is still ${label}`);
    }
  }

  // Thread.id is the session identifier ClaudeClaw stores and resumes by.
  const thread = load('v2/Thread');
  if (!thread) {
    audit.fail('v2/Thread exists', 'the generated schema no longer contains it');
  } else if (!/\bid\s*:\s*string\s*(?=[,;}]|$)/m.test(thread)) {
    const actual = /\bid\s*:\s*([^,;}]+)/.exec(thread);
    audit.fail('Thread.id: string', actual ? `declared type is now \`${actual[1].trim()}\`` : 'the field is absent');
  } else {
    audit.ok('Thread.id is still a string');
  }

  // ActivePermissionProfile members: both required, `extends` nullable. The parser
  // distinguishes absent from null here, so the shape must stay exact.
  const profile = load('v2/ActivePermissionProfile');
  if (!profile) {
    audit.fail('v2/ActivePermissionProfile exists', 'the generated schema no longer contains it');
  } else {
    if (/\bid\s*:\s*string\s*(?=[,;}]|$)/m.test(profile)) {
      audit.ok('ActivePermissionProfile.id is still a required string');
    } else {
      audit.fail('ActivePermissionProfile.id: required string', 'the member changed or is absent');
    }
    if (/\bextends\s*:\s*string\s*\|\s*null\s*(?=[,;}]|$)/m.test(profile)) {
      audit.ok('ActivePermissionProfile.extends is still a required string | null');
    } else {
      const actual = /\bextends\s*\??\s*:\s*([^,;}]+)/.exec(profile);
      audit.fail(
        'ActivePermissionProfile.extends: required string | null',
        actual ? `declared type is now \`${actual[1].trim()}\`` : 'the member is absent',
      );
    }
  }

  // Request-side sandbox selector: the three kebab-case modes our profile emits.
  const sandboxMode = load('v2/SandboxMode');
  if (!sandboxMode) {
    audit.fail('v2/SandboxMode exists', 'the generated schema no longer contains it');
  } else {
    const missing = ['read-only', 'workspace-write', 'danger-full-access']
      .filter((mode) => !sandboxMode.includes(`"${mode}"`));
    if (missing.length > 0) {
      audit.fail('SandboxMode still accepts our three modes', `missing: ${missing.join(', ')}`);
    } else {
      audit.ok('SandboxMode still accepts read-only | workspace-write | danger-full-access');
    }
  }

  // Request-side fields ClaudeClaw SENDS, on both start and resume. Presence alone is
  // not enough: if `sandbox` stopped taking a mode, or `config` stopped accepting a
  // map, the request would be rejected or — worse — silently accepted with our
  // hardening dropped.
  const REQUEST_FIELDS: Array<{ field: string; type: RegExp; label: string }> = [
    { field: 'model', type: /string\s*\|\s*null/, label: 'string | null' },
    { field: 'modelProvider', type: /string\s*\|\s*null/, label: 'string | null' },
    { field: 'cwd', type: /string\s*\|\s*null/, label: 'string | null' },
    { field: 'sandbox', type: /SandboxMode\s*\|\s*null/, label: 'SandboxMode | null' },
    { field: 'approvalPolicy', type: /AskForApproval\s*\|\s*null/, label: 'AskForApproval | null' },
    { field: 'developerInstructions', type: /string\s*\|\s*null/, label: 'string | null' },
  ];
  for (const paramsName of ['v2/ThreadStartParams', 'v2/ThreadResumeParams'] as const) {
    const source = load(paramsName);
    if (!source) {
      audit.fail(`${paramsName} exists`, 'the generated schema no longer contains it');
      continue;
    }
    for (const { field, type, label } of REQUEST_FIELDS) {
      // These are optional-by-design on the request side (`field?: T | null`), so the
      // required-field helper does not apply; assert the declared type instead.
      const declared = new RegExp(`\\b${field}\\s*\\?\\s*:\\s*(?:${type.source})\\s*(?=[,;}]|$)`, 'm');
      if (declared.test(source)) {
        audit.ok(`${paramsName}.${field} still accepts ${label}`);
      } else {
        const actual = new RegExp(`\\b${field}\\s*\\??\\s*:\\s*([^,;}]+)`).exec(source);
        audit.fail(
          `${paramsName}.${field}: ${label}`,
          actual ? `declared type is now \`${actual[1].trim()}\`` : `not found in ${paramsName}`,
        );
      }
    }
    // `config` is how every hardening override travels (project_doc_max_bytes,
    // features.apps, web_search, sandbox_workspace_write, model_reasoning_effort).
    // It must still be a MAP: if it became a typed struct our keys would be rejected
    // or, worse, silently dropped along with the hardening they carry.
    // Exact: an open string-keyed map of JsonValue, nullable. A narrower value type
    // would reject the nested objects our hardening sends (features, web_search,
    // sandbox_workspace_write), and losing `| null` would change how absence is
    // expressed.
    if (/\bconfig\s*\?\s*:\s*\{\s*\[\s*key\s+in\s+string\s*\]\?\s*:\s*JsonValue\s*\}\s*\|\s*null\s*(?=[,;}]|$)/m.test(source)) {
      audit.ok(`${paramsName}.config is still { [key in string]?: JsonValue } | null`);
    } else {
      const actual = /\bconfig\s*\??\s*:\s*([^,;]+)/.exec(source);
      audit.fail(
        `${paramsName}.config: { [key in string]?: JsonValue }`,
        actual
          ? `declared type is now \`${actual[1].trim()}\` — hardening overrides may no longer be accepted`
          : 'hardening overrides and reasoning effort have no delivery path without it',
      );
    }
  }
  // resume-specific: the thread id we address, and the transcript we decline. Typed,
  // because a threadId that stopped being a required string would change how resume
  // is addressed, and an excludeTurns that stopped being boolean would silently start
  // pulling full history we deliberately do not want.
  const resumeParams = load('v2/ThreadResumeParams');
  if (resumeParams) {
    for (const { field, pattern, label } of [
      { field: 'threadId', pattern: /threadId\s*:\s*string\s*(?=[,;}]|$)/m, label: 'required string' },
      { field: 'excludeTurns', pattern: /excludeTurns\s*\?\s*:\s*boolean\s*(?=[,;}]|$)/m, label: 'optional boolean' },
    ]) {
      if (pattern.test(resumeParams)) {
        audit.ok(`ThreadResumeParams.${field} is still a ${label}`);
      } else {
        const actual = new RegExp(`\\b${field}\\s*\\??\\s*:\\s*([^,;}]+)`).exec(resumeParams);
        audit.fail(
          `ThreadResumeParams.${field}: ${label}`,
          actual ? `declared type is now \`${actual[1].trim()}\`` : 'the field is absent',
        );
      }
    }
  }

  // Response-side tagged policy: tags, variant-specific field TYPES, and both temp
  // exclusion flags. Type-checking the variants matters because the parser rejects a
  // non-boolean networkAccess: if the schema changed it to an enum, every turn would
  // fail as a protocol error at runtime rather than at upgrade time.
  const sandboxPolicy = load('v2/SandboxPolicy');
  if (!sandboxPolicy) {
    audit.fail('v2/SandboxPolicy exists', 'the generated schema no longer contains it');
  } else {
    // externalSandbox is included deliberately: we never request it, and verification
    // must keep being able to name it when a host applies it.
    for (const tag of ['readOnly', 'workspaceWrite', 'dangerFullAccess', 'externalSandbox']) {
      if (sandboxPolicy.includes(`"${tag}"`)) {
        audit.ok(`SandboxPolicy still tags "${tag}"`);
      } else {
        audit.fail(`SandboxPolicy tags "${tag}"`, 'the tag is gone or renamed; every effective-sandbox comparison would mismatch');
      }
    }
    // readOnly.networkAccess and workspaceWrite.{networkAccess,excludeTmpdirEnvVar,
    // excludeSlashTmp} must all still be booleans.
    const readOnlyVariant = /\{\s*"type"\s*:\s*"readOnly"\s*,([^}]*)\}/.exec(sandboxPolicy);
    if (!readOnlyVariant || !/networkAccess\s*:\s*boolean/.test(readOnlyVariant[1])) {
      audit.fail('readOnly.networkAccess: boolean', 'network confinement can no longer be verified on a read-only sandbox');
    } else {
      audit.ok('readOnly.networkAccess is still boolean');
    }
    const wsVariant = /\{\s*"type"\s*:\s*"workspaceWrite"\s*,([^}]*)\}/.exec(sandboxPolicy);
    if (!wsVariant) {
      audit.fail('workspaceWrite variant exists', 'the workspace-write policy shape is gone');
    } else {
      const body = wsVariant[1];
      // Element type pinned: the parser rejects non-string elements and requires each
      // to be absolute, so an array of structs would fail every turn at runtime.
      if (!/writableRoots\s*:\s*Array<AbsolutePathBuf>/.test(body)) {
        const actual = /writableRoots\s*:\s*([^,;}]+)/.exec(body);
        audit.fail(
          'workspaceWrite.writableRoots: Array<AbsolutePathBuf>',
          actual ? `declared type is now \`${actual[1].trim()}\`` : 'root broadening can no longer be verified',
        );
      } else {
        audit.ok('workspaceWrite.writableRoots is still Array<AbsolutePathBuf>');
      }
      for (const flag of ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp']) {
        if (new RegExp(`${flag}\\s*:\\s*boolean`).test(body)) {
          audit.ok(`workspaceWrite.${flag} is still boolean`);
        } else {
          audit.fail(
            `workspaceWrite.${flag}: boolean`,
            flag === 'networkAccess'
              ? 'network confinement can no longer be verified'
              : 'temp directories could become implicit writable roots undetected',
          );
        }
      }
    }
  }

  // Approvals: only the exact "never" value is acceptable to us.
  const approval = load('v2/AskForApproval');
  if (!approval) {
    audit.fail('v2/AskForApproval exists', 'the generated schema no longer contains it');
  } else if (!approval.includes('"never"')) {
    audit.fail('AskForApproval still accepts "never"', 'ClaudeClaw has no interactive approval channel and requires it');
  } else {
    audit.ok('AskForApproval still accepts "never"');
  }

  // turn/start input: the text variant, including the snake_case text_elements that
  // is easy to omit and required.
  const userInput = load('v2/UserInput');
  if (!userInput) {
    audit.fail('v2/UserInput exists', 'the generated schema no longer contains it');
  } else {
    // Isolate the TEXT variant and check inside it. Searching the whole union would
    // pass if `text` lived on one variant and `text_elements` on another — the shape
    // we send would still fail to deserialize.
    const variant = /\{\s*"type"\s*:\s*"text"\s*,([^}]*)\}/.exec(userInput);
    if (!variant) {
      audit.fail('UserInput has a "text" variant', 'turn/start input can no longer be plain text');
    } else if (!/\btext\s*:\s*string\s*(?=[,;}]|$)/m.test(variant[1])) {
      audit.fail('UserInput text variant: text is a string', `variant is now \`${variant[1].trim()}\``);
    } else if (!/\btext_elements\s*:\s*Array<[^>]+>\s*(?=[,;}]|$)/m.test(variant[1])) {
      audit.fail(
        'UserInput text variant: text_elements is an array',
        `variant is now \`${variant[1].trim()}\` — this field is required and easy to omit`,
      );
    } else {
      audit.ok('UserInput text variant still has string text + array text_elements');
    }
  }

  // The turn/start RESPONSE is what names the turn. Cancellation reads the id from it
  // rather than waiting for `turn/started`, because an abort that beats the
  // notification would otherwise have nothing to interrupt — and the adapter now
  // quarantines the connection rather than report a cancellation it cannot perform.
  const startResponse = load('v2/TurnStartResponse');
  const turn = load('v2/Turn');
  if (!startResponse || !turn) {
    audit.fail('v2/TurnStartResponse and v2/Turn exist', 'the generated schema no longer contains them');
  } else if (!/\bturn\s*:\s*Turn\s*(?=[,;}]|$)/m.test(startResponse)) {
    audit.fail(
      'TurnStartResponse carries a required `turn: Turn`',
      `response is now \`${startResponse.trim()}\` — the turn could not be named until turn/started arrived`,
    );
  } else if (!/\bid\s*:\s*string\s*(?=[,;}]|$)/m.test(turn)) {
    audit.fail(
      'Turn.id is a required string',
      'a turn that cannot be named cannot be interrupted, and cancellation would poison the connection instead',
    );
  } else {
    audit.ok('TurnStartResponse still returns a Turn whose id is a required string');
  }

  // ── server-initiated requests ───────────────────────────────────────────────
  //
  // Only the shapes ClaudeClaw actually emits are asserted. The structured user
  // question is answered with content; everything else gets a schema-valid refusal,
  // and a refusal is only valid while the variant it names still exists.
  const serverRequest = load('ServerRequest');
  if (!serverRequest) {
    audit.fail('ServerRequest exists', 'the generated schema no longer contains it');
  } else {
    if (!/"method"\s*:\s*"item\/tool\/requestUserInput"[^|]*params\s*:\s*ToolRequestUserInputParams/.test(serverRequest)) {
      audit.fail(
        'ServerRequest still carries item/tool/requestUserInput with ToolRequestUserInputParams',
        'the one server-initiated method ClaudeClaw implements changed shape or name',
      );
    } else {
      audit.ok('ServerRequest still routes item/tool/requestUserInput to ToolRequestUserInputParams');
    }

    // The union and our classification table must agree in BOTH directions. A variant
    // we have not classified would fall through to method-not-found, which for an
    // authority-bearing request is a shrug dressed as a refusal; one we classify that
    // no longer exists is a policy guarding nothing. Either way the table is stale.
    const declared = [...stripComments(serverRequest).matchAll(/"method"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    const unclassified = declared.filter((method) => !SERVER_REQUEST_METHODS.includes(method));
    const vanished = SERVER_REQUEST_METHODS.filter((method) => !declared.includes(method));
    if (unclassified.length > 0) {
      audit.fail(
        'every ServerRequest variant is classified',
        `unclassified: ${unclassified.join(', ')} — ClaudeClaw would answer these method-not-found without anyone deciding that is safe`,
      );
    } else if (vanished.length > 0) {
      audit.fail(
        'every classified method still exists in ServerRequest',
        `no longer declared: ${vanished.join(', ')} — the denial or refusal for each is now dead policy`,
      );
    } else {
      audit.ok(`all ${declared.length} ServerRequest variants are classified, and none is stale`);
    }
  }

  // `item/tool/call` is denied with an empty, unsuccessful result rather than an
  // error, so the model is told the call did not happen instead of the turn breaking.
  const dynamicToolResponse = load('v2/DynamicToolCallResponse');
  if (!dynamicToolResponse) {
    audit.fail('v2/DynamicToolCallResponse exists', 'the generated schema no longer contains it');
  } else if (!/contentItems\s*:\s*Array</.test(dynamicToolResponse) || !/success\s*:\s*boolean/.test(dynamicToolResponse)) {
    audit.fail(
      'DynamicToolCallResponse still takes contentItems + success',
      `response is now \`${dynamicToolResponse.trim()}\` — the empty denial ClaudeClaw sends for item/tool/call no longer fits`,
    );
  } else {
    audit.ok('DynamicToolCallResponse still takes contentItems + success, so an empty unsuccessful denial is valid');
  }

  // Routing a question needs BOTH ids: it is answered by the exact turn that asked,
  // with no thread-only or latest-turn fallback.
  const askParams = load('v2/ToolRequestUserInputParams');
  if (!askParams) {
    audit.fail('v2/ToolRequestUserInputParams exists', 'the generated schema no longer contains it');
  } else {
    const missing = ['threadId', 'turnId', 'itemId'].filter(
      (field) => !new RegExp(`\\b${field}\\s*:\\s*string\\s*(?=[,;}]|$)`, 'm').test(askParams),
    );
    if (missing.length > 0) {
      audit.fail(
        'ToolRequestUserInputParams keeps threadId + turnId + itemId as required strings',
        `not required strings: ${missing.join(', ')} — the question could not be routed to the exact turn that asked`,
      );
    } else if (!/\bquestions\s*:\s*Array<ToolRequestUserInputQuestion>/.test(askParams)) {
      audit.fail('ToolRequestUserInputParams.questions is an array of questions', `params are now \`${askParams.trim()}\``);
    } else {
      audit.ok('ToolRequestUserInputParams still carries threadId + turnId + itemId and a question array');
    }
  }

  const askQuestion = load('v2/ToolRequestUserInputQuestion');
  if (!askQuestion) {
    audit.fail('v2/ToolRequestUserInputQuestion exists', 'the generated schema no longer contains it');
  } else if (!/\bid\s*:\s*string\s*(?=[,;}]|$)/m.test(askQuestion)) {
    audit.fail('ToolRequestUserInputQuestion.id is a required string', 'answers are keyed by question id and could not be returned');
  } else if (!/\bisSecret\s*:\s*boolean\s*(?=[,;}]|$)/m.test(askQuestion)) {
    // Losing this flag would silently start routing credentials to a chat UI.
    audit.fail('ToolRequestUserInputQuestion.isSecret is a required boolean', 'secret questions could no longer be told apart');
  } else {
    audit.ok('ToolRequestUserInputQuestion still has a required id and isSecret');
  }

  // The decline IS the empty answer map, so the values must stay optional.
  const askResponse = load('v2/ToolRequestUserInputResponse');
  if (!askResponse) {
    audit.fail('v2/ToolRequestUserInputResponse exists', 'the generated schema no longer contains it');
  } else if (!/answers\s*:\s*\{\s*\[key in string\]\?\s*:\s*ToolRequestUserInputAnswer\s*\}/.test(askResponse)) {
    audit.fail(
      'ToolRequestUserInputResponse.answers is a map of OPTIONAL answers',
      `response is now \`${askResponse.trim()}\` — an empty map is how ClaudeClaw declines, and it is the only decline this method has`,
    );
  } else {
    audit.ok('ToolRequestUserInputResponse still maps question ids to optional answers');
  }

  const askAnswer = load('v2/ToolRequestUserInputAnswer');
  if (!askAnswer || !/answers\s*:\s*Array<string>/.test(askAnswer)) {
    audit.fail('ToolRequestUserInputAnswer.answers is a string array', 'the answer payload ClaudeClaw builds no longer fits');
  } else {
    audit.ok('ToolRequestUserInputAnswer still takes a string array');
  }

  // Each refusal ClaudeClaw emits, and the variant that makes it legal.
  const refusals: Array<{ type: string; needle: RegExp; what: string; why: string }> = [
    {
      type: 'v2/CommandExecutionApprovalDecision',
      needle: /"decline"/,
      what: 'CommandExecutionApprovalDecision still has a "decline" variant',
      why: 'command approvals are declined with it under approvalPolicy: "never"',
    },
    {
      type: 'v2/FileChangeApprovalDecision',
      needle: /"decline"/,
      what: 'FileChangeApprovalDecision still has a "decline" variant',
      why: 'file-change approvals are declined with it',
    },
    {
      type: 'v2/McpServerElicitationAction',
      needle: /"decline"/,
      what: 'McpServerElicitationAction still has a "decline" variant',
      why: 'MCP elicitation is denied with it',
    },
    {
      type: 'ReviewDecision',
      needle: /"denied"/,
      what: 'ReviewDecision still has a "denied" variant',
      why: 'the legacy applyPatchApproval and execCommandApproval methods are denied with it',
    },
    {
      type: 'v2/PermissionGrantScope',
      needle: /"turn"/,
      what: 'PermissionGrantScope still has a "turn" variant',
      why: 'the empty permission grant is scoped to the narrowest thing available',
    },
  ];
  for (const { type, needle, what, why } of refusals) {
    const source = load(type);
    if (!source) audit.fail(`${type} exists`, 'the generated schema no longer contains it');
    else if (!needle.test(source)) audit.fail(what, `${why}; the refusal ClaudeClaw sends is no longer schema-valid`);
    else audit.ok(what);
  }

  // `item/permissions/requestApproval` has NO decline variant, so the refusal is an
  // EMPTY grant. That only stays valid while every member is optional.
  const granted = load('v2/GrantedPermissionProfile');
  if (!granted) {
    audit.fail('v2/GrantedPermissionProfile exists', 'the generated schema no longer contains it');
  } else if (/\b(network|fileSystem)\s*:/.test(granted)) {
    audit.fail(
      'GrantedPermissionProfile members are all optional',
      'a permission approval has no decline variant, so ClaudeClaw refuses with an EMPTY grant; a required member would force it to grant something',
    );
  } else {
    audit.ok('GrantedPermissionProfile members are still optional, so an empty grant is a valid refusal');
  }

  // The `maxToolItems: 0` backstop classifies thread items by EXCLUSION: anything not
  // on the non-tool list counts as the turn acting on the world, so a new variant
  // fails a tool-less turn closed rather than slipping past. The risk that runs the
  // other way is a non-tool variant being renamed — `agentMessage` becoming something
  // else would make every tool-less turn fail on its own reply — so each name is
  // checked against the union here.
  const threadItem = load('v2/ThreadItem');
  if (!threadItem) {
    audit.fail('v2/ThreadItem exists', 'the generated schema no longer contains it');
  } else {
    const missing = NON_TOOL_THREAD_ITEM_TYPES.filter(
      (type) => !new RegExp(`"type"\\s*:\\s*"${type}"`).test(threadItem),
    );
    if (missing.length > 0) {
      audit.fail(
        'every non-tool ThreadItem variant still exists',
        `no longer declared: ${missing.join(', ')} — a tool-less turn would now fail closed on one of its own harmless items`,
      );
    } else {
      audit.ok(`all ${NON_TOOL_THREAD_ITEM_TYPES.length} non-tool ThreadItem variants still exist`);
    }
  }

  // Pre-approving a trusted MCP server writes `default_tools_approval_mode: "approve"`
  // into its `mcp_servers` entry. That table is free-form CONFIG rather than a
  // generated type, so there is nothing to check its shape against — but the approval
  // vocabulary itself is pinned, and `"approve"` disappearing from it would leave the
  // dispatch bridge silently gated again, its calls cancelled with no approver.
  const approvalMode = load('v2/AppToolApproval');
  if (!approvalMode) {
    audit.fail('AppToolApproval exists', 'the generated schema no longer contains it');
  } else if (!/"approve"/.test(approvalMode)) {
    audit.fail(
      'AppToolApproval still has an "approve" variant',
      `the vocabulary is now \`${approvalMode.trim()}\` — trusted MCP servers would be pre-approved with a value Codex does not accept`,
    );
  } else {
    audit.ok('AppToolApproval still has an "approve" variant');
  }

  // turn/interrupt addressing: cancellation is turn-scoped, not connection-scoped.
  // Both ids must remain required strings — killing the shared child to cancel one
  // turn would abort unrelated missions and chats.
  const interrupt = load('v2/TurnInterruptParams');
  if (!interrupt) {
    audit.fail('v2/TurnInterruptParams exists', 'the generated schema no longer contains it');
  } else {
    const wrong = ['threadId', 'turnId'].filter(
      (field) => !new RegExp(`\\b${field}\\s*:\\s*string\\s*(?=[,;}]|$)`, 'm').test(interrupt),
    );
    if (wrong.length > 0) {
      audit.fail(
        'TurnInterruptParams keeps threadId + turnId as required strings',
        `not required strings: ${wrong.join(', ')} — per-turn cancellation could no longer target one turn`,
      );
    } else {
      audit.ok('TurnInterruptParams still takes threadId + turnId as required strings');
    }
  }
}
