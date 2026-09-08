import { classifyError, type ErrorCategory } from './errors.js';
import type { ExecutionCertainty, ProviderFailure, ProviderFailureCategory } from './agent-engine/types.js';
import type { ProviderConfig } from './provider.js';

const REQUEST_PATTERNS = [
  'bad request', 'invalid request', 'invalid_request', 'malformed', 'unsupported model',
  'model is not supported', 'does not support this model', 'context length', 'context window',
  'maximum tokens', '400', '422',
  'model not found', 'model_not_found',
];
const UNAVAILABLE_PATTERNS = [
  'service unavailable', 'temporarily unavailable', 'provider unavailable', 'overloaded',
  'model unavailable', 'capacity', 'connection refused', 'econnrefused', 'econnreset', 'enotfound', 'dns',
  'fetch failed', 'socket hang up', '502', '503', '504', '529',
];

function includesAny(text: string, patterns: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function failureCategory(category: ErrorCategory, text: string): ProviderFailureCategory {
  if (category === 'auth') return 'auth';
  if (category === 'rate_limit') return 'rate_limit';
  // A model-specific rejection is a request problem even when its endpoint
  // happens to express it as a 404. A bare 404 remains unavailable: several
  // provider gateways use it when a configured backend has disappeared.
  if (includesAny(text, REQUEST_PATTERNS) || /model.{0,60}(does not exist|not found|not supported)/i.test(text)) return 'request';
  if (/\b401\b|\b403\b/.test(text)) return 'auth';
  if (/\b429\b/.test(text)) return 'rate_limit';
  if (/\b404\b/.test(text) || includesAny(text, UNAVAILABLE_PATTERNS)) return 'unavailable';
  if (category === 'network' || category === 'overloaded' || category === 'timeout' || category === 'subprocess_crash') {
    return 'unavailable';
  }
  if (category === 'context_exhausted' || category === 'billing' || category === 'provider_misconfigured') {
    return 'request';
  }
  return 'unknown';
}

function metadataCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const raw = error as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code']) {
    if (typeof raw[key] === 'string' || typeof raw[key] === 'number') return raw[key] as string | number;
  }
  return undefined;
}

function metadataRetryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const raw = error as Record<string, unknown>;
  for (const key of ['retryAfterMs', 'retry_after_ms']) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** Classify an adapter error without making any replay-safety inference. */
export function toProviderFailure(
  error: unknown,
  provider: ProviderConfig,
  execution: ExecutionCertainty = 'unknown',
): ProviderFailure {
  const classified = classifyError(error);
  const originalMessage = error instanceof Error ? error.message : String(error);
  const retryAfterMs = metadataRetryAfter(error) ?? (classified.recovery.retryAfterMs > 0
    ? classified.recovery.retryAfterMs
    : undefined);
  return {
    category: failureCategory(classified.category, originalMessage),
    execution,
    provider: provider.type,
    ...(provider.model ? { model: provider.model } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(metadataCode(error) !== undefined ? { code: metadataCode(error) } : {}),
    message: originalMessage,
  };
}

export type ProviderRecoveryDecision =
  | {
      action: 'retry';
      provider: ProviderConfig;
      attempt: number;
      delayMs: number;
      availableAtMs: number;
      reason: 'same_provider' | 'fallback_provider';
    }
  | {
      action: 'fail';
      reason: 'non_recoverable' | 'attempts_exhausted' | 'deadline_exceeded' | 'provider_not_configured';
    }
  | {
      action: 'reconcile';
      reason: 'execution_started' | 'execution_unknown';
    };

export interface ProviderRecoveryInput {
  failure: ProviderFailure;
  currentProvider: ProviderConfig;
  configuredProviders: readonly ProviderConfig[];
  /** The just-failed attempt, one based. */
  attempt: number;
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** Absolute workflow deadline. */
  deadlineAtMs: number;
  nowMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

function sameProvider(a: ProviderConfig, b: ProviderConfig): boolean {
  return a.type === b.type && (a.model ?? '') === (b.model ?? '') && (a.baseUrl ?? '') === (b.baseUrl ?? '');
}

/**
 * Pure scheduler seam for bounded recovery. It never invents providers and it
 * never authorizes replay without positive `not_started` evidence.
 */
export function decideProviderRecovery(input: ProviderRecoveryInput): ProviderRecoveryDecision {
  if (input.failure.execution === 'started') return { action: 'reconcile', reason: 'execution_started' };
  if (input.failure.execution !== 'not_started') return { action: 'reconcile', reason: 'execution_unknown' };
  if (input.failure.category !== 'unavailable' && input.failure.category !== 'rate_limit') {
    return { action: 'fail', reason: 'non_recoverable' };
  }
  if (!Number.isInteger(input.attempt) || input.attempt < 1 || !Number.isInteger(input.maxAttempts) || input.attempt >= input.maxAttempts) {
    return { action: 'fail', reason: 'attempts_exhausted' };
  }

  const index = input.configuredProviders.findIndex((provider) => sameProvider(provider, input.currentProvider));
  if (index < 0) return { action: 'fail', reason: 'provider_not_configured' };
  const provider = input.configuredProviders[index + 1] ?? input.configuredProviders[index];
  const base = Math.max(0, input.baseBackoffMs ?? 2_000);
  const cap = Math.max(base, input.maxBackoffMs ?? 60_000);
  const exponential = Math.min(cap, base * (2 ** Math.max(0, input.attempt - 1)));
  const delayMs = Math.max(exponential, input.failure.retryAfterMs ?? 0);
  const nowMs = input.nowMs ?? Date.now();
  const availableAtMs = nowMs + delayMs;
  if (!Number.isFinite(input.deadlineAtMs) || availableAtMs >= input.deadlineAtMs) {
    return { action: 'fail', reason: 'deadline_exceeded' };
  }
  return {
    action: 'retry',
    provider,
    attempt: input.attempt + 1,
    delayMs,
    availableAtMs,
    reason: index + 1 < input.configuredProviders.length ? 'fallback_provider' : 'same_provider',
  };
}
