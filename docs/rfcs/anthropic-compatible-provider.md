---
Type: RFC
Author: Niko Rockensüß
Title: Z.ai GLM Provider (Anthropic-compatible endpoint)
Decision: Proposed
Decision date: —
Implementation: Complete (proposed for review)
Component: provider engine / third-party endpoints
Target baseline: Claude Code 2.1.237, Claude Agent SDK bundled runtime
Last updated: 2026-08-24
Last reviewed: 2026-08-24
---

# Z.ai GLM Provider (Anthropic-compatible endpoint)

## Summary

Add Z.ai GLM as a provider option: a turn runs through the real Claude Code
harness — subprocess, tools, MCP — against Z.ai's Anthropic-compatible
endpoint, **with the full Claude Code tool surface**. The built-in, tested
path is Z.ai and the default models are GLM (`glm-5.3[1m]`, fast slot
`glm-4.7`).

Internally the provider type is `anthropic-compatible`; that abstraction stays
(the engine speaks the wire protocol, not one vendor), and custom endpoints
using the same protocol remain available as advanced configuration.

No new adapter is introduced. The Claude SDK adapter already spawns the real
`claude` binary as a subprocess; this provider hands that subprocess a
different counterpart, a different credential, and a config directory of its
own. The entire provider-specific behaviour is one expression in
`claude-sdk-adapter.ts` plus two leaf modules.

## Motivation

ClaudeClaw today has no non-Anthropic provider that can use tools *and* MCP
servers. The nearest option, the OpenRouter v1 adapter, opens its system
prompt with:

> You have NO tools available — no shell, no file system, no APIs, no code
> execution.

