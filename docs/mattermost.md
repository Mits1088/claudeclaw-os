# Mattermost Messenger Adapter (single-operator gateway)

The Mattermost adapter is a **single-operator gateway**: exactly ONE configured
Mattermost user — the owner — may invoke ClaudeClaw, from any channel the bot is
a member of (or a DM). Every other user is rejected before routing, state
access, attachments, commands, or tools.

Why the gateway is single-operator: ClaudeClaw runs agent turns on the
**owner's personal provider credentials** (Claude
subscription etc.). Admitting other channel members would let them consume the
owner's subscription, read agent context, and invoke tools under the owner's
account. The gateway fails closed — an unset owner is a boot error, never an
implicit allow-all.

What the single operator keeps: self-hosted Mattermost messages and history,
channel-organized agents, files, threads, audit history, and no Telegram/Signal
dependency. Colleagues can see agent output in channels, but only the configured
owner can drive the agents. Prompts and accepted attachments may be sent to the
agent's configured model provider for processing.

Run ClaudeClaw as a **single-operator gateway** on your own [Mattermost](https://mattermost.com)
server. One bot account serves many channels, and each channel can route to a
different agent while the owner remains the only authorized operator.

This is the open-source Slack-alternative counterpart to the Telegram (default)
and Signal (#111) adapters, built on the same shared `bootMessenger()` boot path.
Select it with `MESSENGER_TYPE=mattermost`.

---

## Why Mattermost?

- **Self-hosted history** — Mattermost messages and history remain on your
  Mattermost infrastructure. Prompts and accepted attachments may be sent to
  the agent's configured model provider for processing.
- **Single-operator access** — only the configured owner can drive agents;
  colleagues may still see agent output posted into shared channels.
- **Per-channel agents** — `#support` → your comms agent, `#ops` → your ops
  agent, etc. Each channel is its own isolated conversation (separate memory,
  separate session).
- **Full audit trail** — every message is logged on your server; you control
  retention and access.

---

## Architecture

```
#comms ───┐                              ┌─ comms process   (WS, owns #comms)
#ops   ───┤   Mattermost server          ├─ ops process     (WS, owns #ops)
#research─┤   (one bot account)   ◀────▶ ├─ research process (WS, owns #research)
#general ─┘                              └─ main process     (WS, #general @mention + default)
              each process: WebSocket receive → agent → REST post back into the channel
```

ClaudeClaw runs **one OS process per agent** (`main`, plus any specialists you
configure). The Mattermost adapter uses a **multi-process-subscribe** model:

- All processes connect to the same bot account (one token, several WebSocket
  sessions — Mattermost allows this).
- `MATTERMOST_CHANNEL_AGENT_MAP` partitions channels **disjointly** across
  agents. Each process only acts on the channels mapped to its own agent id;
  every other process drops those events. So each channel is handled by exactly
  one process — no double-replies.
- `main` is the default: it owns every **unmapped** channel plus the
  **mention-only** channels (where it replies only when `@`-mentioned).
- The bot's own posts are echo-filtered by user id.

Why this model? An agent's identity (model, system prompt, MCP allow-list,
working dir) is **process-global** in ClaudeClaw — one process is one agent. So
"channel → agent" maps naturally onto "channel → the process that already *is*
that agent", and the owning process handles its channels end-to-end (receive →
run → reply in-thread), exactly like the other adapters handle their single
conversation.

---

## Quick start

```bash
# .env
MESSENGER_TYPE=mattermost
MATTERMOST_URL=https://chat.example.com
MATTERMOST_TOKEN=<bot-access-token>
MATTERMOST_TEAM=my-team
MATTERMOST_DEFAULT_AGENT=main
MATTERMOST_OWNER_USER=your-mattermost-username
```

Then `npm run build && npm run setup` (or restart your services). Invite the bot
into a channel and talk to it.

---

## Step 1 — Create a bot account

A **bot account** (not a normal user) is recommended: it can't log in, doesn't
consume a license seat, and shows a `BOT` badge.

