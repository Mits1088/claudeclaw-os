import { expect, it } from 'vitest';
import { getChatSteering, registerChatSteering, revokeChatSteering } from './steering.js';
import type { SteeringHandle } from './agent-engine/steering.js';

it('isolates agent/chat/provider and prevents stale cleanup from deleting a newer turn', () => {
  const handle: SteeringHandle = { sessionId: 's', turnId: 't', submit: async () => ({ status: 'accepted' }) };
  const removeOld = registerChatSteering('a', 'c', 'p')(handle);
  expect(getChatSteering('b', 'c', 'p')).toBeUndefined();
  expect(getChatSteering('a', 'd', 'p')).toBeUndefined();
  expect(getChatSteering('a', 'c', 'other')).toBeUndefined();
  const next = { ...handle, turnId: 'next' };
  const removeNew = registerChatSteering('a', 'c', 'p')(next);
  removeOld();
  expect(getChatSteering('a', 'c', 'p')).toBe(next);
  removeNew();
  expect(getChatSteering('a', 'c', 'p')).toBeUndefined();
});

it('rejects late registration from an invocation reset before its provider started', () => {
  const register = registerChatSteering('a', 'c', 'p');
  revokeChatSteering('a', 'c');
  register({ sessionId: 's', turnId: 'late', submit: async () => ({ status: 'accepted' }) });
  expect(getChatSteering('a', 'c', 'p')).toBeUndefined();
});
