import { describe, it, expect } from 'vitest';

import {
  formatForMattermost,
  splitMessage,
  extractFileMarkers,
  buildMattermostHelpText,
  isImageAttachment,
  buildMattermostAttachmentMessage,
} from './mattermost-bot.js';
import { parseChannelAgentMap } from './mattermost-config.js';

// Pure-function coverage for the Mattermost adapter, mirroring the Signal
// adapter's format/split tests. Locks in the transport-edge behaviour so a
// regression can't silently change routing or leak raw HTML into a channel.

describe('formatForMattermost', () => {
  it('passes plain Markdown through unchanged (minus trailing whitespace)', () => {
    expect(formatForMattermost('# Title\n\n- a\n- b')).toBe('# Title\n\n- a\n- b');
  });

  it('converts the Telegram HTML subset back to Markdown', () => {
    expect(formatForMattermost('<b>bold</b> <i>italic</i> <code>x</code>')).toBe('**bold** *italic* `x`');
    expect(formatForMattermost('<strong>b</strong> <em>i</em>')).toBe('**b** *i*');
    expect(formatForMattermost('<a href="https://example.com">link</a>')).toBe('[link](https://example.com)');
    expect(formatForMattermost('<pre>code block</pre>')).toBe('```\ncode block\n```');
  });

  it('strips stray tags and unescapes HTML entities', () => {
    expect(formatForMattermost('a &lt;tag&gt; &amp; b <span>c</span>')).toBe('a <tag> & b c');
  });

  it('collapses excessive blank lines and trims the end', () => {
    expect(formatForMattermost('a\n\n\n\n\nb\n\n\n')).toBe('a\n\n\nb');
  });
});

describe('isImageAttachment', () => {
  it('treats common image extensions as images (Vision path)', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic']) {
      expect(isImageAttachment({ id: 'x', extension: ext })).toBe(true);
    }
  });

  it('treats non-image files as documents', () => {
    for (const ext of ['pdf', 'txt', 'docx', 'csv', 'zip']) {
      expect(isImageAttachment({ id: 'x', extension: ext })).toBe(false);
    }
  });

  it('is case-insensitive and falls back to the filename extension', () => {
    expect(isImageAttachment({ id: 'x', extension: 'PNG' })).toBe(true);
    expect(isImageAttachment({ id: 'x', name: 'holiday.JPG' })).toBe(true);
    expect(isImageAttachment({ id: 'x', name: 'report.pdf' })).toBe(false);
  });

  it('treats an unknown/extensionless file as a document (safe default)', () => {
    expect(isImageAttachment({ id: 'x' })).toBe(false);
  });
});

describe('buildMattermostAttachmentMessage', () => {
  it('builds a photo-analysis prompt for a single image', () => {
    const out = buildMattermostAttachmentMessage(
      [{ path: '/up/sunset.jpg', name: 'sunset.jpg', isImage: true }],
      'look at this',
    );
    expect(out).toContain('/up/sunset.jpg');
    expect(out).toContain('analyze this image');
    expect(out).toContain('look at this');
  });

  it('builds a document-read prompt for a single non-image file', () => {
    const out = buildMattermostAttachmentMessage(
      [{ path: '/up/notes.pdf', name: 'notes.pdf', isImage: false }],
    );
    expect(out).toContain('/up/notes.pdf');
    expect(out).toContain('notes.pdf');
    expect(out).toContain('read and process');
  });

  it('builds a single grouped prompt when several files arrive together', () => {
    const out = buildMattermostAttachmentMessage([
      { path: '/up/a.jpg', name: 'a.jpg', isImage: true },
      { path: '/up/b.pdf', name: 'b.pdf', isImage: false },
    ]);
    expect(out).toContain('/up/a.jpg');
    expect(out).toContain('/up/b.pdf');
    expect(out).toContain('2 files');
  });
});

