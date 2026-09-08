# Bounded mission recovery and coordinator routing

Tracking: [#263](https://github.com/earlyaidopters/claudeclaw-os/issues/263),
[#264](https://github.com/earlyaidopters/claudeclaw-os/issues/264),
[#266](https://github.com/earlyaidopters/claudeclaw-os/pull/266).

This slice applies to scheduled **mission execution**. Interactive conversations
retain their selected provider; this is not a claim that all of #263 is complete.
Ordinary one-shot missions retain their existing execution path. A caller must
deliberately create a workflow to request durable assessment and follow-up.

## Implementation scope and simplicity review (2026-09-05)

The user-facing term is **Crew missions**: delegate, receive findings, assess, then
complete or assign bounded follow-up. The candidate UI adopts this wording;
internal workflow table, API, and CLI names remain stable. Ordinary missions do
not require a crew mission. Native provider harnesses own execution within a worker.

Retain persisted outcomes, duplicate prevention, atomic wake-up/dispatch, execution
bounds, tool authority, and reliable final reporting. Freeze additional orchestration
mechanisms while behavioral acceptance runs. Periodic process recovery and
instance-bound completion remain separate Phase 1.1 work. Do not introduce a new
workflow engine, provider-native subagent replacement, or storage rename to support
this terminology change.

This is a narrower operating and product boundary, not evidence that the existing
production implementation has been reduced. A bounded code review must map each
substantial mechanism to required behavior and identify concrete duplication or
removable abstractions before any simplification patch. Separate production code
from regression tests and optional probes when assessing size. Passing behavior,
maintainability, and fewer moving parts matter more than a target line count.

The current local 23-hour acceptance plan is
`workspace/scratch/v110-20260905/crew-runs-23h.md`. Its provider probes exercise
real models in disposable stores; circuit faults are synthetic. Repaired fixture
configuration and passing probes do not establish live outage recovery, resolve
all coordinator authority evidence gaps, or complete the runtime acceptance window.

## Configuration details

Set an explicit ordered fallback on the owning agent in `agent.yaml`:

```yaml
fallback:
  providers:
    - type: claude
      model: claude-opus-4-8
      runtimeMode: medium
  trigger: unavailable
  max_attempts: 3
  max_runtime_seconds: 1800
  cooldown_seconds: 60
```

An empty or absent provider list never authorizes a different provider. An
unavailable provider can still receive bounded delayed retries when execution is
known not to have started. `unavailable+ratelimit` explicitly includes rate limits.
Authentication, malformed requests, and model behavior do not authorize failover.
Limits are at most 10 attempts, 3,600 seconds, and two fallback configurations.
`fallback.max_runtime_seconds` is the non-sliding total provider-attempt budget
for one mission, measured from its first provider preparation and including
execution, cooldown, and retry backoff. It defaults to 1,800 seconds, matching
the scheduler's default 30-minute maximum runtime; it is separate from the
sliding 15-minute provider-inactivity watchdog. Provider activity refreshes only
the inactivity window, never this total budget. A smaller explicit value is
honored, a persisted retry deadline cannot move later across attempts or process
restarts, and an earlier workflow or scheduler deadline wins.

An optional `coordinator_provider` uses the same provider object format. Supported
coordinator providers in this release are Claude and OpenAI. Other execution
paths fail with `blocked_capability` unless an explicitly authorized supported
coordinator provider/fallback exists. Provider selection does not change the
workflow identity, objective, history, limits, or task count.

Fallback and explicit coordinator configurations never grant permission bypass.
Coordinator turns expose only the mission transition and inspection tools. Native
shell, network, nested-agent, and alternate dispatch surfaces are disabled for
these control turns. Workers continue to use their configured native harness.

## Failure safety and circuit behavior

The adapters record failure category separately from execution certainty.
Automatic retry or provider switching requires positive `not_started` evidence.
An SDK error before its first event is **unknown**, not proof that the provider
received nothing. App Server request-delivery evidence can distinguish a request
that was not sent/refused from an unanswered request. A started or ambiguous turn
becomes a durable failure for assessment; the scheduler does not replay it.

Circuit health is shared in SQLite across agent processes and scoped to provider,
endpoint, and model. Two consecutive eligible failures open the circuit. A
configured fallback can handle new assignments while it is open. Without one,
the same mission waits at its existing `available_at` gate within its deadline.
After cooldown, the next eligible mission claims one half-open probe. There is
no independent polling daemon. Generation and attempt tokens reject stale or
duplicate settlement. Trip/recovery alerts are queued for durable delivery.

After process interruption, Phase 1 records a visible failed mission with unknown
execution. It does not infer that a partial external effect can safely be retried.
Automatic process relaunch remains [#270](https://github.com/earlyaidopters/claudeclaw-os/issues/270).

## History, reporting, and limits

Workers return findings; the coordinator assesses them with the original
assignment, workflow objective, prior outcomes/decisions, and remaining limits.
Only one validated disposition can advance each outcome. Completion/outcome/wake-up
and transition/dispatch each commit in one database transaction.

Terminal and human-wait reports are distinct from model completion. A durable
outbox leases delivery without replaying a model turn. A network success followed
by a crash before acknowledgement may deliver twice; the stable report ID exposes
that ambiguity. Headless agents leave delivery to the primary messenger.
Intermediate workflow findings are not sent as final answers.

Provider usage from worker and coordinator calls is recorded separately with the
workflow identity. Telemetry errors do not change executed mission outcomes.
Depth/task/fan-out/control-turn/deadline bounds are not dollar or token caps. Native
nested execution accounting depends on the provider's reported usage; this slice
does not add a portable native fan-out API or claim a nested spend ceiling.

`mission-cli workflow-result <id>` includes persisted recovery diagnostics.
Workflow `--at` uses the existing one-time availability gate. `--key` supports
idempotent external initiation. A job firing or initiating mission supplies a
host-owned entry key so model retries cannot create duplicate workflow roots or
replace the first root's bounds. Distinct recurring firings can create distinct
workflows. Human resume keeps the existing workflow and its original limits.

## Validation and deployment

`scripts/probe-mission-loop.ts` uses real providers with disposable configuration,
store, and identities. `scripts/probe-mission-contention.ts` races real processes
against an isolated WAL store and terminates only its owned children at exported
transaction checkpoints. These utilities do not establish live runtime acceptance.

Before deploying, preserve existing overlays and record source/patch/build
identities. Run the full isolated build and suite. Before a service rebuild or
restart, create and verify a one-shot continuation mission to the actual runtime
agent, due 10-15 minutes later, containing those identities and the next checks.
Verify the loaded build after restart. Complete bounded crew acceptance and the
24-hour soak before release approval. A working-tree overlay is not shipped evidence.

For rollback, restore the saved runtime source/build artifacts and preserved local
overlays, then use the same checkpoint/restart protocol. Migrations in this slice
are additive; do not delete durable history or roll back the live store to erase
new outcomes. `CODEX_TRANSPORT=sdk` remains the existing transport rollback option,
with its more conservative execution-certainty limits.
