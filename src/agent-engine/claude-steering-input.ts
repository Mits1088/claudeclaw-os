import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { STEERING_LIMITS, type SteeringResult, type SteeringOutcome } from './steering.js';

interface Submission {
  handed: boolean;
  handoff: () => void;
  settle: (result: SteeringOutcome) => void;
}

/** Streaming-input idea from merlinfrombelgium's PR #167; receipt tracking is new. */
export class ClaudeSteeringInput {
  private queue: SDKUserMessage[];
  private submissions = new Map<string, Submission>();
  private wake?: () => void;
  private closed = false;
  hasHandedSteer = false;

  constructor(prompt: string, private sessionId = '') {
    this.queue = [{ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: sessionId }];
  }

  setSession(sessionId: string): void { this.sessionId = sessionId; }

  submit(text: string): Promise<SteeringResult> {
    if (this.closed) return Promise.resolve({ status: 'not-delivered', reason: 'closed' });
    const uuid = randomUUID();
    const message: SDKUserMessage = { type: 'user', uuid, session_id: this.sessionId, parent_tool_use_id: null, message: { role: 'user', content: text } };
    return new Promise((resolve) => {
      let complete!: (result: { status: 'accepted' | 'uncertain' }) => void;
      const completion = new Promise<{ status: 'accepted' | 'uncertain' }>((done) => { complete = done; });
      let timer = setTimeout(() => {
        const submission = this.submissions.get(uuid);
        if (!submission) return;
        this.queue = this.queue.filter((item) => item.uuid !== uuid);
        submission.settle(submission.handed ? { status: 'uncertain' } : { status: 'not-delivered', reason: 'timeout' });
      }, STEERING_LIMITS.requestTimeoutMs);
      this.submissions.set(uuid, { handed: false, handoff: () => {
        clearTimeout(timer);
        // Tool calls can take minutes. Do not mistake their boundary delay for
        // failed delivery, or hold the messenger handler open while waiting.
        timer = setTimeout(() => this.submissions.get(uuid)?.settle({ status: 'uncertain' }), STEERING_LIMITS.lifetimeMs);
        resolve({ status: 'pending', completion });
      }, settle: (result) => {
        clearTimeout(timer);
        this.submissions.delete(uuid);
        resolve(result);
        complete(result.status === 'accepted' ? { status: 'accepted' } : { status: 'uncertain' });
      } });
      this.queue.push(message);
      this.wake?.();
    });
  }

  acknowledge(event: Record<string, unknown>): void {
    if (event.type !== 'user' || event.isReplay !== true || event.session_id !== this.sessionId || typeof event.uuid !== 'string') return;
    const submission = this.submissions.get(event.uuid);
    if (submission?.handed) submission.settle({ status: 'accepted' });
  }

  /** Stop admission at the first result; already handed messages may still be acknowledged. */
  close(): void {
    this.closed = true;
    this.queue = [];
    for (const submission of this.submissions.values()) {
      if (!submission.handed) submission.settle({ status: 'not-delivered', reason: 'closed' });
    }
    this.wake?.();
  }

  dispose(): void {
    this.close();
    for (const submission of this.submissions.values()) submission.settle({ status: 'uncertain' });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message = this.queue.shift();
      if (message) {
        const submission = message.uuid ? this.submissions.get(message.uuid) : undefined;
        if (submission) { submission.handed = true; this.hasHandedSteer = true; submission.handoff(); }
        yield message;
      } else {
        await new Promise<void>((resolve) => { this.wake = resolve; });
        this.wake = undefined;
      }
    }
  }
}
