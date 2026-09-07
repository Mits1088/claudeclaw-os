// Mindfield-only file. Tiny dispatcher that picks the right entry point based
// on MESSENGER_TYPE. Keeps Mark's src/index.ts pristine; signal-entry and
// mattermost-entry each hand a MessengerFactory to the shared bootMessenger()
// path (src/messenger.ts). Every supervisor entry point targets
// dist/main-entry.js -- the launchd templates, the systemd units, the generated
// per-agent services and the documented npm/PM2 commands -- for specialists as
// well as main: ClaudeClaw runs one process per agent and each process opens
// its own transport (signal-entry.ts and mattermost-entry.ts are both written
// against an agentId), so an agent started through dist/index.js is pinned to
// Telegram whatever MESSENGER_TYPE says.
//
// Reads MESSENGER_TYPE from .env directly because launchd/systemd do not load
// .env automatically (and we don't want to add MESSENGER_TYPE to Mark's launchd
// plist, which would create a future conflict surface).

import { readEnvFile } from './env.js';

const env = readEnvFile(['MESSENGER_TYPE']);
const messenger = (process.env.MESSENGER_TYPE || env.MESSENGER_TYPE || 'telegram').toLowerCase();

// MINDFIELD: propagate into process.env so downstream modules that read
// process.env.MESSENGER_TYPE directly see the right value. Without this,
// launchd/systemd-spawned services fall back to the 'telegram' default.
process.env.MESSENGER_TYPE = messenger;

if (messenger === 'signal') {
  await import('./signal-entry.js');
} else if (messenger === 'mattermost') {
  await import('./mattermost-entry.js');
} else {
  await import('./index.js');
}
