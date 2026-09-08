# Recovery handoff and asynchronous mission acceptance

## Publication decision and runtime evidence — 2026-09-08

Mike authorized one combined recovery PR and merge after validation/review. This
supersedes the earlier separate-PR publication sequence, not the worker-isolation
gate. Retain Crew Missions behind the existing default-off feature/governor
controls; do not remove the durable state or bounded background continuation.
Keep the non-overridable headless startup block until Phase 4B is implemented and
accepted. Enabling the governor is not acceptance of worker isolation.

Mike also requested restoring the original `Low` effort display across OpenAI
models before publication. The earlier `Light` presentation override is removed;
persisted/provider values remain `low`. A regression covers all catalogued OpenAI
models and the unchanged Claude label. This supersedes the original Phase 1 label
decision; it does not change model selection or reasoning effort.

Pre-merge review identified the legacy `MODEL_FALLBACK_CHAIN` setting as a silent
compatibility break. It is now explicitly deprecated, with a once-per-process
warning that never includes configured values and migration guidance in
`docs/interactive-provider-acceptance.md`. It does not authorize legacy replay.

The runtime operator reported a successful build/restart, six online agents with
zero unstable restarts, no errors in inspected post-start logs, normal dashboard
response, all 118 dashboard contract tests passing, governor disabled, and no
queued/running missions or active reservations. These are disabled-feature smoke
checks, not a live headless-worker or full Crew Mission acceptance run.

The tested source candidate is `a763f23`, based on `020dc19`. The runtime overlay
was staged on runtime-only HEAD `ed20349`; all 80 recovery paths were independently
rechecked against combined tree `c266f4437447b8c05634ebf4ef74c56fb1227ed8` with zero
mismatches. Runtime-only Skool, Playwright and invoice changes are excluded from
this PR. Local settings and runtime deployment state are also excluded.

The isolated candidate build, no-emit typecheck and generated CLI documentation
check pass. Full post-build suite: **2,489 passed, zero failed, 16 skipped**, recorded
in `workspace/recovery-publication-final-tests.json`, including the Low-label and
legacy-fallback deprecation changes. The initial default-parallel run
had one five-second timeout in the existing agent PID/dashboard test; rerunning
the entire suite with four test workers passed without changing code or timeouts.
The historical source-only counts below are retained as evidence, not the final
post-build acceptance result. CI must build and run the full suite before merge.
Branch/worktree deletion and runtime-overlay reconciliation remain separate from
publishing this recovery PR.

## Checkpoint — 2026-09-08

Mike authorized continuing local implementation and committing the existing
candidate on `recovery/crew-mission-governor`. The checkpoint preserves the
uncommitted work on top of `f581f5e`; it is not a release or runtime acceptance.
Subsequent corrections should be separate commits so the handoff is recoverable.

The inherited candidate includes headless startup containment, outbound text
sanitization and fixtures, worker-instance completion fencing, provider recovery,
and source-based mission fixtures. The earlier acceptance ledgers remain historical
evidence, including their explicitly incomplete coverage.

Baseline validation:

- No-emit typecheck and `git diff --check` passed.
- Full source suite: 2,436 passed, 20 failed, 16 pending. Eighteen failures were
  sandbox-dependent temporary-directory/process-inspection tests; all three
  affected suites passed when rerun outside the sandbox.
- The remaining two failures require the absent `dist/web/index.html` SPA build.
  No production build or runtime change was performed to mask that dependency.
- A credential-pattern scan of changed/untracked source found no matching private
  keys or provider/access-token literals. This is a bounded scan, not a complete
  security audit.
- Local test reports: `workspace/recovery-handoff-baseline.json` and
  `workspace/recovery-handoff-platform.json` (ignored test artifacts).

## Clarified product contract

A Telegram agent can own a durable background mission, use a capable orchestrator
to delegate to lightweight headless workers, receive individual results or a
gather/join, and continue within the original objective and host bounds. Its
interactive Telegram conversation remains available while that mission progresses.
The background mission has independent context; a final handback returns to its
initiator. Separate mission context and coordinator wakeups are intentional.

Keep the existing durable mission architecture. Simplify overlapping mechanisms
only when the following behavior remains demonstrated:

1. Background execution does not hold the interactive chat queue or reuse its
   provider session, cancellation controller, or dispatch authority.
2. Worker results return durably; duplicates and stale completion cannot advance
   the mission twice.
3. Independent results, gather, bounded follow-up, and final assessment work with
   conservative usage accounting. A budget limit must not silently strand the
   final result; stopping must produce a durable explanation.
4. The initiator can inspect/cancel the mission while continuing unrelated chat.
5. Original scope, worker limits, provider authorization, and safety gates persist.

## Remaining delivery boundaries

