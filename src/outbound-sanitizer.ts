/**
 * Shared outbound sanitization boundary (issue #269).
 *
 * ONE idempotent policy that every delivery and persistence seam calls before
 * model-generated text reaches a messenger, browser stream, voice consumer, or
 * a stored/serialized row. It reuses the existing credential detector
 * (`scanForSecrets` / `redactSecrets` in exfiltration-guard.ts) and the
 * configured protected-value set — this module adds the *boundary*, the
 * *opt-out semantics*, and the *fail-safe behaviour*, not new detection.
 *
 * Design notes (see docs/rfcs/outbound-output-sanitization.md):
 *
 *  - Idempotent: `redactSecrets` replaces every match with the literal
 *    `[REDACTED]`, which matches no detector pattern, so re-sanitizing already
 *    sanitized text is a no-op. Callers may therefore stack this guard at more
 *    than one seam (engine + send-side + persistence) without corruption.
 *  - Explicit opt-out: `enabled: false` is passthrough (returns the input
 *    verbatim), preserving the legacy `EXFILTRATION_GUARD_ENABLED=false`
 *    escape hatch. That deployment is UNGUARDED by definition.
 *  - Fail-safe: with the guard enabled, a detector throw must NOT return raw
 *    text. The affected payload is suppressed and replaced with a safe marker.
 *  - Diagnostics carry categories and counts only — never secret values or the
 *    matched substring.
 *
 * The pure functions here take everything they need as arguments and do NOT
 * import config, so they unit-test without an environment. `resolveOutbound-
 * Policy()` is the thin config-bound adapter the seams use at runtime.
 */

import { scanForSecrets, redactSecrets } from './exfiltration-guard.js';

/** Text emitted when the guard is enabled but the detector itself throws. */
export const SANITIZER_FAILURE_PLACEHOLDER = '[output withheld: sanitizer error]';

export interface SanitizeOptions {
  /**
   * Master switch. `false` is an explicit opt-out: the text is returned
   * unchanged and `redacted` is false. Defaults to `true` (fail-closed) when
   * omitted, so a caller that forgets to pass a policy still gets protection.
   */
  enabled?: boolean;
  /**
   * Raw protected values (e.g. resolved env secrets) to redact in raw, base64
   * and url-encoded form, in addition to the built-in credential patterns.
   */
  protectedValues?: string[];
  /** Seam label for diagnostics (e.g. 'telegram.final', 'mission.result'). */
  seam?: string;
  /**
   * Diagnostic sink invoked ONLY when something was redacted or suppressed.
   * Receives categories and counts, never raw secret text.
   */
  onEvent?: (event: SanitizeDiagnostic) => void;
}

export interface SanitizeDiagnostic {
  seam?: string;
  /** 'redacted' — matches removed; 'suppressed' — detector failed, payload replaced. */
  kind: 'redacted' | 'suppressed';
  matchCount: number;
  /** Distinct detector categories (e.g. ['anthropic_key','env_value']). */
  types: string[];
}

export interface SanitizeResult {
  /** The text safe to release. */
  text: string;
  /** True when any secret was redacted OR the payload was suppressed. */
  redacted: boolean;
  /** Number of detector matches removed (0 when suppressed or clean). */
  matchCount: number;
  /** Distinct detector categories that matched. */
  types: string[];
  /** True when the whole payload was replaced because the detector threw. */
  suppressed: boolean;
}

const CLEAN = (text: string): SanitizeResult => ({
  text,
  redacted: false,
  matchCount: 0,
  types: [],
  suppressed: false,
});

function emit(options: SanitizeOptions, event: SanitizeDiagnostic): void {
  try { options.onEvent?.(event); } catch { /* Diagnostics cannot reopen the output boundary. */ }
}

/**
 * Sanitize a single text payload. Idempotent and fail-safe.
 *
 * @param text     The outbound text.
 * @param options  Policy: enabled flag, protected values, diagnostics sink.
 */
export function sanitizeOutbound(text: string, options: SanitizeOptions = {}): SanitizeResult {
  const enabled = options.enabled ?? true;
  if (!enabled) return CLEAN(text);
  if (!text) return CLEAN(text);

  try {
    const matches = scanForSecrets(text, options.protectedValues);
    if (matches.length === 0) return CLEAN(text);

    const types = [...new Set(matches.map((m) => m.type))];
    // Merge overlapping detector/protected-value matches before replacement.
    // Replacing overlapping ranges separately corrupts offsets and can leave
    // part of the larger secret visible after the first replacement.
    const ranges = matches.map(match => ({ ...match })).sort((a, b) => a.position - b.position);
    const merged: typeof ranges = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.position <= previous.position + previous.length) {
        previous.length = Math.max(previous.position + previous.length, range.position + range.length) - previous.position;
      } else merged.push(range);
    }
    const redactedText = redactSecrets(text, merged);
    emit(options, {
      seam: options.seam,
      kind: 'redacted',
      matchCount: matches.length,
      types,
    });
    return {
      text: redactedText,
      redacted: true,
      matchCount: matches.length,
      types,
      suppressed: false,
    };
  } catch {
    // Fail-closed: with the guard enabled, a detector fault must never let raw
    // text through. Suppress the payload and report a safe diagnostic.
    emit(options, {
      seam: options.seam,
      kind: 'suppressed',
      matchCount: 0,
      types: [],
    });
    return {
      text: SANITIZER_FAILURE_PLACEHOLDER,
      redacted: true,
      matchCount: 0,
      types: [],
      suppressed: true,
    };
  }
}

/**
 * Convenience wrapper returning just the safe string. Use when the caller does
 * not need the diagnostic result object.
 */
export function sanitizeOutboundText(text: string, options: SanitizeOptions = {}): string {
  return sanitizeOutbound(text, options).text;
}

/**
 * Resolve the concrete raw secret values for a set of env var names against an
 * environment map. Pure — the environment is passed in. Values of 8 chars or
 * fewer are dropped (they are too short to be a meaningful credential and would
 * cause pathological false positives); the detector applies the same floor.
 */
export function resolveProtectedValues(
  varNames: string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return varNames
    .map((key) => env[key])
    .filter((v): v is string => !!v && v.length > 8);
}
