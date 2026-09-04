# Codex 0.153.2 native-Windows containment probe

Date: 2026-09-04 MDT  
Host: native Windows 10.0.26200, x64  
Runtime: `@openai/codex` and `@openai/codex-sdk` 0.153.2

The probe used a fresh directory under the OS temp root, a fresh isolated `CODEX_HOME`, the operator-approved elevated sandbox setup state, and no production store or runtime workspace. It made no model turn and required no account request.

| Gate | Result |
|---|---|
| App Server reports Windows sandbox readiness | Pass, `ready` |
| Requested `workspace-write` is effective `workspaceWrite` | Pass |
| Approval policy remains `never` | Pass |
| Effective network access remains false | Pass |
| Unexpected instruction sources | Pass, zero reported |
| Unexpected active permission profile | Pass, null |
| Write inside `cwd` | Pass |
| Write outside `cwd` | Pass, blocked |
| Outbound shell network access | Pass, blocked |
| Junction/reparse-point escape | Pass, blocked |
| Sandboxed process-tree cancellation | **Blocked upstream** |
| Unrelated-turn/process isolation during cancellation | Not run because sandboxed cancellation is unavailable |

The exact 0.153.2 failure from `command/exec/terminate` with an active sandboxed Windows command was:

```text
command/exec/terminate failed: command/exec/write, command/exec/terminate, and command/exec/resize are not supported for windows sandbox processes
```

Decision: do not switch native OpenAI to App Server by default. Keep the SDK default and `CODEX_TRANSPORT=app-server` opt-in. The shippable uplift pins both packages to 0.153.2, keeps the generated protocol contract green, mirrors only approved Windows sandbox setup artifacts into isolated `CODEX_HOME`, and fails closed before `thread/start` unless readiness is `ready`.

Re-run with:

```powershell
$env:NODE_ENV='development'
npm run codex:windows-probe
```

The command exits nonzero while the cancellation gate is blocked. A complete pass should exit zero only after the cancellation and unrelated-process checks are implemented and proven on the pinned upstream runtime.
