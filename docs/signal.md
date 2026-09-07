# Signal Messenger Adapter

_Living integration guide. Last reviewed against v1.8.2 on 2026-08-01._

ClaudeClaw ships with a Signal adapter as an alternative to the default
Telegram bot. Signal offers end-to-end encryption by default, a native
"Note to Self" chat that works elegantly with ClaudeClaw's
single-authorized-user model, and no bot-token-registration hurdle.

This guide walks through the full setup on macOS. Linux works the same way
with `systemd` user services instead of `launchd`. Windows is not covered
here — signal-cli runs on Windows, but auto-start requires NSSM or the Task
Scheduler and is not yet documented.

## Architecture

```
          Signal (phone, primary device)
                      │
                      │  Signal protocol (end-to-end encrypted)
                      ▼
          signal-cli daemon (launchd / systemd)
                      │
                      │  JSON-RPC 2.0 over localhost TCP (default :7583)
                      ▼
          ClaudeClaw bot (src/signal-bot.ts)
                      │
                      │  Claude Agent SDK
                      ▼
                 Claude Code
```

The bot runs as a **linked secondary device** on your Signal account,
exactly like Signal Desktop. Your phone remains the primary device; the Mac
just holds a linked session that can read and send on the account's behalf.

## Selecting the Signal adapter

In `.env`:

```ini
MESSENGER_TYPE=signal

SIGNAL_PHONE_NUMBER=+491234567890
SIGNAL_RPC_HOST=127.0.0.1
SIGNAL_RPC_PORT=7583

# Comma-separated list of senders the bot will talk to. Defaults to the
# bot's own number (which enables the "Note to Self" workflow). Add
# trusted contacts here if you want them to talk to your bot too.
SIGNAL_AUTHORIZED_RECIPIENTS=+491234567890
```

Leave `TELEGRAM_BOT_TOKEN` and `ALLOWED_CHAT_ID` empty — the Signal and
Telegram code paths are mutually exclusive; `index.ts` picks one at startup
based on `MESSENGER_TYPE`.

## Step 1 — Install signal-cli

```bash
brew install signal-cli qrencode
signal-cli --version   # require 0.14.5 or higher
```

> **Minimum version: 0.14.5.** signal-cli **< 0.14.5** has a
> `getServerGuid` / `getSender` `NullPointerException` that *silently drops*
> certain inbound envelopes — notably **Note-to-Self** and sealed-sender
> messages — before they ever reach the JSON-RPC client. The bot then looks
> dead: it connects fine and can send, but never reacts to your messages.
> The adapter logs a warning on connect if it detects an older daemon
> (`signal-rpc` version probe). If inbound silently breaks, first run
> `brew upgrade signal-cli` and restart the daemon.

signal-cli pulls OpenJDK (~500 MB) as a dependency. `qrencode` renders the
linking QR code inline in the terminal.

## Step 2 — Link as a secondary device

```bash
signal-cli link -n "ClaudeClaw-Mac" | tee /tmp/signal-link.txt
```

The command prints a `sgnl://linkdevice?uuid=...` URI and stays running
until you complete the pairing. Render the URI as a QR code so you can scan
it from the phone:

```bash
# In another terminal:
cat /tmp/signal-link.txt | qrencode -t UTF8
```

On the phone:

1. Signal → **Settings** → **Linked Devices**
2. Tap **+**
3. Scan the QR code in the terminal

The `signal-cli link` process finishes once the phone confirms. Run
**`signal-cli -a +YOUR_NUMBER receive`** once to sync the account state
(contacts, groups, recent messages), then stop it with `Ctrl-C`. The
attachment-storage directory is created as a side-effect.

## Step 3 — Run signal-cli as a long-running daemon

`signal-cli` has a JSON-RPC daemon mode that stays connected to Signal's
push endpoint and streams `receive` notifications to whoever connects to
its TCP socket. We run it under `launchd` so it survives reboots and
restarts on crash.

Copy the template plist and substitute your phone number + the
signal-cli binary path. On Apple Silicon, `which signal-cli` resolves
to `/opt/homebrew/bin/signal-cli`. On Intel Macs it's usually
`/usr/local/bin/signal-cli`, and on Linux it depends on how you
installed it. The plist can't rely on `PATH`, so substitute the
absolute path at install time:

