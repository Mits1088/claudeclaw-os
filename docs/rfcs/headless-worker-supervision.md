---
Type: RFC
Title: Headless Worker Supervision and Lease Fencing
Author: Michael Kidder
Decision: Accepted
Decision date: 2026-08-17
Implementation: Phase 1 implemented in PR #243; Phase 1.1 planned
Scope: Headless worker process ownership, liveness, restart recovery, and mission write fencing
Related: PR #243, docs/headless-workers.md
Last reviewed: 2026-08-17
---

# Headless Worker Supervision and Lease Fencing

## Outcome

ClaudeClaw owns the lifecycle of every headless worker launched from its exact
runtime checkout. A configured worker identity is not considered online merely
because a process exists. Online status and permission to claim work require a
fresh lease issued by the current main-process supervisor epoch and runtime
build.

Phase 1 establishes restart fencing and safe startup reconciliation. Phase 1.1
closes the remaining live-supervision gap by periodically reconciling workers,
bounding restart attempts, and binding terminal mission writes to the worker
instance that claimed the mission.

## Terms

- **Desired state** is operator intent: `active` or `inactive`.
- **Health state** is observed runtime condition, independent of desired state.
- **Supervisor epoch** is a unique generation minted by the main process.
- **Worker instance** is one launched process with a unique instance ID.
- **Current lease** matches the active epoch and build and has a fresh heartbeat.
- **Fencing** rejects state changes from an old or expired worker instance even
  when the operating system has not terminated that process.

Desired state must never be changed merely because a worker crashes repeatedly.
Doing so would confuse operator intent with runtime health.

## Phase 1 contract

PR #243 provides these invariants:

1. Only the main process creates the supervisor epoch and launches headless
   workers.
2. Every launched worker receives an instance ID, supervisor epoch, and runtime
   build ID and must acquire the corresponding lease before starting its
   scheduler.
3. Workers heartbeat every 15 seconds and self-terminate when lease renewal is
   rejected.
4. A mission claim by a headless worker checks lease currency inside the same
   immediate database transaction that changes the mission to `running`.
5. Main-process startup revokes old leases, stops exact-checkout orphan
   processes, confirms termination, and relaunches only desired-active workers.
6. Failure to confirm termination prevents replacement, avoiding two live
   instances for one worker identity.
7. Main-process shutdown revokes leases and stops owned headless workers.
8. A mission left running by a terminated worker is marked failed for
   inspection. It is not automatically retried because external side effects
   may already have occurred.
9. Messenger agents remain PM2-owned and are excluded from headless-worker
   reconciliation.

## Phase 1 boundary

Phase 1 reconciles at main-process startup and shutdown. It does not relaunch a
worker that crashes while the main process continues running. That worker
becomes offline when its lease expires and remains unavailable until explicit
activation or the next main-process restart.

Claim fencing prevents the stale process from taking new missions. It does not
yet prove that a terminal write came from the same worker instance that claimed
an already-running mission.

## Phase 1.1 requirements

### Main-owned periodic reconciliation

The main process must own a dedicated, non-overlapping reconciliation timer.
It must not depend on an individual worker scheduler or messenger delivery
loop. A slow reconciliation pass must not overlap the next pass.

For every configured headless worker:

1. Preserve `desired_state` as operator intent.
2. If desired-inactive, revoke any lease and stop any exact-checkout process.
3. If desired-active with a current lease and matching live process, do nothing.
4. If desired-active with a stale or missing lease, stop and confirm any recorded
   or enumerated old process before launching a replacement.
5. If termination cannot be confirmed, mark the worker unhealthy, emit an
   operator-visible error, and do not launch a replacement.
6. Relaunch only when the worker is within its restart budget.

Process enumeration must remain scoped to the exact project entrypoint and
must continue excluding messenger agents.

### Restart budget and health

Restart failure state must be stored separately from desired state. The model
must support at least:

- `health_state`, including `healthy` and `unhealthy`;
- consecutive or windowed restart attempts;
- the next eligible restart time;
- the last failure reason and timestamp.

Retries use bounded exponential backoff. Exceeding the restart budget changes
health to unhealthy and suppresses automatic relaunch until an operator action
or an explicitly defined cooldown resets the budget. It does not change
`desired_state` to inactive.

Exact default intervals and limits belong in the implementation PR and must be
environment-overridable. Tests must use deterministic injected time rather than
wall-clock sleeps.

### Instance-bound mission completion

When a headless worker claims a mission, the same transaction must persist the
claiming worker instance ID on that mission. A terminal update from a headless
worker must be a compare-and-set operation requiring all of the following:

- mission ID matches;
- status is still `running`;
- assigned agent matches;
- claiming worker instance ID matches;
- the instance lease is current in the terminal-write transaction.

If the compare-and-set updates no row, the scheduler must treat the completion
as fenced. It must log the rejected instance and must not release a gather join
or overwrite a result produced by another instance. It must not blindly retry
the mission.

Messenger-agent mission completion remains compatible and does not require a
worker instance ID.

### PID provenance

The lease and instance ID remain the correctness boundary. PID comparison is
diagnostic hardening only. Reconciliation should log divergence between the
runtime row and exact-checkout process enumeration, but PID reuse or a legacy
PID file must never establish worker liveness or authority.

## Required tests

Phase 1.1 must prove:

- a crashed desired-active worker is relaunched without restarting main;
- healthy siblings are not restarted;
- a crash loop backs off and becomes unhealthy without changing desired state;
- an unconfirmed old process blocks replacement;
- a stale instance cannot claim a new mission;
- a stale instance cannot complete or fail an already-running mission;
- a fenced completion cannot release a gather join;
- messenger agents are never stopped by worker reconciliation;
- reconciliation passes cannot overlap;
- restart and completion behavior survives main-process restart and SQLite
  contention.

## Non-goals

- Moving headless workers under PM2.
- Automatically retrying externally mutating missions.
- Porting the runtime to Elixir or BEAM.
- Adding provider-native coding fan-out inside ClaudeClaw.
- Adding A2A, signed identities, cross-host workers, or general worker pools.

Provider-native subagents own same-provider coding fan-out. ClaudeClaw retains
the cross-provider fleet, durable mission state, shared memory, named identity,
and Windows-native lifecycle boundary.
