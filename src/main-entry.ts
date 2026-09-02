// Mindfield-only file. Tiny dispatcher that picks the right entry point based
// on MESSENGER_TYPE. Keeps Mark's src/index.ts pristine; signal-entry and
// mattermost-entry each hand a MessengerFactory to the shared bootMessenger()
// path (src/messenger.ts). The launchd plist for the main process targets
// dist/main-entry.js. Specialists keep using dist/index.js because they only
// delegate to main and don't open their own messenger transport.
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