```bash
# In the claudeclaw-os checkout:
SIGNAL_CLI_PATH=$(which signal-cli)
sed "s|__SIGNAL_PHONE_NUMBER__|+491234567890|g; s|__HOME__|$HOME|g; s|__SIGNAL_CLI_PATH__|$SIGNAL_CLI_PATH|g; s|__PROJECT_DIR__|$PWD|g" \
    launchd/signal-cli.plist > ~/Library/LaunchAgents/com.claudeclaw.signal-cli.plist

launchctl load ~/Library/LaunchAgents/com.claudeclaw.signal-cli.plist
```

Verify the daemon is listening:

```bash
launchctl list | grep signal-cli    # should show the service ID
nc -zv 127.0.0.1 7583                # should say "connection succeeded"
tail /tmp/signal-cli.err             # "Started JSON-RPC server on …"
```

## Step 4 — Start ClaudeClaw

Either via the normal `npm start` or (recommended) install the main
`launchd` service created by `npm run setup`. With `MESSENGER_TYPE=signal`
set, the bot skips Telegram entirely and connects to `signal-cli` on
startup:

```
ClaudeClaw online via Signal: +491234567890
Signal bot connected to signal-cli daemon {"host":"127.0.0.1","port":7583}
```

## Step 5 — Chat from your phone

Open Signal on the phone and select the **Notiz an mich selbst** / **Note to
Self** chat (your own name at the top of the chat list). Send a test:

```
/help
```

The bot replies with the command list. Everything else you type goes
straight to Claude.

### Why "Note to Self"?

When you send a message from a linked device's *primary* device (the phone)
to *yourself*, Signal delivers it to all other linked devices — including
the Mac where the bot runs — as a `syncMessage` with
`destinationNumber` set to your own account. The adapter treats a sync
whose destination equals `SIGNAL_PHONE_NUMBER` as a normal inbound message,
so Note-to-Self becomes your personal bot channel. Syncs for messages you
send to *other* contacts are ignored, so the bot never tries to answer on
your behalf.

## Group chat routing (optional)

By default the bot lives in your **Note to Self** channel. You can also hand
dedicated Signal **groups** to specific agents — the Signal analogue of the
Mattermost per-channel routing. Each mapped group becomes that agent's topic
channel: only its owning agent answers there, and that agent's scheduled and
status messages are delivered into the group instead of Note-to-Self.

Routing is driven by a small JSON file, `store/signal-groups.json` (deliberately
not `.env` — the mapping is not a secret, and keeping it out of the credentials
file lets tooling manage it):

```json
{
  "<base64GroupId>": "<agentId>"
}
```

Rules (implemented by `shouldHandleInbound` in `src/signal-groups.ts`):

- **A message in a group mapped to an agent** → only that agent's process
  answers it.
- **A message in an unmapped group** → nobody answers. The bot never speaks in
  a group it was not explicitly given (conservative by design).
- **1:1 / Note to Self** → the `main` agent only, exactly as before.

A missing or unreadable file simply disables group routing and the bot falls
back to Note-to-Self — it never blocks boot.

### Finding a group's id

signal-cli identifies groups by a base64 id. List the groups the linked account
is in and copy the target group's `Id:`:

```bash
signal-cli -a "$SIGNAL_PHONE_NUMBER" listGroups
```

To create a fresh group for an agent, use the Signal app or
`signal-cli … updateGroup -n "HealthOS"`, then put its id in the file. The file
is read **once at boot** (like `.env`) — restart the affected services after
editing it.

## Commands

```
/newchat                Start a new Claude session
/forget                 Clear the current session
/memory                 Show recent memories (newest first)
/pin <id>               Pin a memory so it's never pruned
/unpin <id>             Unpin a memory
/voice on|off|auto      Voice-reply mode: always / never / mirror input
/model opus|sonnet|haiku  Switch models mid-session
/agents                 List sub-agents (if configured)
/delegate <agent> <prompt>  Run a sub-agent for one query
/dashboard              Link to the web dashboard
/lock                   Lock the session (requires PIN to unlock)
/status                 Show security status
/stop                   Cancel the currently-running agent query
```

