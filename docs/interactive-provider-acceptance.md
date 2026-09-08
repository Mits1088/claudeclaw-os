# #263 durable-health interactive fallback source acceptance

## Operator migration — publication breaking change

`MODEL_FALLBACK_CHAIN` no longer authorizes model switching. Existing nonempty
values are detected only to emit one warning per process; values are never
included in that warning. Remove the environment setting and configure explicit
providers in the relevant agent's `agent.yaml`, for example:

```yaml
fallback:
  trigger: unavailable
  providers:
    - type: claude
      model: claude-sonnet-4-6
  max_attempts: 3
```

This does not reproduce legacy retry behavior: fallback requires positive
`not_started` execution evidence. Started/unknown execution is never replayed;
rate-limit retry requires an explicit `unavailable+ratelimit` trigger. No provider
is added to an operator's configuration automatically. The positional API
argument and messenger callsites remain only for deprecation detection.

## Historical source checkpoint

Mission: `2806fce8`, 2026-09-08. Candidate: `recovery/crew-mission-governor`, HEAD `f581f5e3918b586f6509ad1411cbdb72efa7d6ec`. Local/uncommitted; existing dirty and untracked work preserved.

## Implemented

`runAgentWithRetry` now uses `interactive-provider-execution.ts`. It loads the active agent's existing `fallback` policy through `loadMissionProviderPolicy`; no new configuration registry, model tiers, or process-local circuit. Legacy positional `fallbackModels` remains API-compatible but no longer authorizes model switching. Primary retries and explicitly configured fallbacks share bounded attempts, exponential backoff, retry-after and recovery deadline checks. An all-open circuit fails the interactive call instead of queuing background work.

Only `unavailable` with positive `not_started` evidence may replay by default. Rate limits require `fallback.trigger: unavailable+ratelimit`. Auth, request/model rejection, unknown failures and started/unknown execution never replay. Both typed result failures and thrown failures are handled; generic throws retain unknown execution certainty. Availability failures can update health even when replay is forbidden. A rate-only circuit opened by another opted-in caller is bypassed without changing its health when the current policy excludes rate limits.

Every attempt claims the existing SQLite `provider_health` / `provider_health_attempts` generation contract. Mission and interactive callers use the same settlement, Hive event and durable report plumbing. Tests exercise trip in both caller directions, exclusive half-open probe and recovery. No DB schema changes were required in this slice.

Fallbacks retain the caller's tool policy and MCP allowlist, cannot manufacture skip-permission grants, and always start without the original session (including same-provider configured model fallback). Primary execution retains existing provider-session validation. Explicit mission execution context is rejected before interactive engine invocation: scheduler-owned recovery/admission remains the mission path. This is an in-process boundary, not Phase4B OS isolation.

## Validation

73 distinct tests passed across eight focused suites using the final passing evidence for each: interactive-provider-execution (16), agent (13), agent-provider-selection (11), mission-provider-execution (11), provider-recovery (10), mission-provider-policy (3), mission-provider-state (6), recovery-scheduler-fixture (3). Reports: `workspace/scratch/interactive-provider-tests.json`, `interactive-provider-final.json`, and `interactive-provider-fixture-final.json`. The first two preserve intermediate failures: direct-agent mock import isolation and then the first fake-timer/import setup case. The affected suites were rerun successfully; this is not a claim that those intermediate aggregate reports were green. Fake EngineFactory and in-memory DB only. Existing state tests cover durable health generation/stale settlement. No full-suite rerun or build.

Final no-emit typecheck and diff whitespace check passed. The old pre-aborted SDK-call expectation was updated to zero invocations. Legacy retry tests explicitly opt into rate-limit recovery and verify unconfigured model hints are ignored.

## Residuals and next slice

This is not full #263/#264 delivery or Phase7/runtime acceptance. Operator circuit inspection/reset commands, dashboard controls and notification presentation still need an independently bounded review/implementation. Existing durable report delivery was reused, not externally exercised. No proactive health poller or persistent recovery workflow was added. Non-outage/cancelled health claims retain the existing expiry behavior: probe leases expire after 120 seconds and abandoned attempt rows are pruned on later claims after one day. Recovery deadline bounds new attempts/backoff; the existing turn watchdog bounds an in-flight engine call.

Permission tests establish engine-input preservation, not cross-adapter enforcement parity or OS isolation. Direct runAgent, voice and War Room paths were not converted to interactive fallback. Shared circuit identity retains the existing provider/baseURL/model key contract, including its default aliases. #270 mission per-attempt fencing remains separate from provider-health generations. Remaining #269 transport/operator acceptance gaps remain as documented.

Next concrete slice: review #264 Slice4 native-provider result/error, permission and session parity against this shared recovery contract with fake adapters; separately inventory #263 operator UI/command gaps before implementation. Crew remains disabled; Phase4B deferred. No commits, external writes/sends, providers, build, overlay, restart, continuation, child mission or handback command.

## Native parity and primary handback follow-through (2026-09-08)

The earlier next-slice status is superseded by
`docs/native-provider-parity-acceptance.md`: native Claude/OpenAI source parity
and the operator-control inventory have now been reviewed and tested. The ledger
distinguishes requested policy from effective-policy verification and documents
the remaining live/OS enforcement limits. No second circuit or recovery workflow
was added. Manual reset, force-probe and bypass controls were not manufactured as
part of recovery; they remain a separately scoped operator feature, not a
prerequisite for the existing automatic fenced half-open probe.

Interactive turns now include up to three current mission reports owned by that
agent from the preceding 24 hours, each sanitized before a 3,000-character cap.
This reuses the durable outbox, independently of messenger delivery leases or
success. Missing current reports are materialized without taking a delivery
lease; a user turn before the reporting tick still receives the finding. Recency
is based on the workflow disposition, so creating an old report late does not
make it recent. Reports are explicitly untrusted evidence, not authority for new work.
The current user message remains intact. Evidence is repeated while recent, like
scheduled-task context; no new inbox, acknowledgement journal or autonomous
handback turn was introduced. Resumed workflows' obsolete waiting-human reports
and system health chatter are excluded.

The actual interactive fake-engine test follows worker completion, coordinator
acceptance and messenger acknowledgement into the primary model's next turn,
including a fresh provider-fallback session. Both attempts receive the same
finding. Telegram, Signal and Mattermost share this wrapper; dashboard chat uses
the same context accessor. Background scheduler turns do not use that wrapper
and retain their separate objective/context/authority. This is next-interaction
context, not a promise of an automatic primary-model wakeup while idle.
