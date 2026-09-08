import { randomUUID } from 'node:crypto';
import { claimProviderHealth, recordProviderHealth, getMissionProviderRecovery, getMissionWorkflow, deferMissionForProvider, logToHiveMind, recordMissionProviderFailure, enqueueMissionSystemReport, type MissionTask } from './db.js';
import { canCoordinateMission, loadMissionProviderPolicy, type MissionProviderPolicy } from './mission-provider-policy.js';
import { decideProviderRecovery } from './provider-recovery.js';
import type { ProviderFailure } from './agent-engine/types.js';
import { effectiveSkipPermissions, type ProviderConfig } from './provider.js';

export interface MissionProviderAttempt {
  provider: ProviderConfig;
  providers: ProviderConfig[];
  policy: MissionProviderPolicy;
  attempt: number;
  deadlineAt: number;
  deadlineSource: 'provider_runtime' | 'persisted_recovery' | 'workflow';
  token: string;
  key: string;
  /** False when this policy deliberately bypassed a rate-limit-only circuit. */
  healthTracked: boolean;
}

export function missionProviderDeadlineDescription(attempt: Pick<MissionProviderAttempt, 'deadlineAt' | 'deadlineSource'>): string {
  if (attempt.deadlineSource === 'workflow') {
    return `Workflow deadline reached at ${new Date(attempt.deadlineAt * 1000).toISOString()}`;
  }
  return 'Bounded provider recovery deadline exhausted';
}

type CategorizedHealthClaim = ReturnType<typeof claimProviderHealth> & {
  /** The failure category that opened the shared circuit, when it is open. */
  failureCategory?: ProviderFailure['category'];
};

type RecordCategorizedProviderHealth = (
  key: string,
  token: string,
  now: number,
  cooldown: number,
  error?: string,
  failureCategory?: ProviderFailure['category'],
) => ReturnType<typeof recordProviderHealth>;

function recordFailure(mission: MissionTask, failureJson: string, reason: string, deadlineAt: number): boolean {
  if (mission.claiming_instance_id) {
    return recordMissionProviderFailure(mission.id, failureJson, reason, deadlineAt,
      { agentId: mission.assigned_agent!, instanceId: mission.claiming_instance_id, generation: mission.claim_generation });
  }
  return recordMissionProviderFailure(mission.id, failureJson, reason, deadlineAt);
}

export function prepareMissionProvider(mission: MissionTask, primary: ProviderConfig):
  { kind: 'run'; attempt: MissionProviderAttempt } | { kind: 'queued' } | { kind: 'blocked'; reason: string } {
  const policy = loadMissionProviderPolicy(mission.assigned_agent!);
  const selected = mission.role === 'coordinator' ? policy.coordinatorProvider ?? primary : primary;
  const providers = [selected, ...policy.fallbackProviders.map(provider => ({ ...provider,
    // A fallback can preserve an existing grant only when both sides explicitly
    // carry it. Policy parsing currently denies it, and execution must never
    // manufacture a broader permission boundary during recovery.
    dangerouslySkipPermissions: effectiveSkipPermissions(selected) && effectiveSkipPermissions(provider),
  }))];
  const recovery = getMissionProviderRecovery(mission.id);
  const saved = recovery?.provider_json ? JSON.parse(recovery.provider_json) as ProviderConfig : null;
  // A removed fallback is no longer authorized, even for an already queued retry.
  const start = saved ? providers.findIndex(provider => provider.type === saved.type && provider.model === saved.model) : 0;
  if (start < 0) return { kind: 'blocked', reason: 'Configured recovery provider was removed; explicit review required' };
  const now = Math.floor(Date.now() / 1000);
  const workflow = mission.workflow_id ? getMissionWorkflow(mission.workflow_id) : null;
  const policyDeadlineAt = now + policy.maxRuntimeSeconds;
  let deadlineAt = policyDeadlineAt;
  let deadlineSource: MissionProviderAttempt['deadlineSource'] = 'provider_runtime';
  if (recovery?.deadline_at != null && recovery.deadline_at <= deadlineAt) {
    deadlineAt = recovery.deadline_at;
    deadlineSource = 'persisted_recovery';
  }
  if (workflow?.deadline_at != null && workflow.deadline_at <= deadlineAt) {
    deadlineAt = workflow.deadline_at;
    deadlineSource = 'workflow';
  }
  if ((recovery?.attempts ?? 0) >= policy.maxAttempts) {
    recordFailure(mission, recovery?.failure_json ?? '{}', 'attempts_exhausted', deadlineAt);
    return { kind: 'blocked', reason: 'Bounded provider recovery attempts exhausted' };
  }
  if (now >= deadlineAt) {
    recordFailure(mission, recovery?.failure_json ?? '{}', 'deadline_exceeded', deadlineAt);
    return { kind: 'blocked', reason: missionProviderDeadlineDescription({ deadlineAt, deadlineSource }) };
  }
  const token = randomUUID();
  let retryAt = now + policy.cooldownSeconds;
  for (const provider of providers.slice(start)) {
    if (mission.role === 'coordinator' && !canCoordinateMission(provider)) continue;
    const key = `${provider.type}:${provider.baseUrl ?? 'default'}:${provider.model ?? 'default'}`;
    const health = claimProviderHealth(key, token, now) as CategorizedHealthClaim;
    if (health.allowed) return { kind: 'run', attempt: { provider, providers, policy, attempt: (recovery?.attempts ?? 0) + 1, deadlineAt, deadlineSource, token, key, healthTracked: true } };
    // Provider health is shared, but recovery triggers are agent-local policy.
    // Do not reinterpret a rate-limit circuit opened by an opted-in agent as an
    // availability outage for an agent whose current policy excludes 429s.
    if (health.failureCategory === 'rate_limit' && !policy.retryRateLimit) {
      return { kind: 'run', attempt: { provider, providers, policy, attempt: (recovery?.attempts ?? 0) + 1, deadlineAt, deadlineSource, token, key, healthTracked: false } };
    }
    retryAt = Math.max(retryAt, health.retryAt);
  }
  if (mission.role === 'coordinator' && !providers.some(canCoordinateMission)) {
    return { kind: 'blocked', reason: 'blocked_capability: no explicitly authorized provider can execute mission_transition' };
  }
  const queued = deferMissionForProvider({ taskId: mission.id, providerJson: JSON.stringify(providers[start]), failureJson: JSON.stringify({ category: 'unavailable', execution: 'not_started' }),
    deadlineAt, availableAt: retryAt, reason: 'provider_unavailable: circuit open; waiting for a bounded health probe', countAttempt: false,
    ...(mission.claiming_instance_id ? { fence: { agentId: mission.assigned_agent!, instanceId: mission.claiming_instance_id, generation: mission.claim_generation } } : {}) });
  return queued ? { kind: 'queued' } : { kind: 'blocked', reason: missionProviderDeadlineDescription({ deadlineAt, deadlineSource }) };
}

