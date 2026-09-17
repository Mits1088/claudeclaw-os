import { sanitizeOutboundText, SANITIZER_FAILURE_PLACEHOLDER, type SanitizeOptions } from './outbound-sanitizer.js';
import { OutboundStreamBoundary } from './outbound-stream-boundary.js';

export const DEFAULT_MAX_STREAM_CHARS = 256 * 1024;
export const OVERFLOW_PLACEHOLDER = '[output withheld: stream buffer limit exceeded]';

export interface StreamGuardOptions extends SanitizeOptions {
  maxBufferedChars?: number;
  /** Release only credential-safe prefixes before completion. Default retains whole-payload behavior. */
  incremental?: boolean;
}

/**
 * Whole-payload buffering by default. Messenger turns opt into credential-safe
 * prefix delivery; unresolved tokens and protected-value prefixes stay private.
 * The raw cumulative history and safe preview each remain bounded by the limit.
 * Overflow/revision stops further delivery; already safe bytes cannot be recalled.
 */
export class OutboundStreamGuard {
  private pending = '';
  private released = '';
  private closed = false;
  private readonly limit: number;
  private boundary?: OutboundStreamBoundary;
  private releasedRawChars = 0;

  constructor(private readonly options: StreamGuardOptions = {}) {
    this.limit = options.maxBufferedChars ?? DEFAULT_MAX_STREAM_CHARS;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error('Invalid stream buffer limit');
  }

  get safeText(): string { return this.released; }
  get pendingLength(): number { return this.pending.length; }
  get retainedChars(): number { return this.pending.length + this.released.length; }

  pushDelta(delta: string): string {
    if (this.closed) return '';
    if (delta.length > this.limit - this.pending.length) return this.suppress(OVERFLOW_PLACEHOLDER);
    this.pending += delta;
    return this.releasePrefix(delta);
  }

  pushAccumulated(text: string): string {
    if (this.closed) return '';
    if (text.length > this.limit) return this.suppress(OVERFLOW_PLACEHOLDER);
    if (!text.startsWith(this.pending)) return this.suppress('[output withheld: inconsistent stream]');
    const delta = text.slice(this.pending.length);
    this.pending = text;
    return this.releasePrefix(delta);
  }

  private releasePrefix(delta: string): string {
    if (!this.options.incremental || !delta) return '';
    try {
      let cut = this.pending.length;
      if (this.options.enabled !== false) {
        this.boundary ??= new OutboundStreamBoundary(this.options.protectedValues);
        this.boundary.append(delta);
        cut = this.boundary.cutoff(this.pending);
      }
      if (cut <= this.releasedRawChars) return '';
      const safe = sanitizeOutboundText(this.pending.slice(0, cut), this.options);
      if (safe === SANITIZER_FAILURE_PLACEHOLDER) return this.suppress(safe);
      if (safe.length > this.limit) return this.suppress(OVERFLOW_PLACEHOLDER);
      this.releasedRawChars = cut;
      this.released = safe;
      return safe;
    } catch {
      return this.suppress(SANITIZER_FAILURE_PLACEHOLDER);
    }
  }

  finalize(): string {
    if (this.closed) return '';
    this.closed = true;
    const text = sanitizeOutboundText(this.pending, this.options);
    this.pending = '';
    this.released = text.length <= this.limit ? text : OVERFLOW_PLACEHOLDER;
    return this.released;
  }

  abort(): string { return this.finalize(); }

  private suppress(marker: string): string {
    this.closed = true;
    this.pending = '';
    this.released = marker;
    return marker;
  }
}
