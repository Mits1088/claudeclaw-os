// Mindfield-only file. Holds Mattermost single-operator gateway configuration
// that is not part of upstream ClaudeClaw. Keeping these vars out of
// src/config.ts means Mark's config.ts stays pristine and we avoid merge
// conflicts on every upstream update. mattermost-bot.ts and
// mattermost-entry.ts import from here.
//
// Access model (single-operator, fail-closed): exactly one Mattermost user —
// the configured owner — may invoke ClaudeClaw. Everyone else is rejected in
// onMessage() BEFORE routing, state access, attachments, commands, or tools.
// The owner gate exists because Business OS runs on the operator's personal
// provider credentials: any other admitted user would consume the owner's
// subscription, read agent context, and invoke tools. An unset owner is a
// boot error, never an implicit allow-all.
//
// Routing model: each agent process subscribes to every channel but answers
// only in channels whose 26-char channel ID is mapped to its AGENT_ID; the
// default agent additionally owns unmapped channels and direct messages.
// IDs, not name slugs: a renamed channel keeps its ID, so routing cannot
// silently drift; a slug in the map is a boot error.

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile([
  'MESSENGER_TYPE',
  'MATTERMOST_URL',
  'MATTERMOST_TOKEN',
  'MATTERMOST_TEAM',
  'MATTERMOST_DEFAULT_AGENT',
  'MATTERMOST_CHANNEL_AGENT_MAP',
  'MATTERMOST_MENTION_ONLY_CHANNELS',
  'MATTERMOST_OWNER_USER',
  'MATTERMOST_STATUS_CHANNEL_ID',
  'MATTERMOST_MAX_FILES',
  'MATTERMOST_MAX_FILE_MB',
  'MATTERMOST_ALLOWED_FILE_TYPES',
]);

function pick(key: string, fallback = ''): string {
  return (process.env[key] || env[key] || fallback).trim();
}

function csv(key: string): string[] {
  return pick(key).split(',').map((s) => s.trim()).filter(Boolean);
}

/** A Mattermost entity ID: 26 chars of [a-z0-9] (users, teams, channels). */
export function isMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/.test(value);
}

/** Base URL of the Mattermost server, e.g. https://chat.example.com (no trailing slash). */
export const MATTERMOST_URL = pick('MATTERMOST_URL').replace(/\/+$/, '');

/** Bot-account personal access token. Sent as `Authorization: Bearer <token>`. */
export const MATTERMOST_TOKEN = pick('MATTERMOST_TOKEN');

/** Team name (slug) or 26-char team ID the bot operates in. */
export const MATTERMOST_TEAM = pick('MATTERMOST_TEAM');

/** Agent that handles unmapped channels + direct messages. */
export const MATTERMOST_DEFAULT_AGENT = pick('MATTERMOST_DEFAULT_AGENT', 'main');

/**
 * The single operator: Mattermost username or 26-char user ID. Required —
 * the gateway refuses to boot without it (fail-closed) so a missing entry can
 * never silently become a shared-subscription gateway. Replaces the earlier
 * MATTERMOST_ALLOWED_USERS list, which defaulted an empty value to allow-all.
 */
export const MATTERMOST_OWNER_USER = pick('MATTERMOST_OWNER_USER');

/** Throw a clear boot error if the owner is unconfigured. Fail-closed. */
export function assertOwnerConfigured(): void {
  if (!MATTERMOST_OWNER_USER) {
    throw new Error(
      'MATTERMOST_OWNER_USER is not set. The Mattermost gateway is single-operator and fails closed: ' +
      'set it to your Mattermost username or 26-char user ID (see docs/mattermost.md).',
    );
  }
}

/**
 * Parse MATTERMOST_CHANNEL_AGENT_MAP, a JSON object mapping 26-char channel
 * ID → agent id, e.g. {"<26-char-id>":"comms","<26-char-id>":"ops"}.
 * Fail-closed on anything unparsable or slug-keyed: booting with a broken map
 * would silently route every mapped channel to the default agent, so this
 * throws instead of degrading.
 */