Headless startup containment and the default Crew freeze remain in force. The
Phase 4B isolated launcher, real-provider acceptance, runtime overlay/build/restart,
and GitHub publication/merge remain separate delivery gates. Local commits and
synthetic validation do not authorize enabling workers or modifying the runtime.
The outstanding sanitization/provider-parity and attempt-fencing gaps in the
existing acceptance ledgers are not declared complete by this checkpoint.

## Follow-through — 2026-09-08

Checkpoint commit: `b3c7b3c`. The governing plan is the runtime checkout's local
`.claude/plans/crew-mission-recovery-governor.md` (nine phases plus Phase 4B).
This section supersedes its older "all work uncommitted" status and the older
acceptance ledgers' per-attempt-fencing gap, but not their other residuals.

Implemented after the checkpoint:

- Durable workflow coordinators use a separate per-agent FIFO, independent of
  the interactive chat queue. They still start with independent provider context
  and restricted dispatch authority. Ordinary tasks/continuations/handbacks and
  full-power workers retain their existing lane: concurrent mutation of the same
  checkout is not authorized by this change.
- Codex App Server mission-control turns keep task identity on their per-turn MCP
  configuration, not the shared child environment. This avoids unnecessary
  launch-fingerprint rotation/draining against interactive turns. Full-power
  worker scope remains on the child environment. Native no-shell/no-app/network
  restrictions are retained; this is not OS isolation.
- Follow-up dispatch checks whether the current allocation covers the requested
  workers AND one subsequent assessment. The default nine-turn allowance stops
  conservatively after root work and review when necessary, preserving findings
  in a durable exhausted report. An explicit fixture allocation demonstrates a
  complete worker/review/follow-up/final-review sequence. Defaults were not raised.
  This is admission lookahead, not a reservation of future reviews against other
  workflows or provider-specific budget exhaustion.
- Each claim increments a persisted generation. Completion, usage settlement,
  provider failure metadata and retry/requeue reject a previous attempt even
  when the same worker instance reclaims the task. Generation zero supports an
  already-running claim migrated from the previous schema; new worker claims
  cannot omit their generation. This is not a supervisor/restart framework.
- Workflow outcome reconciliation, transition reasons and final outbox bodies
  pass through the shared sanitizer before persistence. Exhausted reports retain
  the stopping reason and latest worker findings. System-report insertion and
  claim-time repair of older unsanitized outbox bodies use the same boundary;
  the repaired body remains sanitized on retry.
- The source-only cross-process fixture now covers worker crash/unknown execution
  without replay and cancellation with rejected late completion, in addition to
  the original completion path. Three sequential synthetic children, maximum one
  active worker, no provider calls or messenger instances.

Validation after these changes:

- Full source suite: **2,464 passed, 2 failed, 16 pending**. The two failures are
  `dashboard.contract.test.ts` public SPA-shell checks for `/` and `/warroom`,
  whose `dist/web/index.html` artifact is absent. No build performed.
- Report: `workspace/recovery-followthrough-tests.json` (ignored local evidence).
- No-emit typecheck passed. Targeted suites include the real message queue's
  overlapping chat/coordinator lanes, actual scheduler with fake engine, stale
  same-instance retry fences, budget exhaustion/report delivery, sanitized rows,
  and the existing 108-cycle governor stress test. A waiting-human workflow is
  verified to retain its active slot; resumption does not bypass that limit.
- Cross-process fixture passed seven assertions. Evidence:
  `C:/Users/mikek/AppData/Local/Temp/crew-recovery-fixture-39by7s/evidence.json`.
  It exercises DB contracts; the scheduler fixture is separate and in-process.

## Source acceptance follow-through — 2026-09-08

Mike authorized finishing the remaining local items after `89627b4`. The first
three items previously listed above the delivery gates are now addressed within
the source-only acceptance boundary:

- Native Claude/OpenAI permission/session/error parity has a reviewed evidence
  matrix in `docs/native-provider-parity-acceptance.md`. Setup failures before a
  Codex prompt is sent preserve `not_started`; ambiguous execution does not
  acquire replay permission. Fresh-session fallback requires actual evidence of
  an absent session, not a generic failed-resume wrapper.
- Actual Telegram/Signal/Mattermost handlers now have synthetic provider-to-
  transport and assistant-row acceptance fixtures. Captures cover progress,
  success, abort, error, retries, Telegram edit fallback, Signal groups and TTS
  fallback. Visible URL/button metadata is sanitized; routing remains intact.
  Mattermost no longer says `Done.` on an empty failed result and clears its
  timeout on throws. See `docs/sanitizer-transport-acceptance.md`.
