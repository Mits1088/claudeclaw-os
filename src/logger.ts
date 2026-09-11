import pino from 'pino';

import { redactString, redactValue } from './log-redact.js';
import { logProtectedValues } from './protected-values.js';
import { sanitizeOutboundText } from './outbound-sanitizer.js';

/**
 * Pretty output is for a human watching a terminal. Under launchd both stdout
 * and stderr are redirected to a file, so colorize:true wrote ANSI escapes into
 * every production log line — which broke grep and made the logs harder to read
 * than the JSON they replaced.
 *
 * NODE_ENV stays the default signal (agent-create.ts already sets
 * NODE_ENV=production in the units it generates), but LOG_PRETTY now overrides
 * it in both directions so an operator can force one or the other without
 * touching NODE_ENV, which other code branches on.
 */
function wantsPretty(): boolean {
  const explicit = process.env.LOG_PRETTY?.trim().toLowerCase();
  if (explicit === 'true' || explicit === '1') return true;
  if (explicit === 'false' || explicit === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  hooks: {
    /**
     * Single chokepoint for secret redaction. Every log call — message,
     * merging object, interpolation args — passes through here before it can
     * reach a sink. See log-redact.ts for why this is not done at call sites.
     *
     * Cost: a handful of regex passes per log line. Acceptable because the
     * high-volume caller (dashboard request logging) now logs at debug.
     */
    logMethod(args, method) {
      let safeArgs: unknown[];
      try {
        const protectedValues = logProtectedValues();
        // Logging remains guarded even when outbound delivery is opted out.
        // No diagnostic callback here: logging a redaction would recurse.
        const sanitize = (text: string) => redactString(sanitizeOutboundText(text, { protectedValues }));
        safeArgs = args.map(a => redactValue(a, 0, new WeakSet<object>(), sanitize));
      } catch {
        safeArgs = ['[log withheld: redaction error]'];
      }
      return method.apply(this, safeArgs as Parameters<typeof method>);
    },
  },
  transport: wantsPretty() ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});
