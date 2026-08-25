---
Type: RFC
Author: Michael Kidder
Contributors: Lawrence
Title: Native OpenAI Provider via Codex App Server
Decision: Accepted
Decision date: 2026-07-31
Implementation: Complete
Implemented in: v1.8.0 (PR #174)
Component: provider engine / native OpenAI transport
Current validated baseline: Codex CLI 0.149.1. Historical 0.144.6 probe findings remain labelled below where they still explain a protocol decision.
Last updated: 2026-07-24
Last reviewed: 2026-08-01
---

# Native OpenAI Provider via Codex App Server

## Outcome

The initial production scope shipped in v1.8.0 through PR #174. Codex App
Server is the default native OpenAI transport behind the existing `AgentEngine`
interface, with policy verification, isolated credentials, dispatch parity,
schema drift checks, and the SDK adapter retained as the planned rollback path.
Post-soak removal of that rollback path remains a follow-up rather than an
unfinished part of the initial release.

## Summary

Replace the native OpenAI provider's `@openai/codex-sdk` transport with one
persistent `codex app-server` process per ClaudeClaw agent process.

The provider remains behind the existing `AgentEngine` interface. Telegram,
Signal, missions, schedules, memory ingestion, voice, war rooms, session
storage, progress rendering, cancellation, and usage accounting must not gain
provider-specific branches.

The first production release keeps `CodexSdkEngineAdapter` as an explicit
rollback path. App Server becomes the default native OpenAI transport after its
compatibility and integration tests pass. The SDK path is removed only after a
successful soak period.

Before App Server implementation begins, ClaudeClaw must close an existing
authorization gap in the SDK path. The current SDK adapter can add
`claudeclaw-dispatch` after caller tool policy has been resolved. That makes
restricted turns more capable than their callers requested. Phase 0 moves
dispatch authorization ahead of the adapter, introduces shared Codex
capability profiles, and proves those profiles against the SDK path. App Server
must reuse that policy layer rather than port the gap.

The resulting process model is:

```text
ClaudeClaw agent process
  |
  +-- EngineFactory
  |     |
  |     +-- openai -> CodexAppServerEngineAdapter
  |
  +-- one CodexAppServerClient singleton
        |
        +-- one long-lived child process
        |     node @openai/codex/bin/codex.js app-server --listen stdio://
        |
        +-- stdin:  JSON-RPC requests and responses, one JSON object per line
        +-- stdout: JSON-RPC responses, requests, and notifications
        +-- stderr: Codex diagnostics
```

## Decision

ClaudeClaw will use Codex App Server as the primary native OpenAI transport.

This is a transport replacement, not a provider rewrite:

- `ProviderConfig.type === "openai"` remains unchanged.
- `AgentEngine`, `AgentTurnInput`, and `AgentEngineEvent` remain the public
  provider seam.
- Existing provider-prefixed session identifiers remain valid.
- Codex continues to own thread history, compaction, built-in tools, MCP
  lifecycle, authentication, and sandbox execution.
- ClaudeClaw continues to own trust policy, MCP selection, agent identity,
  persona construction, dispatch governance, retries, user-visible progress,
  and normalized usage.

App Server is the better fit for ClaudeClaw's long-lived, interactive host. It
provides a bidirectional protocol for thread lifecycle, streamed agent events,
server-initiated requests, cancellation, and effective configuration. The
current TypeScript SDK launches `codex exec` for each invocation and hides
important lifecycle details behind a per-turn wrapper.

## Goals

1. Keep one warm Codex runtime per ClaudeClaw agent process.
2. Remove per-turn `codex exec` process startup.
3. Preserve native OpenAI behavior across every existing `AgentEngine` caller.
4. Preserve existing Codex thread IDs and resume behavior.
5. Stream text, tool progress, plans, compaction, errors, and token usage through
   the current normalized event contract.
6. Cancel one turn without killing unrelated turns on the shared App Server.
7. Pass the persona and MCP configuration as JSON rather than command-line
   arguments.
8. Verify the effective sandbox and approval policy before starting a turn.
9. Fail closed when the applied host policy is weaker or different from the
   policy ClaudeClaw requested.
10. Retain a temporary, operator-selectable SDK rollback path.
11. Make caller intent authoritative for shell, web search, MCP, dispatch,
    filesystem, and network capabilities.
12. Ensure tool-less and restricted turns cannot regain capabilities through
    adapter defaults.
13. Use one shared Codex capability policy for both the SDK rollback and App
    Server transports.

## Non-goals

- Replacing the `AgentEngine` abstraction.
- Changing the experimental ACP `acp-codex` provider.
- Sharing one App Server across multiple ClaudeClaw operating-system processes.
- Running App Server over TCP, WebSocket, Unix socket, SSH, or remote control.
- Exposing the raw App Server protocol through Telegram or the dashboard.
- Reimplementing Codex tools, context storage, compaction, or MCP in
  ClaudeClaw.
- Migrating Codex thread transcripts into ClaudeClaw's SQLite database.
- Solving native Windows `workspace-write` limitations.
- Broadening any caller's tool, MCP, filesystem, or network authorization.
- Automatically approving interactive permission requests.
- Using App Server dynamic tools in the first release.
- Pretending Claude tool names map one-for-one to Codex runtime tools.
- Preserving an existing adapter behavior when that behavior violates the
  caller's resolved authorization.

## Why App Server

The current `@openai/codex-sdk` adapter is convenient, but its execution model
works against a persistent personal assistant:

- Every `invoke()` creates an SDK client that launches `codex exec`.
- Configuration is serialized into command-line arguments.
- Large personas and MCP definitions are constrained by the Windows command-line
  limit.
- Cancellation is coupled to a short-lived child process.
- Concurrent turns cannot share a warm Codex runtime.
- The adapter can request a sandbox but cannot reliably inspect the policy the
  host actually applied.
- Server-initiated user input and approval requests are not available through
  the current stream abstraction.

App Server exposes the lifecycle directly:

- `initialize` and `initialized` establish one connection.
- `thread/start` creates a persisted conversation.
- `thread/resume` rejoins an existing thread.
- `turn/start` begins work.
- notifications stream text, items, plans, compaction, errors, and usage.
- `turn/interrupt` cancels a specific active turn.
- `turn/completed` provides the authoritative terminal status.

Official Codex documentation describes App Server as the interface for rich
product integrations that need authentication, conversation history,
approvals, and streamed agent events. That matches ClaudeClaw more closely than
a one-shot automation or CI wrapper.

## Harness parity assessment

The target is product-level parity at the `AgentEngine` boundary, not identical
internal tools. Claude Code and Codex have different tool models, permission
controls, skills, and lifecycle protocols.

| Capability | Claude Code harness | Current Codex SDK path | App Server target | Disposition |
|---|---|---|---|---|
| Existing `AgentEngine` callers | supported | supported | supported | preserve |
| Persisted sessions and resume | supported | supported | supported | preserve existing IDs |
| Incremental assistant text | supported | complete messages only | `item/agentMessage/delta` | close gap |
| Tool and plan progress | supported | partial normalized events | item and plan notifications | close gap |
| Per-turn cancellation | abortable turn | short-lived process abort | `turn/interrupt` | improve isolation |
| Structured user questions | supported | unavailable | experimental request-user-input flow | close gap behind schema guard |
| Exact per-tool allow and deny | Claude-native | not enforceable by Claude names | not enforceable by Claude names | use Codex-native profiles |
| Bounded turns | `maxTurns` | ignored | no direct equivalent | deadline and tool-item budget |
| MCP authorization | caller selected | adapter can add dispatch today | caller selected only | Phase 0 fix |
| Warm runtime | SDK-managed | new `codex exec` per invocation | one persistent process | close gap |
| Persona and large config | SDK input | command-line constrained | JSON-RPC configuration | close gap |
| Usage and compaction | normalized | available but coarse | turn usage and compaction events | normalize |
| Effective sandbox inspection | provider controlled | requested value only | verify returned effective policy | close visibility gap |
| Safe contained writes on native Windows | provider dependent | not available in current host | not fixed by App Server | external blocker |
| Harness-specific skills and commands | Claude-native | Codex-native equivalents differ | Codex-native equivalents differ | no false equivalence |

App Server closes lifecycle and streaming gaps. It does not automatically close
tool authorization, dispatch governance, bounded-turn, skill, or native Windows
sandbox gaps. Those require the explicit policy and test work in this RFC.

## Protocol baseline and versioning

App Server is experimental. Its protocol may change without notice.

ClaudeClaw must therefore treat the Codex binary and its protocol schema as one
versioned dependency:

1. Replace the transitive CLI dependency with a direct dependency on
   `@openai/codex`.
2. Pin the package to an exact version. Do not use a caret range.
3. The initial baseline is `@openai/codex` `0.144.6`.
4. Keep `package-lock.json` committed.
5. Generate reference bindings from the pinned binary during development:

   ```powershell
   codex app-server generate-ts --experimental --out <temporary-directory>
   codex app-server generate-json-schema --experimental --out <temporary-directory>
   ```

6. Keep a small, ClaudeClaw-owned protocol surface in source control rather than
   committing hundreds of generated types for unrelated App Server features.
7. Add a schema compatibility test that generates the pinned schema and asserts
   that all methods and fields ClaudeClaw consumes still exist. It must enforce
   the handshake shapes exactly as specified under "Initialization handshake":
   that `InitializeCapabilities` still requires both `experimentalApi` and
   `requestAttestation`, that the consumed `InitializeResponse` fields are still
   present and still strings, that every consumed request method still exists in
   `ClientRequest`, and that the `initialized` client notification still carries
   no `params` member. The check exists to fail loudly on exactly the drift that
   would otherwise be discovered as a runtime deserialization error.
8. A Codex dependency upgrade is blocked until that compatibility test and the
   App Server integration suite pass.

The first implementation uses V2 methods and camelCase fields from the
0.144.6 schema. It initializes with `experimentalApi: true` because structured
`item/tool/requestUserInput` support is experimental in this baseline, and with
`requestAttestation: false` because attestation is not implemented. Core thread
and turn lifecycle methods must not depend on unrelated experimental features.

## Existing contract that must remain stable

The current engine seam is:

```typescript
export interface AgentEngine {
  invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent>;
}
```

The new adapter must preserve every existing normalized event:

```typescript
export type AgentEngineEvent =
  | { type: "session"; sessionId: string; raw?: unknown }
  | { type: "text_delta"; delta: string; accumulatedText: string; raw?: unknown }
  | { type: "progress"; progress: AgentEngineProgressEvent; raw?: unknown }
  | { type: "usage"; usage: AgentEngineUsage; raw?: unknown }
  | { type: "compact"; preCompactTokens: number | null; trigger?: string; raw?: unknown }
  | { type: "result"; text: string | null; usage: AgentEngineUsage | null; stopReason?: string; raw?: unknown }
  | { type: "aborted"; text: string | null; sessionId?: string; usage: AgentEngineUsage | null; raw?: unknown }
  | { type: "error"; error: unknown; raw?: unknown };
```

No caller should know whether an OpenAI turn used App Server or the SDK rollback
adapter.

## Components

### `CodexAppServerClient`

`src/agent-engine/codex-app-server-client.ts` owns the child process and JSONL
protocol. It is transport-only and must not know about Telegram, missions,
providers, or `AgentEngineEvent`.

Responsibilities:

- Resolve the pinned `@openai/codex` launcher.
- Spawn exactly one App Server child.
- Perform the initialization handshake.
- Allocate request IDs.
- Correlate responses to pending requests.
- Parse and route server notifications.
- Handle server-initiated requests and send responses.
- Track process readiness and failure.
- Expose typed `request()` and notification subscription methods.
- Shut down the child when the ClaudeClaw process exits.

### `CodexAppServerManager`

`src/agent-engine/codex-app-server-manager.ts` owns shared runtime state above
the raw protocol:

- lazy singleton construction;
- per-thread turn serialization;
- thread and turn notification routing;
- active turn registry;
- launch-environment fingerprinting;
- bounded restart behavior;
- process health metrics;
- graceful shutdown.

The manager is process-scoped, not adapter-instance-scoped. `EngineFactory`
currently creates adapters per call, so storing the child on an adapter instance
would accidentally restore the per-turn process model.

### `CodexAppServerEngineAdapter`

`src/agent-engine/codex-app-server-adapter.ts` implements `AgentEngine`.

Responsibilities:

- Convert `AgentTurnInput` into thread and turn configuration.
- Start or resume a Codex thread.
- Verify the effective thread configuration.
- Start a turn.
- Convert App Server notifications into `AgentEngineEvent`.
- Normalize usage and estimate cost.
- Map structured user-input requests to `onAskUserQuestion`.
- Perform safe stale-session fallback.
- Produce user-visible terminal errors through the same path as the existing
  adapter.

### Protocol types

`src/agent-engine/codex-app-server-protocol.ts` contains only the request,
response, notification, and item shapes ClaudeClaw consumes.

All input from App Server is treated as `unknown` until its envelope and required
discriminants are checked. Unknown notification methods and unknown item types
are logged at debug level and ignored. A new optional field must not break a
turn. A missing required field on a consumed method is a protocol error.

## Process lifecycle

### Launcher resolution

Declare `@openai/codex` as a direct exact-version dependency.

Resolve its `package.json` relative to the installed application, then derive
`bin/codex.js`. Spawn it with the current Node executable:

```text
process.execPath <resolved>/@openai/codex/bin/codex.js app-server --listen stdio:// --strict-config
```

Do not depend on a globally installed `codex` or the caller's `PATH`. This keeps
the runtime version identical to the schema version tested by ClaudeClaw.

`--strict-config` is required so a misspelled hardening override fails startup
instead of being silently ignored.

### Lazy startup

Start App Server on the first native OpenAI invocation. Startup has these
states:

```text
stopped -> starting -> ready
                |        |
                v        v
              failed <- exited
```

Concurrent callers that arrive during `starting` await the same startup promise.
They must not spawn additional children.

### Initialization handshake

After spawn:

1. Begin draining stderr immediately.
2. Begin reading stdout line by line.
3. Send:

   ```json
   {
     "method": "initialize",
     "id": 1,
     "params": {
       "clientInfo": {
         "name": "claudeclaw",
         "title": "ClaudeClaw",
         "version": "<package version>"
       },
       "capabilities": {
         "experimentalApi": true,
         "requestAttestation": false
       }
     }
   }
   ```

   Both capability fields are REQUIRED by the 0.144.6 `InitializeCapabilities`
   schema. `requestAttestation` is not optional and has no default, so it must be
   sent explicitly — `false`, because the first release does not implement
   `attestation/generate` (see "Dynamic tools, MCP elicitation, auth refresh, and
   attestation"). Sending only `experimentalApi` fails deserialization.

4. Wait for a successful `initialize` response.
5. Verify that the returned `codexHome` is the isolated ClaudeClaw
   `CODEX_HOME`.
6. Record `userAgent`, `platformFamily`, and `platformOs` for diagnostics.
7. Send `{"method":"initialized"}`.

   The 0.144.6 `ClientNotification` variant for `initialized` has NO `params`
   member. Do not send `"params": {}`.

8. Mark the client ready.

No other request may be sent before initialization completes.

Startup timeout is 10 seconds. A timeout kills that child, rejects all startup
waiters, and leaves the manager restartable for a later invocation.

### Standard I/O rules

- stdin and stdout are reserved for protocol JSONL.
- stderr is diagnostic output only.
- Every outbound message is one compact JSON object followed by `\n`.
- Empty stdout lines may be ignored.
- A malformed non-empty stdout line is a protocol failure.
- Cap a single inbound line at 32 MiB to prevent unbounded memory growth.
- Backpressure on child stdin must be respected.
- Never write application logs to the child's stdin.
- Never log full protocol payloads at info level.
- Redact tokens, secrets, MCP environment values, prompts, and tool results.

### Request correlation

Use monotonically increasing positive integer request IDs. Maintain:

```typescript
Map<number, {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>
```

A response with an unknown ID is logged and ignored. Duplicate responses are a
protocol warning. Each request removes its pending entry exactly once.

Control requests use a 30-second timeout unless a narrower timeout is defined.
The lifetime of an active Codex turn is controlled by the caller's
`AbortController`, not by the 30-second control timeout.

### Shutdown

On normal ClaudeClaw shutdown:

1. Stop accepting new App Server requests.
2. Interrupt active turns.
3. Wait up to 5 seconds for terminal notifications.
4. Close child stdin.
5. Wait up to 2 seconds for process exit.
6. Terminate the child if it remains alive.

Install process signal handlers once, at the application lifecycle layer. The
manager must not add a new global handler for every turn.

## Environment and authentication

Preserve the current isolated `CODEX_HOME` behavior.

Before spawning App Server:

1. Ensure `<CLAUDECLAW_CONFIG>/codex-home` exists.
2. Ensure its required state directories exist.
3. If API-key auth is not configured, sync the operator's Codex `auth.json` into
   the isolated home using the existing safe-copy rules.
4. Refuse to start if isolation cannot be established.
5. Set `CODEX_HOME` to the isolated directory.
6. Preserve the runtime `PATH` and required operating-system variables.
7. Strip Anthropic credentials and unrelated provider credentials.
8. Pass `OPENAI_API_KEY` only when configured.
9. Keep API keys and access tokens out of model-spawned shell environments using
   the existing shell environment policy.

App Server is long-lived, so changes to launch-critical environment variables
cannot silently apply halfway through its life. The manager stores a fingerprint
of:

- resolved `CODEX_HOME`;
- `PATH`;
- OpenAI authentication mode, represented by a non-secret hash;
- configured CA certificate paths;
- provider endpoint settings, if supported;
- hardening configuration that is fixed at process launch.

When a later invocation has a different fingerprint:

- restart before the turn if no turn is active;
- otherwise queue the restart until active turns finish;
- never run a turn under an environment that does not match its expected
  fingerprint.

Authentication failures keep the current actionable user message:

```text
Codex isn't authenticated. Run `codex login` on the host or set
OPENAI_API_KEY, then restart ClaudeClaw.
```

## Thread lifecycle

### New thread

When `AgentTurnInput.sessionId` is absent:

1. Build the complete thread configuration.
2. Send `thread/start`.
3. Validate the response.
4. Emit `{ type: "session", sessionId: thread.id }`.
5. Register the thread in the manager.
6. Send `turn/start`.

Thread IDs remain raw Codex IDs inside the adapter. Existing caller code
continues to wrap them as `openai:<thread-id>` when storing a provider session.

### Existing thread

When a session ID is present:

1. Acquire the per-thread mutex.
2. Send `thread/resume` using the thread ID only.
3. Include current model, cwd, approval policy, sandbox, persona, and config
   overrides so the current caller policy is applied to this invocation.
4. Request `excludeTurns: true`; ClaudeClaw does not need the historical
   transcript.
5. Validate the response.
6. Start the turn.

`thread/resume` is required even when the thread is already loaded. It is the
point where the adapter reapplies caller-authorized MCP configuration and
receives the effective thread policy for verification.

### Stale session fallback

If `thread/resume` returns a recognized missing-thread or missing-rollout error:

- start one fresh thread;
- emit the new session ID;
- execute the prompt once on the new thread.

Fallback is allowed only before `turn/start` is sent. Once `turn/start` may have
reached App Server, replay is forbidden because commands or MCP tools may
already have produced side effects.

No other resume failure starts a new thread automatically.

### Per-thread serialization

App Server may run different threads concurrently. ClaudeClaw must not run two
normal `invoke()` calls concurrently on the same thread.

The manager provides an abort-aware FIFO mutex keyed by thread ID:

- different threads may run in parallel;
- turns on the same thread are serialized;
- a caller aborted while queued is removed without starting a turn;
- the lock is held through terminal notification handling and cleanup;
- `turn/steer` is not used by the first implementation.

This avoids ambiguous notification routing and App Server's single-active-turn
constraint without reducing concurrency for missions, war-room agents, and
independent chats.

## Mandatory Phase 0: capability and dispatch policy

Phase 0 is a blocking prerequisite for App Server work. Its tests must pass on
the existing SDK transport before Phase 1 begins.

The reason for this ordering is concrete: the current SDK adapter injects
`claudeclaw-dispatch` for native OpenAI turns independently of the caller's
`allowedTools`, `disallowedTools`, and MCP selection. The dispatch server
contains state-changing mission, schedule, and hive tools. A memory-ingest
turn, warmup turn, untrusted voice turn, or default-deny war-room turn can
therefore receive a trusted MCP server even when the caller requested no tools.
Copying that behavior into App Server would preserve a policy bypass.

### Authorization boundary

The authorization boundary is before `AgentEngine.invoke()`:

```text
caller intent
  -> shared tool and dispatch authorization
  -> Codex capability profile
  -> complete authorized AgentTurnInput
  -> SDK or App Server adapter
  -> effective-policy verification
  -> turn start
```

The following invariants are mandatory:

1. An adapter must never add an MCP server that is absent from the authorized
   `AgentTurnInput`.
2. `input.mcpServers` is the complete authorized MCP set, not a partial set to
   which an adapter may add trusted defaults.
3. Dispatch is materialized by the shared dispatch authorization layer only
   when the turn is explicitly eligible for it.
4. Direct engine callers default to no dispatch.
5. `allowedTools: []`, `disallowedTools: ["*"]`, and the tool-less profile
   always result in no shell, no web search, no caller-configured MCP servers,
   and no host-owned Codex Apps server.
6. A sandbox limits filesystem and process effects. It does not authorize MCP
   tools and must never be used as a substitute for MCP filtering.
7. `default_tools_approval_mode = "approve"` may be applied only to an already
   authorized `claudeclaw-dispatch` entry.
8. Deny rules win over allow rules and defaults.

The shared dispatch registry may produce different MCP transport descriptions
for Claude and Codex, but callers must not branch on provider transport.
`runAgent()` asks the registry for the authorized dispatch entry and merges the
result before invoking the engine. Memory ingestion, warmup, voice, war-room,
and other direct engine call paths receive no implicit dispatch. A restricted
path that needs dispatch later must opt in through the same shared
authorization function and add a focused policy test.

### Codex capability profiles

Claude tool names are not a reliable Codex security boundary. For example,
omitting `Bash` from a Claude allowlist does not disable Codex's shell tool.
ClaudeClaw must translate resolved caller intent into one of four explicit
Codex-native profiles:

| Profile | Shell | Web search | Caller MCP | Host-owned apps | Sandbox | Intended callers |
|---|---|---|---|---|---|---|
| `tool-less` | disabled | disabled | none | disabled | `read-only`; `apply_patch` may remain visible but writes are rejected | memory ingest, warmup, pure transforms |
| `read-only-research` | enabled for repository reads | policy controlled | explicit read-only servers only | disabled | `read-only` | repository analysis and untrusted-input research |
| `workspace-agent` | enabled | policy controlled | explicit authorized servers only | enabled for trusted operator turns | `workspace-write` | normal trusted agent work |
| `full-trust` | enabled | policy controlled | explicit authorized servers only | enabled for trusted operator turns | `danger-full-access` | explicit trusted-operator escape hatch |

The shared policy helper returns a transport-neutral decision:

```typescript
type CodexCapabilityMode =
  | "tool-less"
  | "read-only-research"
  | "workspace-agent"
  | "full-trust";

interface CodexCapabilityProfile {
  mode: CodexCapabilityMode;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  shellEnabled: boolean;
  webSearchEnabled: boolean;
  networkAccess: boolean;
  hostAppsEnabled: boolean;
  mcpServers: Record<string, McpServerConfig>;
  turnBudget: {
    deadlineMs?: number;
    maxToolItems?: number;
  };
}
```

Both native OpenAI adapters must consume this helper. The SDK adapter uses the
profile to build Codex config. The App Server adapter uses the same profile for
thread config and then verifies the effective result before `turn/start`.

Profile selection rules:

1. `disallowedTools` containing `*` selects `tool-less`.
2. An explicitly empty `allowedTools` selects `tool-less`.
3. Memory ingestion and warmup explicitly select `tool-less`, even if future
   defaults become more permissive.
4. A restricted read-only caller that needs repository inspection selects
   `read-only-research`.
5. A normal trusted agent turn selects `workspace-agent`.
6. `full-trust` requires an explicit trusted-operator decision, expressed by
   `allowDangerouslySkipPermissions` or by `CODEX_DANGER_WRITE` for an eligible
   write turn. It is never inferred from an incomplete policy.

For `tool-less`, set the version-pinned Codex configuration
`features.shell_tool = false`, `features.apps = false`, and
`web_search = "disabled"`; omit all caller-configured MCP servers, request
`read-only`, and disable network. `mcpServers: {}` controls only MCP servers
provided by ClaudeClaw. It does not disable the host-owned `codex_apps` server.
The separate stable `features.apps = false` gate is mandatory.

For `read-only-research`, the shell may remain enabled because Codex uses it for
repository reads and searches, but the sandbox remains `read-only`, network
remains disabled, MCP servers must be independently authorized, and
`features.apps = false` prevents an untrusted-input research or voice turn from
enumerating the operator's account connectors. Host-owned apps may remain
enabled only for the trusted `workspace-agent` and `full-trust` profiles.

The name `tool-less` describes the authorized capability outcome, not a literal
absence of every Codex built-in tool in SDK 0.144.6. The pinned runtime may
still present `apply_patch`; `read-only` is the control that rejects its writes.
The runtime tool-item guard detects unexpected tool events after they start and
is not a preventive boundary. Rejected `apply_patch` attempts may emit only a
router-level diagnostic and no stream item, so the guard cannot observe every
attempt.

If the pinned Codex version cannot express a requested profile, fail before
starting the turn. Do not silently promote the turn to a broader profile.

### Phase 0 implementation gate

Phase 0 is complete only when:

1. Dispatch MCP construction is removed from
   `CodexSdkEngineAdapter.invoke()`.
2. The shared dispatch authorization layer is the only place that can add
   `claudeclaw-dispatch`.
3. A shared Codex capability helper is used by the SDK adapter.
4. Tool-less turns explicitly disable shell, web search, and host-owned apps
   and contain no caller MCP configuration.
5. Tests cover memory ingestion, warmup, untrusted voice, default-deny
   war-room, normal chat, and mission call shapes.
6. A real-account probe against the pinned binary proves
   `features.apps = false` removes `codex_apps` account inventory from
   tool-less and read-only-research turns.
7. The existing SDK transport remains green and is still the default.

## Turn configuration

### Persona

Pass `AgentTurnInput.systemPrompt` as `developerInstructions` on
`thread/start` and `thread/resume`.

Do not prepend the persona to the user message. Do not impose the current
8,000-character command-line ceiling. JSONL carries the persona through stdin,
so a normal large agent persona does not consume Windows command-line space.

Set `project_doc_max_bytes = 0` in the thread config so Codex does not also load
the agent's `AGENTS.md` symlink and duplicate the persona.

The response's `instructionSources` must be empty. A non-empty value is treated
as a configuration mismatch and blocks the turn.

### User input

For the pinned 0.144.6 schema:

```json
{
  "threadId": "<thread-id>",
  "input": [
    {
      "type": "text",
      "text": "<AgentTurnInput.prompt>",
      "text_elements": []
    }
  ]
}
```

The first implementation supports text input only because `AgentTurnInput`
currently exposes a text prompt. Image, skill, mention, and additional-context
input can be added without changing the transport.

### Model and reasoning

Preserve the current model precedence:

```text
input.model
  -> input.provider.model
  -> DEFAULT_OPENAI_MODEL
```

Preserve the current reasoning mapping:

| ClaudeClaw input | App Server effort |
|---|---|
| `thinkingMode=low` | `low` |
| `thinkingMode=medium` | `medium` |
| `thinkingMode=high` | `high` |
| `thinkingMode=xhigh` | `xhigh` |
| `thinkingMode=auto` | omitted |
| unsupported explicit thinking value | omitted |
| `effort=low` | `low` |
| `effort=medium` | `medium` |
| `effort=high` | `high` |
| `effort=max` | `xhigh` |

An explicit `thinkingMode` remains authoritative. An unsupported explicit value
must not fall through to `effort`.

Set the model on `thread/start` or `thread/resume`. Reasoning effort has no
direct thread parameter in the pinned protocol; send it as
`config.model_reasoning_effort` in the thread request configuration. Do not
override either value on `turn/start`. The adapter first verifies the effective
thread response, including its returned `reasoningEffort`, and only then starts
the turn under that verified configuration.

### Sandbox and approval policy

Use the shared Phase 0 capability profile. The legacy
`sandboxModeFor(input)` mapping is replaced by:

| Capability profile | Requested sandbox |
|---|---|
| `tool-less` | `read-only` |
| `read-only-research` | `read-only` |
| `workspace-agent` | `workspace-write` |
| `full-trust` | `danger-full-access` |

Always request `approvalPolicy: "never"`. ClaudeClaw's non-interactive trust
policy is decided before the provider call. App Server approval prompts must not
silently expand that policy.

For `workspace-write`, explicitly request network disabled. For `read-only`,
explicitly request network disabled. `danger-full-access` retains the current
behavior where Codex is not additionally network-confined.

### Effective-policy verification

This is a release requirement.

`thread/start` and `thread/resume` return the effective:

- model;
- model provider;
- cwd;
- runtime workspace roots;
- approval policy;
- sandbox policy;
- active permission profile;
- reasoning effort;
- instruction sources.

Before sending `turn/start`, verify:

1. `modelProvider === "openai"`.
2. `model` equals the requested model unless an explicitly supported model
   fallback policy was enabled. The first release does not enable fallback.
3. `cwd` resolves to the requested working directory.
4. `approvalPolicy === "never"`.
5. the effective sandbox type exactly matches the requested sandbox.
6. read-only and workspace-write policies report network disabled.
7. workspace-write roots do not broaden access beyond the requested workspace
   and explicitly configured writable roots.
8. the returned reasoning effort matches the requested value, or is omitted
   when ClaudeClaw requested the model default.
9. `instructionSources` is empty.

If any check fails:

- do not call `turn/start`;
- log requested and effective non-secret policy fields;
- return a visible `result` with `stopReason: "error"`;
- identify the mismatch and direct the operator to the Codex host or managed
  policy layer.

The adapter must never log a requested sandbox as though it were the applied
sandbox. Logs use separate `requestedSandbox` and `effectiveSandbox` fields.

### Web search and network

Use the shared capability profile's web-search decision:

- disable when `disallowedTools` contains `*`;
- disable when `disallowedTools` contains `WebSearch`;
- disable when a restricted allowlist omits `WebSearch`;
- disable for every `tool-less` turn;
- enable otherwise.

Apply this through the thread's version-pinned Codex config using
`web_search = "disabled"` when disabled. Keep sandbox network access disabled
for read-only and workspace-write turns even when live web search is enabled.
Codex's managed web-search capability and model-spawned shell network access
are separate controls.

### Maximum turns

`AgentTurnInput.maxTurns` has no direct App Server equivalent. Silently ignoring
it is not acceptable for restricted callers.

Translate it into the shared profile's turn budget:

- tool-less `maxTurns: 1` callers receive no authorized external capabilities
  and a declared bounded deadline;
- tool-capable callers retain their `AbortController` deadline and may set a
  maximum completed command, file-change, web-search, and MCP item count;
- on App Server, when the deadline or item budget is exhausted, send
  `turn/interrupt` and return an explicit budget stop reason;
- notification count is never used as a proxy for model turns;
- no prompt is replayed after a budget interrupt.

The SDK rollback path enforces only `maxToolItems: 0` for tool-less turns. It
carries and logs `deadlineMs` but does not start a second timer; existing caller
`AbortController` timeouts remain the SDK path's wall-clock enforcement. App
Server owns active deadline and nonzero item-budget enforcement through
`turn/interrupt`.

This is not claimed as exact Claude model-turn parity. It preserves the safety
intent: a supposedly bounded call cannot enter an unbounded tool loop. The
adapter must log the requested `maxTurns` and the effective deadline and item
budget so the approximation is visible.

## MCP configuration

Continue to treat `input.mcpServers` as an already-authorized set. Caller policy
remains responsible for selecting which servers reach the adapter.

Preserve the current conversion rules:

- stdio servers map to `command`, `args`, and explicit `env`;
- streamable HTTP servers without custom headers map to `url`;
- in-process Claude SDK servers are skipped;
- legacy SSE servers are skipped;
- unsupported header-bearing HTTP servers are skipped;
- names are sanitized to `[A-Za-z0-9_-]`;
- sanitized-name collisions are warned and skipped.

Do not inject `claudeclaw-dispatch` in either Codex adapter. The shared dispatch
authorization layer constructs it before adapter invocation when the turn is
eligible:

- command: current Node executable;
- script: `dist/dispatch-mcp-server.js`;
- explicit agent ID;
- explicit config and store directory;
- database encryption key only when configured;
- hive-read flag only when explicitly enabled;
- kill switch honored;
- only this injected server receives
  `default_tools_approval_mode = "approve"`.

If `claudeclaw-dispatch` is absent from `input.mcpServers`, the resulting Codex
configuration must not contain it. A tool-less turn must produce no
`mcp_servers` configuration at all.

`mcp_servers` covers caller-configured servers only. With ChatGPT
authentication, Codex 0.144.6 can independently materialize the host-owned
`codex_apps` MCP server. Restricted profiles must set
`features.apps = false`; an empty `mcp_servers` table alone is insufficient.

MCP definitions travel in the `config` object on `thread/start` and
`thread/resume`. They must not be placed on the App Server process command line.
The MCP set on each start or resume is authoritative and replaces the prior
turn's set. Omitting a server must remove it from effective thread
configuration before `turn/start`.
If the pinned protocol cannot atomically clear a prior MCP entry, the adapter
must start a clean thread or fail the turn. It must never inherit a broader MCP
set for the sake of session continuity.

Because App Server persists, MCP child processes may outlive one turn. They
remain scoped to the Codex thread/runtime configuration and are cleaned up when
Codex unloads the thread or App Server exits. ClaudeClaw must not create a second
dispatch MCP process outside Codex for the same thread.

## Notification routing

App Server notifications share one stdout stream. The client must route them by
`threadId` and `turnId`.

Starting a turn has a small race: notifications may arrive before the
`turn/start` response is processed. To avoid losing them:

1. Hold the per-thread mutex.
2. Register a provisional sink keyed by thread ID before sending `turn/start`.
3. Route the first `turn/started` notification to that sink.
4. Bind the returned turn ID to the sink.
5. Route subsequent notifications by the thread and turn pair.
6. Remove the sink only after terminal handling completes.

Notifications for unknown threads or completed turns are logged at debug level
and ignored.

## Event translation

### Session

`thread/start` response:

```typescript
{ type: "session", sessionId: response.thread.id }
```

For a successful resume, do not emit a redundant session event unless the
current engine behavior requires it. A stale-session fallback must emit the new
thread ID.

### Text

Map `item/agentMessage/delta` directly:

```typescript
{
  type: "text_delta",
  delta: params.delta,
  accumulatedText
}
```

Maintain latest full text by agent-message item ID from `item/started` and
`item/completed`. The item snapshots are authoritative for terminal text. Delta
accumulation is for live display and may not represent a later non-prefix
rewrite.

Multiple agent-message items are joined with a blank line for the final result.

### Commands

Preserve the current low-noise behavior:

- ignore routine successful command lifecycle events;
- on failed `commandExecution` completion, emit one `task_completed` progress
  event with `status: "failed"`;
- include a truncated command description and item ID;
- never include unbounded command output in user-visible progress.

### File changes

On completed `fileChange`:

- emit `task_completed`;
- use `kind: "edit"`;
- include changed paths as locations;
- include the App Server patch status;
- do not duplicate the patch body in progress output.

### MCP tools

For `mcpToolCall`:

- started -> `tool_active`;
- completed -> `task_completed`;
- description -> `<server>: <tool>`;
- preserve item ID and status.

### Web search

For `webSearch`:

- started -> `tool_active`;
- completed -> `task_completed`;
- use `kind: "search"`;
- truncate the query in the visible description.

### Plans

Map `turn/plan/updated` to:

```typescript
{
  type: "progress",
  progress: {
    type: "plan",
    description: params.explanation ?? "Plan updated",
    planEntries: params.plan.map(step => ({
      content: step.step,
      status: step.status
    }))
  }
}
```

Ignore raw reasoning deltas in the first release.

### Compaction

Treat either of these as compaction:

- a `contextCompaction` item;
- `thread/compacted`, retained for protocol compatibility.

Emit one normalized `compact` event per compaction. Use the latest known
pre-compaction token total when available and `null` otherwise. Mark
`AgentEngineUsage.didCompact = true`.

### Warnings and provisional errors

- log `warning`, `configWarning`, and deprecation notices;
- retain the first specific non-retrying error for terminal diagnosis;
- do not fail a turn on `error` when `willRetry === true`;
- `turn/completed` is authoritative;
- a completed turn must not be changed into a failure by a trailing warning or
  process wrapper error.

Unknown optional notifications are ignored. Unknown terminal statuses are
protocol errors.

## Usage accounting

App Server 0.144.6 emits:

```typescript
type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};
```

`total` is thread-cumulative, while ClaudeClaw needs per-turn usage. Calculate
per-turn usage without requiring transcript history:

1. On the first `thread/tokenUsage/updated` for the active turn, initialize the
   turn aggregate from `tokenUsage.last`.
2. Store `tokenUsage.total` as the previous thread total.
3. On later updates for that turn, add the non-negative component-wise delta
   between the new and previous thread totals.
4. Store the latest `last` breakdown for `lastCall*` fields.
5. Use `modelContextWindow` when present. Fall back to the local model context
   table only when App Server omits it.
6. If no usage notification arrives, emit zero token counts and flag a
   diagnostic warning.

Normalize OpenAI token accounting as today:

```text
inputTokens = inputTokensIncludingCache - cachedInputTokens
cacheReadInputTokens = cachedInputTokens
outputTokens = outputTokens
```

This preserves the downstream invariant that
`inputTokens + cacheReadInputTokens` equals total input context and prevents
double counting cached input.

Estimate cost using `estimateOpenAiCostUsd()` and the exact model returned by
the verified thread response. Subscription-auth turns still report the API-rate
estimate, matching current behavior.

At terminal completion:

1. emit one `usage` event;
2. emit `result` or `aborted` with the same usage object.

## Server-initiated requests

App Server can send requests that require a client response. Every request must
receive exactly one response, including unsupported methods.

### Structured user input

For `item/tool/requestUserInput`:

1. Find the active turn by thread and turn ID.
2. If `input.onAskUserQuestion` exists, translate questions into
   `AskUserQuestionRequest`.
3. Call the resolver.
4. Map answers back by App Server question ID.
5. Return an empty answer list for skipped questions.
6. Honor App Server's `autoResolutionMs` without extending the resolver beyond
   the caller's abort signal.

Question options map label and description directly. Secret questions must not
be logged. Free-form or `isOther` questions use the resolver's free-form answer
path when available.

If no resolver exists, return empty answers rather than leaving the server
request pending.

### Command and file approvals

`approvalPolicy: "never"` should prevent command and file approval requests. If
one arrives:

- log an invariant violation;
- respond `decline` or `cancel`;
- do not ask the Telegram user to expand permissions;
- continue only if App Server can complete under the existing policy.

This fail-closed response also applies to permission-profile approval requests.

### Dynamic tools, MCP elicitation, auth refresh, and attestation

The first release does not advertise dynamic tools or attestation capabilities.

- unexpected dynamic tool calls return `success: false`;
- unsupported MCP elicitation receives a declined/cancelled response;
- ChatGPT auth refresh requests are supported only if ClaudeClaw has an explicit
  token refresh provider;
- otherwise auth refresh receives a structured error and the turn fails
  visibly;
- every unsupported server request is answered with JSON-RPC method-not-found
  or a schema-valid negative response, whichever the protocol requires.

Never leave a server request unresolved until timeout.

## Cancellation

Cancellation is turn-scoped.

When `input.abortController.signal` fires:

1. If queued on a per-thread mutex, remove the queued invocation and yield
   `aborted`.
2. If `turn/start` has not returned but may have been sent, wait for its response
   or `turn/started`, obtain the turn ID, and immediately send
   `turn/interrupt`.
3. If the turn ID is known, send:

   ```json
   {
     "method": "turn/interrupt",
     "params": {
       "threadId": "<thread-id>",
       "turnId": "<turn-id>"
     }
   }
   ```

4. Continue draining notifications for up to 5 seconds.
5. On terminal `interrupted`, yield `aborted` with partial text, session ID, and
   usage.
6. If interruption times out, detach the caller, mark the transport unhealthy,
   and restart App Server after other active turns finish.

Do not kill the shared child to cancel one healthy turn. That would abort
unrelated missions and chats.

## Terminal results

Map `turn/completed.turn.status`:

| App Server status | Engine output |
|---|---|
| `completed` | `result`, `stopReason: "end_turn"` |
| `interrupted` | `aborted` |
| `failed` | visible error `result`, `stopReason: "error"` |
| `inProgress` | protocol error if received as terminal |

For failures, preserve the existing friendly classification:

- authentication;
- rate or usage limit;
- billing or quota;
- missing runtime;
- configuration failure;
- generic OpenAI request failure.

The adapter should continue surfacing failures through `text_delta` plus
terminal `result`, not a bare `error` event, because existing callers do not all
render engine `error` events.

## Failure and restart behavior

### Child exits while idle

- reject pending control requests;
- mark the client stopped;
- log exit code and signal;
- lazily start a fresh child on the next invocation.

### Child exits during active turns

- fail every active turn once;
- preserve partial text and usage;
- do not replay any prompt;
- release all per-thread locks;
- lazily restart on a later invocation.

### Protocol corruption

A malformed line, impossible envelope, response type mismatch, or duplicate
terminal event makes the connection unhealthy.

- stop sending new requests;
- fail pending and active operations;
- terminate the child;
- restart only on a later invocation;
- never replay an uncertain turn.

### Request timeout

A timed-out control request does not prove the server skipped it. Therefore:

- `initialize` timeout may restart immediately because no turn exists;
- `thread/start` or `thread/resume` timeout fails the invocation without
  replay;
- `turn/start` timeout is treated as an uncertain active turn and is not
  replayed;
- `turn/interrupt` timeout follows the cancellation recovery path.

### Restart budget

Allow at most one automatic restart attempt for startup before returning a
visible error. Do not create an unbounded crash loop inside an invocation.
Process supervision may restart the ClaudeClaw agent according to existing
deployment policy.

## Concurrency and backpressure

- One App Server process supports multiple active threads.
- One active normal turn is allowed per thread.
- Bound the total active OpenAI turn count with a configurable semaphore.
- Default concurrency should match the current agent process's practical
  mission concurrency, initially 8.
- Queue control writes through one ordered writer.
- Bound queued protocol messages and fail visibly if the client cannot keep up.
- Never drop terminal, usage, approval, or user-input messages.
- Low-value progress notifications may be coalesced only after parsing and
  routing, never at the transport layer.

## Security requirements

1. App Server uses stdio only.
2. No TCP listener or remote-control endpoint is opened.
3. `CODEX_HOME` remains isolated from the operator's global config.
4. `model_provider` is pinned to OpenAI.
5. `project_doc_max_bytes` remains zero.
6. login shells remain disabled.
7. API keys and token-like variables remain excluded from model-spawned shells.
8. caller-selected MCP servers remain the only external tools passed to Codex.
9. only an already-authorized ClaudeClaw dispatch MCP server is pre-approved.
10. requested and effective sandbox policies are compared before the turn.
11. a more permissive effective policy is always rejected.
12. a more restrictive but different effective policy is also rejected, because
    silently running read-only when writes were required creates false success.
13. protocol logs are redacted.
14. prompts, tool arguments, tool output, auth payloads, and MCP environment
    variables are not logged by default.
15. an App Server crash never triggers automatic prompt replay after
    `turn/start`.

## Observability

Add structured lifecycle logs:

- `codex_app_server_starting`;
- `codex_app_server_ready`;
- `codex_app_server_exit`;
- `codex_app_server_restart`;
- `codex_thread_started`;
- `codex_thread_resumed`;
- `codex_turn_started`;
- `codex_turn_completed`;
- `codex_turn_interrupted`;
- `codex_policy_mismatch`;
- `codex_protocol_error`;
- `codex_server_request_unexpected`.

Useful non-secret fields:

- process PID;
- Codex user agent/version;
- platform;
- request method and ID;
- thread ID and turn ID, truncated or hashed if logs leave the machine;
- provider and model;
- duration;
- requested and effective sandbox;
- requested and effective approval policy;
- reasoning effort;
- MCP server names only;
- input, cached-input, output, and context-window token counts;
- restart count;
- active and queued turn counts.

Do not label process startup latency as model latency. Track:

- cold App Server startup;
- thread start/resume latency;
- turn acknowledgment latency;
- time to first text;
- total turn duration.

## Configuration and rollout

Add:

```bash
# Phases 0 through 3: sdk is the default; app-server is an explicit opt-in.
# After Phase 4: app-server is the default; sdk is the temporary rollback.
CODEX_TRANSPORT=app-server

# Maximum concurrent native OpenAI turns per ClaudeClaw agent process.
CODEX_APP_SERVER_MAX_CONCURRENT_TURNS=8

# Existing trusted-operator Windows escape hatch remains unchanged.
CODEX_DANGER_WRITE=false
```

Rollout phases:

### Phase 0: close the existing authorization gap

This phase lands on the SDK path first and blocks every later phase.

- Extract one shared Codex capability-profile helper.
- Move dispatch authorization and MCP materialization ahead of both adapters.
- Remove implicit dispatch injection from `CodexSdkEngineAdapter`.
- Make tool-less SDK turns set `features.shell_tool = false`,
  `features.apps = false`, `web_search = "disabled"`, read-only sandbox,
  disabled network, and no caller-configured MCP servers.
- Make read-only-research turns set `features.apps = false`.
- Add call-shape policy tests for memory ingestion, warmup, untrusted voice,
  war room, chat, and missions.
- Keep the SDK adapter as default.

Exit gate:

- tool-less tests prove no dispatch, shell, web search, `codex_apps`, or
  unauthorized caller MCP capability is present;
- read-only-research tests prove host-owned apps are disabled while the
  read-only repository shell remains contained;
- a pinned-binary real-account probe proves tool-less suppresses shell, removes
  account-app enumeration, and leaves a test file byte-identical after a
  rejected patch attempt;
- normal authorized chat and mission turns still receive dispatch exactly once;
- the existing SDK test suite and caller integration tests pass.

### Phase 1: transport client

- Add the direct pinned `@openai/codex` dependency.
- Implement process lifecycle and JSONL request correlation.
- Implement initialization and shutdown.
- Add fake-server protocol tests.
- Do not place the new client on a production call path yet.
- Keep the SDK adapter as default.

Exit gate:

- protocol unit tests pass without a real account;
- schema compatibility passes against the exact pinned binary;
- process exit, malformed protocol, timeout, and backpressure behavior are
  deterministic.

### Phase 2: engine adapter

- Implement thread start/resume.
- Implement effective-policy verification.
- Consume the Phase 0 capability helper without reimplementing policy.
- Implement turn start, notification translation, usage, and terminal results.
- Implement cancellation and stale-session fallback.
- Implement server-initiated user input.
- Run the App Server adapter only when
  `CODEX_TRANSPORT=app-server`.

Exit gate:

- adapter unit tests pass for every capability profile;
- no App Server adapter code adds dispatch or any other MCP server;
- policy mismatches fail before `turn/start`;
- SDK remains the default and rollback behavior is unchanged.

### Phase 3: integration

- Exercise real Codex App Server using an isolated temporary `CODEX_HOME`.
- Verify existing SDK-created thread IDs resume through App Server.
- Verify chat, mission, memory-ingest, voice, and war-room call shapes.
- Verify multiple threads can run concurrently.
- Verify same-thread turns serialize.
- Verify one cancellation does not kill another turn.
- Verify an App Server crash does not replay a prompt.
- Verify every Phase 0 restricted caller remains restricted on App Server.
- Verify turn-budget exhaustion interrupts only its target turn.

Exit gate:

- SDK and App Server produce equivalent normalized results for supported call
  shapes;
- all P0 security cases pass on both transports;
- native Windows reports the actual sandbox limitation honestly, with no
  requested-policy label presented as applied policy.

### Phase 4: default switch

- Set App Server as the default native OpenAI transport.
- Keep `CODEX_TRANSPORT=sdk` as the documented rollback.
- Update dashboard and provider labels from "Codex SDK" to "Codex App Server".
- Keep provider type and stored sessions unchanged.

Exit gate:

- production configuration has completed the agreed soak period;
- session resume, cancellation, usage, memory, voice, mission, schedule, and
  war-room checks pass;
- the SDK rollback is documented and has been exercised once.

### Phase 5: SDK removal

After the soak period:

- remove `@openai/codex-sdk`;
- remove `CodexSdkEngineAdapter`;
- remove the rollback flag;
- retain the direct pinned `@openai/codex` dependency;
- retain schema compatibility tests for every Codex upgrade.

Do not combine Phase 0 with the App Server adapter change. The policy fix must
be independently reviewable and testable on the current production transport.
Do not combine Phase 4 and Phase 5. A default switch without a rollback window
is not an acceptable rollout.

## Files

### New

| File | Purpose |
|---|---|
| `src/agent-engine/codex-capability-policy.ts` | shared native Codex capability profiles and turn budgets |
| `src/agent-engine/codex-capability-policy.test.ts` | profile precedence and deny-wins tests |
| `src/agent-engine/codex-app-server-client.ts` | JSONL process and request/response transport |
| `src/agent-engine/codex-app-server-manager.ts` | singleton lifecycle, routing, concurrency, restart |
| `src/agent-engine/codex-app-server-protocol.ts` | narrow validated protocol surface |
| `src/agent-engine/codex-app-server-adapter.ts` | `AgentEngine` implementation |
| `src/agent-engine/codex-app-server-client.test.ts` | transport and process tests |
| `src/agent-engine/codex-app-server-adapter.test.ts` | event and policy mapping tests |
| `src/agent-engine/codex-app-server.integration.test.ts` | real pinned-binary integration tests |
| `scripts/check-codex-app-server-schema.ts` | generated-schema compatibility check |

### Modified

| File | Change |
|---|---|
| `src/agent-engine/types.ts` | carry the resolved Codex capability profile or transport-neutral inputs needed to derive it |
| `src/dispatch-registry.ts` | resolve only the dispatch MCP entries authorized for the current turn |
| `src/dispatch-tools.ts` | materialize provider-specific dispatch MCP entries behind the shared registry |
| `src/agent.ts` | merge authorized dispatch before `AgentEngine.invoke()` without transport-specific caller logic |
| `src/agent-engine/index.ts` | select App Server or temporary SDK rollback |
| `src/agent-engine/codex-sdk-adapter.ts` | remove implicit dispatch injection and consume the shared capability profile |
| `src/agent-engine/codex-sdk-adapter.test.ts` | prove restricted turns cannot regain shell, web, or dispatch |
| `src/memory-ingest.ts` | explicitly request the tool-less profile |
| `src/warroom-text-router.ts` | explicitly request the tool-less profile for routing |
| `src/warroom-text-orchestrator.ts` | explicitly request tool-less warmup and preserve war-room policy |
| `src/agent-engine/openai-pricing.ts` | accept App Server usage breakdown |
| `src/provider.ts` | preflight direct Codex package and App Server availability |
| `src/config.ts` | transport and concurrency configuration |
| `src/dashboard.ts` | provider label and diagnostic note |
| `.env.example` | document transport and concurrency |
| `package.json` | add exact `@openai/codex`, later remove SDK |
| `package-lock.json` | lock the binary and platform package |

Shared pure helpers should move out of the SDK adapter before both adapters use
them:

- isolated `CODEX_HOME` setup;
- environment scrubbing;
- MCP conversion;
- Codex capability-profile resolution;
- turn-budget resolution;
- reasoning mapping;
- sandbox, shell, network, and web-search mapping;
- friendly error classification;
- usage and pricing normalization;
- item-to-progress mapping where protocol shapes overlap.

## Test specification

### Phase 0 policy tests

These tests run against the SDK transport before App Server implementation:

- deny-all selects `tool-less`;
- an empty allowlist selects `tool-less`;
- deny-all wins over a conflicting allowlist;
- tool-less sets `features.shell_tool = false`;
- tool-less sets `features.apps = false`;
- tool-less sets `web_search = "disabled"`;
- tool-less requests read-only with network disabled;
- tool-less emits no caller-configured `mcp_servers` configuration;
- an empty caller `mcp_servers` configuration is not treated as proof that the
  host-owned apps surface is absent;
- tool-less and read-only-research expose no `codex_apps` account inventory;
- the pinned-binary control run produces command items while the tool-less run
  produces none for the same shell-seeking prompt;
- a rejected `apply_patch` leaves the target byte-identical even if no stream
  item reports the rejected attempt;
- memory ingestion receives no dispatch;
- warmup receives no dispatch;
- untrusted voice receives no dispatch;
- default-deny war-room turns receive no dispatch;
- an authorized normal chat turn receives dispatch exactly once;
- an authorized mission or schedule turn receives dispatch exactly once;
- only an already-authorized dispatch entry is pre-approved;
- disabling `Bash` by Claude tool name alone never claims to disable the Codex
  shell;
- a read-only-research profile may use shell for reads but cannot write;
- full-trust requires either explicit `allowDangerouslySkipPermissions` or
  `CODEX_DANGER_WRITE` for an eligible write turn, with deny-all and read-only
  policy taking precedence;
- exhausting a turn budget aborts the target turn without replay.

### Transport unit tests

- spawns one child for concurrent startup callers;
- sends `initialize` with both required capability fields, waits for the response,
  then sends `initialized` with no `params` member;
- correlates out-of-order responses;
- routes interleaved notifications for different threads;
- answers server-initiated requests;
- rejects malformed JSON;
- rejects invalid consumed envelopes;
- handles stderr without corrupting stdout;
- respects stdin backpressure;
- rejects pending requests on child exit;
- enforces request timeouts;
- shuts down without orphaning the child;
- restarts once after startup failure;
- does not restart or replay an uncertain active turn.

### Adapter unit tests

Port every behavior test from `codex-sdk-adapter.test.ts` that remains valid
after Phase 0, including:

- API-key and credential scrubbing;
- isolated `CODEX_HOME`;
- small and oversized personas as developer instructions;
- MCP mapping and collision handling;
- authorized dispatch MCP mapping and kill switch;
- dispatch hive-read governance;
- only dispatch MCP pre-approved;
- reasoning mapping and `auto` behavior;
- project-doc disablement;
- model-provider pinning;
- web-search mapping;
- deny-all and read-only policy mapping;
- workspace-write mapping;
- `CODEX_DANGER_WRITE`;
- authentication and quota error messages;
- stale-session fallback;
- no fallback after possible side effects;
- first-specific-error preservation;
- recovered provisional errors;
- partial-text cancellation.

Do not port implicit adapter dispatch injection. Replace that test with proof
that the adapter never adds an MCP server absent from `input.mcpServers`.

Add App Server-specific tests:

- effective read-only matches request;
- effective workspace-write matches request;
- effective danger-full-access matches request;
- requested workspace-write but effective read-only fails before `turn/start`;
- requested read-only but effective danger-full-access fails before
  `turn/start`;
- approval-policy mismatch fails before `turn/start`;
- unexpected instruction sources fail before `turn/start`;
- model-provider mismatch fails before `turn/start`;
- cwd mismatch fails before `turn/start`;
- notification-before-`turn/start`-response is not lost;
- two threads interleave correctly;
- two turns on one thread serialize;
- abort while queued never starts;
- interrupt affects only its target turn;
- a tool-less turn starts with shell, web search, caller MCP, and host-owned
  apps disabled;
- a read-only-research turn starts with host-owned apps disabled;
- a restricted turn does not inherit MCP configuration from a prior thread
  invocation;
- turn-budget exhaustion sends one interrupt and produces one terminal result;
- user-input requests invoke the resolver and receive answers;
- unexpected approval requests are declined;
- token usage aggregates across multiple model calls;
- cached input is not double counted;
- compaction emits once;
- terminal item snapshots override drifted text deltas.

### Integration tests

Run against the exact installed App Server binary:

1. Initialize and inspect the reported version and isolated home.
2. Start a text-only thread and receive a terminal result.
3. Resume that thread in a second invocation.
4. Resume a thread created by the SDK adapter, if the pinned runtime supports
   the same rollout format.
5. Run a read-only repository query and verify no writes occur.
6. Run a writable test in a temporary workspace and verify the effective policy
   before checking the file.
7. Inject a fake stdio MCP server and observe its lifecycle.
8. Run every Phase 0 caller shape and inspect the effective capability profile.
9. Cancel a long-running turn while another thread completes.
10. Kill App Server during a side-effecting turn and verify no replay.
11. Start a fresh turn after the crash and verify lazy recovery.

Real-account tests are opt-in and must not run in normal CI. Protocol tests use a
deterministic fake App Server child.

## Acceptance criteria

The migration is complete when:

1. Phase 0 policy tests pass on both SDK and App Server transports.
2. No Codex adapter adds dispatch or any other MCP server after caller
   authorization.
3. Tool-less turns have shell, web search, network, caller MCP, and host-owned
   apps disabled; any visible `apply_patch` tool remains contained by verified
   read-only enforcement.
4. `openai` uses App Server by default.
5. Exactly one App Server child exists per ClaudeClaw agent process under normal
   operation.
6. Existing provider-prefixed OpenAI sessions resume without a database
   migration.
7. All valid native OpenAI adapter behavior tests pass against the new adapter.
8. Chat, mission, schedule, memory, voice, and war-room call paths need no
   App Server-specific logic.
9. Text and progress stream incrementally.
10. Usage, cache, context, and estimated cost remain correct.
11. Same-thread turns serialize and different threads run concurrently.
12. Turn interruption does not kill unrelated work.
13. Turn budgets stop bounded callers without prompt replay.
14. Stale sessions fall back only before a turn may have started.
15. Large personas and MCP configuration do not travel through process
    arguments.
16. The effective sandbox is verified before every turn.
17. A requested/effective policy mismatch fails loudly and before side effects.
18. Native Windows `workspace-write` is not reported as safe when the host
    applies read-only or unrestricted access instead.
19. App Server crashes do not cause prompt replay.
20. The SDK rollback flag works during the soak period.
21. Dependency upgrades fail compatibility checks when required protocol fields
    change.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| App Server protocol is experimental | Exact dependency pin, narrow protocol layer, generated-schema compatibility test |
| Shared process failure affects concurrent turns | Fail active turns once, no replay, lazy restart |
| Notification routing races | Provisional thread sink plus turn binding |
| Same-thread concurrent turns conflict | Abort-aware per-thread FIFO mutex |
| Long-lived credentials or config become stale | Launch fingerprint and controlled restart |
| Host silently changes sandbox policy | Verify effective policy before `turn/start` |
| Persistent MCP children leak | Let Codex own thread MCP lifecycle and clean up on server exit |
| Protocol output contains secrets | Redacted structured logging, no payload logging at info |
| Usage is thread-cumulative | Per-turn delta accumulator keyed by turn ID |
| SDK and App Server session formats diverge | Integration test real resume; clean fallback only before turn start |
| Windows command-line limit | Send persona and MCP config in JSONL |
| Experimental user-input API changes | Isolate behind one translation function and schema test |
| Claude tool names do not exactly map to Codex tools | Resolve one of four Codex-native capability profiles and test effective controls |
| Adapter defaults reintroduce trusted MCP tools | Adapters may only consume the complete authorized MCP set |
| Restricted calls loop longer than intended | Apply explicit deadlines and tool-item budgets, then interrupt the target turn |
| Native Windows cannot provide contained writes | Fail policy verification, use the explicit full-trust escape hatch only for trusted operation, or run under WSL2 |
| Host-owned `codex_apps` appears despite empty caller MCP config | Set and verify `features.apps = false` for tool-less and read-only-research profiles |
| Rejected built-in tool attempts produce no stream item | Treat the runtime guard as detection only and verify read-only effects against the filesystem |

## Alternatives considered

### Keep the TypeScript SDK

Rejected as the primary path. It retains per-turn process startup, command-line
configuration limits, and weak visibility into applied runtime policy. It
remains temporarily as a rollback path.

### Use `codex exec --json` directly

Rejected. This recreates the SDK's one-process-per-turn model and still lacks a
shared bidirectional lifecycle.

### Use WebSocket App Server

Rejected for local production use. It adds a listening socket,
authentication, queueing, and network exposure without helping a same-process
host. Stdio is simpler and has a smaller attack surface.

### Run one App Server for the entire multi-agent installation

Rejected. A process per ClaudeClaw agent process preserves agent-specific
environment, identity, configuration, failure isolation, and supervision.

### Reimplement Codex with the Responses API

Rejected. ClaudeClaw would inherit responsibility for the tool loop, sandbox,
MCP, session history, compaction, approvals, skills, and Codex-specific runtime
behavior.

## Open questions

These do not block the initial implementation:

1. Should the manager proactively unload idle threads, or rely on App Server
   lifecycle and process restart?
2. Should structured user input become a stable required capability after the
   App Server API graduates from experimental?
3. Should future dynamic tools replace the dispatch MCP bridge for in-process
   ClaudeClaw actions?
4. Should App Server model discovery replace the dashboard's static OpenAI model
   list?
5. After policy verification is reliable, should the dashboard expose requested
   and effective sandbox values for diagnostics?

## References

- [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server.md)
- [Codex App Server source](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [Codex 0.144.6 feature registry](https://github.com/openai/codex/blob/rust-v0.144.6/codex-rs/features/src/lib.rs)
- [Codex 0.144.6 host-owned Apps MCP gate](https://github.com/openai/codex/blob/rust-v0.144.6/codex-rs/codex-mcp/src/mcp/mod.rs)
- [Codex TypeScript SDK source](https://github.com/openai/codex/tree/main/sdk/typescript)
- [Agent Provider Engine](sdk-engine.md)
- [In-process Dispatch RFC](in-process-dispatch.md)