That is a property of ClaudeClaw's adapter, not of the platform: the adapter
sends no tool definitions, does not handle `tool_calls`, and does not run a
multi-turn tool loop, while OpenRouter itself supports [standardized tool
calling](https://openrouter.ai/docs/guides/features/tool-calling). Meanwhile
`DEFAULT_OPENROUTER_MODEL` is already `z-ai/glm-4.5-air:free`, so the same
vendor is reachable today only in that chat-only form. Building the missing
agent loop against OpenRouter would mean owning a second harness; handing Z.ai
the existing Claude Code harness gets the tool surface without building one.

Anyone holding a GLM Coding Plan (or a custom endpoint — Moonshot, DeepSeek,
or a corporate Anthropic gateway — as advanced configuration) can run Claude
Code against it by setting `ANTHROPIC_BASE_URL` — a documented Claude Code
setting. This RFC brings that into ClaudeClaw with the containment an
unattended agent needs.

## Goals

- A third-party model gets the same tool surface as Claude, not a chat box.
- The credential reaches exactly one endpoint, chosen deliberately.
- No Anthropic credential can reach a third-party endpoint, in any spelling.
- An agent's `mcp_servers` allow-list becomes the complete, *enforced* tool
  surface for such a turn.
- The Claude path is bit-for-bit unchanged.

## Non-goals

- No dynamic model catalogue. The model is `.env` configuration.
- No cost comparison between vendors. See *Cost* below.
- No effort/thinking dials: `agent.ts` gates both on `provider.type ===
  'claude'`, so a third-party turn never sends them.
- No migration of any existing agent. This RFC adds a capability.

## Design

### One seam

`claude-sdk-adapter.ts` resolves the turn environment once, before `query()`:

```ts
const istCompat = input.provider?.type === 'anthropic-compatible';
if (istCompat && !compatProviderEnabled()) throw new CompatConfigError(…);
const turnEnv = istCompat
  ? buildCompatEnv(
      input.env ?? getScrubbedSdkEnv(),
      withConfigDir(getCompatConfig(input.provider.baseUrl), ensureCompatConfigDir(STORE_DIR)),
    )
  : input.env;
```

`sdkEnv` is built at five call sites (`agent.ts`, `agent-voice-bridge.ts`,
`memory-ingest.ts`, and both war-room files). **None of them is touched.** All
five already pass `provider` in the same `invoke()` call as `env`; the adapter
was provider-*blind*, not provider-*free*.

The `?? getScrubbedSdkEnv()` fallback is not optional. Callers may pass no
`env` at all; without it, such a turn would inherit the parent process's whole
environment — `CLAUDE_CODE_OAUTH_TOKEN` included — and hand it to a third-party
vendor.

### Environment: an allow-list

The first design copied `input.env` and deleted `ANTHROPIC_*` / `CLAUDE_CODE_*`.
That is not enough: everything else stays, and a turn can run `env` and return
the output as a tool result. So the environment is built up from an explicit
allow-list of unavoidable process plumbing (`PATH`, `HOME`, `TMPDIR`, locale,
Windows essentials, `NODE_EXTRA_CA_CERTS`) plus the deliberately-set
`ANTHROPIC_*` / `CLAUDE_CODE_*` values. Anything unknown does not exist for the
child.

Authentication uses `ANTHROPIC_AUTH_TOKEN` (bearer). `ANTHROPIC_API_KEY` is
never set, so no `x-api-key` path exists.

### Endpoint: allow-listed, or the turn aborts

The built-in default (z.ai) needs no configuration. Any other URL needs **both**
`ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS=true` **and** an entry in
`ANTHROPIC_COMPAT_ALLOWED_HOSTS`.

A URL failing any check **aborts the turn**. There is deliberately no fallback
to the default: falling back would send a key intended for vendor B to vendor A.
The safety path must not be the leak.

Also enforced: `https:` only (an allowed `http://` host would receive the bearer
token in cleartext); no userinfo in the URL; and URL and allow-list entries
canonicalized by the *same* routine — punycode, lowercase, default port
dropped, trailing dot removed — so a Unicode homoglyph host or a
differently-spelled entry cannot walk past the check.

Exactly one credential name may be set. `ZAI_API_KEY` and `GLM_API_KEY` are read
as aliases, but two names set at once is a configuration error, so a forgotten
old value can never quietly win a precedence contest. A quoted value or a
trailing `\r` is rejected with a message that says why — that exact mistake
produced a hintless HTTP 401 in the field.

### Tool surface: a generated config directory

**The heaviest finding of this work.** Measured on a developer machine
(2026-08-20): a `claude` subprocess with no `CLAUDE_CONFIG_DIR` loads the
machine's global configuration — **24 MCP servers, 273 tools**, including CRM,
mail accounts, WooCommerce, ownCloud and four SSH hosts. An agent's
`mcp_servers` allow-list does not bound that: the allow-list limits what
ClaudeClaw *hands over* and says nothing about what the CLI offers on its own.
`STRICTEST_CHAT_TOOL_PROFILE` has the same blind spot.

Measured in the same session:

| CLAUDE_CONFIG_DIR | MCP servers offered |
|---|---|
| unset | 24 (273 tools) |
| unset, `--setting-sources project,user`, cwd in repo | 24 (273 tools) |
| empty directory | 0 |
| empty directory + servers passed programmatically | exactly those |

So the directory does not need to *contain* the allow-list — it needs to contain
nothing, while ClaudeClaw keeps passing the allow-listed servers through the
SDK's `mcpServers` option as it already does. That is strictly better than
writing server definitions to disk: no credential is ever serialized.

The one enforcement step is per turn: strip any `mcpServers` block that has
appeared in the directory's `.claude.json`. Not a one-off, because `claude mcp
add` or a hand edit would otherwise plant a global server that every future
third-party turn inherits.

Side benefit: third-party sessions live in that directory, so such a turn never
touches `~/.claude` and cannot resume, or be resumed by, a Claude session.

**The same finding applies to Claude agents.** This change applies the
generated directory to the new provider only; correcting the inherited global
surface on the Claude path is left for separate tracking and deliberately not
changed here.

### Chat surface

`STRICTEST_CHAT_TOOL_PROFILE`, like every unvetted provider. Running the same
engine as Claude buys *enforceability* of an allow-list, not *judgement* about
what to do with a casual message. That judgement belongs to the model, and this
provider's model is by definition not Claude — and swappable per `.env`, so no
track record accrues to it either.

### Dispatch

Off by default; opt in with `ANTHROPIC_COMPAT_ALLOW_DISPATCH=true`. Even then
`hive_read` is withheld: it egresses everything every agent has written to the
shared mind. `EGRESS_GATED_TOOLS` previously existed only in
`dispatch-mcp-server.ts`, the stdio bridge — the in-process path never enforced
it, because until now only Claude used that path.

The withholding is done by caching **one server instance per policy**, not by
filtering a shared tool list. A Claude turn and a third-party turn are in flight
in the same process; mutating a shared list would let whichever ran last decide
the other's tools. A test drives 40 interleaved resolutions to pin this.

### Cost

The Claude SDK still reports a `total_cost_usd` for these turns — Anthropic list
pricing applied to somebody else's model. Measured: a two-word "PONG" turn
against GLM was reported as **$0.0219**.

A new `cost_source` column (`'provider' | 'unknown'`) records whether the figure
is money. Every cost aggregate filters on it, and the footer renders an em dash
rather than `$0.00`, because a turn nobody priced is not a free turn.

`cost_usd` itself stays `NOT NULL DEFAULT 0`: SQLite cannot drop a `NOT NULL`
constraint via `ALTER TABLE`, and rebuilding a live table carries more risk than
the marker column removes. Existing rows backfill to `'provider'`, which is
accurate — every row written before this column existed came from a runtime that
priced its own turns.

The migration uses the existing `addColumnIfMissing`, which already tolerates
the concurrent-startup race several agent services create (`busy_timeout = 5000`
plus "duplicate column" treated as a no-op).

## Security requirements

1. No Anthropic credential in a third-party subprocess, under any name.
2. No credential to a host that is not explicitly allow-listed; failure aborts.
3. No credential over cleartext transport.
4. No credential in any log or error message (central redaction).
5. Tool surface bounded by the agent's allow-list, verified against what the CLI
   actually offers, not what was passed in.
6. `hive_read` withheld under concurrency.
7. A kill switch checked *per turn*, so it takes effect without a restart.

## Data egress

Measured through a logging proxy (2026-08-20):

| Configuration | Hosts contacted |
|---|---|
| without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `api.anthropic.com` ×5, `api.z.ai` ×2 |
| with it (what this provider sets) | `api.z.ai` only |

Prompt content, tool definitions, tool results and file contents read during the
turn all go to the configured endpoint. That is inherent to the feature and is
why the endpoint is allow-listed rather than free-form.

## Credential and deployment boundary

ClaudeClaw is a single-owner, self-hosted fleet. The deployment owner supplies
their own Z.ai credential; ClaudeClaw does not share, proxy, resell, or provide
other users access to that quota. Personal and headless-agent use for the
owner is the intended scope.

One hard boundary holds regardless of configuration: **no Anthropic Max/Pro
OAuth credential may ever be sent to the compatible endpoint.** This is
enforced technically, not by convention — the environment allow-list in
`anthropic-compat-env.ts` means the subprocess inherits nothing the operator
did not explicitly pass, so a `CLAUDE_CODE_OAUTH_TOKEN` from the parent
process cannot reach the child.

## Legal position

Anthropic documents [LLM gateways](https://code.claude.com/docs/en/llm-gateway)
using supported API formats, and also states that it does not support routing
Claude Code to non-Claude models. Taken together, this provider is best
described as exactly that: a supported gateway mechanism, with non-Claude
model routing lying outside Anthropic product support.

Two facts differ from the default Claude path and are stated here rather than
left to be discovered:

- The login does not stay in `~/.claude/` — this provider deliberately uses
  its own config directory.
- Non-essential traffic is off. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is
  an [officially documented
  opt-out](https://code.claude.com/docs/en/data-usage), so setting it is an
  ordinary configuration choice, not a terms concern, and it does not weaken
  any existing position. The egress measurement above records what it changes
  and nothing more.

The user-facing provider is Z.ai (GLM) — the built-in, tested endpoint and
the default models. The type id stays `anthropic-compatible` as the internal
abstraction, which is what keeps custom endpoints a configuration option
rather than a second provider.

This is a judgement for the maintainer. It is raised here so it is a decision,
not a discovery.

## Files

**New (5)** `src/anthropic-compat-env.ts` · `src/anthropic-compat-config-dir.ts`
· three test files · this RFC.

**Changed** `provider.ts` · `provider-registry.ts` · `agent-engine/index.ts` ·
`agent-engine/claude-sdk-adapter.ts` · `agent-engine/types.ts` ·
`active-provider.ts` · `chat-tool-policy.ts` · `dispatch-tools.ts` ·
`dispatch-mcp-server.ts` · `db.ts` · `errors.ts` · `net-reachable.ts` ·
`scheduler.ts` · `cost-footer.ts` · `agent.ts` (one type field) · the four
`saveTokenUsage` call sites · `.env.example` · UI and script polish.

**Untouched** `security.ts`, the five `sdkEnv` construction sites, and every
Claude code path.

## Test specification

Unit (67 new assertions across five files): environment allow-list including a
marked secret that must not survive; bearer not `x-api-key`; all four model
slots carry the context suffix; `http://` rejected; foreign host without the
switch **aborts** rather than falling back; allow-list canonicalized like the
URL (case, port, punycode); two credential names rejected; generated directory
strips any `mcpServers`; engine resolves to the Claude adapter, not ACP;
registry experimental but not ACP-gated; system prompt modelled; dispatch absent
without opt-in; `hive_read` absent under 40 interleaved turns; `cost_source`
excluded from totals; migration idempotent; env-less caller leaks nothing;
Claude turn passes its env through by identity.

Live (against the real endpoint, disposable store and config): event contract
(`text`, `finalText`, `stopReason`, heartbeats) with a Claude control run
showing the identical event shape; a real tool call reading a file; the tool
surface as reported by the CLI's own init event (one server, none of CRM,
mail, SSH, ownCloud, WooCommerce); an environment proof executed *by the turn*
(`env | grep -c CLAUDE_CODE_OAUTH_TOKEN` → `0`, marked test secret → `0`); a
disallowed endpoint aborting before any request; dispatch absent.

