# Native provider recovery acceptance

This ledger covers the source-level portion of issue #264 for the two stable
native providers: Claude and OpenAI. OpenAI is checked through both supported
transports (`sdk` and `app-server`). ACP-family and OpenRouter adapters remain
experimental and are outside this acceptance boundary.

The tests use fake SDKs and a fake App Server manager. They prove adapter
classification, session handling, and requested/effective policy checks without
starting a provider, child runtime, build, deployment, or live mission.

## Result and delivery classification

| Adapter boundary | Execution certainty | Recovery consequence |
| --- | --- | --- |
| Claude structured error result | `started` | Persist the failure; do not replay. Category is derived independently (including rate limit). |
| Claude SDK throw before any event | `unknown` | No automatic replay: the SDK supplies no delivery receipt. |
| Codex SDK `startThread`/`resumeThread` synchronous throw | `not_started` | The prompt has not reached `runStreamed`; ordinary provider recovery may proceed. |
| Codex SDK failure after `runStreamed` but before an event | `unknown` | No automatic replay. An observed turn event changes certainty to `started`. |
| App Server manager readiness or `thread/start`/`thread/resume` failure | `not_started` | Those calls carry configuration, not the prompt; `turn/start` was never sent. |
| App Server `turn/start` refused/not sent | `not_started` | Safe for the bounded recovery policy. |
| App Server `turn/start` unanswered or otherwise ambiguous | `unknown` | Quarantine the connection and do not replay. |

This slice closed two holes in that matrix. Codex SDK thread-construction errors
now return an engine `result` with typed failure metadata instead of escaping the
engine seam. App Server readiness and thread-setup errors now retain the positive
pre-prompt boundary instead of falling through the generic `unknown` catch.

The shared stale-session predicate was also narrowed. A generic
`thread/resume failed` prefix is not evidence of a missing session because auth,
rate-limit, and transport errors can use the same prefix. Fresh-session fallback
now requires explicit absence language such as `not found`, `no rollout found`,
`no such`, `missing`, or `does not exist`.

## Session and permission behavior

| Adapter | Session behavior | Permission evidence |
| --- | --- | --- |
| Claude SDK | A positively missing saved session is retried fresh once. The fallback removes only `resume`; the prompt, explicit `allowDangerouslySkipPermissions: false`, permission mode, coordinator allow/deny lists, and MCP table are preserved. | The adapter passes the caller's controls directly to the Claude SDK. The fake proves input preservation, not what a particular Claude CLI build enforces. |
| Codex SDK | A positively missing resume may fall back fresh once before observable output; output or a non-stale failure prevents replay. | The shared capability resolver maps coordinator/tool policy to a restricted requested sandbox, shell/apps/web gates, MCP table, and turn budget. The SDK does not expose effective host policy, so this remains request plus runtime backstop rather than enforcement attestation. |
| Codex App Server | Resume is serialized by thread id. Stale replacement holds both old and new thread locks, and no fallback occurs after the prompt may have started. | The adapter verifies the returned effective sandbox before `turn/start`, reads and compares MCP authority on resume, uses `approvalPolicy: never`, and fails closed on blocking mismatch. Tool-less runtime detection is still a backstop after the first forbidden tool item appears, not prevention of that first item. |

The independent interactive recovery layer intentionally invokes a fallback
provider without the original provider session. These adapter tests complement,
but do not replace, the higher-level assertions in
`docs/interactive-provider-acceptance.md`. Mission coordinator turns and ordinary
interactive turns remain distinct sessions; no adapter manufactures a permission
bypass during fallback.

## Issue #263 operator-control inventory

The existing operator surface is read-only and recovery-scoped:

- Telegram `/provider` shows current mission recovery attempts and their attached
  circuit state for that agent.
- The dashboard `/api/agents` response and agent cards show the same current
  recovery rows, including open/probing/closed state.
- `mission-cli workflow-result` includes persisted recovery diagnostics.
- The database accessor deliberately excludes upstream error text; surfaces show
  a bounded category/label rather than endpoint credentials or raw provider data.

There is no dedicated command or dashboard/API action to list every provider
circuit independently of an active recovery row, manually reset a circuit, force
a probe, or create an audited time-limited bypass. Cooldown and the single fenced
half-open probe remain the only reset path. No operator control was added here:
reset/bypass semantics need a separate authority and audit design and must not be
implemented as a direct table edit.

## Verification and remaining limits

Focused source verification:

```text
node node_modules/vitest/vitest.mjs run \
  src/agent-engine/codex-sdk-adapter.test.ts \
  src/agent-engine/codex-app-server-adapter.test.ts \
  src/agent-engine/claude-sdk-adapter.test.ts --reporter=dot

222 passed
```

The complete `src/agent-engine` suite also passed: 843 tests across 15 files.
`npm run typecheck` passed.

Still outside this evidence:

- live Claude/OpenAI requests, real credential or rate-limit failures, and actual
  provider-side effects;
- OS containment and the deferred isolated worker launcher;
- runtime overlay, build, restart, Telegram delivery, and soak acceptance;
- enforcement attestation for Claude SDK and Codex SDK, whose APIs do not report
  an effective host policy comparable to App Server;
- experimental provider parity and #263 circuit reset/control implementation.