**Via the UI:** System Console → Integrations → Bot Accounts → *Add Bot Account*.
Username e.g. `claudeclaw`. Copy the **access token** — it is shown only once.

**Via `mmctl`:**
```bash
mmctl bot create claudeclaw --display-name "ClaudeClaw"
mmctl token generate claudeclaw "gateway"
```

Verify the token:
```bash
curl -s -H "Authorization: Bearer <token>" https://chat.example.com/api/v4/users/me
# → {"username":"claudeclaw","is_bot":true,...}
```

> Use a **dedicated** bot account, not your personal access token. If the bot
> posts as you, the echo filter can't tell your messages from the bot's.

---

## Step 2 — Add the bot to the team and channels

A fresh bot belongs to no team. Add it to the team, then invite it to the
channels you want it active in:

- In Mattermost: open a channel → *Add Members* → add `@claudeclaw` (or type
  `/invite @claudeclaw`).
- The bot only **receives** messages for channels it is a member of.

---

## Step 3 — Configure `.env`

```bash
MESSENGER_TYPE=mattermost
MATTERMOST_URL=https://chat.example.com         # no trailing slash
MATTERMOST_TOKEN=<bot-access-token>
MATTERMOST_TEAM=my-team                          # REQUIRED — the gateway serves exactly one team
MATTERMOST_DEFAULT_AGENT=main

# The ONE user allowed to invoke ClaudeClaw (username or 26-char user id).
# REQUIRED — the gateway refuses to boot without it (fail-closed). Resolved
# to the canonical user ID at startup; authorization then compares userId only.
MATTERMOST_OWNER_USER=niko

# 26-char channel ID → agent id. Unmapped channels fall to the default agent.
# Copy the id from the channel's "View Info" / URL. Keys must be IDs, not name
# slugs (a renamed channel keeps its ID; a slug would silently drift).
MATTERMOST_CHANNEL_AGENT_MAP={"<26-char-channel-id>":"comms","<26-char-channel-id>":"ops"}

# Channels (26-char ids) where the bot replies ONLY when @mentioned:
MATTERMOST_MENTION_ONLY_CHANNELS=<26-char-channel-id>,<26-char-channel-id>

# Inbound attachment bounds (Vision). Defaults shown.
MATTERMOST_MAX_FILES=4
MATTERMOST_MAX_FILE_MB=10
MATTERMOST_ALLOWED_FILE_TYPES=png,jpg,jpeg,webp,gif,pdf,txt,md,csv,json,docx,xlsx,pptx

# Optional: channel id for scheduler/status messages. Empty = status off
# (or, in dual mode, delivered via the other messenger).
MATTERMOST_STATUS_CHANNEL_ID=
```

---

## Step 4 — Channel → agent routing

`MATTERMOST_CHANNEL_AGENT_MAP` is a JSON object mapping **26-char channel ID**
to **agent id**. At boot the map is validated against the channels the bot
actually sees — an unknown or slug-keyed entry is a boot error (fail-closed),
because a broken map would silently route mapped channels to the default agent.
A clean convention is to name the channel after the agent (the NAME is for
humans; the map still keys on the ID):

```bash
MATTERMOST_CHANNEL_AGENT_MAP={"c1o2m3m4s5…26chars":"comms","o4p5s6…26chars":"ops"}
```

| Channel        | Handled by        | Mode                          |
| -------------- | ----------------- | ----------------------------- |
| `#comms`       | `comms` agent     | active                        |
| `#ops`         | `ops` agent       | active                        |
| `#research`    | `research` agent  | active                        |
| `#general`     | `main` (default)  | mention-only (`@claudeclaw`)  |
| direct message | `main` (default)  | active                        |

The routing is enforced by the pure `ownsChannel()` function and is unit-tested
to guarantee each channel has exactly one owning process.

---

## Step 5 — Start ClaudeClaw

```bash
npm run build
npm run setup            # or restart your launchd/service processes
```

You should see, per process:

```
Mattermost bot identity resolved
ClaudeClaw online via mattermost
Mattermost bot connected
```

Post a message in a mapped channel and the right agent replies in-thread.

---

## Commands

Same set as the other adapters (Markdown-rendered here):

| Command                       | Effect                                  |
| ----------------------------- | --------------------------------------- |
| `/help`                       | List commands                           |
| `/newchat` / `/forget`        | Clear the channel's session             |
| `/memory`                     | Recent memories                         |
| `/pin <id>` / `/unpin <id>`   | Pin / unpin a memory                    |
| `/model <opus\|sonnet\|haiku>`| Switch model for this channel           |
| `/agents`                     | List configured agents                  |
| `/delegate <agent> <prompt>`  | Delegate to one agent                   |
| `/await <agents> <prompt>`    | Fan out to agents, wait for one combined answer |
| `/gather <agents> <prompt>`   | Fan out to agents, get pinged with a summary when all finish |
| `/dashboard`                  | Dashboard link (**DM only** — the link carries a token) |
| `/lock` / `/status`           | Security (PIN lock / status)            |
| `/stop`                       | Stop the in-flight agent run            |

`/await` and `/gather` take a comma-separated agent list, e.g.
`/await comms,research summarise today's inbox`. The fan-out itself runs inside
the agent turn (mission-cli), so plain English ("ask comms and research, then
wait for both") works identically.

Anything else goes straight to the agent.

---

## AskUserQuestion bridge

When an agent calls the built-in **AskUserQuestion** tool, the adapter posts each
question with numbered Markdown options and captures your next message in that
channel as the answer:

```
❓ **Which environment?**
  **1.** Production — live
  **2.** Staging — test
↳ Antworte mit der Nummer, eigenem Text, `go` (mit bisherigen Antworten
   weitermachen) oder `stop` (abbrechen).
```

Reply with a number (`2`), several for multi-select (`1,3`), free text, `go` to
proceed with what's gathered, or `stop` to cancel. There is no inline-keyboard
dependency, so it works in every Mattermost client.

---

## Files

**Outbound.** Agents emit `[SEND_FILE:/path/to/file|optional caption]` or
`[SEND_PHOTO:/path]` markers. The adapter strips them from the text, uploads each
file to the channel (`POST /api/v4/files`), and attaches it to a post
(`file_ids`). Works for documents and images alike.

**Inbound (Vision).** When you attach a file to a message, the adapter downloads
it (`GET /api/v4/files/{id}`) to `workspace/uploads/` and hands the agent a
path-based prompt — an **image** is sent for analysis, a **document** (PDF, text,
…) to read and process; Claude Code's Read tool opens the saved file. Several
files in one post are described as a single set (Mattermost has no album concept,
so they simply share the post's `file_ids`). A file-only message (no text) is
handled too; the text, if any, becomes the caption. A download that fails is
skipped, never fatal.

---

## Access control

- **The owner gate is the first and decisive boundary.**
  `MATTERMOST_OWNER_USER` names the single operator (username or 26-char user
  id). At startup the gateway resolves it to the **canonical user ID**
  (`resolveUserWithRetry`, boot-failing on a mistyped owner) and authorizes by
  `userId` only — usernames and display names can never authorize a message.
  The check runs in `onMessage()` BEFORE routing, session/state access,
  attachments, commands, or tools — everyone else is dropped there. Unset →
  the process refuses to boot (fail-closed). This replaces the earlier
  `MATTERMOST_ALLOWED_USERS` list, whose empty default meant allow-all.
- **Team boundary.** `MATTERMOST_TEAM` (required) is resolved at startup; the
  gateway ignores every channel event from any other team, and channel events
  without a team id fail closed. Direct messages carry no team id and stay
  allowed. With the boundary enforced, routing an unmapped channel to the
  default agent is safe: it only decides which agent answers the owner.
- **Channel membership** is a second boundary — the bot only sees channels it's
  invited to; unknown entries in the routing map are boot errors.
- **`/dashboard` is DM-only.** The link it returns embeds a dashboard bearer
  token, so the bot refuses to post it into a shared channel — run `/dashboard`
  in a direct message with the bot.
- **Inbound attachments are bounded** (`MATTERMOST_MAX_FILES`,
  `MATTERMOST_MAX_FILE_MB`, `MATTERMOST_ALLOWED_FILE_TYPES`) and every accepted
  file is disclosed as model egress: its contents are processed by the
  configured model provider, noted in both the log and the agent prompt.
  Attachments the server reports **without an extension are rejected** — the
  allowlist trusts only the server-reported type, and a filename must not
  decide it.
- The standard ClaudeClaw security applies: PIN lock (`/lock`), emergency kill
  phrase, destructive-action confirmation, and the exfiltration guard that
  redacts protected env values from replies.

---

## Troubleshooting

### The bot doesn't react to messages
First confirm the sender **is the configured owner** (`MATTERMOST_OWNER_USER`) —
everyone else is dropped by design. Then confirm the bot is a **member** of the
channel and the channel's 26-char ID is mapped to the agent whose process is
running. `GET /users/me/teams/{team}/channels` lists the bot's channels.

### Replies appear twice
Two processes think they own the same channel. Check that
`MATTERMOST_CHANNEL_AGENT_MAP` is valid JSON and each channel ID maps to exactly
one agent. Invalid JSON, slug keys, or unknown channel IDs are boot errors
(fail-closed) rather than silent degradation.

### `Mattermost connection stale — forcing reconnect` on a quiet channel
Fixed: the client sends an application-level `{"action":"ping"}` every 30 s and
treats the pong as liveness, so idle channels don't trigger reconnects. If you
see this repeatedly, the server may be unreachable — check `MATTERMOST_URL`.

### Literal `<b>` / HTML in messages
Mattermost renders Markdown, not HTML. The adapter formats at the transport edge
(`formatForMattermost`), so don't pre-format for another messenger. In
multi-messenger mode the shared status formatter returns raw text and lets each
transport format itself.

### `403` listing teams/channels
The bot isn't a member of the team yet. Add it (UI *Add Members* or
`POST /api/v4/teams/{team}/members`).

---

## Design notes

- **Native WebSocket + fetch.** The adapter uses Node's global `WebSocket` and
  `fetch` (Node ≥ 22) rather than `@mattermost/client`, which references
  `window` and breaks under Node. No extra dependency, no polyfill.
- **Double-encoded events.** Mattermost's `posted` event carries `data.post` as a
  JSON **string** inside the already-parsed event — the adapter decodes both
  levels. This is documented behaviour, not a bug.
- **Keepalive.** Node auto-pongs protocol pings but doesn't surface them to
  `onmessage`, so an app-level ping feeds the staleness watchdog on idle
  channels.
- **Adapter, not a refactor.** Like the Signal adapter, Mattermost lives in its
  own files (`mattermost-config.ts`, `mattermost-rpc.ts`, `mattermost-bot.ts`,
  `mattermost-entry.ts`, `mattermost-askuserquestion.ts`) plus a one-line
  dispatcher branch. The Telegram entry (`src/index.ts`) is untouched.

### Files

| File                            | Role                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `src/mattermost-config.ts`      | Env vars + `ownsChannel()` routing logic                   |
| `src/mattermost-rpc.ts`         | WebSocket + REST client (auth, posts, files, typing, reconnect) |
| `src/mattermost-bot.ts`         | Message handler, commands, channel-ownership, file send    |
| `src/mattermost-askuserquestion.ts` | AskUserQuestion → numbered-reply bridge                 |
| `src/mattermost-entry.ts`       | Thin `MessengerFactory` over the shared `bootMessenger()`  |

---

## Rollback

```bash
# in .env — back to Telegram or Signal only
MESSENGER_TYPE=telegram
# or
MESSENGER_TYPE=signal
```

Restart the services. To disable the bot entirely, remove it from the channels or
deactivate the bot account in the System Console.
