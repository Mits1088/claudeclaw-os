import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';
import type { AgentTurnInput } from './types.js';
import type { SteeringHandle, SteeringResult } from './steering.js';

const queryMock = vi.mocked(query);
const initial = { type: 'system', subtype: 'init', session_id: 's' };
const result = { type: 'result', subtype: 'success', result: 'done' };
const base = { prompt: 'initial', cwd: '/tmp', provider: { type: 'claude' } } as AgentTurnInput;
async function collect(input: AgentTurnInput) {
  const events = [];
  for await (const event of new ClaudeSdkEngineAdapter().invoke(input)) events.push(event);
  return events;
}
beforeEach(() => { queryMock.mockReset(); });

describe('Claude steering adapter lifecycle', () => {
  it('registers after init, acknowledges a steer, revokes at result and drains SDK completion', async () => {
    let handle: SteeringHandle;
    let receipt: Promise<SteeringResult>;
    const unregister = vi.fn();
    queryMock.mockImplementation(({ prompt, options }: any) => (async function* () {
      expect(options.extraArgs).toEqual({ 'replay-user-messages': null });
      expect(options.permissionMode).toBe('default');
      expect(options.allowedTools).toEqual(['Read']);
      const reader = prompt[Symbol.asyncIterator]();
      await reader.next();
      yield initial;
      receipt = handle.submit('1', 'redirect');
      await Promise.resolve();
      const message = (await reader.next()).value;
      yield { ...message, isReplay: true };
      expect(await finalReceipt(receipt)).toEqual({ status: 'accepted' });
      yield result;
      expect(unregister).toHaveBeenCalledTimes(1);
      expect((await reader.next()).done).toBe(true);
      expect(await handle.submit('late', 'late')).toEqual({ status: 'not-delivered', reason: 'closed' });
    })() as any);
    const events = await collect({ ...base, allowedTools: ['Read'], registerSteering: (h) => { handle = h; return unregister; } });
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('withdraws a finish-edge submission before it reaches the SDK', async () => {
    let handle: SteeringHandle;
    let receipt: Promise<SteeringResult>;
    queryMock.mockImplementation(({ prompt }: any) => (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      yield initial;
      receipt = handle.submit('1', 'too late');
      await Promise.resolve();
      yield result;
      expect(await finalReceipt(receipt)).toEqual({ status: 'not-delivered', reason: 'closed' });
    })() as any);
    await collect({ ...base, registerSteering: (h) => { handle = h; return () => {}; } });
  });

  it('settles pending delivery and revokes on cancellation', async () => {
    const abortController = new AbortController();
    let handle: SteeringHandle;
    const unregister = vi.fn();
    queryMock.mockImplementation(({ prompt }: any) => (async function* () {
      const reader = prompt[Symbol.asyncIterator]();
      await reader.next();
      yield initial;
      const receipt = handle.submit('1', 'update');
      await Promise.resolve();
      await reader.next();
      abortController.abort();
      expect(await finalReceipt(receipt)).toEqual({ status: 'uncertain' });
      expect(unregister).toHaveBeenCalledTimes(1);
      throw new Error('cancelled');
    })() as any);
    await expect(collect({ ...base, abortController, registerSteering: (h) => { handle = h; return unregister; } })).rejects.toThrow('cancelled');
  });

  it('does not recover a missing session by replaying a turn after handing over a steer', async () => {
    let handle: SteeringHandle;
    queryMock.mockImplementation(({ prompt, options }: any) => (async function* () {
      const reader = prompt[Symbol.asyncIterator]();
      await reader.next();
      yield initial;
      const receipt = handle.submit('1', 'update');
      await Promise.resolve();
      await reader.next();
      options.stderr('No conversation found with session ID: s');
      yield { type: 'result', subtype: 'error_during_execution', is_error: true };
      // The receipt is settled on teardown; no automatic replay follows.
      void receipt;
    })() as any);
    await expect(collect({ ...base, sessionId: 's', registerSteering: (h) => { handle = h; return () => {}; } })).rejects.toThrow('not replayed');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the finite input path when steering is disabled', async () => {
    queryMock.mockImplementation(({ prompt, options }: any) => (async function* () {
      expect(options.extraArgs).toBeUndefined();
      const messages = [];
      for await (const message of prompt) messages.push(message);
      expect(messages).toHaveLength(1);
      yield initial;
      yield result;
    })() as any);
    await collect(base);
  });

  it('recovers a missing session with a fresh handle when no steer was handed over', async () => {
    const handles: SteeringHandle[] = [];
    const unregister = vi.fn();
    queryMock.mockImplementationOnce(({ options }: any) => (async function* () {
      yield initial;
      options.stderr('No conversation found with session ID: s');
      yield { type: 'result', subtype: 'error_during_execution', is_error: true };
    })() as any).mockImplementationOnce(() => (async function* () {
      yield { ...initial, session_id: 'fresh' };
      yield result;
    })() as any);
    await collect({ ...base, sessionId: 's', registerSteering: (h) => { handles.push(h); return unregister; } });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(handles.map((h) => h.sessionId)).toEqual(['s', 'fresh']);
    expect(handles[0].turnId).not.toBe(handles[1].turnId);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(await handles[0].submit('stale', 'update')).toEqual({ status: 'not-delivered', reason: 'closed' });
  });

  it('marks SDK crashes unknown and settles outstanding delivery without replay', async () => {
    let handle: SteeringHandle;
    let receipt: Promise<SteeringResult>;
    const unregister = vi.fn();
    queryMock.mockImplementation(({ prompt }: any) => (async function* () {
      const reader = prompt[Symbol.asyncIterator]();
      await reader.next();
      yield initial;
      receipt = handle.submit('1', 'update');
      await Promise.resolve();
      await reader.next();
      throw new Error('SDK crashed');
    })() as any);
    await expect(collect({ ...base, registerSteering: (h) => { handle = h; return unregister; } })).rejects.toMatchObject({ execution: 'unknown' });
    expect(await finalReceipt(receipt!)).toEqual({ status: 'uncertain' });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});

async function finalReceipt(receipt: Promise<import('./steering.js').SteeringResult>) {
  const result = await receipt;
  return result.status === 'pending' ? result.completion : result;
}
