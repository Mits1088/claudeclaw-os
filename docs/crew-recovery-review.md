# Crew recovery responsibility review

Reviewed baseline: merged PR #266 (`268de99`), recovery HEAD `f581f5e`, with local Phase 4A containment. This is a local candidate decision, not runtime acceptance or authorization to change GitHub history.

## Phase 5 decision

Keep the additive data model and bounded control-plane implementation, patch specific defects, and keep workflow execution disabled. A wholesale revert would also remove ordinary-mission recovery, outcome evidence, and provider/watchdog fixes. Preserve tables and historical rows. Phase 4B isolation remains deferred and blocks worker re-enablement.

| Responsibility | Disposition | Code and dependency impact |
| --- | --- | --- |
| Schema and migrations | Keep | `src/db.ts` migration adds workflow/outcome/transition tables and columns. Preserve these alongside governor tables; removing them breaks forensic reads and retained task references. Existing migration tests are source evidence only; no production migration was run. |
| Completion and outcomes | Patch | `completeMissionTask` and `persistWorkflowTaskOutcome` transact task/outcome state and preserve terminal idempotency. Completion accepts nonterminal tasks without claimant identity. Salvage only #270 instance fencing; do not take unfinished supervisor scaffolding. |
| Transitions and authorization | Disable execution, keep reads | `applyMissionWorkflowTransition`, `resumeMissionWorkflow`, shared CLI actions and `mission-coordinator-policy.ts`. Phase 2 freeze and Phase 3 graph ceilings remain authoritative. Tool policy does not substitute for Phase 4B OS isolation. |
| Scheduler and cancellation | Patch terminal-result handling; keep reconciliation and cancellation | `src/scheduler.ts:460-545` ignores `completeMissionTask().changed` before join release, notification, conversation persistence and ingestion. Gate downstream completion effects on an accepted terminal write alongside instance fencing. Freeze blocks workflow advancement; preserve interrupted-turn failure semantics to avoid replaying unknown side effects. |
| Provider recovery | Keep, review #263 incrementally | `mission-provider-execution.ts`, `mission-provider-policy.ts`, `provider-recovery.ts`. Explicit fallback configuration and bounded attempts are already present. Governor authorization must remain after provider selection and before invocation. Do not duplicate this state machine with the quarantined circuit implementation. |
| CLI and dispatch | Keep reads and cancellation; disable workflow mutations | Shared `cli-actions.ts` guard plus database enforcement covers supported mutation paths. Governor operator controls stay outside model dispatch. Phase 4B is required before model shell access can be treated as an authority boundary. |
| Dashboard/API | Keep visibility and freeze | `dashboard.ts`, `web/src/pages/MissionControl.tsx`. Preserve state/usage inspection and disabled presentation. Built SPA-shell validation remains pending Mike's build gate. |
| Retention and reporting | Keep current terminal semantics | `src/db.ts:3428` resumes only `waiting_human`; blocked workflows are terminal for transition, claim and reconciliation. `cleanupOldMissionTasks` prunes terminal task rows, preserving outcomes, transitions and workflow/report rows. New retention test proves blocked resume rejection, pruning, preserved outcome and report reconstruction. Future blocked-resume support must change retention together. Delivery remains at-least-once. |
| Watchdog | Keep | `turn-watchdog.ts` owns idle and wall-clock aborts. Workflow scheduler applies the smaller host ceiling. This is independent of periodic worker restart supervision, which remains outside this salvage slice. |
| Tests and probes | Keep unit tests; replace build-dependent probe path | `mission-workflow-stress.test.ts` executes 108 seeded isolated cycles. `scripts/probe-mission-contention.ts` imports `dist`, so it cannot establish current source correctness under the no-build constraint. Phase 7 needs source-based disposable multiprocess fixtures. |

Validation: seven workflow, retention, stress, provider-execution/policy, reporting and watchdog suites passed, 50 tests total. The stress suite includes 108 seeded cycles. These results do not prove isolated worker execution, live provider behavior, or compatibility with the runtime overlay.

## PR #271 disposition

Local reviewed documentation head `1222983` still describes cancelled crew branches as active implementation. Preserve it as evidence and replace the status wording in the candidate documentation after salvage. No current remote CI/mergeability claim is made. Do not merge or close the PR until the external-write gate.

## Remaining gates

Phase 5 source responsibility audit and candidate decision are complete. The full Phase 5 exit gate is NOT complete: runtime-overlay compatibility and approval for GitHub history changes remain outstanding. Phase 6 requires a separately assigned slice. No build, runtime overlay, restart, provider worker, push, merge, or cleanup is authorized by this document.

## Source questions closed by mission 7773f1fa