## Acceptance criteria

1. `npm test` green, with `security.test.ts` and `enable-openai-gate.test.ts`
   unchanged.
2. `npm run typecheck`, `npm run build`, `npm run gen:cli-docs:check` clean.
3. The live checks above pass against a real endpoint.
4. No agent is switched to the provider by this change.

## Rollout and rollback

Nine agents run as services against one SQLite store, so anything that goes
wrong here goes wrong for all of them at once.

**Migration.** The `cost_source` column uses the existing `addColumnIfMissing`,
which already handles the concurrent-startup race these services create:
`busy_timeout = 5000` is set at open, and a losing racer's "duplicate column"
is swallowed as a no-op. No separate migrator step is needed, and no service
ordering is implied.

**Staged adoption.** The path is written down before anyone improvises one:

1. A disposable agent, chat only. Abort if the event contract differs from
   Claude's (missing `finalText`, missing `stopReason`, no heartbeats).
2. One non-critical agent, chat only, for a few days. Abort on tool
   misbehaviour or on a turn reaching a tool its allow-list does not name.
3. The same agent with a small number of scheduled tasks. Abort if the stall
   watchdog fires more often than it does for a Claude agent.
4. Wider use, one agent at a time.

**Rollback.** `ANTHROPIC_COMPAT_ENABLED=false` stops new turns on every agent
immediately — it is read per turn, not cached. To go further: pause the
agent's schedules, set its provider back to Claude in `agent.yaml`. The
migration stays; an older build simply ignores the extra column, and
`normalizeProviderType` returns `undefined` for the unknown provider type, so
such a build falls back to Claude rather than failing. That fallback is benign
but should be verified before any downgrade.

