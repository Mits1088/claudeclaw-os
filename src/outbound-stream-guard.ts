import { sanitizeOutboundText, type SanitizeOptions } from './outbound-sanitizer.js';

export const DEFAULT_MAX_STREAM_CHARS = 256 * 1024;
export const OVERFLOW_PLACEHOLDER = '[output withheld: stream buffer limit exceeded]';

export interface StreamGuardOptions extends SanitizeOptions {
  maxBufferedChars?: number;
}

/**
 * Buffer until completion: arbitrary protected values can span whitespace and
 * every chunk boundary. A final scan cannot retract bytes sent earlier.
 * The bounded buffer trades incremental delivery for an enforceable boundary.
 * Overflow and revised cumulative snapshots suppress the entire payload.
 */
export class OutboundStreamGuard {
  private pending = '';
  private released = '';
  private closed = false;
  private readonly limit: number;

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
    return '';
  }

  pushAccumulated(text: string): string {
    if (this.closed) return '';
    if (text.length > this.limit) return this.suppress(OVERFLOW_PLACEHOLDER);
    if (!text.startsWith(this.pending)) return this.suppress('[output withheld: inconsistent stream]');
    this.pending = text;
    return '';
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
