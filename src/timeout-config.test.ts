import { describe, expect, it } from 'vitest';
import { parseTimeoutMs } from './config.js';

describe('parseTimeoutMs', () => {
  it.each(['0', '-1', 'NaN', 'Infinity', '1.5', '10ms', '', '2147483648'])(
    'rejects unsafe timeout value %j',
    (raw) => expect(() => parseTimeoutMs('TEST_TIMEOUT_MS', raw)).toThrow(/TEST_TIMEOUT_MS must be a positive integer/),
  );

  it.each(['1', '900000', '2147483647'])('accepts positive integer timeout value %s', (raw) => {
    expect(parseTimeoutMs('TEST_TIMEOUT_MS', raw)).toBe(Number(raw));
  });
});
