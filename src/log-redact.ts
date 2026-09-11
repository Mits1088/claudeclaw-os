/**
 * Secret redaction for anything on its way to a log sink.
 *
 * Why here and not at the call sites: the Telegram bot token leaked through
 * `err.message`, not through a field anyone chose to log. node-fetch builds
 * "request to https://api.telegram.org/bot<TOKEN>/getUpdates failed, reason: ..."
 * and grammy propagates it, so every `logger.error({ err })` on the polling
 * path wrote the token to disk. Patching one catch block leaves the next one
 * free to reintroduce it — this is a chokepoint, not a convention.
 *
 * Redaction is best-effort and deliberately conservative: it rewrites known
 * credential shapes and never tries to guess. Anything unmatched still reaches
 * the log, so this is a safety net, not a licence to log secrets on purpose.
 */

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: string;
}

// Ordered most-specific first. All patterns are global + case-insensitive
// where the credential shape allows it.
const RULES: readonly Rule[] = [
  {
    // Telegram bot tokens are <numeric-id>:<35-char secret>, and leak inside
    // api.telegram.org URLs. Keep the numeric id: it identifies the bot for
    // debugging and is not itself a credential.
    name: 'telegram-bot-token',
    pattern: /(api\.telegram\.org\/bot)(\d+):[A-Za-z0-9_-]+/g,
    replace: '$1$2:<redacted>',
  },
  {
    // Bare token outside a URL (defensive: grammy sometimes formats its own).
    name: 'telegram-bot-token-bare',
    pattern: /\b(\d{8,12}):(AA[A-Za-z0-9_-]{30,})\b/g,
    replace: '$1:<redacted>',
  },
  {
    name: 'authorization-header',
    pattern: /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: '$1 <redacted>',
  },
  {
    name: 'url-userinfo',
    pattern: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g,
    replace: '$1<redacted>@',
  },
  {
    name: 'anthropic-key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replace: '<redacted>',
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replace: '<redacted>',
  },
  {
    name: 'slack-token',
    pattern: /\bxox[bpsare]-[A-Za-z0-9-]{10,}/g,
    replace: '<redacted>',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: '<redacted>',
  },
];

/** Rewrite every known credential shape in a string. */
export function redactString(input: string): string {
  let out = input;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

/** True when the string still carries something that looks like a credential. */
export function hasSecret(input: string): boolean {
  return RULES.some((r) => {
    // Rules are global, so lastIndex must not leak between calls.
    r.pattern.lastIndex = 0;
    return r.pattern.test(input);
  });
}

const MAX_DEPTH = 6;

/**
 * Deep-redact an arbitrary log payload. Strings are rewritten, Errors are
 * rebuilt with a clean message/stack, and cycles are broken. Non-string leaves
 * (numbers, booleans, dates) pass through untouched.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>(), sanitize = redactString): unknown {
  if (typeof value === 'string') return sanitize(value);
  // Do not let a copied toJSON hook reconstruct unsanitized state at the sink.
  if (typeof value === 'function') return '[Function]';
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';

  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);

  if (value instanceof Error) {
    // Copy rather than mutate: the caller may still handle this error, and a
    // rewritten message on a live object is a nasty surprise downstream.
    const clone = new Error(sanitize(value.message));
    clone.name = sanitize(value.name);
    if (value.stack) clone.stack = sanitize(value.stack);
    if (value.cause !== undefined) clone.cause = redactValue(value.cause, depth + 1, seen, sanitize);
    for (const [k, v] of Object.entries(value)) {
      (clone as unknown as Record<string, unknown>)[sanitize(k)] = redactValue(v, depth + 1, seen, sanitize);
    }
    return clone;
  }

  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen, sanitize));

  // Exotic built-ins carry their state outside enumerable own properties, so
  // rebuilding them from Object.entries() silently destroys them — a Date came
  // back as {} and would have wiped every timestamp in the logs. Treat them as
  // leaves: pino's own serializers know what to do with these.
  if (
    value instanceof Date
    || value instanceof RegExp
    || value instanceof Map
    || value instanceof Set
    || ArrayBuffer.isView(value)
  ) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(out, sanitize(k), { value: redactValue(v, depth + 1, seen, sanitize), enumerable: true, configurable: true, writable: true });
  }
  return out;
}
