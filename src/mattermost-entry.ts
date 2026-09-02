// Mattermost entry point (MINDFIELD). Selected at boot by src/main-entry.ts when
// MESSENGER_TYPE=mattermost. Supplies a Mattermost Messenger to the shared
// bootMessenger() path (src/messenger.ts) — the same path src/index.ts (Telegram)
// and src/signal-entry.ts (Signal) use. All non-transport boot logic (PID lock,
// DB, security, dashboard, War Room, scheduler, main-agent CLAUDE.md + provider
// resolution, ensureMainAgentConfig) is shared, so the fork-drift bugs the old
// standalone mattermost-entry carried (unconditional releaseLock, missing main
// provider config, wrong main CLAUDE.md path, /tmp warroom path) cannot recur.
// Builds on the Messenger abstraction introduced by the Signal PR (#98 / #111).
//
// Imported first so the process-level uncaughtException guard registers before
// any transport module (mattermost-bot.ts → agent.ts) transitively pulls in the SDK.
import './crash-guard.js';
import { createMattermostBot, MattermostBot } from './mattermost-bot.js';
import { MATTERMOST_URL, MATTERMOST_TOKEN, MATTERMOST_STATUS_CHANNEL_ID, assertOwnerConfigured } from './mattermost-config.js';
import { logger } from './logger.js';
import { bootMessenger, Messenger, MessengerFactory } from './messenger.js';
import { setTelegramConnected, setBotInfo } from './state.js';

/** Build the Mattermost Messenger (called after DB init). */
function createMattermostMessenger(agentId: string): Messenger {
  const bot: MattermostBot = createMattermostBot();

  // Status-message recipient: the configured status channel (scheduler, War
  // Room, OAuth health). Null → status/scheduler delivery disabled; inbound
  // channel chat still works.
  const primaryRecipient = MATTERMOST_STATUS_CHANNEL_ID || null;

  return {
    kind: 'mattermost',
    primaryRecipient,

    // The dashboard's /api/chat/send route only calls `sendMessage`; a minimal
    // Telegram-Api-shaped shim relays the agent reply back to the status channel
    // (only wired when a status channel is configured).
    dashboardApi: primaryRecipient
      ? {
          sendMessage: async (_chatId: unknown, text: string, _opts?: unknown) => {
            await bot.sendTo(primaryRecipient, text);
            return undefined;
          },
        }
      : undefined,

    async sendToPrimary(text: string): Promise<void> {
      if (!primaryRecipient) return;
      await bot.sendTo(primaryRecipient, text).catch((err) =>
        logger.error({ err }, 'Mattermost status message failed'),
      );
    },

    async start(_interactive: boolean): Promise<void> {
      await bot.start();
      setTelegramConnected(true); // reuse the connected flag for dashboard state
      setBotInfo('mattermost', 'ClaudeClaw (Mattermost)');
      if (agentId === 'main') {
        console.log(`\n  ClaudeClaw online via Mattermost: ${MATTERMOST_URL}\n`);
      } else {
        console.log(`\n  ClaudeClaw agent [${agentId}] online via Mattermost\n`);
      }
    },

    async stop(): Promise<void> {
      await bot.stop();
    },
  };
}

const mattermostFactory: MessengerFactory = {
  preflight(_agentId: string): void {
    if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
      logger.error('MATTERMOST_URL / MATTERMOST_TOKEN not set. See docs/mattermost.md.');
      process.exit(1);
    }
    // Single-operator gateway, fail-closed: no owner configured → no boot. The
    // gateway runs on the owner's personal provider credentials and must never
    // fall back to admitting everyone in the bot's channels.
    try {
      assertOwnerConfigured();
    } catch (err) {
      logger.error({ err }, 'Mattermost gateway misconfigured');
      process.exit(1);
    }
  },
  create: createMattermostMessenger,
};

void bootMessenger(mattermostFactory);
