import { describe, it, expect } from 'vitest';
import {
  sanitizeOutbound,
  sanitizeOutboundText,
  resolveProtectedValues,
  SANITIZER_FAILURE_PLACEHOLDER,
  type SanitizeDiagnostic,
} from './outbound-sanitizer.js';

// Synthetic canary secrets — none are real credentials.
const CANARY_ANTHROPIC = 'sk-ant-api03-CANARYcanaryCANARYcanary01';
const CANARY_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcnkiOiJ0cnVlLXRydWUtdHJ1ZSJ9.CANARYcanaryCANARY_signature01';
const CANARY_TELEGRAM = '1234567890:AAFAKEcanaryCANARYcanaryFAKEcanary01';

describe('sanitizeOutbound', () => {
  it('redacts the union of overlapping protected values', () => {
    expect(sanitizeOutboundText('abcdefghijklmnop', {
      protectedValues: ['abcdefghijk', 'fghijklmnop'],
    })).toBe('[REDACTED]');
  });

  it('does not expose output or throw when diagnostic delivery fails', () => {
    expect(sanitizeOutboundText(CANARY_ANTHROPIC, {
      onEvent: () => { throw new Error('diagnostic unavailable'); },
    })).toBe('[REDACTED]');
  });
  it('redacts a built-in credential pattern and reports categories/counts only', () => {
    const events: SanitizeDiagnostic[] = [];
    const res = sanitizeOutbound(`your key is ${CANARY_ANTHROPIC} ok`, {
      seam: 'test',
      onEvent: (e) => events.push(e),
    });
    expect(res.redacted).toBe(true);
    expect(res.text).not.toContain(CANARY_ANTHROPIC);
    expect(res.text).toContain('[REDACTED]');
    expect(res.types).toContain('anthropic_key');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seam: 'test', kind: 'redacted' });
    // Diagnostic never carries the raw secret.
    expect(JSON.stringify(events[0])).not.toContain('CANARY');
  });

  it('leaves clean text unchanged and emits no diagnostic', () => {
    const events: SanitizeDiagnostic[] = [];
    const res = sanitizeOutbound('a perfectly ordinary message', { onEvent: (e) => events.push(e) });
    expect(res.redacted).toBe(false);
    expect(res.text).toBe('a perfectly ordinary message');
    expect(events).toHaveLength(0);
  });

  it('is idempotent — sanitizing already-sanitized text is a no-op', () => {
    const first = sanitizeOutbound(`token ${CANARY_JWT} end`).text;
    const second = sanitizeOutbound(first).text;
    expect(second).toBe(first);
    expect(second).not.toContain('eyJ');
  });

  it('redacts a raw protected value that no generic pattern would catch', () => {
    const res = sanitizeOutbound(`leaked verbatim: ${CANARY_TELEGRAM} done`, {
      protectedValues: [CANARY_TELEGRAM],
    });
    expect(res.text).not.toContain(CANARY_TELEGRAM);
    expect(res.redacted).toBe(true);
    expect(res.types).toContain('env_value');
  });

  it('redacts a base64-encoded protected value', () => {
    const encoded = Buffer.from(CANARY_TELEGRAM).toString('base64');
    const res = sanitizeOutbound(`blob=${encoded}`, { protectedValues: [CANARY_TELEGRAM] });
    expect(res.text).not.toContain(encoded);
    expect(res.redacted).toBe(true);
  });

  // ── Explicit opt-out semantics ─────────────────────────────────────
  it('passes through unchanged when enabled=false (opt-out)', () => {
    const events: SanitizeDiagnostic[] = [];
    const res = sanitizeOutbound(`key ${CANARY_ANTHROPIC}`, {
      enabled: false,
      onEvent: (e) => events.push(e),
    });
    expect(res.text).toBe(`key ${CANARY_ANTHROPIC}`);
    expect(res.redacted).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('defaults to enabled (fail-closed) when the flag is omitted', () => {
    const res = sanitizeOutbound(`key ${CANARY_ANTHROPIC}`);
    expect(res.text).not.toContain(CANARY_ANTHROPIC);
  });

  // ── False positives ────────────────────────────────────────────────
  it('does not flag ordinary code, paths or git SHAs', () => {
    const text = [
      'See src/agent-engine/index.ts and ./dist/outbound-sanitizer.js.',
      'commit a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 landed the fix.',
      'const x = foo.bar.baz(); // dotted call, not a JWT',
      'color #ff00aa and id 0deadbeef123 are fine',
    ].join('\n');
    const res = sanitizeOutbound(text);
    expect(res.redacted).toBe(false);
    expect(res.text).toBe(text);
  });

  // ── Fail-safe behaviour ────────────────────────────────────────────
  it('suppresses the payload (never returns raw) if the detector throws', () => {
    const events: SanitizeDiagnostic[] = [];
    // Force a deterministic detector fault: a protectedValues object whose
    // iteration throws when the detector loops over it.
    const hostile = {
      [Symbol.iterator]() {
        throw new Error('boom');
      },
    } as unknown as string[];
    const res = sanitizeOutbound(`leak ${CANARY_TELEGRAM}`, {
      protectedValues: hostile,
      onEvent: (e) => events.push(e),
    });
    expect(res.suppressed).toBe(true);
    expect(res.text).toBe(SANITIZER_FAILURE_PLACEHOLDER);
    expect(res.text).not.toContain(CANARY_TELEGRAM);
    expect(events[0]?.kind).toBe('suppressed');
  });

  it('sanitizeOutboundText returns just the safe string', () => {
    expect(sanitizeOutboundText(`x ${CANARY_ANTHROPIC}`)).not.toContain(CANARY_ANTHROPIC);
    expect(sanitizeOutboundText('clean')).toBe('clean');
  });
});

describe('resolveProtectedValues', () => {
  it('resolves configured env names, dropping short/empty values', () => {
    const env = { A: CANARY_TELEGRAM, B: 'short', C: undefined, D: '' };
    const vals = resolveProtectedValues(['A', 'B', 'C', 'D', 'MISSING'], env);
    expect(vals).toEqual([CANARY_TELEGRAM]);
  });
});
