import type { RegisterSteering, SteeringHandle } from './agent-engine/steering.js';

/** Only the authenticated Telegram text route consumes this process-local registry. */
const active = new Map<string, { provider: string; handle: SteeringHandle }>();
const generations = new Map<string, symbol>();
const recorded = new WeakMap<SteeringHandle, Set<string>>();
const key = (agentId: string, chatId: string): string => JSON.stringify([agentId, chatId]);

export function registerChatSteering(agentId: string, chatId: string, provider: string): RegisterSteering {
  const id = key(agentId, chatId);
  const generation = Symbol();
  generations.set(id, generation);
  active.delete(id);
  return (handle) => {
    if (generations.get(id) !== generation) return () => {};
    const entry = { provider, handle };
    active.set(id, entry);
    return () => {
      if (active.get(id) === entry) active.delete(id);
      if (generations.get(id) === generation) generations.delete(id);
    };
  };
}

export function getChatSteering(agentId: string, chatId: string, provider: string): SteeringHandle | undefined {
  const entry = active.get(key(agentId, chatId));
  return entry?.provider === provider ? entry.handle : undefined;
}

/** Called only for accepted/uncertain receipts, bounded by the handle's submission cap. */
export function claimSteeringReceipt(handle: SteeringHandle, messageId: string): boolean {
  let ids = recorded.get(handle);
  if (!ids) { ids = new Set(); recorded.set(handle, ids); }
  if (ids.has(messageId)) return false;
  ids.add(messageId);
  return true;
}

export function revokeChatSteering(agentId: string, chatId: string): void {
  active.delete(key(agentId, chatId));
  generations.delete(key(agentId, chatId));
}
