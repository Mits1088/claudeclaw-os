import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveAgentDir } from './agent-config.js';
import type { ProviderConfig } from './provider.js';
import { defaultModelForProvider } from './active-provider.js';

export interface MissionProviderPolicy {
  fallbackProviders: ProviderConfig[];
  coordinatorProvider?: ProviderConfig;
  maxAttempts: number;
  maxRuntimeSeconds: number;
  cooldownSeconds: number;
  retryRateLimit: boolean;
}

export const DEFAULT_MISSION_PROVIDER_MAX_RUNTIME_SECONDS = 1_800;

function configuredProvider(value: unknown): ProviderConfig {
  const raw = typeof value === 'string' ? { type: value } : value as Record<string, unknown> | null;
  if (!raw || (raw.type !== 'claude' && raw.type !== 'openai')) {
    throw new Error('Mission fallback/coordinator providers must explicitly select claude or openai');
  }
  const provider: ProviderConfig = { type: raw.type, dangerouslySkipPermissions: false };
  if (raw.model !== undefined && (typeof raw.model !== 'string' || !raw.model.trim())) throw new Error('Invalid mission provider model');
  provider.model = typeof raw.model === 'string' ? raw.model : defaultModelForProvider(provider);
  if (typeof raw.thinkingMode === 'string') provider.thinkingMode = raw.thinkingMode;
  if (typeof raw.runtimeMode === 'string') provider.runtimeMode = raw.runtimeMode;
  return provider;
}

export function parseMissionProviderPolicy(raw: Record<string, unknown>): MissionProviderPolicy {
  const fallback = raw.fallback as Record<string, unknown> | undefined;
  if (fallback !== undefined && (!fallback || typeof fallback !== 'object' || Array.isArray(fallback))) throw new Error('fallback must be an object');
  const bounded = (name: string, defaultValue: number, max: number) => {
    const value = fallback?.[name] ?? defaultValue;
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid fallback.${name}`);
    return Number(value);
  };
  const providers = fallback?.providers ?? [];
  if (!Array.isArray(providers) || providers.length > 2) throw new Error('fallback.providers must contain at most two explicit providers');
  if (fallback?.trigger !== undefined && !['unavailable', 'unavailable+ratelimit'].includes(String(fallback.trigger))) throw new Error('Invalid fallback.trigger');
  return {
    fallbackProviders: providers.map(configuredProvider),
    ...(raw.coordinator_provider !== undefined ? { coordinatorProvider: configuredProvider(raw.coordinator_provider) } : {}),
    maxAttempts: bounded('max_attempts', 3, 10),
    maxRuntimeSeconds: bounded('max_runtime_seconds', DEFAULT_MISSION_PROVIDER_MAX_RUNTIME_SECONDS, 3600),
    cooldownSeconds: bounded('cooldown_seconds', 60, 3600),
    retryRateLimit: fallback?.trigger === 'unavailable+ratelimit',
  };
}

export function loadMissionProviderPolicy(agent: string): MissionProviderPolicy {
  const file = path.join(resolveAgentDir(agent), 'agent.yaml');
  return parseMissionProviderPolicy(fs.existsSync(file) ? (yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) ?? {} : {});
}

/** The release's supported coordinator contract is deliberately narrower than worker execution. */
export function canCoordinateMission(provider: ProviderConfig): boolean {
  return provider.type === 'claude' || provider.type === 'openai';
}
