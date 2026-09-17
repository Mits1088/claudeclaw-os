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
Only App Server implements the handle. Unsupported/inactive adapters report
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
