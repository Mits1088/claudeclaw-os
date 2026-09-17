import { expect, it } from 'vitest';
import { TelegramStreamBuffer } from './telegram-stream-buffer.js';

it('keeps a short throttled message for a heartbeat even with no further deltas', () => {
  const buffer = new TelegramStreamBuffer();
  buffer.update('Checking settings.', 100);
  expect(buffer.due(200, 2500)).toBe(false);
  expect(buffer.due(5000, 2500)).toBe(true);
  expect(buffer.text).toBe('Checking settings.');
  buffer.published();
  expect(buffer.due(10000, 2500)).toBe(false);
});

it('coalesces text without resetting the deadline when activity wins the edit slot', () => {
  const buffer = new TelegramStreamBuffer();
  buffer.update('First ', 0);
  buffer.update('First and second.', 2000);
  expect(buffer.due(2500, 2500)).toBe(true);
  expect(buffer.text).toBe('First and second.');
  buffer.published();
  buffer.update('First and second.', 2600);
  expect(buffer.due(10000, 2500)).toBe(false);
  buffer.update('First and second. Third.', 10000);
  expect(buffer.due(12500, 2500)).toBe(true);
});
