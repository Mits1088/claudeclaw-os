# Active-turn steering

Tracking: https://github.com/earlyaidopters/claudeclaw-os/issues/192

## Delivery

v1.10 targets opt-in Telegram steering through Codex App Server. PR #167 follows
separately with Claude support, reusing this contract. This supersedes the original
#192 sequencing behind #167. No plugin loader or workflow engine is required.

## Implementation

1. Add an optional adapter registration callback carrying an invocation-owned
   steering handle. Unsupported adapters never register. Preserve existing FIFO.
2. Register Codex only after the actual thread and turn are known. Send text-only
   `turn/steer` with `expectedTurnId`; validate the response turn ID. Reuse request
   delivery classification. Revoke on completion, cancellation and cleanup.
3. Route only explicit `/steer <message>` commands through owner authentication
   and PIN/kill controls. Ordinary text retains its queue and question/state-machine
   handling. No `/queue` command or provider allowlist is needed. Exclude forwarded/derived inputs. Do not
   steer past an already queued follow-up. Provider identity is fixed per handle.
4. Report accepted, known non-delivery (visible FIFO), and uncertain delivery
   (visible warning, no automatic replay). Acceptance is provider receipt, not a
   promise that the model has acted on the message. Persist accepted/uncertain
   user input in the existing conversation log; FIFO uses normal persistence.
5. Test protocol targeting, limits, receipt deduplication, authority precedence,
   provider fallback, finish/cancel races and cleanup. Run typecheck, schema audit,
   focused tests and the full suite. Live Telegram validation remains separate.

## Bounds and rollout

`MIDTURN_STEERING_ENABLED=false` is the sole rollout control.
Codex App Server and the Claude SDK adapter implement the handle. Unsupported/inactive adapters report
unavailable without queuing `/steer`; send ordinary text for a follow-up. Disabled
steering also reports disabled without queuing. A known rejection after finding
an active handle visibly queues the stripped message; uncertain delivery never
automatically requeues. Initial fixed
bounds: 4000 characters/message, eight submissions/turn, at least one second
between submissions, one in flight, five-second request deadline, fifteen-minute
admission lifetime. Existing turn watchdogs are never reset by steering.

No changes to system prompts, model, cwd, MCP permissions or sandbox policy.
Only direct text is eligible: no automatic steering from documents, transcripts,
memory, scheduled work, external messages or mission handbacks. Unknown delivery
cannot safely be replayed. In-process receipts are bounded and do not promise
exactly-once delivery across process crashes.

Protocol reference: https://learn.chatgpt.com/docs/app-server#steer-an-active-turn

## Validation (2026-09-11)

Implemented on `feat/codex-steering`, based on main `d513e1c`.
Local Node 24.14.0: full build, typecheck, 155 pinned-schema checks, and full
Vitest suite pass (2395 passed, 16 skipped). No live provider turn was invoked.
Node 22 CI and live Telegram/Codex acceptance remain follow-up verification.
The latter should exercise an update during tool work, completion-edge fallback,
/stop, /newchat, and SDK fallback with steering enabled. The runtime is unchanged.

## Claude implementation (2026-09-21)

Carry PR #167 forward on the shared contract delivered in #288, with a fresh
replacement PR. Credit merlinfrombelgium for the original streaming-input design
and implementation in [#167](https://github.com/earlyaidopters/claudeclaw-os/pull/167).
Close #167 as superseded only once the replacement is available to link.

- Keep explicit `/steer` and the existing Telegram routing, receipts, limits and
  feature flag. Ordinary text remains FIFO. Other messengers are separate work.
- Only the native Claude provider registers; Anthropic-compatible endpoints are
  not enabled implicitly because they happen to use the same adapter.
- Create streaming input per SDK attempt and register after session initialization.
  Revoke at the first result, cancellation, exception or iterator teardown.
- UUID-tag each steer. Enable the documented `--replay-user-messages` acknowledgment
  and accept only a matching replay UUID/session. SDK consumption alone is uncertain.
  See [CLI reference](https://code.claude.com/docs/en/cli-reference).
- Withdraw unconsumed input on timeout/completion so existing FIFO fallback cannot
  duplicate it. Input already handed to the SDK is never replayed automatically.
  Close input at the first result and continue draining the SDK output normally.
- Preserve safe missing-session recovery only when no steer was handed to the SDK.
  Existing generic retry requires positive not-started evidence; ambiguous Claude
  failures remain unknown and cannot replay the original prompt or a steer.
- Validate adapter receipt handling, cancellation, finish-edge races, stale handles,
  disabled behavior, resume recovery, and the existing Telegram routing tests.
  Record real-provider smoke evidence separately from mocked protocol tests.

Rollout remains disabled by default. Implementation and tests in a feature worktree
do not constitute live fleet deployment or Telegram acceptance.

### Claude validation evidence

On Windows / Node 24.14.0, branch `feat/claude-steering-contract` based on main
`4a1e92a`: typecheck, production build, and full Vitest suite passed (2580 passed,
17 skipped). Build CLI artifacts before running the suite; CLI contract tests
require `dist/`. No dependency manifest or lockfile changes.

A real Claude Haiku 4.5 SDK invocation used a harmless in-process MCP pause tool
with project/user settings disabled and filesystem/shell tools denied. During
the pause, the shared handle submitted a direction to change the final response
from `ORIGINAL_OK` to `STEERED_OK`. The exact replay receipt was accepted, the
model returned `STEERED_OK`, and the handle was revoked at completion.
This proves the adapter path for that run, not live Telegram or every Claude model.
Cancellation, timeout withdrawal, uncertain delivery, missing-session recovery,
compatible-provider exclusion and existing Telegram routing have automated coverage.

### Delayed acknowledgment correction

Naomi's live test exposed acknowledgments delayed beyond five seconds by a long
tool call. Both messages were recorded as absorbed mid-turn, but the initial
implementation had already reported uncertainty. Claude now returns a pending
receipt as soon as the SDK pulls the message. Telegram promptly reports submission
and releases its handler; a later exact acknowledgment produces a reply linked to
the original command. Pending is not confirmed acceptance and never triggers FIFO
replay. Teardown or the bounded fifteen-minute receipt lifetime resolves uncertainty.
The five-second withdrawal deadline applies only before SDK consumption.

Validation: 2583 tests passed, 17 skipped; typecheck and server build passed.
Fake-clock coverage waits two minutes before acknowledging, and Telegram coverage
proves immediate return and duplicate-safe final notification. A real Claude smoke
test with a twelve-second pause returned pending, then accepted, and STEERED_OK.
