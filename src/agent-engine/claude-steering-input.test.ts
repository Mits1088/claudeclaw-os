import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSteeringInput } from './claude-steering-input.js';
import { STEERING_LIMITS } from './steering.js';

afterEach(() => vi.useRealTimers());

describe('Claude streaming delivery receipts', () => {
  it('requires an exact replay receipt, not merely an SDK pull', async () => {
    const input = new ClaudeSteeringInput('initial', 'session');
    const reader = input[Symbol.asyncIterator]();
    expect((await reader.next()).value.message.content).toBe('initial');
    const receipt = input.submit('redirect');
    const message = (await reader.next()).value;
    let settled = false;
    void finalReceipt(receipt).then(() => { settled = true; });
    input.acknowledge({ ...message, isReplay: true, session_id: 'other' });
    input.acknowledge({ ...message, isReplay: false });
    await Promise.resolve();
    expect(settled).toBe(false);
    input.acknowledge({ ...message, isReplay: true });
    expect(await finalReceipt(receipt)).toEqual({ status: 'accepted' });
    input.dispose();
    expect((await reader.next()).done).toBe(true);
  });

  it('withdraws an unconsumed timed-out message so FIFO cannot duplicate it', async () => {
    vi.useFakeTimers();
    const input = new ClaudeSteeringInput('initial');
    const receipt = input.submit('never pulled');
    await vi.advanceTimersByTimeAsync(STEERING_LIMITS.requestTimeoutMs);
    expect(await finalReceipt(receipt)).toEqual({ status: 'not-delivered', reason: 'timeout' });
    const reader = input[Symbol.asyncIterator]();
    expect((await reader.next()).value.message.content).toBe('initial');
    const waiting = reader.next();
    input.dispose();
    expect((await waiting).done).toBe(true);
  });

  it('reports uncertainty after SDK consumption and ignores late receipts', async () => {
    vi.useFakeTimers();
    const input = new ClaudeSteeringInput('initial', 's');
    const reader = input[Symbol.asyncIterator]();
    await reader.next();
    const receipt = input.submit('consumed');
    const message = (await reader.next()).value;
    await vi.advanceTimersByTimeAsync(STEERING_LIMITS.lifetimeMs);
    expect(await finalReceipt(receipt)).toEqual({ status: 'uncertain' });
    input.acknowledge({ ...message, isReplay: true });
    expect(await finalReceipt(receipt)).toEqual({ status: 'uncertain' });
    input.dispose();
  });

  it('rejects queued input at completion while permitting in-flight acknowledgment', async () => {
    const input = new ClaudeSteeringInput('initial', 's');
    const reader = input[Symbol.asyncIterator]();
    await reader.next();
    const handed = input.submit('handed');
    const message = (await reader.next()).value;
    const queued = input.submit('queued');
    input.close();
    expect(await queued).toEqual({ status: 'not-delivered', reason: 'closed' });
    input.acknowledge({ ...message, isReplay: true });
    expect(await finalReceipt(handed)).toEqual({ status: 'accepted' });
    expect(await input.submit('late')).toEqual({ status: 'not-delivered', reason: 'closed' });
    input.dispose();
  });

  it('settles a consumed input as uncertain during teardown', async () => {
    const input = new ClaudeSteeringInput('initial');
    const reader = input[Symbol.asyncIterator]();
    await reader.next();
    const receipt = input.submit('handed');
    await reader.next();
    input.dispose();
    expect(await finalReceipt(receipt)).toEqual({ status: 'uncertain' });
  });

  it('keeps a two-minute tool-boundary acknowledgment pending without replay', async () => {
    vi.useFakeTimers();
    const input = new ClaudeSteeringInput('initial', 's');
    const reader = input[Symbol.asyncIterator]();
    await reader.next();
    const receipt = input.submit('update');
    const message = (await reader.next()).value;
    expect((await receipt).status).toBe('pending');
    let completed = false;
    void finalReceipt(receipt).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(120000);
    expect(completed).toBe(false);
    input.acknowledge({ ...message, isReplay: true });
    expect(await finalReceipt(receipt)).toEqual({ status: 'accepted' });
    input.dispose();
  });
});

async function finalReceipt(receipt: Promise<import('./steering.js').SteeringResult>) {
  const result = await receipt;
  return result.status === 'pending' ? result.completion : result;
}
