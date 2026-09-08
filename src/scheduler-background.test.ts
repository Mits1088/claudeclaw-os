import { describe, expect, it } from 'vitest';

import { messageQueue } from './message-queue.js';
import { missionExecutionQueueKey } from './scheduler.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('background mission coordinator lane', () => {
  it('detaches only durable workflow coordinators from the interactive chat lane', () => {
    expect(missionExecutionQueueKey(
      { role: 'coordinator', workflow_id: 'workflow-1' },
      'astra',
      'telegram-chat',
    )).toBe('mission-control:astra');

    // A workflow worker still has normal workspace authority. Until workers
    // have isolated checkouts, it must serialize with the interactive agent.
    expect(missionExecutionQueueKey(
      { role: 'task', workflow_id: 'workflow-1' },
      'astra',
      'telegram-chat',
    )).toBe('telegram-chat');
    expect(missionExecutionQueueKey(
      { role: 'continuation' },
      'astra',
      'telegram-chat',
    )).toBe('telegram-chat');
    expect(missionExecutionQueueKey(
      { role: 'task' },
      'headless-worker',
      '',
    )).toBe('mission');
  });

  it('runs the coordinator lane beside chat while retaining FIFO within the lane', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const chatKey = `chat-test:${suffix}`;
    const coordinatorKey = `mission-control:test:${suffix}`;
    const releaseChat = deferred();
    const releaseFirstCoordinator = deferred();
    const chatStarted = deferred();
    const chatFinished = deferred();
    const firstCoordinatorStarted = deferred();
    const secondCoordinatorFinished = deferred();
    const events: string[] = [];

    messageQueue.enqueue(chatKey, async () => {
      events.push('chat:start');
      chatStarted.resolve();
      await releaseChat.promise;
      events.push('chat:end');
      chatFinished.resolve();
    });
    await chatStarted.promise;

    messageQueue.enqueue(coordinatorKey, async () => {
      events.push('coordinator-1:start');
      firstCoordinatorStarted.resolve();
      await releaseFirstCoordinator.promise;
      events.push('coordinator-1:end');
    });
    messageQueue.enqueue(coordinatorKey, async () => {
      events.push('coordinator-2:start');
      events.push('coordinator-2:end');
      secondCoordinatorFinished.resolve();
    });

    await firstCoordinatorStarted.promise;
    expect(events).toEqual(['chat:start', 'coordinator-1:start']);
    expect(messageQueue.queuedFor(chatKey)).toBe(1);
    expect(messageQueue.queuedFor(coordinatorKey)).toBe(2);

    releaseFirstCoordinator.resolve();
    await secondCoordinatorFinished.promise;
    expect(events).toEqual([
      'chat:start',
      'coordinator-1:start',
      'coordinator-1:end',
      'coordinator-2:start',
      'coordinator-2:end',
    ]);
    expect(messageQueue.queuedFor(chatKey)).toBe(1);

    releaseChat.resolve();
    await chatFinished.promise;
    await Promise.resolve();
    expect(messageQueue.queuedFor(chatKey)).toBe(0);
    expect(messageQueue.queuedFor(coordinatorKey)).toBe(0);
  });
});
