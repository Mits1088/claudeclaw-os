import { describe, expect, it } from 'vitest';
import { OutboundStreamGuard, OVERFLOW_PLACEHOLDER } from './outbound-stream-guard.js';
import { sanitizeOutboundText } from './outbound-sanitizer.js';

describe('bounded outbound stream', () => {
  it.each(['alpha beta gamma', 'alpha\nbeta\tgamma', 'sk-ant-api03-CANARYcanaryCANARYcanary01'])('captures safe output at every split for %j', (secret) => {
    const text = `before ${secret} after`;
    for (let split = 0; split <= text.length; split++) {
      for (const accumulated of [false, true]) {
        const guard = new OutboundStreamGuard({ protectedValues: [secret] });
        const captured = [accumulated ? guard.pushAccumulated(text.slice(0, split)) : guard.pushDelta(text.slice(0, split))];
        expect(captured.join('')).toBe('');
        captured.push(accumulated ? guard.pushAccumulated(text) : guard.pushDelta(text.slice(split)));
        expect(captured.join('')).toBe('');
        captured.push(guard.finalize());
        expect(captured.join('')).toBe('before [REDACTED] after');
        expect(guard.pendingLength).toBe(0);
        expect(guard.finalize()).toBe('');
      }
    }
  });

  it('sanitizes abort output and closes the stream', () => {
    const guard = new OutboundStreamGuard({ protectedValues: ['alpha beta'] });
    guard.pushDelta('alpha beta');
    expect(guard.abort()).toBe('[REDACTED]');
    expect(guard.pushDelta('ignored')).toBe('');
  });

  it('bounds retained data across arbitrarily many whitespace-delimited chunks', () => {
    const guard = new OutboundStreamGuard({ maxBufferedChars: 64 });
    const captured: string[] = [];
    for (let i = 0; i < 10000; i++) {
      captured.push(guard.pushDelta('word '));
      expect(guard.retainedChars).toBeLessThanOrEqual(64);
    }
    expect(captured.join('')).toBe(OVERFLOW_PLACEHOLDER);
    expect(guard.finalize()).toBe('');
  });

  it('suppresses a huge snapshot without retaining it', () => {
    const guard = new OutboundStreamGuard({ maxBufferedChars: 64 });
    expect(guard.pushAccumulated('x'.repeat(1000000))).toBe(OVERFLOW_PLACEHOLDER);
    expect(guard.pendingLength).toBe(0);
    expect(guard.retainedChars).toBeLessThanOrEqual(64);
  });

  it('suppresses revised snapshots rather than mixing stream histories', () => {
    const guard = new OutboundStreamGuard();
    guard.pushAccumulated('original');
    expect(guard.pushAccumulated('revision')).toContain('withheld');
    expect(guard.safeText).not.toContain('original');
  });

  it('keeps opt-out explicit while retaining the buffer ceiling', () => {
    const guard = new OutboundStreamGuard({ enabled: false });
    guard.pushDelta('alpha beta');
    expect(guard.finalize()).toBe('alpha beta');
  });

  it.each([0, -1, Infinity, NaN, 1.5])('rejects invalid buffer bound %s', (maxBufferedChars) => {
    expect(() => new OutboundStreamGuard({ maxBufferedChars })).toThrow(/buffer limit/);
  });
});

