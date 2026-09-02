#!/bin/bash
# ClaudeClaw OS — Full Uninstall
# Removes everything: services, config, database, and the repo itself.
# Usage: bash scripts/uninstall.sh
#   or:  npm run uninstall

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo ""
echo -e "${BOLD}ClaudeClaw OS — Uninstall${RESET}"
echo ""

# ── 1. Stop and remove launchd services (macOS) ─────────────────────────
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="$HOME/Library/LaunchAgents"
  found_plists=0
  for plist in "$LAUNCH_DIR"/com.claudeclaw.*.plist; do
    [ -f "$plist" ] || continue
    found_plists=1
    label=$(basename "$plist" .plist)
    echo -e "  Stopping ${CYAN}$label${RESET}..."
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
  done
  if [ "$found_plists" -eq 1 ]; then
    echo -e "  ${GREEN}✓${RESET}  launchd services removed"
  else
    echo -e "  ${YELLOW}—${RESET}  No launchd services found"
  fi
fi

# ── 2. Stop and remove systemd services (Linux) ─────────────────────────
if [ "$(uname)" = "Linux" ] && command -v systemctl &>/dev/null; then
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  found_units=0
  for unit in "$SYSTEMD_DIR"/claudeclaw*.service; do
    [ -f "$unit" ] || continue
    found_units=1
    name=$(basename "$unit")
    echo -e "  Stopping ${CYAN}$name${RESET}..."
    systemctl --user stop "$name" 2>/dev/null || true
    systemctl --user disable "$name" 2>/dev/null || true
    rm -f "$unit"
  done
  if [ "$found_units" -eq 1 ]; then
    systemctl --user daemon-reload 2>/dev/null || true
    echo -e "  ${GREEN}✓${RESET}  systemd services removed"
  else
    echo -e "  ${YELLOW}—${RESET}  No systemd services found"
  fi
fi

# ── 3. Remove config directory (~/.claudeclaw) ──────────────────────────
# Resolve it the way the runtime does (getClaudeclawConfig, src/config.ts): the
# process environment wins, .env is consulted only when the process value is
# absent, and ~/.claudeclaw is the last resort. Letting .env win instead points
# the rm -rf below at whatever directory the file happens to name — deleting a
# config the user did not target, and leaving the one they did.
CONFIG_DIR="${CLAUDECLAW_CONFIG:-}"
if [ -z "$CONFIG_DIR" ] && [ -f "$PROJECT_ROOT/.env" ]; then
  # Strip one layer of surrounding quotes (mirrors readEnvFile in src/env.ts) BEFORE expanding ~,
  # so a single-quoted Windows path resolves with backslashes intact.
  CONFIG_DIR=$(grep '^CLAUDECLAW_CONFIG=' "$PROJECT_ROOT/.env" 2>/dev/null | cut -d'=' -f2- | sed -E "s/^'(.*)'\$/\1/; s/^\"(.*)\"\$/\1/")
fi
# Expand a leading ~ on whichever value won, as expandHome does at runtime.
# Quotes are stripped first, so a single-quoted path keeps its layout intact.
CONFIG_DIR=$(printf '%s' "${CONFIG_DIR:-$HOME/.claudeclaw}" | sed "s|^~|$HOME|")

if [ -d "$CONFIG_DIR" ]; then
  echo -e "  Removing config: ${CYAN}$CONFIG_DIR${RESET}"
  rm -rf "$CONFIG_DIR"
  echo -e "  ${GREEN}✓${RESET}  Config directory removed"
else
  echo -e "  ${YELLOW}—${RESET}  No config directory at $CONFIG_DIR"
fi

# ── 4. Remove database and runtime data ─────────────────────────────────
if [ -d "$PROJECT_ROOT/store" ]; then
  echo -e "  Removing store/ (database, sessions, logs)..."
  rm -rf "$PROJECT_ROOT/store"
  echo -e "  ${GREEN}✓${RESET}  Runtime data removed"
fi

# ── 5. Remove temp files ────────────────────────────────────────────────
rm -f /tmp/claudeclaw*.log /tmp/claudeclaw*.err /tmp/warroom-debug.log /tmp/warroom-agents.json
echo -e "  ${GREEN}✓${RESET}  Temp files cleaned"

# ── 6. Remove the repo itself ───────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Everything outside this directory has been removed.${RESET}"
echo ""
echo -e "  To finish, delete the repo:"
echo ""
echo -e "  ${CYAN}cd .. && rm -rf $(basename "$PROJECT_ROOT")${RESET}"
echo ""
echo -e "  ${GREEN}✓${RESET}  ${BOLD}ClaudeClaw OS uninstalled.${RESET}"
echo ""
