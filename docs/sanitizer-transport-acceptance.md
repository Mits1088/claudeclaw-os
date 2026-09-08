# Phase 6 #269 transport acceptance ledger

Mission `b5272a5e`, 2026-09-08. Candidate branch `recovery/crew-mission-governor`, HEAD `f581f5e3918b586f6509ad1411cbdb72efa7d6ec`. Existing tracked and untracked candidate work retained. All additions are local and uncommitted.

**Disposition: partial acceptance evidence; #269 remains open.** These fixtures do not establish complete provider-to-consumer coverage. Crew remains disabled; Phase 4B is deferred. No build, external send/provider, runtime overlay/restart, commit, push, merge, or GitHub write occurred.

## Supported text-path inventory

| Path | Candidate boundary | Captured evidence | Remaining gate |
| --- | --- | --- | --- |
| Telegram sendMessage, editMessageText, editMessageCaption | Actual Bot installs `outboundTelegramTransformer`; `formatForTelegram` and `splitMessage` scan complete input before mutation. Legacy final scanner replaced with central sanitizer. | `outbound-transport.test.ts` calls real grammY Api methods and captures downstream callback payload JSON. `outbound-dashboard.test.ts` checks HTML-sensitive secrets and a 4096-character split boundary. | Full bot handler with adversarial provider progress/error, accumulated stream, abort and retry fixtures. Inline keyboard labels/URLs and other non-text presentation metadata need separate inventory. |
| Signal direct/group send and attachment caption | `signal-bot.ts` scans before formatting, logging and splitting; `SignalRpcClient.send/sendWithAttachments` scan at send boundary. | Real RPC framing into an injected physical socket callback, including newline bytes and response parsing; existing loopback RPC regressions run separately. | Full handler synthetic-secret capture, including groups, retries, voice-to-text fallback and preformatted call sites. No Signal edit method exists in this client. |
| Mattermost posts, threads, attachment caption | Bot scans before formatting/logging/splitting; `postMessage` scans before REST serialization. | Captured fetch POST body with channel/root identifiers preserved. | Full handler synthetic-secret capture across progress, errors and retries. No edit method exists in this client. |
| Dashboard chat SSE | Publisher scans presentation fields; route serializer independently scans direct event-bus producers. | Actual Hono `/api/chat/stream` response bytes, including direct bus error; callback JSON tests cover nested locations/plan entries, progress and assistant content. Subscriber cleanup asserted. | Full provider-to-SSE stream/abort matrix and metadata such as photo URLs. |
| Voice JSON response/error | Both stdout success and catch paths call `serializeOutboundJson`; response retains existing central final scan. | Exact shared serializer output for response and error; numeric usage preserved. | Disposable subprocess fixture invoking the actual bridge with a fake engine, capturing stdout on success, abort and thrown provider error. No subprocess acceptance claimed. |
| War Room chunks/final/errors/tool events | Existing bounded whole-response guard; final text scanned before whitespace normalization; channel scans before live emit and replay buffering; DB scans transcripts/conversations. | Channel subscriber JSON, replay buffer, actual disposable transcript row and assistant conversation row. Existing guard tests separately exercise stream safety. | Orchestrator-driven fake provider fixture must connect chunks, final, abort/error, replay, transcript and conversation rows in the same run. Channel tests alone do not prove cross-chunk safety. |
| Progress/tool diagnostics | `runAgent` scans structured progress; presentation fields recursively scan at chat/War Room emission. War Room raw result scan now precedes whitespace normalization/truncation; argument JSON scan precedes truncation. | Nested progress sanitizer and callback tests; tool-result error event capture; direct scan-before-truncate assertion. | Provider-side truncation/normalization can destroy complete protected values before these seams; see exact blockers below. |
| Mission/scheduled/delegation/conversation persistence | Existing `db.ts` insertion/completion seams retained. | Prior mission and assistant-conversation persisted-row tests rerun. War Room row evidence added. | Scheduled/delegation/outcome rows still require a complete acceptance matrix, beyond the two prior persistence cases. |

## Exact residual blockers

1. Progress and errors may already contain partial credentials. `agent-engine/command-summary.ts`, `codex-app-server-adapter.ts`, `codex-sdk-adapter.ts`, and `codex-app-server-client.ts` normalize/truncate text upstream. Adapter stderr buffers also retain truncated tails. A final full-value matcher cannot remove arbitrary fragments. Choose and test sanitization before transformation or content-free error/progress summaries; do not claim the current downstream scan solves this.
2. War Room argument previews call `JSON.stringify` before scanning. JSON escaping can hide a configured value containing quotes/newlines/backslashes. Sanitize original string leaves before serialization, or suppress argument values, then capture actual orchestrator tool events and audit rows. Provider-progress audit strings are also truncated without this acceptance evidence. Diagnostic logger output outside the central sanitizer has not been accepted.
3. Voice has serializer evidence only, and War Room has channel/DB seam evidence only. Neither is an executed provider fixture for the entire path. Success, accumulated response, every-split protected values, abort, error, overflow and retry must be connected to captured outputs and persisted rows where applicable. Existing primitive tests establish the guard itself, not every caller's lifecycle.
4. Messenger bot-level tests do not yet carry a synthetic secret through every handler, formatting fallback, progress and error branch. Telegram final API callbacks cannot recover a secret already transformed or split by an unreviewed caller. The listed format/split seams reduce this risk; they do not close all metadata or command paths.