- The primary model receives its own recent durable mission findings on its
  next interactive turn, including a fresh fallback session, independently of
  messenger delivery. Context is explicitly untrusted and bounded to three
  current reports from 24 hours, 3,000 characters each after sanitization.
  The context path materializes a missing current report transactionally without
  taking a send lease, so it does not depend on a prior reporting tick. Recency
  follows the workflow disposition, not a late report-creation timestamp.
  This intentionally reuses recent context, not a new unread inbox/ack journal
  or an automatic model wakeup. Background turns retain separate authority.
- The scheduler fixture now traverses the actual registered MCP server over
  in-memory transport. It checks the restricted coordinator tool list, rejects
  a forged coordinator task ID, and completes through the authorized tool.
  It does not claim physical stdio or OS-boundary acceptance.
- `scripts/probe-mission-contention.ts --source` runs without built artifacts.
  A disposable home/store/config and environment allowlist replace inherited
  credentials. Two synthetic DB clients (not model workers) exercise 108 races
  and crash/reopen at the outcome and transition commit boundaries. Each cycle
  settles/cancels its own tasks, preserving the single-active-workflow default.
  The fixture-only 1,000-turn allocation covers all sequential DB cases and
  never invokes a provider. Evidence:
  `C:/Users/mikek/AppData/Local/Temp/claudeclaw-268-contention-KxhMVo/evidence.json`.
- The separate addressed-worker fixture was rerun successfully, including crash,
  cancellation and missing-usage accounting. Evidence:
  `C:/Users/mikek/AppData/Local/Temp/crew-recovery-fixture-O9dRJA/evidence.json`.

Final combined validation: **2,487 passed, 2 failed, 16 pending** in
`workspace/recovery-source-acceptance-tests.json`. Both failures remain the
absent-build dashboard SPA-shell checks. No-emit typecheck and diff checks pass.
The complete engine suite passed 843 tests. Independent review found and verified
the repair for the reporting-tick handback race; no remaining blocker was found
in this source fix set. Earlier `recovery-followthrough-tests.json` was reused
during intermediate runs; the separate source-acceptance report is the final
evidence for this slice.

These checks cover the plan's deterministic mission layers, not live-provider
acceptance or permission attestation. The provider-control inventory is complete:
read-only recovery status and automatic fenced probes exist; manual circuit reset,
forced probe and bypass UI do not. Those are a separate operator feature, not a
new implementation obligation silently added to this recovery. Experimental
adapters, attachment DLP and every possible diagnostic/command path are outside
the bounded native-provider/text acceptance claim.

## Remaining delivery gates

1. Phase 4B: implement and accept an OS-isolated worker launcher before enabling
   headless execution. Keep startup containment and the default freeze meanwhile.
2. Phase 8: disabled-feature runtime smoke evidence is recorded above, including
   runtime-only compatibility and both previously missing dashboard artifact tests.
   This does not satisfy Phase 4B or authorize live headless execution.
3. Phase 9: combined PR publication and merge are authorized after green CI and
   review. Related branch/worktree cleanup requires separate preservation and
   deletion approval; reconcile the runtime overlay separately after merge.

## Related branch preservation inventory

Read-only local inventory on 2026-09-08. All six listed source worktrees were clean
when inspected. Recheck status and exact HEAD immediately before any later cleanup;
clean does not mean merged or disposable. Preserve the recorded commits first.

| Local source branch | Preserved HEAD | Candidate disposition |
| --- | --- | --- |
| `feature/issue-263-provider-circuit-breaker` | `6342e50563361bcf1ede227a131e6424e883ed26` | Shared durable-health fallback salvaged; reject duplicate process-local circuit and stale capability registry. |
| `feat/issue-264-slice-1-correctness` | `ab0e8bfb03098ff59ee66bcfdf5e9392d7565b6c` | Preserve correctness work; native-provider source parity reviewed and tested, with live/OS limits in its ledger. |
| `feature/issue-268-mission-harness` | `f8f856b526dd76a5a17a3e56138aaf70f7c982be` | Source-only fixture replaces selected harness concepts; no wholesale merge of build-dependent harness. |
| `feature/issue-269-outbound-sanitization` | `93a50cb702cb11986e80ba3b5fc2d6550e5fe35f` | Sanitizer/transport concepts salvaged; unsafe whitespace streaming replaced by bounded buffering. |
| `feature/issue-270-supervision-phase-1-1` | `0b404e8bf928ecb5c44c97a09eacda4b5d6868bb` | Instance and attempt fences reimplemented narrowly; unfinished supervision/restart machinery not accepted. |
| `docs/plan-tracking-20260904` | `12229839dd0046e97246c5be7c7400c2134475d2` | Historical status only; replace stale claims when publication is authorized. |

The runtime checkout, governor candidate, PR266 integration/timeout worktrees,
detached PR272 review worktrees and premerge evidence worktree are not deletion
targets in this inventory. No wholesale branch merge is recommended.