export function parseChannelAgentMap(raw: string): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `MATTERMOST_CHANNEL_AGENT_MAP is not valid JSON — refusing to boot with a broken routing map. ` +
      `Expected {"<26-char channel id>": "<agent id>", …}.`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `MATTERMOST_CHANNEL_AGENT_MAP is not a JSON object — refusing to boot with a broken routing map.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [channel, agent] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isMattermostId(channel.trim())) {
      throw new Error(
        `MATTERMOST_CHANNEL_AGENT_MAP key "${channel}" is not a 26-char channel ID — refusing to boot. ` +
        `Route by channel ID, not name slug: a renamed channel keeps its ID, so ID routing cannot silently drift.`,
      );
    }
    if (typeof agent === 'string' && agent.trim()) {
      out[channel.trim()] = agent.trim();
    } else {
      throw new Error(
        `MATTERMOST_CHANNEL_AGENT_MAP maps channel ${channel} to a non-string agent id — refusing to boot.`,
      );
    }
  }
  return out;
}

/** Channel-ID → agent-id routing table. */
export const MATTERMOST_CHANNEL_AGENT_MAP: Record<string, string> =
  parseChannelAgentMap(pick('MATTERMOST_CHANNEL_AGENT_MAP'));

/**
 * Parse MATTERMOST_MENTION_ONLY_CHANNELS: comma-separated 26-char channel IDs
 * where the bot replies only when @mentioned (e.g. town-square). Fail-closed
 * on slugs for the same reason as the routing map.
 */
export function parseMentionOnlyChannels(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    if (!isMattermostId(entry)) {
      throw new Error(
        `MATTERMOST_MENTION_ONLY_CHANNELS entry "${entry}" is not a 26-char channel ID — refusing to boot.`,
      );
    }
    return entry;
  });
}

/** Channel IDs where the bot replies ONLY when @mentioned (e.g. town-square). */
export const MATTERMOST_MENTION_ONLY_CHANNELS: string[] =
  parseMentionOnlyChannels(pick('MATTERMOST_MENTION_ONLY_CHANNELS'));

/**
 * Channel ID where scheduler / OAuth-health / War-Room status messages are
 * posted (the Mattermost analogue of Signal's primary recipient). Optional —
 * if unset, status delivery is disabled but inbound chat still works. Copy the
 * ID from the channel's "View Info" or URL.
 */
export const MATTERMOST_STATUS_CHANNEL_ID = pick('MATTERMOST_STATUS_CHANNEL_ID');

/** Max attachments accepted per inbound post. Additional files are rejected. */
export const MATTERMOST_MAX_FILES = (() => {
  const n = parseInt(pick('MATTERMOST_MAX_FILES'), 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
})();

/** Max size in MB of a single downloaded attachment. Larger files are rejected. */
export const MATTERMOST_MAX_FILE_MB = (() => {
  const n = parseFloat(pick('MATTERMOST_MAX_FILE_MB'));
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

/**
 * File extensions the gateway will download and hand to the agent. Anything
 * else is rejected before download. Defaults cover images (Vision) and common
 * document formats the Read tool handles.
 */
export const MATTERMOST_ALLOWED_FILE_TYPES: string[] = (() => {
  const fromEnv = csv('MATTERMOST_ALLOWED_FILE_TYPES').map((s) => s.toLowerCase().replace(/^\./, ''));
  return fromEnv.length > 0 ? fromEnv : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv', 'json', 'docx', 'xlsx', 'pptx'];
})();

/**
 * Decide whether this channel (by 26-char ID) belongs to the agent running
 * this process. Pure function so it is unit-testable.
 *
 * Rules:
 *  - Channel explicitly mapped to my agent id → mine.
 *  - Channel mapped to a DIFFERENT agent → not mine (that process owns it).
 *  - Channel not mapped at all → belongs to the default agent (documented:
 *    under the single-operator gate only the owner can post in, so the
 *    fallback merely picks WHICH agent answers the owner, never exposes a
 *    new user).
 *  - Mention-only channels belong to the default agent too (it decides
 *    whether the bot was @mentioned).
 */
export function ownsChannel(
  channelId: string,
  agentId: string,
  opts: {
    channelAgentMap?: Record<string, string>;
    defaultAgent?: string;
    mentionOnlyChannels?: string[];
  } = {},
): boolean {
  const map = opts.channelAgentMap ?? MATTERMOST_CHANNEL_AGENT_MAP;
  const def = opts.defaultAgent ?? MATTERMOST_DEFAULT_AGENT;
  const mentionOnly = opts.mentionOnlyChannels ?? MATTERMOST_MENTION_ONLY_CHANNELS;
  const mapped = map[channelId];
  if (mapped) return mapped === agentId;
  // Unmapped (including mention-only) → default agent owns it.
  if (agentId !== def) return false;
  // Default agent owns unmapped channels, including mention-only ones (the
  // mention check itself happens in the bot's shouldHandle).
  return true;
}
