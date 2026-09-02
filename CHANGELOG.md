# Changelog

All notable changes to ClaudeClaw will be documented here.

From v1.2.0 onward this file is generated from Conventional Commit history with
[git-cliff](https://git-cliff.org). Do not hand-edit it. See CONTRIBUTING.md.

## [1.9.0] - 2026-09-02

### Features

- **models:** Add Claude Fable 5.1 support ([#262](https://github.com/earlyaidopters/claudeclaw-os/pull/262))
- Mattermost messenger adapter — self-hosted team chat with per-channel agent routing ([#112](https://github.com/earlyaidopters/claudeclaw-os/pull/112))
- **codex:** Uplift 0.149.1 and gate Windows containment ([#251](https://github.com/earlyaidopters/claudeclaw-os/pull/251))
- **agents:** Add headless worker runtime ([#243](https://github.com/earlyaidopters/claudeclaw-os/pull/243))
- **provider:** Add Z.ai GLM support through Claude Code harness ([#244](https://github.com/earlyaidopters/claudeclaw-os/pull/244))
- Add task and job execution banners ([#242](https://github.com/earlyaidopters/claudeclaw-os/pull/242))

### Bug Fixes

- **agents:** Resolve main's PID file the way the runtime writes it ([#257](https://github.com/earlyaidopters/claudeclaw-os/pull/257))
- **db:** Survive concurrent migrations on first boot ([#256](https://github.com/earlyaidopters/claudeclaw-os/pull/256))
- **uninstall:** Resolve CLAUDECLAW_CONFIG the way the runtime does before rm -rf ([#254](https://github.com/earlyaidopters/claudeclaw-os/pull/254))
- **launchd:** Keep generated plists valid across Node upgrades ([#253](https://github.com/earlyaidopters/claudeclaw-os/pull/253))
- **launchd:** Keep user-created agents when reinstalling services ([#250](https://github.com/earlyaidopters/claudeclaw-os/pull/250))
- **bot:** Log outbound file deliveries ([#232](https://github.com/earlyaidopters/claudeclaw-os/pull/232))
- **codex:** Support GPT-5.6 through maintained ACP adapter ([#245](https://github.com/earlyaidopters/claudeclaw-os/pull/245))
- **missions:** Add bounded self-continuation ([#241](https://github.com/earlyaidopters/claudeclaw-os/pull/241))

### Documentation

- **migrations:** Align skill with release workflow ([#260](https://github.com/earlyaidopters/claudeclaw-os/pull/260))
- **node:** Update supported Node baseline to 22 and 24 LTS, drop EOL Node 20 ([#209](https://github.com/earlyaidopters/claudeclaw-os/pull/209))

### Testing

- **launchd:** Skip macOS installer suite on Windows ([#259](https://github.com/earlyaidopters/claudeclaw-os/pull/259))

## [1.8.5] - 2026-08-15

### Bug Fixes

- **orchestrator:** Route failed delegations to failure status ([#239](https://github.com/earlyaidopters/claudeclaw-os/pull/239))
- **deps:** Patch hono server and js-yaml advisories ([#240](https://github.com/earlyaidopters/claudeclaw-os/pull/240))
- **deps:** Remediate compatible audit findings in hono and ip-address ([#204](https://github.com/earlyaidopters/claudeclaw-os/pull/204))
- **runtime:** Use sliding and absolute turn deadlines ([#222](https://github.com/earlyaidopters/claudeclaw-os/pull/222))
- **missions:** Release the gather join when the last child is cancelled ([#237](https://github.com/earlyaidopters/claudeclaw-os/pull/237))
- **scheduler:** Route failed agent runs to failure status ([#236](https://github.com/earlyaidopters/claudeclaw-os/pull/236))
- **signal:** Resolve models from active provider ([#219](https://github.com/earlyaidopters/claudeclaw-os/pull/219))
- **health:** Align documented Supabase env names ([#235](https://github.com/earlyaidopters/claudeclaw-os/pull/235))
- **deps:** Upgrade better-sqlite3 for Node 24 ([#234](https://github.com/earlyaidopters/claudeclaw-os/pull/234))

### Documentation

- **readme:** Point persona instructions at agents/main/CLAUDE.md instead of the removed repo-root file ([#210](https://github.com/earlyaidopters/claudeclaw-os/pull/210))

## [1.8.4] - 2026-08-12

### Bug Fixes

- **missions:** Stop recursive mission handbacks ([#231](https://github.com/earlyaidopters/claudeclaw-os/pull/231))
- **launchd:** Keep generated plists out of repo ([#220](https://github.com/earlyaidopters/claudeclaw-os/pull/220))
- **agents:** Start agents via detached child on Linux ([#228](https://github.com/earlyaidopters/claudeclaw-os/pull/228))
- **deploy:** Preserve per-agent bot tokens across installer re-runs ([#229](https://github.com/earlyaidopters/claudeclaw-os/pull/229))
- **status:** Report effective provider ([#221](https://github.com/earlyaidopters/claudeclaw-os/pull/221))
- **missions:** Include task id in execution prompt ([#218](https://github.com/earlyaidopters/claudeclaw-os/pull/218))
- **shutdown:** Tolerate messenger stop failures ([#217](https://github.com/earlyaidopters/claudeclaw-os/pull/217))
- **claude:** Recover unresumable saved sessions instead of replying "Done." ([#212](https://github.com/earlyaidopters/claudeclaw-os/pull/212))
- **setup:** Assign CLAUDECLAW_OWNER_NAME after env is declared ([#205](https://github.com/earlyaidopters/claudeclaw-os/pull/205))

## [1.8.3] - 2026-08-04

### Features

- **deploy:** Set CLAUDECLAW_OWNER_NAME, and document OPENAI_API_KEY

### Bug Fixes

- **health:** Ignore supabase link artifacts under agents/health/supabase ([#199](https://github.com/earlyaidopters/claudeclaw-os/pull/199))
- **docs:** Correct App Server reasoning config path ([#202](https://github.com/earlyaidopters/claudeclaw-os/pull/202))
- **codex:** Fail closed on trusted MCP collisions ([#201](https://github.com/earlyaidopters/claudeclaw-os/pull/201))
- **deps:** Declare @modelcontextprotocol/sdk as a direct dependency ([#184](https://github.com/earlyaidopters/claudeclaw-os/pull/184))
- **deploy:** Re-own install dir on RUN_USER change, report real clone errors
- **deploy:** Make migrations safe to run unattended
- **deploy:** Restart the service so re-running actually deploys the rebuild
- **deploy:** Apply migrations so a fresh v1.8 install can start

### Documentation

- **security:** Draft untrusted content provenance RFC ([#203](https://github.com/earlyaidopters/claudeclaw-os/pull/203))
- **deploy:** Rename Day-2 section and fix stale branch guidance
- Organize RFC lifecycle and documentation ([#183](https://github.com/earlyaidopters/claudeclaw-os/pull/183))

## [1.8.2] - 2026-08-01

### Bug Fixes

- Warn on divergent cwd store env ([#182](https://github.com/earlyaidopters/claudeclaw-os/pull/182))
- **deps:** Remediate compatible audit findings ([#181](https://github.com/earlyaidopters/claudeclaw-os/pull/181))
- **test:** Make Codex path assertions portable ([#180](https://github.com/earlyaidopters/claudeclaw-os/pull/180))
- **model:** Sync reset and runtime state ([#179](https://github.com/earlyaidopters/claudeclaw-os/pull/179))

### Documentation

- **release:** Upgrade applies to all installs + consolidated Codex .env block
- **release:** Restore v1.8.0 upgrade steps (download, install, migrate, build, restart)
- **release:** Drop redundant App Server/SDK line from v1.8.0 known limitations
- **release:** Finalize v1.8.0 notes (transports, sandbox, hive-read governance, Windows write access)
- **release:** Expand v1.8.0 notes (intro + Codex v0 framing + detail)

## [1.8.1] - 2026-07-31

### Bug Fixes

- **warroom:** Correct tool/MCP policy semantics and cover with tests ([#178](https://github.com/earlyaidopters/claudeclaw-os/pull/178))

### Documentation

- **release:** Clarify v1.8.0 upgrade callout

## [1.8.0] - 2026-07-31

### Features

- **telegram:** Switch native OpenAI models
- **dashboard:** Enrich the sidebar runtime summary
- **telegram:** Collapse repeated activity rows and keep the turn timer alive
- **telegram:** Unify Telegram streaming activity
- **setup:** Promote native OpenAI and prepare v1.8.0 notes
- **runtime:** Inject resolved model identity per turn
- **model:** Refresh model catalog and runtime controls
- **codex:** Audit the inbound App Server schema surface
- **codex:** Share the isolated CODEX_HOME credential lifecycle
- **codex:** Enforce turn budgets and cap process concurrency
- **codex:** Answer server-initiated requests instead of shrugging at them
- **config:** Default STREAM_STRATEGY to global-throttle, drop dead single-agent-only
- **telegram:** In-place streaming progress with an elapsed clock
- **codex:** Surface reasoning and readable tool progress from the App Server adapter
- **codex:** App Server manager + engine adapter behind a transport flag (Phase 2b)
- **codex:** Effective-policy verification for App Server threads (Phase 2a)
- **codex:** App Server transport client + pinned schema drift check (Phase 1)
- **chat:** Align native Codex (openai) chat policy with Claude (full)
- **chat:** Grant native Codex (openai) full write/exec chat policy
- **codex:** Inject claudeclaw-dispatch stdio server on Codex turns (Part B)
- **provider:** Initial cut of native OpenAI provider support via Codex SDK
- **dispatch:** Stdio dispatch MCP server bridge (Part A)
- **dispatch:** In-process dispatch API for mission/schedule/hive CLIs

### Bug Fixes

- **warroom:** Configure owner speaker identity
- **config:** Migrate Windows config path quoting
- **cli:** Load repo environment outside checkout
- **runtime:** Synchronize agent settings and hide Codex windows
- **claude:** Stream assistant text across the whole turn
- **dashboard:** Refine dashboard agent card controls
- **signal:** Stop reporting failed completions with a success glyph
- **codex:** Report a non-zero command exit as an observation, not a verdict
- **config:** Make agent templates provider-neutral
- **telegram:** Render a notice completion as advisory, not a success
- **codex:** Make launch-environment rotation drain instead of overlap
- **codex:** Carry trusted MCP provenance into App Server thread config
- **codex:** Establish cancellation instead of assuming it
- **codex:** Make an unroutable consumed notification a protocol fault
- **codex:** Quarantine the connection when turn/start's outcome is unknown
- **codex:** Make the resumed thread's MCP set authoritative before turn/start
- **codex:** Hold the per-thread lock across resume, verification and the turn
- **telegram:** Fold successful tool completions into the streaming working line
- **setup:** Ask main agent name before provider write so it isn't skipped
- **setup:** Resolve config dir before provider setup to avoid orphaned default

### Security

- **codex:** Authorize dispatch above the engine seam + shared capability profiles

### Refactor

- **providers:** Clarify Codex taxonomy and fail closed on provider writes
- **chat:** Shared per-provider chat tool policy module

### Documentation

- **telegram:** Advertise model reset
- **readme:** Tighten OpenAI/Codex provider section

## [1.7.1] - 2026-07-23

### Bug Fixes

- Reject unknown --flags instead of swallowing them ([#162](https://github.com/earlyaidopters/claudeclaw-os/pull/162)) ([#164](https://github.com/earlyaidopters/claudeclaw-os/pull/164))
- Stamp absolute PROJECT_ROOT into injected CLI index ([#157](https://github.com/earlyaidopters/claudeclaw-os/pull/157)) ([#163](https://github.com/earlyaidopters/claudeclaw-os/pull/163))
- Reconcile specialist agent seeds with the template (file-send + handback sections, hive-cli over raw sqlite3, drift guard) ([#166](https://github.com/earlyaidopters/claudeclaw-os/pull/166))

### Security

- Harden War Room bind, log redaction, exfil guard, migration guard (#160, #161) ([#165](https://github.com/earlyaidopters/claudeclaw-os/pull/165))

## [1.7.0] - 2026-07-22

### Features

- Signal support via signal-cli + AskUserQuestion bridge ([#111](https://github.com/earlyaidopters/claudeclaw-os/pull/111))

## [1.6.1] - 2026-07-21

### Bug Fixes

- Delegate with the target agent's provider, not the caller's ([#158](https://github.com/earlyaidopters/claudeclaw-os/pull/158))

## [1.6.0] - 2026-07-21

### Features

- Reconcile agent id/display-name/alias routing ([#154](https://github.com/earlyaidopters/claudeclaw-os/pull/154))

## [1.5.1] - 2026-07-18

### Bug Fixes

- End SQLITE_BUSY starvation + normalize CLI invocation (Closes #155) ([#156](https://github.com/earlyaidopters/claudeclaw-os/pull/156))

### Features

- CLI-awareness descriptor registry + generated reference + prompt-injected index ([#153](https://github.com/earlyaidopters/claudeclaw-os/pull/153))

## [1.5.0] - 2026-07-17

### Bug Fixes

- Always sandbox CLAUDECLAW_CONFIG so the suite can't poison a real config ([#149](https://github.com/earlyaidopters/claudeclaw-os/pull/149))
- Always write main's agent.yaml to CLAUDECLAW_CONFIG ([#147](https://github.com/earlyaidopters/claudeclaw-os/pull/147))

### Documentation

- Drop redundant "RFC:" heading prefix; correct rfc-sdk-engine authorship
- Add Agent Awareness & Deterministic Comms RFC + normalize RFC frontmatter

### Features

- Token/cost observability — Foundation (cache hit-rate, /savings, dashboard, telemetry) ([#143](https://github.com/earlyaidopters/claudeclaw-os/pull/143))
- Deterministic comms + gather orchestration (Refs #141, Tiers 2-3) ([#144](https://github.com/earlyaidopters/claudeclaw-os/pull/144))
- Agent self-location + Telegram command-scope self-heal (Tier 1) ([#142](https://github.com/earlyaidopters/claudeclaw-os/pull/142))
- Bootstrap main's external agent.yaml on boot ([#148](https://github.com/earlyaidopters/claudeclaw-os/pull/148)) ([#150](https://github.com/earlyaidopters/claudeclaw-os/pull/150))
- Handle media groups (multiple photos/files in one turn) ([#124](https://github.com/earlyaidopters/claudeclaw-os/pull/124))

## [1.4.1] - 2026-07-11

### Bug Fixes

- Auto-fall-back to system claude on non-AVX Intel Macs ([#132](https://github.com/earlyaidopters/claudeclaw-os/pull/132))
- Capture AskUserQuestion Other reply outside the message queue ([#131](https://github.com/earlyaidopters/claudeclaw-os/pull/131))
- Copy-fallback for AGENTS.md on symlink-restricted platforms ([#140](https://github.com/earlyaidopters/claudeclaw-os/pull/140))
- Refresh lockfile and add security overrides ([#139](https://github.com/earlyaidopters/claudeclaw-os/pull/139))
- Remove root AGENTS.md symlink orphaned by #64 ([#138](https://github.com/earlyaidopters/claudeclaw-os/pull/138))
- Route claude CLI off the unrunnable SDK binary on NixOS
- Write vite manualChunks in function form for rolldown compatibility ([#137](https://github.com/earlyaidopters/claudeclaw-os/pull/137))

### Documentation

- Add respin-session, token-cost observability, and agent-identity RFCs ([#133](https://github.com/earlyaidopters/claudeclaw-os/pull/133))

## [1.4.0] - 2026-07-03

### Bug Fixes

- Five Linux/systemd/VPS setup bugs (dashboard bind, warroom key, root sandbox, kill loop) ([#129](https://github.com/earlyaidopters/claudeclaw-os/pull/129))
- Accept custom Claude model ids, show persisted model, extend /model ([#127](https://github.com/earlyaidopters/claudeclaw-os/pull/127))
- Root storage at CLAUDECLAW_CONFIG, not a hardcoded ~/.claudeclaw ([#126](https://github.com/earlyaidopters/claudeclaw-os/pull/126))

### Documentation

- Focus CONTRIBUTING on PR-title convention, drop destructive git-cliff -o

### Features

- One-command VPS installer with Tailscale-private dashboard ([#128](https://github.com/earlyaidopters/claudeclaw-os/pull/128))

## [1.3.2] - 2026-07-01

### Bug Fixes

- Bump default model to gemini-2.5-flash ([#125](https://github.com/earlyaidopters/claudeclaw-os/pull/125))

## [1.3.1] - 2026-07-01

### Features

- Upgrade claude-agent-sdk ^0.3.159 -> ^0.3.197

### Testing

- Restore WARROOM_TMP_DIR in config mock

## [1.3.0] - 2026-07-01

### Bug Fixes

- Surface point-in-time context usage from usage_update (partial #70) ([#121](https://github.com/earlyaidopters/claudeclaw-os/pull/121))
- Classify unauthenticated Claude exit as auth, not retryable crash ([#48](https://github.com/earlyaidopters/claudeclaw-os/pull/48)) ([#120](https://github.com/earlyaidopters/claudeclaw-os/pull/120))
- Faster mid-turn heartbeat for ACP providers ([#86](https://github.com/earlyaidopters/claudeclaw-os/pull/86)) ([#119](https://github.com/earlyaidopters/claudeclaw-os/pull/119))
- Move IPC scratch from /tmp to store/tmp (cross-platform) ([#82](https://github.com/earlyaidopters/claudeclaw-os/pull/82)) ([#117](https://github.com/earlyaidopters/claudeclaw-os/pull/117))
- Backfill chat history on SSE reconnect — SPA + legacy ([#50](https://github.com/earlyaidopters/claudeclaw-os/pull/50)) ([#116](https://github.com/earlyaidopters/claudeclaw-os/pull/116))
- Stabilize Gemini Live model, self-heal on fatal, drop deprecated kwargs ([#39](https://github.com/earlyaidopters/claudeclaw-os/pull/39)) ([#115](https://github.com/earlyaidopters/claudeclaw-os/pull/115))
- Add 'google' pipecat extra to requirements (Gemini Live) ([#110](https://github.com/earlyaidopters/claudeclaw-os/pull/110))

### Documentation

- Align ToS compliance answer to "Yes" ([#42](https://github.com/earlyaidopters/claudeclaw-os/pull/42)) ([#123](https://github.com/earlyaidopters/claudeclaw-os/pull/123))

### Features

- Add Health Coach agent blueprint with WHOOP integration ([#114](https://github.com/earlyaidopters/claudeclaw-os/pull/114))
- Ad-hoc HTML report surface + SVG diagram generator ([#103](https://github.com/earlyaidopters/claudeclaw-os/pull/103))
- Interactive:false for automation-only agents ([#109](https://github.com/earlyaidopters/claudeclaw-os/pull/109))
- CLAUDECLAW_STORE_DIR env override for STORE_DIR ([#108](https://github.com/earlyaidopters/claudeclaw-os/pull/108))
- Export migrateDbFile() to upgrade an arbitrary db file to current schema ([#107](https://github.com/earlyaidopters/claudeclaw-os/pull/107))

### Testing

- Require explicit opt-in for real Telegram API tests ([#85](https://github.com/earlyaidopters/claudeclaw-os/pull/85)) ([#118](https://github.com/earlyaidopters/claudeclaw-os/pull/118))

## [1.2.0] - 2026-06-21

Rolls up everything since v1.1.1: **215 commits across 46 PRs** (77 features, 77 fixes,
plus security hardening). Highlights: native OpenRouter engine and config-driven providers,
HTTP/SSE MCP support, Mission Control v2 frontend rewrite, 3D Hive Mind visualization,
display-names architecture, scheduled-task editing, text War Room, kill-switch toggles,
and Agent SDK 0.2.50 → 0.3.159. No breaking changes. The dated sections below are the
development log accumulated for this release.

## 1.2.0 — dev log (2026-05-01)

### Fixed — per-agent provider selection
- Dashboard-created agents can now choose a full provider config at
  creation time instead of being limited to Claude model selection.
  The wizard supports Claude, OpenCode, Gemini, Codex, and custom ACP
  providers, including provider model, speed/runtime mode, thinking mode,
  and custom ACP command arguments.
- Agent cards now expose a provider editor so existing agents can switch
  provider/model/modes after creation. Sub-agent changes still surface the
  required restart prompt because agent config is loaded at process start.
- `/provider` now reports provider-specific model status for Codex,
  Gemini, OpenCode, and custom ACP providers instead of showing the
  misleading OpenCode fallback text for every non-Claude provider.
- Agent startup logs include the loaded provider config to make launchd
  and scheduled-task debugging clearer.

### Fixed — agent file-send awareness
- New agents created via the dashboard wizard now always include the
  `[SEND_FILE:...]` / `[SEND_PHOTO:...]` marker documentation in their
  CLAUDE.md, regardless of which template the user picked. The plumbing
  in `src/bot.ts:637` (`extractFileMarkers`) has always supported these
  for every agent — newly-created agents just didn't know the syntax
  existed and would say things like "I can't send files" when asked to
  attach an image they'd just generated.
- **Action required for existing agents:** after pulling this commit,
  run `bash scripts/upgrade-agent-claude-md.sh` once. It idempotently
  appends the section to any `agents/<id>/CLAUDE.md` (in either the
  repo or `$CLAUDECLAW_CONFIG`) that doesn't already mention
  `SEND_FILE`/`SEND_PHOTO`. Safe to re-run; skips already-patched
  files. Agents pick up the change on their next turn — no restart
  needed.

## 1.2.0 — dev log (2026-04-29)

### Added — text war room
- Multi-agent text war room (`/warroom/text`) with real-time SSE streaming, sticky-addressee follow-ups, `/standup`, `/discuss`, ack short-circuit, and per-meeting persistence.
- Tool-call disclosure UX in agent bubbles — collapsed by default (`▸ N tool calls`), click to expand for full args + results.
- Prompt-injection delimiters wrapping every retrieved-from-DB block in war-room prompt assembly.

### Added — security hardening
- Centralized kill switches with `requireEnabled()` enforced at every LLM-spawning boundary (`runAgent`, war-room orchestrator, router, gate, voice bridge, Gemini `generateContent`). Refusal counters surfaced via `/api/health.killSwitchRefusals`.
- Single dashboard mutation middleware that returns 503 on every non-GET when `DASHBOARD_MUTATIONS_ENABLED=false`. Replaces scattered per-route checks.
- War-room tool boundary: default-deny side-effect tools (`Bash`, `Write`, `Edit`, `Skill`, all MCPs) unless agent explicitly opts in via `warroom_tools:` in `agent.yaml`. `permissionMode: 'default'` (no bypass). Per-turn 8-tool budget. Audit log writes for every tool call.
- CSRF middleware rejects cross-origin mutating requests outside the allowlist (`localhost`, configured `DASHBOARD_URL`).
- Response headers: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on `/api/`.
- Least-privilege SDK env scrubbing (`getScrubbedSdkEnv()`) drops `DASHBOARD_TOKEN`, third-party API keys, and pattern-matched secret-shaped vars before subprocess inheritance.
- Default bind address `127.0.0.1` (was `0.0.0.0`); `DASHBOARD_BIND` env opt-in for LAN exposure.
- Pre-migration backups written to `store/claudeclaw.db.pre-<version>.bak` with `chmod 0600`, 3-backup rotation, gitignored.

### Added — ops & reliability
- Memory ingestion swapped from Gemini to Claude Haiku via OAuth (no extra API key); Gemini retained as fallback. Quota-aware backoff (5-min cooldown on 429).
- `pruneWarRoomMeetings(retentionDays=90)` integrated into the daily decay sweep.
- `endTextMeeting` now clears SDK sessions tied to the meeting.
- `/api/warroom/voices/apply` 3s cooldown to prevent respawn-storm during voice config edits.
- Voice war room `agent_error` and `hand_down` RTVI frames on OAuth/timeout/bridge failures so the browser surfaces real reasons instead of vague Gemini stutter.

### Added — observability
- `/api/health` exposes `killSwitches`, `killSwitchRefusals`, `memoryIngestion`, `warroom.textOpenMeetings`.
- Audit log writes for every war-room tool call (table existed; now populated).
- Router classifier logs elapsed_ms + outcome (success / parse_failure / timeout_or_error) on every call.

### Tests
- `warroom-text-events.test.ts` (MeetingChannel + finalizedTurns guard).
- `warroom-text-db.test.ts` (saveWarRoomConversationTurn idempotency, multi-agent dedup, memory strict-agent isolation, retention prune).
- `kill-switches.test.ts` extended with `requireEnabled` + refusal-counter coverage.
- All 368+ tests pass.

### Docs
- `docs/release-smoke.md` — release runbook (10-step).
- `docs/incident-runbook.md` — kill switch playbook with symptom → action mapping.
- `docs/warroom-mcp-policy.md` — per-agent tool/MCP allowlist + opt-in via `agent.yaml`.
- `docs/redteam-results.md` — adversarial test results (5/5 PASS).
- `docs/voice-smoke-results.md` — voice fix verification.
- `scripts/audit-profile.sh` — isolated red-team harness with canary `.env`, fail-closed gates.
- `scripts/pre-commit-check.sh` — personal-reference scrub.

### Closes Codex adversarial review high findings
- LLM kill switch now enforced at every boundary, not just one route.
- Dashboard mutation kill switch enforced via single middleware on all non-GET routes.
- War-room tool authority restricted to per-agent allowlist; `permissionMode: 'bypassPermissions'` removed from war-room calls.

## [v1.1.1] - 2026-03-06

### Added
- Migration system with versioned migration files
- `add-migration` Claude skill for scaffolding new versioned migrations