describe('buildMattermostHelpText', () => {
  const help = buildMattermostHelpText();

  it('documents the multi-agent fan-out commands so they are discoverable', () => {
    // /await and /gather fan out to agents (blocking / non-blocking join). The
    // logic lives in the agent turn (mission-cli), but the commands must show up
    // in /help or a Mattermost user never learns they exist.
    expect(help).toContain('/await');
    expect(help).toContain('/gather');
  });

  it('still lists the core commands (regression guard for the help text)', () => {
    for (const cmd of ['/newchat', '/forget', '/memory', '/model', '/agents', '/delegate', '/dashboard', '/lock', '/status', '/stop']) {
      expect(help).toContain(cmd);
    }
  });
});

describe('splitMessage', () => {
  it('returns a single chunk for text within the limit', () => {
    expect(splitMessage('short')).toEqual(['short']);
  });

  it('splits over-long text into chunks that each respect the limit, losing no content', () => {
    const line = 'x'.repeat(1000) + '\n';
    const text = line.repeat(20); // 20_020 chars > 16_000
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(16_000);
    // Only whitespace is trimmed at the split boundary — every 'x' survives.
    const xCount = (s: string) => (s.match(/x/g) ?? []).length;
    expect(parts.reduce((n, p) => n + xCount(p), 0)).toBe(xCount(text));
  });
});

describe('extractFileMarkers', () => {
  it('extracts a document marker and strips it from the text', () => {
    const r = extractFileMarkers('here you go [SEND_FILE:/tmp/report.pdf]');
    expect(r.files).toEqual([{ type: 'document', filePath: '/tmp/report.pdf', caption: undefined }]);
    expect(r.text).toBe('here you go');
  });

  it('extracts a photo marker with a caption', () => {
    const r = extractFileMarkers('[SEND_PHOTO:/tmp/x.png|a nice chart]');
    expect(r.files).toEqual([{ type: 'photo', filePath: '/tmp/x.png', caption: 'a nice chart' }]);
    expect(r.text).toBe('');
  });

  it('extracts multiple markers of both kinds', () => {
    const r = extractFileMarkers('a [SEND_FILE:/1.pdf] b [SEND_PHOTO:/2.png]');
    expect(r.files).toHaveLength(2);
    expect(r.files[0].type).toBe('document');
    expect(r.files[1].type).toBe('photo');
  });

  it('leaves marker-free text unchanged', () => {
    expect(extractFileMarkers('just text')).toEqual({ text: 'just text', files: [] });
  });
});

describe('parseChannelAgentMap (fail-closed, 26-char channel IDs)', () => {
  const id = (label: string) => label.padEnd(26, '0').slice(0, 26);

  it('parses a valid channel-ID→agent JSON object', () => {
    expect(parseChannelAgentMap(`{"${id('ops')}":"ops"}`)).toEqual({ [id('ops')]: 'ops' });
  });

  it('returns an empty map for empty input', () => {
    expect(parseChannelAgentMap('')).toEqual({});
  });

  it('throws on malformed JSON instead of degrading to an empty map', () => {
    // A degraded map would silently route every mapped channel to the
    // default agent — a config typo must stop the boot, not reroute traffic.
    expect(() => parseChannelAgentMap('{not valid')).toThrow(/not valid JSON/);
  });

  it('throws on a non-object payload (array / scalar)', () => {
    expect(() => parseChannelAgentMap('["a","b"]')).toThrow(/not a JSON object/);
    expect(() => parseChannelAgentMap('42')).toThrow(/not a JSON object/);
  });

  it('throws on a slug key instead of accepting it', () => {
    expect(() => parseChannelAgentMap('{"support":"comms"}')).toThrow(/26-char channel ID/);
  });

  it('throws on a non-string / empty agent value instead of dropping the entry', () => {
    expect(() => parseChannelAgentMap(`{"${id('a')}":"","b":"x"}`)).toThrow(/non-string agent id/);
    expect(() => parseChannelAgentMap(`{"${id('a')}":123}`)).toThrow(/non-string agent id/);
  });
});
