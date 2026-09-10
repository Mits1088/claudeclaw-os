import { describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ EXFILTRATION_GUARD_ENABLED: true, PROTECTED_ENV_VARS: ['CUSTOM_SECRET'] }));
vi.mock('./env.js', () => ({ readEnvFile: () => ({ CUSTOM_SECRET: 'synthetic file-only credential' }) }));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { resolveOutboundPolicy } from './outbound-policy.js';
import { sanitizeOutboundText } from './outbound-sanitizer.js';
import { serializeOutboundJson } from './outbound-payload.js';

describe('protected values from application configuration', () => {
  it('redacts file-only credentials in raw and encoded output', () => {
    const secret = 'synthetic file-only credential';
    const policy = resolveOutboundPolicy({});
    for (const value of [secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret)]) {
      expect(sanitizeOutboundText(value, policy)).toBe('[REDACTED]');
    }
  });

  it('uses the same process-over-file precedence as credential loading', () => {
    expect(resolveOutboundPolicy({ CUSTOM_SECRET: 'process credential override' }).protectedValues)
      .toEqual(['process credential override']);
    expect(resolveOutboundPolicy({ CUSTOM_SECRET: '' }).protectedValues)
      .toEqual(['synthetic file-only credential']);
  });

  it('protects serialized presentation without exporting file secrets to children', () => {
    vi.stubEnv('CUSTOM_SECRET', '');
    try {
      expect(serializeOutboundJson({ text: 'synthetic file-only credential', chat_id: 7 }, 'test'))
        .toBe('{"text":"[REDACTED]","chat_id":7}');
      expect(process.env.CUSTOM_SECRET).toBe('');
    } finally { vi.unstubAllEnvs(); }
  });
});
