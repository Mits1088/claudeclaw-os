/** Adapter acceptance is distinct from delivery uncertainty: never replay the latter. */
export type SteeringOutcome =
  | { status: 'accepted' }
  | { status: 'not-delivered'; reason: string }
  | { status: 'uncertain' };

export type SteeringResult = SteeringOutcome
  | { status: 'pending'; completion: Promise<{ status: 'accepted' | 'uncertain' }> };

export interface SteeringHandle {
  readonly sessionId: string;
  readonly turnId: string;
  submit(messageId: string, text: string): Promise<SteeringResult>;
}

export type RegisterSteering = (handle: SteeringHandle) => () => void;

export const STEERING_LIMITS = Object.freeze({
  maxChars: 4000,
  maxMessages: 8,
  minIntervalMs: 1000,
  lifetimeMs: 15 * 60 * 1000,
  requestTimeoutMs: 5000,
});

/** One invocation only. Limits are reserved before asynchronous submission. */
export function createSteeringHandle(options: {
  sessionId: string;
  turnId: string;
  startedAt: number;
  isActive: () => boolean;
  send: (text: string) => Promise<SteeringResult>;
  now?: () => number;
}): SteeringHandle {
  const now = options.now ?? Date.now;
  const receipts = new Map<string, Promise<SteeringResult>>();
  let lastSubmission = -Infinity;
  let busy = false;
  return {
    sessionId: options.sessionId,
    turnId: options.turnId,
    submit(messageId, text) {
      const existing = receipts.get(messageId);
      if (existing) return existing;
      const reject = (reason: string): Promise<SteeringResult> =>
        Promise.resolve({ status: 'not-delivered', reason });
      if (!options.isActive()) return reject('closed');
      if (now() - options.startedAt >= STEERING_LIMITS.lifetimeMs) return reject('expired');
      if (!text.trim() || text.length > STEERING_LIMITS.maxChars) return reject('size');
      if (receipts.size >= STEERING_LIMITS.maxMessages) return reject('limit');
      if (busy || now() - lastSubmission < STEERING_LIMITS.minIntervalMs) return reject('rate');
      lastSubmission = now();
      busy = true;
      const receipt = Promise.resolve().then(() => {
        if (!options.isActive()) return { status: 'not-delivered', reason: 'closed' } as const;
        return options.send(text);
      }).catch((): SteeringResult => ({ status: 'uncertain' })).finally(() => { busy = false; });
      receipts.set(messageId, receipt);
      return receipt;
    },
  };
}