describe('incremental credential-safe delivery', () => {
  it('releases narration before the turn ends while retaining the unfinished token', () => {
    const guard = new OutboundStreamGuard({ incremental: true });
    expect(guard.pushAccumulated('Reviewing the configuration.\n')).toBe('Reviewing the configuration.\n');
    expect(guard.pushDelta('Now checking')).toBe('Reviewing the configuration.\nNow ');
    expect(guard.finalize()).toBe('Reviewing the configuration.\nNow checking');
  });

  const secrets = [
    'alpha beta gamma', 'alpha\nbeta\tgamma', ' repeated repeated secret ',
    'sk-ant-api03-CANARYcanaryCANARYcanary01',
    'sk-' + 'A'.repeat(45), 'ghp_' + 'A'.repeat(30), 'gho_' + 'B'.repeat(30),
    'eyJ' + 'a'.repeat(15) + '.' + 'b'.repeat(15) + '.' + 'c'.repeat(15),
    'rt.1.' + 'a'.repeat(30), 'xoxb-12345-abcdef', 'AKIA' + 'A'.repeat(16),
    'abcdef1234'.repeat(4), 'abcdef1234'.repeat(6),
  ];
  it.each(secrets)('never releases any secret portion across chunk splits: %s', secret => {
    // Configured values and the generic detector are both exercised independently.
    for (const protectedValues of [[secret], []]) {
      if (!protectedValues.length && secrets.indexOf(secret) < 3) continue;
      const text = 'Safe update.\n' + secret + '\nFinished safely.\n';
      const expected = sanitizeOutboundText(text, { protectedValues });
      for (let split = 0; split <= text.length; split++) {
        for (const accumulated of [false, true]) {
          const guard = new OutboundStreamGuard({ incremental: true, protectedValues });
          const first = text.slice(0, split), second = text.slice(split);
          guard.pushDelta(first);
          expect(expected.startsWith(guard.safeText)).toBe(true);
          if (accumulated) guard.pushAccumulated(text); else guard.pushDelta(second);
          expect(expected.startsWith(guard.safeText)).toBe(true);
          expect(guard.finalize()).toBe(expected);
        }
      }
    }
  });

  it('handles encoded and overlapping multiline values one character at a time', () => {
    const values = ['first secret\nnext', 'secret\nnext secret', 'next secret value'];
    const text = 'Progress.\nfirst secret\nnext secret value\n' +
      Buffer.from(values[0]).toString('base64') + '\n' + encodeURIComponent(values[0]) + '\nDone.\n';
    const expected = sanitizeOutboundText(text, { protectedValues: values });
    const guard = new OutboundStreamGuard({ incremental: true, protectedValues: values });
    for (const char of text) {
      guard.pushDelta(char);
      expect(expected.startsWith(guard.safeText)).toBe(true);
    }
    expect(guard.finalize()).toBe(expected);
  });

  it('never truncates a generic key at the start of an incomplete protected value', () => {
    const guard = new OutboundStreamGuard({ incremental: true, protectedValues: ['ABC DEF GHI'] });
    expect(guard.pushDelta('Visible. sk-ABC DEF ')).toBe('Visible. ');
    expect(guard.pushDelta('GHI rest\n')).not.toContain('ABC');
  });

  it('keeps long multiline prefixes private, not just a fixed trailing window', () => {
    const secret = 'PRIVATE-start\n' + 'middle '.repeat(2000) + 'PRIVATE-end';
    const guard = new OutboundStreamGuard({ incremental: true, protectedValues: [secret] });
    expect(guard.pushDelta('Visible.\n' + secret.slice(0, -1))).toBe('Visible.\n');
    guard.pushDelta(secret.slice(-1) + '\nDone.\n');
    expect(guard.finalize()).toBe('Visible.\n[REDACTED]\nDone.\n');
  });

  it('fails closed on invalid protected-value encoding', () => {
    const guard = new OutboundStreamGuard({ incremental: true, protectedValues: ['secret-value-\ud800'] });
    expect(guard.pushDelta('Visible.\n')).toContain('withheld');
    expect(guard.pushDelta('more')).toBe('');
  });

  it('bounds incremental history and stops on revision or overflow', () => {
    const guard = new OutboundStreamGuard({ incremental: true, maxBufferedChars: 64 });
    guard.pushDelta('Safe text.\n');
    expect(guard.pushAccumulated('Revised text.\n')).toContain('inconsistent');
    expect(guard.finalize()).toBe('');
    const large = new OutboundStreamGuard({ incremental: true, maxBufferedChars: 64 });
    for (let i = 0; i < 100; i++) {
      large.pushDelta('text ');
      expect(large.retainedChars).toBeLessThanOrEqual(128);
    }
    expect(large.safeText).toBe(OVERFLOW_PLACEHOLDER);
  });
});
