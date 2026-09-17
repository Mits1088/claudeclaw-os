import { describe, expect, it, vi } from 'vitest';
import { createSteeringHandle, STEERING_LIMITS } from './steering.js';

describe('invocation steering', () => {
  it('deduplicates in-flight and completed submissions', async () => {
    const send = vi.fn(async () => ({ status: 'accepted' as const }));
    const handle = createSteeringHandle({ sessionId: 's', turnId: 't', startedAt: 0,
      now: () => 1, isActive: () => true, send });
    const first = handle.submit('1', 'hello');
    expect(handle.submit('1', 'hello')).toBe(first);
    await first;
    expect(await handle.submit('1', 'hello')).toEqual({ status: 'accepted' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds size, rate, count and lifetime without renewing the start time', async () => {
    let now = 0;
    const send = vi.fn(async () => ({ status: 'accepted' as const }));
    const handle = createSteeringHandle({ sessionId: 's', turnId: 't', startedAt: 0,
      now: () => now, isActive: () => true, send });
    expect(await handle.submit('oversize', 'a'.repeat(4001))).toMatchObject({ reason: 'size' });
    await handle.submit('0', 'hello');
    expect(await handle.submit('fast', 'hello')).toMatchObject({ reason: 'rate' });
    for (let i = 1; i < 8; i++) { now += 1000; await handle.submit(String(i), 'hello'); }
    expect(await handle.submit('9', 'hello')).toMatchObject({ reason: 'limit' });
    now = STEERING_LIMITS.lifetimeMs;
    expect(await handle.submit('10', 'hello')).toMatchObject({ reason: 'expired' });
    expect(send).toHaveBeenCalledTimes(8);
  });

  it('rechecks completion before sending and treats unexpected send errors as uncertain', async () => {
    let active = true;
    const send = vi.fn(async () => { throw new Error('lost connection'); });
    const handle = createSteeringHandle({ sessionId: 's', turnId: 't', startedAt: Date.now(),
      isActive: () => active, send });
    const pending = handle.submit('1', 'hello');
    active = false;
    expect(await pending).toMatchObject({ status: 'not-delivered' });
    expect(send).not.toHaveBeenCalled();
    const next = createSteeringHandle({ sessionId: 's', turnId: 't2', startedAt: Date.now(),
      isActive: () => true, send });
    expect(await next.submit('2', 'hello')).toEqual({ status: 'uncertain' });
  });
});
