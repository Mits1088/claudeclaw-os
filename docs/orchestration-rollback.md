# Orchestration rollback and retained boundaries

**v1.10.0 follow-up:** This document records the #280 rollback. PR #290 later
restored native headless execution for trusted local workers through lease-aware
supervision. Its isolation-only startup restriction below is historical, not the
current deployment rule. The removed Crew engine remains removed. See the
[current headless-worker guide](headless-workers.md).

This change reverses the generalized Crew workflow expansion from PR266 and
PR278. It preserves the intervening PR274 memory fixes. PR279's experimental
keep-working layer is not included; its branch and test evidence remain historical
work, not an accepted implementation.

## Removed

The Crew coordinator state machine, governor budgets and reservations, workflow
reporting, shared provider recovery/circuit machinery, Crew dashboard controls,
workflow CLI/MCP surface, and their dedicated probes and tests are removed.
This is code removal, not another feature flag around the same engine.

## Retained

- Ordinary one-shot mission delegation and explicit handback.
- Existing bounded self-continuation and cancellation, plus gather/join.
- PR274 memory extraction and summary fixes.
- Independent permission, replay, terminal-result, duplicate-child, and outgoing
  secret-protection corrections.
- Headless startup containment. Worker configuration and history remain, but
  headless execution is not enabled without OS isolation.
- Model effort remains `low`, displayed as `Low`.

Self-continuation is not the rejected Crew owner-assessment loop. This rollback
does **not** claim to deliver autonomous delegate → assess → delegate orchestration.
That capability needs a later, small design and independent acceptance, not a
revival of the removed engine.

## Existing installations

Stop all processes using the old build before deploying this build. Back up the
database using the normal SQLite-aware backup procedure; do not copy only the
main database file while WAL writers are active.

Historical workflow tables and rows are not deleted. A compatibility marker keeps
legacy workflow-linked tasks out of ordinary task claims. There is no automated
data migration campaign, budget reset, history deletion, or attempt to finish old
workflows. Old Crew settings no longer enable execution in this build. Do not run
old and new schedulers against the same database concurrently.

Interrupted ordinary work must be treated as execution unknown and inspected
before an explicit retry. A missing report is not proof that external side effects
did not happen.

## Acceptance boundary

Validate the source with isolated databases and fake providers: ordinary task
dispatch, handback deduplication, self-continuation limits, gather/join, cancellation
before and during execution, late results, restart recovery, and legacy-row
quarantine. Also run provider, transport, dashboard, build, and type checks.
These checks do not claim live model or OS-isolated worker acceptance.

Runtime overlays, local agent configuration, databases, and service restarts are
deployment concerns and are not part of the source rollback.
