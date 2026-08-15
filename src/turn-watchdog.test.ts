import { describe, expect, it, vi } from 'vitest';
import { TurnWatchdog, turnAbortMessage } from './turn-watchdog.js';

describe('TurnWatchdog', () => {
  it('slides the idle deadline on provider activity', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const watchdog = new TurnWatchdog(controller, 100, 1000);
    watchdog.start();
    vi.advanceTimersByTime(90);
    watchdog.touch();
    vi.advanceTimersByTime(90);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(11);
    expect(watchdog.reason()).toBe('idle_timeout');
    watchdog.dispose();
    vi.useRealTimers();
  });

  it('never slides the absolute runtime ceiling', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const watchdog = new TurnWatchdog(controller, 100, 250);
    watchdog.start();
    vi.advanceTimersByTime(90); watchdog.touch();
    vi.advanceTimersByTime(90); watchdog.touch();
    vi.advanceTimersByTime(71);
    expect(watchdog.reason()).toBe('max_runtime');
    watchdog.dispose();
    vi.useRealTimers();
  });

  it('reports manual cancellation before and after start without replacing it', () => {
    vi.useFakeTimers();
    for (const abortBeforeStart of [true, false]) {
      const controller = new AbortController();
      const watchdog = new TurnWatchdog(controller, 100, 1000);
      if (abortBeforeStart) controller.abort();
      watchdog.start();
      if (!abortBeforeStart) controller.abort();
      vi.advanceTimersByTime(1001);
      expect(watchdog.reason()).toBe('manual');
      watchdog.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('uses one deterministic reason when idle and maximum deadlines coincide', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const watchdog = new TurnWatchdog(controller, 100, 100);
    watchdog.start();
    vi.advanceTimersByTime(100);
    expect(controller.signal.aborted).toBe(true);
    expect(watchdog.reason()).toBe('idle_timeout');
    watchdog.dispose();
    vi.useRealTimers();
  });

  it('is safe to start and dispose repeatedly and leaves no timers', () => {
    vi.useFakeTimers();
    const watchdog = new TurnWatchdog(new AbortController(), 100, 1000);
    watchdog.start();
    watchdog.start();
    expect(vi.getTimerCount()).toBe(2);
    watchdog.dispose();
    watchdog.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('turnAbortMessage', () => {
  it.each([
    ['manual', 'Stopped.'],
    ['idle_timeout', 'Stopped after the provider produced no activity for too long.'],
    ['max_runtime', 'Stopped after reaching the maximum runtime.'],
  ] as const)('maps %s consistently even when a provider returned partial output', (reason, expected) => {
    expect(turnAbortMessage(reason)).toBe(expected);
  });
});
