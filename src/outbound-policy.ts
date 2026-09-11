/**
 * Config-bound adapter for the shared outbound sanitizer (issue #269).
 *
 * Kept separate from `outbound-sanitizer.ts` so the pure sanitizer/stream-guard
 * unit tests never pull `config.ts` (which reads the environment at import).
 * Seams call `resolveOutboundPolicy()` once per turn to snapshot the effective
 * policy, then pass it to `sanitizeOutbound` / `OutboundStreamGuard`.
 */

import { EXFILTRATION_GUARD_ENABLED, PROTECTED_ENV_VARS } from './config.js';
import { logger } from './logger.js';
import { configuredProtectedValues } from './protected-values.js';
import { type SanitizeDiagnostic, type SanitizeOptions } from './outbound-sanitizer.js';

export interface OutboundPolicy {
  enabled: boolean;
  protectedValues: string[];
}

/**
 * Snapshot the effective outbound policy for a turn: the enabled flag and the
 * concrete protected secret values resolved from the current environment.
 */
export function resolveOutboundPolicy(
  env: Record<string, string | undefined> = process.env,
): OutboundPolicy {
  return {
    enabled: EXFILTRATION_GUARD_ENABLED,
    protectedValues: configuredProtectedValues(PROTECTED_ENV_VARS, env),
  };
}

/** Default diagnostic sink: structured warn log with categories/counts only. */
export function logSanitizerEvent(event: SanitizeDiagnostic): void {
  if (event.kind === 'suppressed') {
    logger.error(
      { seam: event.seam },
      'Outbound sanitizer: detector failed, payload suppressed',
    );
    return;
  }
  logger.warn(
    { seam: event.seam, matchCount: event.matchCount, types: event.types },
    'Outbound sanitizer: redacted secrets before delivery/persistence',
  );
}

/**
 * Build ready-to-use SanitizeOptions for a seam from the current config policy.
 * The returned options carry the logging sink and the resolved policy.
 */
export function outboundOptionsForSeam(
  seam: string,
  policy: OutboundPolicy = resolveOutboundPolicy(),
): SanitizeOptions {
  return {
    seam,
    enabled: policy.enabled,
    protectedValues: policy.protectedValues,
    onEvent: logSanitizerEvent,
  };
}
