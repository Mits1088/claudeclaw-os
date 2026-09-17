/** Retains sanitized text skipped by Telegram's shared text/activity edit budget. */
export class TelegramStreamBuffer {
  private latest = '';
  private pendingSince: number | undefined;

  update(text: string, now: number): void {
    if (text === this.latest) return;
    this.latest = text;
    this.pendingSince ??= now;
  }

  /** A short paragraph must eventually appear even if the model starts a long tool call. */
  due(now: number, maxDelayMs: number): boolean {
    return this.pendingSince !== undefined && now - this.pendingSince >= maxDelayMs;
  }

  get text(): string { return this.latest; }

  published(): void { this.pendingSince = undefined; }
}