**Not built, deliberately.** A provider-scoped concurrency cap, a circuit
breaker, and per-provider dashboards were considered and left out: their right
thresholds are not knowable before the provider has run under real load, and
guessing them would add code that has to be re-tuned the first time it fires.
The kill switch covers the incident case today. Revisit when step 3 above has
produced actual numbers.

## Alternatives considered

**A dedicated HTTP adapter.** Rejected: it would reimplement tool-use,
streaming, MCP and permissions — the work the bundled Claude Code subprocess
already does — and would inherit the OpenRouter adapter's no-tools ceiling.

**Extending the OpenRouter adapter.** Rejected: the v1 adapter is deliberately
chat-only — no tool definitions, no `tool_calls` handling, no multi-turn tool
loop. Extending it to a full tool loop would mean building and owning a second
agent harness, exactly the work the Claude Code subprocess already does, while
changing an existing provider's contract. OpenRouter itself supports
[standardized tool calling](https://openrouter.ai/docs/guides/features/tool-calling),
so this is about where ClaudeClaw's agent loop lives, not about the platform.

**No config directory, rely on the tool policy.** Rejected on measurement: the
policy bounds what ClaudeClaw passes, not what the CLI offers. 24 servers and
273 tools were reachable.

**Writing the allow-listed servers into the generated directory.** Rejected once
measurement showed the empty directory suffices: writing them would serialize
credentials to disk for no gain.

**`cost_usd = NULL` for unpriced turns.** Rejected: SQLite cannot drop the
`NOT NULL` constraint without rebuilding a live table. The `cost_source` marker
achieves the same guarantee — unpriced turns never enter a total — without that
risk.

## Known limitations

- `src/email-pre-triage.ts:462` pins Haiku on Anthropic. Switching an agent to
  save money does not affect that path.
- `src/oauth-health.ts:98` still checks the Anthropic login regardless of the
  active provider.
- No vendor cost comparison exists, by design.
- The credential and the enablement live in `.env` (per machine, not synced)
  while `agent.yaml` is synced, so an agent can be pointed at this provider on
  one machine and be keyless on the other. `npm run status` names the resolved
  endpoint, and a missing key fails loudly rather than silently.
