import { describe, it, expect } from 'vitest';

import { makeStderrRelay } from './claude-sdk-adapter.js';

// One failing CLI hook produced 777 × ~5 KB stderr lines in a day: the relay
// must bound each snippet and squelch identical repeats instead of logging all.
describe('makeStderrRelay — truncation and repeat squelch', () => {
  it('reports oversized chunk length without logging raw fragments', () => {
    const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const relay = makeStderrRelay((obj, msg) => calls.push({ obj, msg }));
    relay('x'.repeat(5000));
    expect(calls).toHaveLength(1);
    expect(calls[0].obj).toEqual({ stderrChars: 5000 });
  });

  it('logs an identical repeating message once, then every 50th with the count', () => {
    const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const relay = makeStderrRelay((obj, msg) => calls.push({ obj, msg }));
    for (let i = 0; i < 120; i++) relay('Error in hook callback hook_0: same payload');
    expect(calls).toHaveLength(3); // 1st, 50th, 100th
    expect(calls[1].msg).toBe('claude subprocess stderr (repeating)');
    expect(calls[1].obj.repeats).toBe(50);
    expect(calls[2].obj.repeats).toBe(100);
  });

  it('resets the squelch when a different message arrives', () => {
    const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const relay = makeStderrRelay((obj, msg) => calls.push({ obj, msg }));
    relay('first error');
    relay('first error');
    relay('a different error');
    relay('first error');
    expect(calls.map((c) => c.obj.stderrChars)).toEqual([11, 17, 11]);
    expect(JSON.stringify(calls)).not.toContain('first error');
  });
});
