import { describe, expect, it } from 'vitest';
import { OutboundStreamGuard, OVERFLOW_PLACEHOLDER } from './outbound-stream-guard.js';

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
