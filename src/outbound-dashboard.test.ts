import { expect, it, vi } from 'vitest';
import { buildDashboardApp } from './dashboard.js';
import { _initTestDatabase } from './db.js';
import { chatEvents } from './state.js';
import { formatForTelegram, splitMessage } from './bot.js';

vi.mock('./outbound-policy.js', () => ({
  outboundOptionsForSeam: (seam: string) => ({ seam, enabled: true,
    protectedValues: ['synthetic alpha beta credential', 'synthetic <alpha> & beta'] }),
}));

it('captures actual dashboard SSE bytes even for direct event-bus producers', async () => {
  _initTestDatabase();
  const baseline = chatEvents.listenerCount('chat');
  const app = buildDashboardApp();
  const response = await app.request('/api/chat/stream?token=test-contract-token');
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const initial = decoder.decode((await reader.read()).value);
    expect(initial).toContain('event: processing');
    // The first write must settle before the route attaches its subscriber.
    await vi.waitFor(() => expect(chatEvents.listenerCount('chat')).toBe(baseline + 1));
    chatEvents.emit('chat', { type: 'error', chatId: 'chat', content: 'synthetic alpha beta credential', timestamp: 1 });
    const frame = decoder.decode((await reader.read()).value);
    expect(frame).toContain('event: error');
    expect(frame).toContain('[REDACTED]');
    expect(frame).not.toContain('synthetic alpha beta credential');
  } finally {
    await reader.cancel();
  }
  await vi.waitFor(() => expect(chatEvents.listenerCount('chat')).toBe(baseline));
});

it('sanitizes Telegram before HTML escaping and message-size splitting', () => {
  expect(formatForTelegram('synthetic <alpha> & beta')).toBe('[REDACTED]');
  const parts = splitMessage('x'.repeat(4088) + 'synthetic alpha beta credential');
  expect(parts.join('')).not.toContain('synthetic');
  expect(parts.join('')).toContain('[REDACTED]');
});
