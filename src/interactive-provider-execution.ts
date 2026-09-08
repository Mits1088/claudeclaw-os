import { randomUUID } from 'node:crypto';
import { claimProviderHealth } from './db.js';
import { loadMissionProviderPolicy } from './mission-provider-policy.js';
import { settleSharedProviderHealth } from './mission-provider-execution.js';
import { getMissionExecutionContext } from './mission-execution-context.js';
import { decideProviderRecovery, toProviderFailure } from './provider-recovery.js';
import { effectiveSkipPermissions, type ProviderConfig } from './provider.js';
import type { ProviderFailure } from './agent-engine/types.js';

/** Interactive recovery never claims or retries a scheduler-owned mission. */
export async function executeInteractiveProvider<T extends { failure?: ProviderFailure; aborted?: boolean }>(input: {
  agent: string;
  primary: ProviderConfig;
  signal: AbortSignal;
  invoke: (provider: ProviderConfig, fallback: boolean) => Promise<T>;
  wait: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}): Promise<T> {
  if (getMissionExecutionContext()) throw new Error('Mission execution requires scheduler provider admission; interactive recovery is forbidden');
  const policy = loadMissionProviderPolicy(input.agent);
  const providers = [input.primary, ...policy.fallbackProviders.map(provider => ({
    ...provider,
    dangerouslySkipPermissions: effectiveSkipPermissions(input.primary) && effectiveSkipPermissions(provider),
  }))];
  const deadlineAtMs = Date.now() + policy.maxRuntimeSeconds * 1000;
  let index = 0;
  for (let number = 1; number <= policy.maxAttempts; number++) {
    if (input.signal.aborted) throw new Error('Interactive recovery aborted');
    if (Date.now() >= deadlineAtMs) throw new Error('Interactive provider recovery deadline exhausted');
    let provider = providers[index];
    let token = randomUUID();
    let key = '';
    let healthTracked = false;
    for (;;) {
      key = `${provider.type}:${provider.baseUrl ?? 'default'}:${provider.model ?? 'default'}`;
      const health = claimProviderHealth(key, token, Math.floor(Date.now() / 1000));
      healthTracked = health.allowed;
      if (health.allowed || (health.failureCategory === 'rate_limit' && !policy.retryRateLimit)) break;
      if (++index >= providers.length) throw new Error('Configured providers unavailable: shared circuit open');
      provider = providers[index];
      token = randomUUID();
    }
    const attempt = { provider, token, key, healthTracked, policy };
    let result: T | undefined;
    let error: unknown;
    let failure: ProviderFailure | undefined;
    try {
      result = await input.invoke(provider, index > 0);
      failure = result.failure;
    } catch (caught) {
      error = caught;
      failure = (caught as { failure?: ProviderFailure } | null)?.failure ?? toProviderFailure(caught, provider);
    }
    // Cancellation is not evidence of provider recovery.
    if (!input.signal.aborted && !result?.aborted) settleSharedProviderHealth(input.agent, attempt, failure);
    if (!failure) return result!;
    const decision = decideProviderRecovery({ failure, currentProvider: provider, configuredProviders: providers,
      attempt: number, maxAttempts: policy.maxAttempts, deadlineAtMs });
    if (input.signal.aborted || (failure.category === 'rate_limit' && !policy.retryRateLimit) || decision.action !== 'retry') {
      if (result) return result;
      throw error;
    }
    if (decision.reason === 'fallback_provider') index++;
    input.onRetry?.(number, error ?? failure);
    await input.wait(decision.delayMs);
  }
  throw new Error('Interactive provider recovery attempts exhausted');
}