Everything that is not a command goes straight to Claude Opus by default.

## Voice (optional)

ClaudeClaw's Signal adapter supports both directions:

**Voice input.** When you send a Signal voice note, `signal-cli` drops the
AAC blob in `~/.local/share/signal-cli/attachments/<id>.aac`. The adapter
wraps it into an M4A container with ffmpeg (stream-copy, no re-encode, a
few milliseconds) to satisfy Groq Whisper's accepted format list, then
transcribes it via the same `voice.ts` helpers the Telegram adapter uses.

**Voice output.** The adapter's response modality is controlled by
`/voice`:

- `/voice on` — every reply is spoken, even for typed prompts.
- `/voice off` — no TTS ever, even after a voice note (hard mute).
- `/voice auto` (default) — mirror the incoming modality: voice-in ⇒
  voice-out, text-in ⇒ text-out.

Synthesis falls through the same provider chain as the Telegram adapter
(`voice.ts`): ElevenLabs → Gradium → Kokoro → macOS `say`, and delivers
the audio as a Signal attachment.

Minimum configuration for voice:

```ini
# Incoming voice transcription (Groq Whisper, free tier generous)
GROQ_API_KEY=...

# Outgoing voice: at least one of the providers below.
# ElevenLabs (best quality, paid beyond 10 k chars/month):
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...   # Fin = D38z5RcWu1voky8WS1ja is a neutral default

# Or Gradium (45 k free credits/month):
# GRADIUM_API_KEY=...
# GRADIUM_VOICE_ID=...

# Or local Kokoro (no API key, Docker):
# KOKORO_URL=http://localhost:8880
```

Without any provider configured, the bot falls back to macOS `say` +
ffmpeg. Usable for a functional test, but the voice quality is far below
ElevenLabs/Gradium.

## Troubleshooting

### `Session locked. Send your PIN to unlock.`

You have `SECURITY_PIN_HASH` configured and the bot restarted. Send your
PIN as a plain message to unlock.

### "Got your voice note but could not locate the audio file on disk"

Your signal-cli version stores attachments under a non-default path
(typically `~/.config/signal-cli/attachments/` on older releases). The
adapter probes both the XDG and legacy locations; if neither matches, set
`XDG_DATA_HOME` to your signal-cli data root. Verify the file exists:

```bash
ls ~/.local/share/signal-cli/attachments/
```

### "Voice transcription failed"

Most common cause on Signal: Groq Whisper rejects files whose format is
not in `[flac mp3 mp4 mpeg mpga m4a ogg opus wav webm]`. The adapter
should handle this with ffmpeg, but if ffmpeg is missing install it:

```bash
brew install ffmpeg
```

Other causes: stale/revoked `GROQ_API_KEY`, or the voice note is longer
than Groq's per-file upload limit (25 MB).

### The bot answers itself in a loop

This can happen if you accidentally enabled authorization for a contact
and then sent them a message — Signal mirrors that outbound as a sync,
which the bot treats as inbound and replies to. Check
`SIGNAL_AUTHORIZED_RECIPIENTS`: during personal use it should contain only
your own number. `destinationNumber != SIGNAL_PHONE_NUMBER` syncs are
silently ignored by the adapter, so non-self chats do not cause loops by
default.

### `signal-cli` daemon keeps crashing

