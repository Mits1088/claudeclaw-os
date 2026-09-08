import {
  getCurrentMissionProviderRecoveryState,
  type CurrentMissionProviderRecoveryRow,
  type CurrentProviderHealthRow,
} from './db.js';

export type MissionProviderCircuitState = 'closed' | 'open' | 'probing' | 'probe_ready' | 'untracked';

export interface MissionProviderStatus {
  taskId: string;
  agentId: string;
  taskStatus: 'queued' | 'running';
  provider: string;
  model?: string;
  attempt: number;
  retryReason: string;
  retryAt: number | null;
  deadlineAt: number;
  failureCategory?: string;
  circuit: {
    state: MissionProviderCircuitState;
    failures: number;
    retryAt: number | null;
  };
}

type SavedProvider = { type: string; model?: string; baseUrl?: string };

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
  return clean || fallback;
}

function savedProvider(json: string): SavedProvider | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return {
      type: safeLabel(raw.type, 'unknown'),
      ...(typeof raw.model === 'string' ? { model: safeLabel(raw.model, 'unknown') } : {}),
      // Used only to find the DB-owned health key. It is never returned.
      ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
    };
  } catch {
    return null;
  }
}

function failureCategory(json: string | null): string | undefined {
  if (!json) return undefined;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    return typeof raw.category === 'string' ? safeLabel(raw.category, 'unknown') : undefined;
  } catch {
    return undefined;
  }
}

const REASONS: Record<string, string> = {
  same_provider: 'retrying the same provider',
  fallback_provider: 'using configured mission fallback',
  provider_unavailable: 'provider unavailable',
  attempts_exhausted: 'recovery attempts exhausted',
  deadline_exceeded: 'recovery deadline exceeded',
  rate_limit_trigger_disabled: 'rate-limit recovery is disabled',
};

function retryReason(reason: string | null): string {
  if (!reason) return 'bounded provider recovery';
  if (reason.startsWith('provider_unavailable: circuit open')) return 'provider circuit is open; awaiting bounded probe';
  return REASONS[reason] ?? 'bounded provider recovery';
}

function circuitFor(row: CurrentProviderHealthRow | undefined, now: number): MissionProviderStatus['circuit'] {
  if (!row) return { state: 'untracked', failures: 0, retryAt: null };
  if (row.failures < 2) return { state: 'closed', failures: row.failures, retryAt: null };
  if (row.open_until > now) return { state: 'open', failures: row.failures, retryAt: row.open_until };
  if (row.probe_until > now) return { state: 'probing', failures: row.failures, retryAt: row.probe_until };
  return { state: 'probe_ready', failures: row.failures, retryAt: null };
}

export function missionProviderStatuses(agentId?: string, now = Math.floor(Date.now() / 1000)): MissionProviderStatus[] {
  const snapshot = getCurrentMissionProviderRecoveryState(agentId);
  const health = new Map(snapshot.providerHealth.map((row) => [row.provider_key, row]));
  return snapshot.recoveries.map((row: CurrentMissionProviderRecoveryRow) => {
    const provider = savedProvider(row.provider_json);
    const category = failureCategory(row.failure_json);
    const providerType = provider?.type ?? 'unknown';
    const key = `${providerType}:${provider?.baseUrl ?? 'default'}:${provider?.model ?? 'default'}`;
    const healthRow = health.get(key);
    return {
      taskId: row.task_id,
      agentId: row.assigned_agent,
      taskStatus: row.task_status,
      provider: providerType,
      ...(provider?.model ? { model: provider.model } : {}),
      attempt: row.attempts + 1,
      retryReason: retryReason(row.reason),
      retryAt: row.task_status === 'queued' ? row.available_at : null,
      deadlineAt: row.deadline_at,
      ...(category || healthRow?.failure_category
        ? { failureCategory: category ?? safeLabel(healthRow?.failure_category, 'unknown') }
        : {}),
      circuit: circuitFor(healthRow, now),
    };
  });
}

function timeLabel(epoch: number, now: number): string {
  const delta = epoch - now;
  if (delta <= 0) return 'now';
  if (delta < 60) return `in ${delta}s`;
  return `in ${Math.ceil(delta / 60)}m`;
}

export function formatMissionProviderStatuses(statuses: readonly MissionProviderStatus[], now = Math.floor(Date.now() / 1000)): string[] {
  return statuses.map((status) => {
    const execution = status.taskStatus === 'running'
      ? 'running recovery attempt'
      : `recovery queued${status.retryAt ? ` ${timeLabel(status.retryAt, now)}` : ''}`;
    const model = status.model ? `/${status.model}` : '';
    const circuit = status.circuit.state === 'open'
      ? `open (tripped${status.circuit.retryAt ? ` until ${timeLabel(status.circuit.retryAt, now)}` : ''})`
      : status.circuit.state === 'probing'
        ? 'half-open (probe in progress)'
        : status.circuit.state === 'probe_ready'
          ? 'half-open (probe ready)'
          : status.circuit.state === 'closed'
            ? 'closed (provider available)'
            : 'not yet recorded';
    const category = status.failureCategory ? `; failure ${status.failureCategory}` : '';
    return `${status.taskId}: ${execution} on ${status.provider}${model}, attempt ${status.attempt}; ${status.retryReason}${category}; deadline ${timeLabel(status.deadlineAt, now)}; circuit ${circuit}`;
  });
}
