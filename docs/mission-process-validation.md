# Retained mission process validation

Scope: #268, based on main `23f94cf` after the #280 simplification. The harness starts synthetic Node processes against one temporary encrypted database through the application's DB API. It uses temporary HOME/config/store, an explicit fixture .env, a synthetic key, IPC barriers and bounded waits. It does not load a scheduler, provider or messenger, use real credentials, or operate on live workers.

| Scenario | Observed invariant |
| --- | --- |
| Three competing claimants | Exactly one claim and one successful terminal update; stale lease rejected; result survives observer restart. |
| Replaced instance and wrong generation | Rejected completion leaves the task running and join waiting. |
| Exit after synthetic side effect, before completion | Restart recovery marks execution unknown, releases eligible join, and never replays the recorded file write. Repeated recovery is a no-op. |
| Concurrent handback/continuation requests | One durable handback and one linear continuation edge despite differing request IDs/keys. |
| Cancellation and restart | Cancelled chain remains cancelled, cannot enqueue a late continuation or claim the cancelled child. |
| Failed/cancelled gather children | Independent lanes claim concurrently; join remains waiting until all children are terminal, then is claimed once under contention. |
| Exit immediately after final child commit | Child result and assembled join prompt are durable together; restart sees a queued join without any separate scheduler release call. |

## Defect demonstrated and fixed

The last scenario failed on main: child status was completed but join status remained waiting after process exit. Completion and the scheduler's release call were separate transactions. Fix completion to invoke the existing guarded join release inside the terminal transaction. Apply the same atomic boundary to cancellation and interrupted-task recovery. No new tables, generalized workflow engine, background reconciler or automatic worker recovery are introduced. Existing scheduler release calls remain harmless/idempotent.

The reproduction and fix use actual process exits and reopened persisted state. Existing gather tests now assert automatic release and exactly one assembled result block instead of manually assembling the expected prompt.

## Limits

- DB/control invariants are exercised directly; provider tool invocation/routing and messenger delivery need the separate real-runtime smoke checklist.
- This does not implement #270 periodic worker crash recovery or reopen #263/#264.
- Already-stranded historical joins are not migrated or replayed by this fix. No live store cleanup was performed.
- Run after a fresh isolated install and full build: `npx vitest run src/mission-process.test.ts src/gather-join.test.ts`. The full suite is also required before review readiness.
