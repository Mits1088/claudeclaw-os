import { describe, it, expect } from 'vitest';

import { makeStderrRelay } from './claude-sdk-adapter.js';

// Provider stderr can contain credentials or fragments that no per-chunk detector
// can recognize. Keep only content-free size/count diagnostics.
describe('makeStderrRelay — content-free repeat squelch', () => {
  it('reports only the original length', () => {
    const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const relay = makeStderrRelay((obj, msg) => calls.push({ obj, msg }));
    const secret = 'sk-secret-that-must-never-be-logged';
    relay(secret);
    expect(calls).toHaveLength(1);
    expect(calls[0].obj).toEqual({ stderrChars: secret.length });
    expect(JSON.stringify(calls)).not.toContain(secret);
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
    expect(JSON.stringify(calls)).not.toContain('a different error');
  });
});
