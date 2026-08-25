#!/bin/bash
# Install ClaudeClaw launchd agents for auto-start on login + auto-restart on crash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCHD_DIR="$PROJECT_DIR/launchd"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_DIR/logs"

# Resolve the user's node binary so the plists work on any path layout
# (Apple Silicon homebrew, Intel homebrew, nvm, asdf, system node).
NODE_PATH="$(command -v node)"
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found on PATH. Install Node 22+ first." >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$NODE_PATH")"

echo "ClaudeClaw launchd installer"
echo "============================"
echo "Using Node binary: $NODE_PATH"
echo ""

# Ensure logs directory exists
mkdir -p "$LOG_DIR"

# An agent created through the dashboard or `agent-create` writes its plist
# straight to ~/Library/LaunchAgents and never into launchd/. "Absent from
# launchd/" is therefore the normal state of every user-created agent, not a
# sign that it is stale. Removing those plists unregisters agents the user is
# still running, so treat an existing agent directory as proof the agent is live.
#
# Resolve that directory the way the runtime does (getClaudeclawConfig,
# src/config.ts): the process environment wins, .env is consulted only when the
# process value is absent, and ~/.claudeclaw is the last resort. Reading .env
# over a live process value would point the lookup below at a stale directory
# and delete the plists of the very agents this block exists to protect.
CONFIG_DIR="${CLAUDECLAW_CONFIG:-}"
if [ -z "$CONFIG_DIR" ] && [ -f "$PROJECT_DIR/.env" ]; then
  # Strip one layer of surrounding quotes (mirrors readEnvFile in src/env.ts).
  CONFIG_DIR=$(grep '^CLAUDECLAW_CONFIG=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | sed -E "s/^'(.*)'\$/\1/; s/^\"(.*)\"\$/\1/")
fi
# Expand a leading ~ on whichever value won, as expandHome does at runtime.
# Quotes are stripped first, so a single-quoted path keeps its layout intact.
CONFIG_DIR=$(printf '%s' "${CONFIG_DIR:-$HOME/.claudeclaw}" | sed "s|^~|$HOME|")

# An agent directory lives either under CLAUDECLAW_CONFIG or in the repo,
# depending on how it was created (see createAgent in src/agent-create.ts).
agent_exists() {
  [ -d "$CONFIG_DIR/agents/$1" ] || [ -d "$PROJECT_DIR/agents/$1" ]
}

# Clean up stale/orphaned claudeclaw agents not in the current launchd/ directory
echo "Cleaning up stale agents..."
for existing in "$LAUNCH_AGENTS_DIR"/com.claudeclaw.*.plist; do
  [ -f "$existing" ] || continue
  label=$(basename "$existing" .plist)
  # Check if this plist has a corresponding file in our launchd/ dir
  if [ ! -f "$LAUNCHD_DIR/$label.plist" ]; then
    agent_id="${label#com.claudeclaw.}"
    # scripts/agent-service.sh labels its services com.claudeclaw.agent-<id>
    if agent_exists "$agent_id" || agent_exists "${agent_id#agent-}"; then
      echo "  Keeping user-created agent: $label"
      continue
    fi
    echo "  Removing stale agent: $label"
    launchctl unload "$existing" 2>/dev/null || true
    rm -f "$existing"
  fi
done
# Also remove the bare com.claudeclaw.plist (legacy, pre-multi-agent)
if [ -f "$LAUNCH_AGENTS_DIR/com.claudeclaw.plist" ]; then
  echo "  Removing legacy agent: com.claudeclaw"
  launchctl unload "$LAUNCH_AGENTS_DIR/com.claudeclaw.plist" 2>/dev/null || true
  rm -f "$LAUNCH_AGENTS_DIR/com.claudeclaw.plist"
fi
echo ""

# Build the project first
echo "Building project..."
cd "$PROJECT_DIR"
npm run build
echo "Build complete."
echo ""

# Install each plist
for plist in "$LAUNCHD_DIR"/com.claudeclaw.*.plist; do
  label=$(basename "$plist" .plist)
  dest="$LAUNCH_AGENTS_DIR/$label.plist"

  # Unload if already loaded
  if launchctl list "$label" &>/dev/null; then
    echo "Unloading existing $label..."
    launchctl unload "$dest" 2>/dev/null || true
  fi

  echo "Installing $label..."
  # Copy template and substitute placeholders with actual paths
  sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__NODE_PATH__|$NODE_PATH|g" \
      -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
      -e "s|__LOG_DIR__|$LOG_DIR|g" \
      "$plist" > "$dest"
  if grep -q '__[A-Z_]*__' "$dest"; then
    echo "Refusing to load $label: unresolved placeholder remains" >&2
    exit 1
  fi
  launchctl load "$dest"
done

# Install cloudflared tunnel if config exists
if [ -f "$HOME/.cloudflared/config.yml" ]; then
  TUNNEL_LABEL="com.cloudflare.cloudflared"
  TUNNEL_PLIST="$LAUNCH_AGENTS_DIR/$TUNNEL_LABEL.plist"

  if launchctl list "$TUNNEL_LABEL" &>/dev/null; then
    echo "Cloudflare tunnel already running."
  else
    echo "Installing Cloudflare tunnel..."
    cloudflared service install 2>/dev/null || true
    # Fix the generated plist to include tunnel run args
    if [ -f "$TUNNEL_PLIST" ] && ! grep -q "tunnel" "$TUNNEL_PLIST"; then
      launchctl unload "$TUNNEL_PLIST" 2>/dev/null || true
      # Replace the ProgramArguments to include tunnel run
      python3 -c "
import plistlib
with open('$TUNNEL_PLIST', 'rb') as f:
    plist = plistlib.load(f)
plist['ProgramArguments'] = [
    '/opt/homebrew/bin/cloudflared',
    'tunnel',
    '--config',
    '$HOME/.cloudflared/config.yml',
    'run',
]
with open('$TUNNEL_PLIST', 'wb') as f:
    plistlib.dump(plist, f)
"
      launchctl load "$TUNNEL_PLIST"
    fi
  fi
fi

echo ""
echo "Verifying..."
sleep 2

all_ok=true
for plist in "$LAUNCHD_DIR"/com.claudeclaw.*.plist; do
  label=$(basename "$plist" .plist)
  if launchctl list "$label" &>/dev/null; then
    pid=$(launchctl list "$label" | grep PID | awk '{print $NF}' 2>/dev/null || echo "?")
    echo "  $label: running (PID: $pid)"
  else
    echo "  $label: FAILED to start"
    all_ok=false
  fi
done

# Check tunnel
if launchctl list "com.cloudflare.cloudflared" &>/dev/null 2>&1; then
  echo "  com.cloudflare.cloudflared: running"
else
  echo "  com.cloudflare.cloudflared: not running (optional)"
fi

echo ""
if $all_ok; then
  echo "All agents installed and running."
  echo "Logs: $LOG_DIR/"
  echo ""
  echo "Useful commands:"
  echo "  launchctl list | grep claudeclaw    # check status"
  echo "  tail -f $LOG_DIR/main.log           # follow main bot logs"
  echo "  $SCRIPT_DIR/uninstall-launchd.sh    # remove all agents"
else
  echo "Some agents failed to start. Check logs in $LOG_DIR/"
fi