Policy in this candidate: complete presentation text is centrally sanitized; routing identifiers remain unchanged; progress locations/plan content and tool previews are presentation text. Protected values must be scanned before splitting, normalization, truncation or escaping. No whitespace streaming was introduced. `EXFILTRATION_GUARD_ENABLED=false` remains intentionally unguarded. Existing long-hex detection can redact non-secret hex content; bot length fixtures now use non-hex `x` characters to test splitting rather than that detector policy.

## Validation

Final targeted run: **200 passed, 0 failed, 1 pending across 13 suites**, recorded in `workspace/scratch/sanitizer-transport-tests.json`. New acceptance files contain 12 tests. No-emit typecheck and `git diff --check` passed. The full repository suite was not rerun in this bounded mission; its previously recorded two missing SPA-shell build failures remain outside this no-build scope. Initial fixture callback typo was corrected; the Signal capture then passed. Two bot length tests initially hit the pre-existing long-hex detector after boundary coverage expanded; their fixtures now use non-hex text.

Stop here for review of these local additions and the explicit residual #269 work. No continuation was dispatched. Remaining #270 races/leases, #268 scheduler fixture, #263 durable-health fallback and #264 parity were not addressed.
### Direct follow-through acceptance (2026-09-08)

Reviewed b5272a5e and continued directly. Added scans before provider command/preview normalization and truncation, and before arbitrary tool-argument JSON escaping. Actual voice bridge subprocess fixtures use an isolated home/store and fake engine, capture success/error/abort stdout, and invoke no provider. War Room fake-provider fixtures now capture stream/final/abort/error events, replay, conversation/transcript rows, diagnostic logs, and two tool audit rows (normalized progress plus raw argument JSON). Audit scans precede truncation. Scheduled and delegation result tests cover secrets spanning storage limits.

Claude stderr relay now logs lengths and repeat counts only. Codex/ACP startup stderr buffers suppress the entire buffer on overflow instead of retaining potentially exposed credential suffixes. ACP diagnostic error text and War Room error logs are scanned. Acceptance batch: 312 tests passed across eight suites; expanded War Room tool audit fixture subsequently 3/3 passed. No-emit typecheck passed. ACP has no dedicated adapter test file, so no ACP subprocess acceptance is claimed.

This entry supersedes the earlier voice/War Room fixture-only gaps. Remaining #269 work includes full messenger handler/metadata coverage, provider stderr overflow acceptance, and workflow outcome rows. It does not establish full DLP, attachments, or runtime acceptance. No builds, runtime changes, external sends, commits or delegation occurred. Continue directly with the remaining local recovery work; no new prompt or handback is required.

## Remaining source acceptance completed (2026-09-08)

The earlier entries are historical. Subsequent commits/checks now cover the
following previously missing source paths:

- `outbound-telegram-handler.test.ts`: actual `createBot`/grammY handler, shared
  `runAgentWithRetry`/`runAgent`, fake engine, installed API transformer, captured
  physical fetch body and assistant DB row. Success, accumulated secret stream,
  progress, abort, provider throw, retry and failed-edit fallback are exercised.
  Only the engine, physical network, memory enrichment and queue dispatch are
  substituted; no Telegram connection or provider call occurs.
- `outbound-messenger-handlers.test.ts`: actual Signal/Mattermost receive and text
  handlers, real RPC send framing/REST post serialization, fake physical socket/
  fetch, captured outbound audit append and assistant DB rows. Both cover success,
  progress, error, abort, failed result and bounded retry. Signal also covers group
  reply routing and TTS-to-text fallback. Mattermost thread/channel routing stays
  intact. Audio transcription and attachment contents are outside this matrix.
- These fixtures caught and fixed Mattermost's misleading `Done.` on an empty
  failed result and its uncleared timeout after a thrown provider call. Timer
  cleanup is asserted on every tested Mattermost outcome.
- `outbound-transport.test.ts`: inline keyboard labels/URLs and dashboard photo
  URLs now use the shared presentation scan, including encoded protected values.
  Display titles/filenames/author/footer fields are also presentation fields.
  Transport authentication and routing fields (including callback IDs) are not
  rewritten. This is a scoped text/metadata boundary, not attachment DLP.
- `outbound-persistence.test.ts`: workflow outcomes, coordinator findings,
  transition reasons, report bodies and repair of older outbox rows on claim.
  `mission-report-context.test.ts` covers sanitized, bounded primary-model context.
- Native Codex startup stderr overflow coverage exists in adapter/client suites;
  Claude stderr remains content-free counts. ACP is experimental, and an actual
  ACP subprocess overflow scenario is not claimed by native-provider acceptance.

The default secret-text output paths in this ledger now have source-level
acceptance evidence. This does not mean every command, attachment type, provider
diagnostic, or future metadata field has been exhaustively checked. Disabled
guard configuration remains intentionally unguarded. Live messenger/provider,
OS containment and build/runtime acceptance remain separate gates. Final combined
test counts and commit mapping are recorded in `docs/recovery-handoff.md`.
