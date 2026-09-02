import { describe, it, expect } from 'vitest';

import {
  parseChannelAgentMap,
  parseMentionOnlyChannels,
  isMattermostId,
  assertOwnerConfigured,
  MATTERMOST_OWNER_USER,
  MATTERMOST_MAX_FILES,
  MATTERMOST_MAX_FILE_MB,
  MATTERMOST_ALLOWED_FILE_TYPES,
} from './mattermost-config.js';
import { isOwnerMessage, passesTeamBoundary, filterInboundFiles } from './mattermost-bot.js';
import type { MattermostFileInfo } from './mattermost-rpc.js';

const id = (label: string) => label.padEnd(26, '0').slice(0, 26);

describe('single-operator owner gate (canonical user id)', () => {
  it('accepts the owner by resolved user id', () => {
    expect(isOwnerMessage({ userId: id('owner') }, id('owner'))).toBe(true);
  });

  it('authorizes by userId ONLY — a matching username no longer authorizes', () => {
    // The configured owner is resolved to a canonical id at boot; display
    // names and usernames can never authorize at message time.
    expect(isOwnerMessage({ userId: 'u2' }, 'alice')).toBe(false);
    expect(isOwnerMessage({ userId: id('other') }, id('owner'))).toBe(false);
  });

  it('rejects everyone else — no membership-based allow-all', () => {
    expect(isOwnerMessage({ userId: 'u2' }, id('owner'))).toBe(false);
  });

  it('fails closed when the owner id is unresolved (empty)', () => {
    expect(isOwnerMessage({ userId: 'u1' }, '')).toBe(false);
  });

  it('DMs pass the team boundary without a team_id; channel events must match it', () => {
    expect(passesTeamBoundary({ channelType: 'D' }, id('team'))).toBe(true);
    expect(passesTeamBoundary({ channelType: 'O', teamId: id('team') }, id('team'))).toBe(true);
  });

  it('channel events from another team are ignored', () => {
    expect(passesTeamBoundary({ channelType: 'O', teamId: id('fremd') }, id('team'))).toBe(false);
  });

  it('channel events without a team_id fail closed', () => {
    expect(passesTeamBoundary({ channelType: 'O', teamId: undefined }, id('team'))).toBe(false);
  });

  it('an unresolved team boundary rejects all channel events', () => {
    expect(passesTeamBoundary({ channelType: 'O', teamId: id('team') }, '')).toBe(false);
  });

  it('boots fail-closed: unconfigured owner throws in assertOwnerConfigured', () => {
    // The module constant reflects the test env (no MATTERMOST_OWNER_USER set),
    // so the assertion must throw. Production sets the var via .env.
    expect(() => assertOwnerConfigured()).toThrow(/MATTERMOST_OWNER_USER/);
  });

  it('the test env carries no owner (guards the fail-closed expectation above)', () => {
    expect(MATTERMOST_OWNER_USER).toBe('');
  });
});

describe('channel routing map (fail-closed, IDs only)', () => {
  it('parses a valid 26-char-ID map', () => {
    const map = parseChannelAgentMap(`{"${id('ops')}":"ops","${id('support')}":"comms"}`);
    expect(map).toEqual({ [id('ops')]: 'ops', [id('support')]: 'comms' });
  });

  it('rejects a name-slug key instead of silently accepting it', () => {
    expect(() => parseChannelAgentMap('{"ops":"ops"}')).toThrow(/26-char channel ID/);
  });

  it('rejects invalid JSON instead of degrading to an empty map', () => {
    expect(() => parseChannelAgentMap('{ops:')).toThrow(/not valid JSON/);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseChannelAgentMap('["a","b"]')).toThrow(/not a JSON object/);
  });

  it('mention-only list accepts IDs and rejects slugs', () => {
    expect(parseMentionOnlyChannels(`${id('town')}, ${id('lounge')}`)).toEqual([id('town'), id('lounge')]);
    expect(() => parseMentionOnlyChannels('town-square')).toThrow(/26-char channel ID/);
  });

  it('isMattermostId validates the 26-char [a-z0-9] form', () => {
    expect(isMattermostId(id('x'))).toBe(true);
    expect(isMattermostId('ops')).toBe(false);
    expect(isMattermostId('OPS0000000000000000000000x')).toBe(false); // uppercase
    expect(isMattermostId('')).toBe(false);
  });
});

describe('inbound attachment bounds', () => {
  const file = (name: string, extension?: string): MattermostFileInfo =>
    ({ id: `f-${name}`, name, extension: extension ?? name.split('.').pop() }) as MattermostFileInfo;

  it('defaults: 4 files, 10 MB, image+document whitelist', () => {
    expect(MATTERMOST_MAX_FILES).toBe(4);
    expect(MATTERMOST_MAX_FILE_MB).toBe(10);
    expect(MATTERMOST_ALLOWED_FILE_TYPES).toContain('png');
    expect(MATTERMOST_ALLOWED_FILE_TYPES).toContain('pdf');
  });

  it('accepts files within count and type bounds', () => {
    const { accepted, rejections } = filterInboundFiles(
      [file('a.png'), file('b.pdf')],
      { maxFiles: 4, allowedExtensions: MATTERMOST_ALLOWED_FILE_TYPES },
    );
    expect(accepted).toHaveLength(2);
    expect(rejections).toEqual([]);
  });

  it('rejects files beyond the count cap and says so', () => {
    const files = [file('a.png'), file('b.png'), file('c.png'), file('d.png'), file('e.png'), file('f.png')];
    const { accepted, rejections } = filterInboundFiles(files, { maxFiles: 4, allowedExtensions: MATTERMOST_ALLOWED_FILE_TYPES });
    expect(accepted).toHaveLength(4);
    expect(rejections.some((r) => r.includes('2 more file(s) skipped'))).toBe(true);
  });

  it('rejects disallowed types before download', () => {
    const { accepted, rejections } = filterInboundFiles(
      [file('malware.exe'), file('ok.png')],
      { maxFiles: 4, allowedExtensions: MATTERMOST_ALLOWED_FILE_TYPES },
    );
    expect(accepted).toHaveLength(1);
    expect(rejections[0]).toContain('".exe" not allowed');
  });

  it('rejects extensionless attachments — the type cannot be verified', () => {
    const noExt = { id: 'f-x', name: 'README' } as MattermostFileInfo;
    const withExtOnlyInName = { id: 'f-y', name: 'invoice.pdf.exe', extension: undefined } as MattermostFileInfo;
    const { accepted, rejections } = filterInboundFiles(
      [noExt, withExtOnlyInName],
      { maxFiles: 4, allowedExtensions: MATTERMOST_ALLOWED_FILE_TYPES },
    );
    expect(accepted).toEqual([]);
    expect(rejections).toHaveLength(2);
    expect(rejections[0]).toContain('no file extension');
    expect(rejections[1]).toContain('no file extension');
  });
});
