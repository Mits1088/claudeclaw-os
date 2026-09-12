# Native headless delegation, issue 289

Mike superseded the Docker/OS-isolation requirement on September 12, 2026.
This slice restores trusted local execution through the existing native provider
and worker supervisor. It adds no container dependency or credential relay.
It does not claim filesystem, credential, or network isolation from the host.

Workers require supervisor launch metadata and a current active lease before
acquiring the PID lock. Dashboard and create-CLI activation await that lease
asynchronously; immediate exit or timeout is a failure. Existing lease fencing,
watchdogs, handbacks and persistent/task-scoped lifecycle remain in use.
Headless activation uses the same detached launcher on supported host platforms.
An already-live leased worker is reused. Worker processes cannot activate peers
through the activation API. Explicit owner direction remains required for hub
activation and assignment; local shell access remains trusted host authority.

Background workers do not drive Holden typing. Existing mission notifications
and handbacks carry their activity. No new worker or provider run is started by
this implementation update. Real-provider native acceptance remains to be run
with Mike after the runtime reload.

The Docker experiment is archived separately at
D:/projects/eai/archived-worktrees/issue-289-docker-experiment.

## Fable review corrections

Review 3e959997 completed; runtime matched source and Docker was not wired in.
Corrected messenger/main lock ordering while keeping headless admission before
its lock. Supervisor shutdown now conditionally advances only its owned epoch.
Readiness uses an asynchronous Windows process probe and leaves a still-starting
live child active on timeout, reporting unconfirmed readiness. Reconciliation
awaits independent starts concurrently. Dashboard worker restart uses the same
admission/readiness path; the legacy synchronous restart rejects headless use.
Lease acquisition refuses an already-owned instance instead of overwriting it.

122 focused/regression tests passed, including database coverage, startup timeout
with a live child, stale supervisor shutdown and duplicate lease refusal.
No separate Telegram approval button was added: Mike confirmed it is optional;
these findings concern lifecycle correctness, not missing user authorization.
Windows forced process termination still cannot guarantee JS shutdown handlers;
existing parent-side fencing and next-boot reconciliation remain necessary.
These corrections are worktree-only pending the next runtime update.

Latest validation: 124 tests and TypeScript passed. Confirmed-dead stale leases are now cleared with instance/PID/active-state matching before replacement. These corrections are applied to the runtime overlay and its server build passed; service reload requested by Mike. Continuation remains planning-only.