export function recoverMissionProvider(mission: MissionTask, attempt: MissionProviderAttempt, failure: ProviderFailure): boolean {
  if (failure.category === 'rate_limit' && !attempt.policy.retryRateLimit) {
    recordFailure(mission, JSON.stringify(failure), 'rate_limit_trigger_disabled', attempt.deadlineAt);
    return false;
  }
  const decision = decideProviderRecovery({ failure, currentProvider: attempt.provider, configuredProviders: attempt.providers,
    attempt: attempt.attempt, maxAttempts: attempt.policy.maxAttempts, deadlineAtMs: attempt.deadlineAt * 1000 });
  recordFailure(mission, JSON.stringify(failure), decision.reason, attempt.deadlineAt);
  if (decision.action !== 'retry') return false;
  return deferMissionForProvider({ taskId: mission.id, providerJson: JSON.stringify(decision.provider), failureJson: JSON.stringify(failure),
    deadlineAt: attempt.deadlineAt, availableAt: Math.ceil(decision.availableAtMs / 1000), reason: decision.reason,
    ...(mission.claiming_instance_id ? { fence: { agentId: mission.assigned_agent!, instanceId: mission.claiming_instance_id, generation: mission.claim_generation } } : {}) });
}

export function settleMissionProviderHealth(mission: MissionTask, attempt: MissionProviderAttempt, failure?: ProviderFailure): string | null {
  return settleSharedProviderHealth(mission.assigned_agent!, attempt, failure);
}

/** Shared durable event/report boundary for mission and interactive callers. */
export function settleSharedProviderHealth(agent: string, attempt: Pick<MissionProviderAttempt, 'healthTracked' | 'policy' | 'key' | 'token' | 'provider'>, failure?: ProviderFailure): string | null {
  if (!attempt.healthTracked) return null;
  if (failure?.category === 'rate_limit' && !attempt.policy.retryRateLimit) return null;
  if (failure && !['unavailable', 'rate_limit'].includes(failure.category)) return null;
  // The DB owns shared circuit state. Carry the typed cause so a claimant can
  // enforce its own trigger policy instead of guessing from an error string.
  const event = (recordProviderHealth as RecordCategorizedProviderHealth)(attempt.key, attempt.token,
    Math.floor(Date.now() / 1000), attempt.policy.cooldownSeconds, failure?.message, failure?.category);
  if (!event) return null;
  const message = `Provider ${event}: ${attempt.provider.type}. ${event === 'trip' ? 'Missions use configured fallback or wait within recovery limits.' : 'Primary provider is available again.'}`;
  logToHiveMind(agent, 'mission', 'provider_health', message);
  enqueueMissionSystemReport(`provider:${attempt.key}:${event}:${randomUUID()}`, agent, message);
  return message;
}
