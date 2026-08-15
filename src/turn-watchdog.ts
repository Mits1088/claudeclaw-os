export type TurnAbortReason = 'manual' | 'idle_timeout' | 'max_runtime';

export function turnAbortMessage(reason: TurnAbortReason | undefined): string {
  if (reason === 'max_runtime') return 'Stopped after reaching the maximum runtime.';
  if (reason === 'idle_timeout') return 'Stopped after the provider produced no activity for too long.';
  return 'Stopped.';
}

export class TurnWatchdog {
  private idleTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private timedOut?: Exclude<TurnAbortReason, 'manual'>;
  private started = false;

  constructor(
    private readonly controller: AbortController,
    private readonly idleMs: number,
    private readonly maxMs: number,
  ) {}

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.touch();
    this.maxTimer = setTimeout(() => {
      if (this.controller.signal.aborted) return;
      this.timedOut = 'max_runtime';
      this.controller.abort();
    }, this.maxMs);
  }

  touch(): void {
    if (this.controller.signal.aborted) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.controller.signal.aborted) return;
      this.timedOut = 'idle_timeout';
      this.controller.abort();
    }, this.idleMs);
  }

  reason(): TurnAbortReason {
    return this.timedOut ?? 'manual';
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.idleTimer = undefined;
    this.maxTimer = undefined;
  }
}
