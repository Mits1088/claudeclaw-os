import { AsyncLocalStorage } from 'node:async_hooks';

const entry = new AsyncLocalStorage<string>();
export const MISSION_ENTRY_KEY_ENV = 'CLAUDECLAW_MISSION_ENTRY_KEY';
export function runWithMissionEntryKey<T>(key: string, fn: () => T): T { return entry.run(key, fn); }
export function getMissionEntryKey(): string | undefined { return entry.getStore() ?? process.env[MISSION_ENTRY_KEY_ENV]; }
export function missionEntryEnv(): Record<string, string> {
  const key = getMissionEntryKey();
  return key ? { [MISSION_ENTRY_KEY_ENV]: key } : {};
}