Checkpoint: HEAD `f581f5e3918b586f6509ad1411cbdb72efa7d6ec`, branch `recovery/crew-mission-governor`, exact recovery worktree. Entry dirty state: modified `src/messenger.ts`; untracked `src/headless-worker-policy.ts`, its test, and this review. Existing containment source files were preserved byte-for-byte. No source remediation is represented as implemented by this review.

Completion: `src/db.ts:4237-4360` uses an IMMEDIATE transaction, deterministic outcome ID and unique task reference. Duplicate terminal completion returns `changed: false`; it cannot overwrite cancellation or insert a second outcome. That is idempotency, not claimant fencing: any nonterminal row, including queued or waiting, can be completed without instance/claim identity. `resetStuckMissionTasks` and `failStuckMissionTasks` select by agent alone. Decision: patch exact-instance/claim ownership checks atomically before task, reservation, chain and outcome writes; preserve a distinct host recovery authority. Scheduler success, failure, watchdog and exception paths must honor rejection before completion side effects. Review usage reconciliation and provider recovery against the same ownership boundary. Accept only the narrow #270 fencing concept, not its entire branch or unfinished supervision. Local #270 evidence head: `0b404e8bf928ecb5c44c97a09eacda4b5d6868bb`; salvage remains pending.

Retention: blocked is not a resumable state today. `resumeMissionWorkflow` rejects it even with test admission enabled. The new regression exercises coordinator failure, eight-day pruning, retained outcome text, no coordinator claim and report reconstruction. Keep this behavior; it does not preserve every original task prompt indefinitely. Waiting-human and active gather history remain protected by existing tests. `claimMissionWorkflowReport` derives stable report IDs from durable dispositions and leases delivery; send-before-settle crashes can duplicate a notification. Keep at-least-once semantics, with no exactly-once claim.

Schema: keep the additive #266 workflow columns/tables and unique outcome/transition constraints (`src/db.ts:966-1014`). The older nullable-assignment migration at `src/db.ts:900` rebuilds a table and is not justification to describe every historical migration as additive. The 27 migration tests establish fixture behavior, not production schema compatibility. Removing workflow tables would break recovery governor references, forensic APIs and durable reporting. A broad revert is rejected as the local candidate strategy; runtime overlap remains unvalidated.

PR271: inspected the local `12229839dd0046e97246c5be7c7400c2134475d2` diff across `docs/README.md`, `docs/headless-workers.md` and both supervision/sanitization RFCs. References to #269/#270/#268 and Slice 4 being actively implemented are stale against the recovery ledger. Keep historical merged-#266 attribution, replace active-work claims with quarantined/deferred status in a later documentation slice. No remote status, CI, mergeability, closure or update was checked or performed.

Validation for this mission: eight suites, 78/78 tests, including the prior seven-suite 50-test baseline, one new blocked-retention test and 27 migration tests. The stress test contains 108 seeded isolated cycles, not 108 provider runs. Suites: `mission-workflow`, `mission-workflow-retention`, `mission-workflow-stress`, `mission-provider-execution`, `mission-provider-policy`, `mission-reporting`, `turn-watchdog`, and `migrations`. No real-provider or runtime probe was run.

## Exact next slice, separately assigned Phase 6A

Review local #269 head `93a50cb702cb11986e80ba3b5fc2d6550e5fe35f` and its dirty worktree evidence before accepting any code. Limit the slice to sanitizer/stream-guard primitives and synthetic tests on this unified recovery branch. Do not integrate messenger, scheduler, database or dashboard seams in 6A. The current `src/outbound-stream-guard.ts` cuts at whitespace, so protected value `alpha beta` split as `alpha ` then `beta ` can escape both scans. Its actual `finalize()` scans only the pending tail, contrary to the header's full-buffer-scan claim; even a full scan cannot retract emitted bytes. It also retains full `rawSoFar`, so the token holdback cap does not bound total memory.

Choose a bounded fail-closed streaming design before salvage. Acceptance tests must capture every emitted byte for whitespace-containing values at every split, accumulated snapshots, abort/error, overflow and finalization, plus explicit retained-memory bounds. If that cannot be proved in the bounded slice, leave the stream guard unaccepted and document the blocker. Preserve dirty containment work, Crew freeze and Phase 4B deferral; use synthetic secrets and no-emit checks only. Later separately assigned slices cover persisted-row/output seams, #270 ownership fencing, #268 fixtures and remaining remediation. No Phase 6 execution was dispatched here.

Final checks: no-emit typecheck and git diff --check passed. SHA256 checks confirmed all three pre-existing containment source/test files unchanged. No commits, builds, runtime changes or external writes beyond the required Hive log.