Check `/tmp/signal-cli.err`. Common issues: stale account state after a
force-unlink (re-run `signal-cli link`), or the daemon lost its database
lock (only one `signal-cli` instance may hold the account at a time —
don't run `signal-cli receive` manually while the daemon is up).

### `npm run setup` wants a Telegram token

The setup wizard is Telegram-centric at the moment. For a Signal-only
setup, skip it entirely and write `.env` yourself following the template
in `.env.example`, then install the main `launchd` service manually:

```bash
cat > ~/Library/LaunchAgents/com.claudeclaw.app.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claudeclaw.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$PWD/dist/main-entry.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/tmp/claudeclaw.log</string>
  <key>StandardErrorPath</key><string>/tmp/claudeclaw.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST

launchctl load ~/Library/LaunchAgents/com.claudeclaw.app.plist
```

## Design notes

### Why an adapter, not a refactor?

Telegram's `bot.ts` is 1700+ lines with deep coupling to grammy's `Context`
and `Api` types. A full extract-interface refactor would touch everything
that calls `ctx.reply()` / `ctx.api.sendMessage()` and risk regressions in
the most load-bearing file. Signal is implemented as a **parallel module**
(`src/signal-bot.ts`) that consumes the same core building blocks
(`agent.ts`, `message-queue.ts`, `state.ts`, `memory.ts`, `security.ts`,
`exfiltration-guard.ts`) and wires them to `signal-rpc.ts` instead of
grammy. Conditional selection happens once in `src/index.ts`.

Advantages:

- Zero risk to the Telegram code path (identical bytes for existing users).
- The two paths can evolve independently; Signal doesn't need to match
  every Telegram feature at once.
- Code duplication is concentrated in the outer I/O shell — the expensive
  parts (agent routing, memory context, exfiltration guard, cost footer)
  live once in shared modules.

Trade-off: a small amount of duplicated glue (audit calls, command
dispatch, reply formatting). Acceptable given the size of the payoff.

### What's not implemented in the Signal adapter

- **Streaming message edits.** Signal has no edit-message RPC, so the
  progressive-update pattern used on Telegram (edit a placeholder message
  with accumulating text) does not translate. The adapter sends the final
  response in one go, plus occasional "task started / completed" updates
  from the agent progress callback.
- **Inline keyboards.** Signal has no button primitives. `/dashboard`
  returns a plain URL instead of an inline button. Future nested menus
  should use numbered text options (`1. Open chat`, `2. …`, reply with
  the number).
- **WhatsApp/Slack list-and-reply state machines.** The Telegram adapter
  owns a chat-level state machine for interacting with WhatsApp/Slack via
  forwarded list views. The Signal adapter delegates both to the text
  path (the user can just ask the agent to "reply to the last WhatsApp
  message from Foo"); reimplementing the full menu dance is on the
  roadmap.

### Message flow

```
Signal phone (Note to Self)
    │
    ▼
signal-cli daemon
    │   JSON-RPC `receive` notification over TCP
    ▼
src/signal-rpc.ts     parses envelope, emits SignalIncomingMessage
    │
    ▼
src/signal-bot.ts     onMessage()
    │   - Sync-message filter: accept only if destination == own number
    │   - Authorization gate (SIGNAL_AUTHORIZED_RECIPIENTS)
    │   - Voice-attachment branch: ffmpeg convert → transcribeAudio
    │   - Command dispatch (/voice, /memory, /delegate, …)
    │
    ▼
handleTextMessage()   (mirrors bot.ts's handleMessage for Signal)
    │   - Emergency kill phrase check
    │   - PIN lock gate
    │   - Memory context via buildMemoryContext
    │   - Delegation parsing (@agent)
    │   - runAgentWithRetry
    │   - Exfiltration guard on response
    │   - File-marker extraction
    │   - Cost footer
    │
    ▼
sendMessage / sendWithAttachments via signal-rpc
    │
    ▼
signal-cli → Signal server → phone
```

## Rollback

To switch back to Telegram:

```ini
# in .env
MESSENGER_TYPE=telegram
TELEGRAM_BOT_TOKEN=<your token>
ALLOWED_CHAT_ID=<your chat id>
```

Reload the service (`launchctl unload/load ~/Library/LaunchAgents/com.claudeclaw.app.plist`). The Signal-cli daemon can keep running; ClaudeClaw just stops connecting to it.

To fully tear down Signal:

```bash
launchctl unload ~/Library/LaunchAgents/com.claudeclaw.signal-cli.plist
rm ~/Library/LaunchAgents/com.claudeclaw.signal-cli.plist
signal-cli -a +YOUR_NUMBER removeDevice --deviceId <device-id-of-the-mac>
# or remove the linked device from the phone: Settings → Linked Devices → Mac → Unlink
```
