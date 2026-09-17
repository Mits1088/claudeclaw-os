# Headless Workers

v1.10.0 restores native headless execution through the existing supervisor.
Workers run as trusted local processes with host access; process supervision is
not OS isolation. No Docker setup or separate credential relay is required.
Activation and restart wait for a current lease, and direct startup without valid
supervisor metadata is rejected. This supersedes the isolation-only startup block
introduced during the Crew rollback. See [native headless delegation](native-headless-289.md).

Headless workers are normal ClaudeClaw agents with a mission-only runtime. They use the same provider, model, agent instructions, mission scheduler, SQLite task state, and service lifecycle as messenger agents, but own no Telegram token and create no messenger transport.

## Configuration

```yaml
name: Fable Worker
description: Bounded implementation tasks
runtime:
  mode: headless
lifecycle:
  mode: persistent
provider:
  type: claude
  model: claude-fable-5-1
```

Existing agents remain `messenger` by default. Existing headless workers default to `persistent`. Messenger credentials are validated by the selected transport's preflight; headless workers create no messenger transport. Invalid runtime or lifecycle combinations fail closed during config loading.

## Lifecycle policy

Creating and activating a new headless worker identity requires explicit user
authorization. A mission or delegation request does not authorize an agent to
expand the fleet on its own. The creation request chooses one lifecycle:

- `persistent` workers remain available for unrelated future missions until an
  operator explicitly deactivates or deletes them.
- `task-scoped` workers arm when they claim their first mission or scheduled
  job. After all missions assigned to them and all missions they created for
  other agents become terminal, they deactivate automatically. Any retained
  active, running, or paused scheduled job prevents automatic deactivation.

Automatic deactivation changes desired process state and follows the normal
graceful shutdown path. It does not delete the agent configuration, history,
mission attribution, logs, or credentials. Deletion remains an explicit
dashboard action.

## Create and activate

```powershell
node dist/agent-create-cli.js `
  --id fable-worker `
  --name "Fable Worker" `
  --description "Bounded implementation tasks" `
  --runtime-mode headless `
  --lifecycle task-scoped `
  --model claude-fable-5-1 `
  --activate
```

The dashboard creation wizard exposes the same runtime and lifecycle choices.
Headless agent cards show `persistent` or `task-scoped` beside their live lease
status.

## Task and notification behavior

- Assign work with `mission-cli`, exactly as for messenger agents.
- The worker claims addressed tasks through the normal scheduler.
- Progress and completion remain in mission state. No Telegram start banner, completion message, or failure alert is emitted by the worker.
- The assigning agent owns review and user reporting. Terminal handbacks remain terminal and must not create recursive handbacks.
- Mission tasks and scheduled jobs use a sliding 15-minute provider-inactivity timeout with a non-sliding 30-minute maximum runtime. Provider activity extends the idle window but never the absolute ceiling. Override these defaults with `SCHEDULER_IDLE_TIMEOUT_MS` and `SCHEDULER_MAX_RUNTIME_MS`.

## Runtime supervision and restart safety

The main agent supervises headless worker processes. Activation state is stored
separately from process identity, so a crew restart can stop the old processes
and relaunch every worker that was intentionally active.

Each main-agent startup creates a new supervisor epoch and runtime build id.
Workers receive a unique instance id and maintain a 15-second SQLite heartbeat;
the dashboard considers a worker online only while that lease is current and
fresh. Mission claims are fenced inside the same database transaction, so a
process from an older epoch cannot consume queued work even if the operating
system has not terminated it yet.

On shutdown and startup reconciliation, ClaudeClaw enumerates agent processes
for the exact project entrypoint, preserves PM2-managed messenger agents, and
stops headless or no-longer-configured processes. A stale process that cannot be
confirmed stopped leaves its worker unhealthy and is not replaced. A mission
left `running` by a terminated worker is marked failed with a reconciliation
warning. It is never rerun blindly because an interrupted task may already have
changed an external system.

Direct mission assignment to a headless worker without a current lease is
rejected. This prevents an offline configured identity from looking like an
active dispatch target.

### Current supervision boundary

The initial supervision release reconciles workers when the main process starts
and stops. If a worker crashes while main remains running, its lease expires and
it becomes unavailable for new work, but it is not automatically relaunched
until explicit activation or the next main-process restart.

Mission completion is bound to the worker instance and claim generation that
claimed the task. Periodic reconciliation and restart backoff remain outside this
release's scope. Desired activation state remains operator intent. See
[`docs/rfcs/headless-worker-supervision.md`](rfcs/headless-worker-supervision.md)
for the accepted lifecycle and fencing specification.

## Runtime validation boundary

Runtime acceptance should use authorized headless workers with different provider paths, one Fable 5.1 and one OpenAI/Codex model. Give them bounded, read-only or disposable-worktree tasks, gather results back to `main`, and verify that no worker needs a Telegram token or emits a direct notification. A disposable task directory does not isolate the process from the host. Commits, pushes, deployments, and external writes retain their authorization boundaries. Identity creation and delegation restrictions are not yet uniformly enforced across all application entrypoints; see the follow-ups in PR #290.
