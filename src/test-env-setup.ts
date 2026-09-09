// Runs before any test module imports. Sets the env vars that config.ts
// reads at import time so contract tests can build a working dashboard
// app without polluting the developer's real .env or DB.
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DASHBOARD_TOKEN = 'test-contract-token';
process.env.DASHBOARD_MUTATIONS_ENABLED = process.env.DASHBOARD_MUTATIONS_ENABLED || 'true';
process.env.WARROOM_ENABLED = process.env.WARROOM_ENABLED || 'false';

// Sandbox CLAUDECLAW_CONFIG to a temp dir so tests that exercise
// loadAgentConfig / resolveAgentDisplayName / setMainProviderConfig don't
// collide with a real config dir. The temp dir is created once per test
// run; individual tests can populate it with agent.yaml files.
//
// This ALWAYS overrides any inherited CLAUDECLAW_CONFIG. It must not honor
// an ambient production value: tests like dashboard.contract.test.ts's
// "updates main provider with a selected model" persist a fixture provider
// via setMainProviderConfig, which (correctly, since #147) writes to
// CLAUDECLAW_CONFIG/agents/main/agent.yaml. If that resolved to a user's
// real config dir (e.g. CLAUDECLAW_CONFIG exported by PM2 --update-env, a
// shell profile, or a systemd EnvironmentFile), running the suite would
// silently overwrite their live main provider with the test fixture and
// never restore it — breaking the bot on next turn. To intentionally point
// tests at a specific dir, set CLAUDECLAW_TEST_CONFIG_DIR (test-only, never
// a production path).
const testConfigDir = process.env.CLAUDECLAW_TEST_CONFIG_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-test-config-'));
fs.mkdirSync(path.join(testConfigDir, 'agents'), { recursive: true });
process.env.CLAUDECLAW_CONFIG = testConfigDir;

// Fallback bot token for tests that exercise loadAgentConfig('main').
// The main agent falls back to TELEGRAM_BOT_TOKEN when agent.yaml omits
// telegram_bot_token_env, so this prevents spurious failures.
if (!process.env.TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-placeholder';
}
// Pinned for the CSRF allowlist regression — the contract test issues
// a POST with Origin=https://dash.test.example and asserts the
// middleware lets it through. Without this, the CSRF check has no
// allowed-origin host and 403s every cross-origin POST.
process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://dash.test.example';
// Contract tests exercise the multi-provider feature surface (models endpoint,
// runtime-options, PATCH /api/agents/:id/provider). The ENABLE_ACP gate defaults
// to off, so enable it here to keep those tests meaningful. Tests for the gated
// (off) state should override this explicitly.
process.env.ENABLE_ACP = process.env.ENABLE_ACP || 'true';
