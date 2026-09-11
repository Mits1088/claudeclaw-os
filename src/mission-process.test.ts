import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { MissionTask } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
let tmp: string;
let peers: Peer[];

class Peer {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private output = '';
  readonly child;
  readonly closed: Promise<number | null>;
  readonly ready: Promise<void>;

  constructor() {
    this.child = spawn(process.execPath, ['--import', tsx, path.join(here, 'test-fixtures/mission-process-worker.ts')], {
      cwd: tmp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: tmp, USERPROFILE: tmp, TEMP: tmp, TMP: tmp, NODE_ENV: 'test', LOG_LEVEL: 'silent',
        CLAUDECLAW_CONFIG: path.join(tmp, 'config'), CLAUDECLAW_STORE_DIR: path.join(tmp, 'store'),
        DB_ENCRYPTION_KEY: 'a'.repeat(64) },
    });
    this.child.stdout!.on('data', data => { this.output += data; });
    this.child.stderr!.on('data', data => { this.output += data; });
    this.closed = new Promise(resolve => this.child.once('close', code => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Fixture exited ${code}: ${this.output}`));
      }
      this.pending.clear();
      resolve(code);
    }));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill(); reject(new Error(`Fixture startup timeout: ${this.output}`)); }, 15000);
      this.child.once('error', error => { clearTimeout(timer); reject(error); });
      this.child.once('close', code => { clearTimeout(timer); reject(new Error(`Fixture startup exit ${code}: ${this.output}`)); });
      this.child.on('message', (message: any) => {
        if (message.ready) { clearTimeout(timer); resolve(); return; }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      });
    });
  }

  call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Fixture ${method} timeout: ${this.output}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, args });
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    await this.closed;
  }
}

async function peer(): Promise<Peer> {
  const next = new Peer(); peers.push(next); await next.ready; return next;
}
const fence = (task: MissionTask) => ({ agentId: task.assigned_agent!, instanceId: task.claiming_instance_id!, generation: task.claim_generation });
async function lease(control: Peer, agentId: string, instanceId: string) {
  await control.call('desired', agentId, 'active');
  expect(await control.call('lease', { agentId, instanceId, supervisorEpoch: 'epoch', pid: control.child.pid,
    processStartedAt: 1, runtimeBuildId: 'fixture' })).toBe(true);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-process-'));
  peers = [];
  // Prevent the env reader from consulting any checkout or user .env.
  fs.writeFileSync(path.join(tmp, '.env'), '# isolated mission fixture\n');
});
afterEach(async () => {
  await Promise.all(peers.map(item => item.stop()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('retained missions across real isolated processes', () => {
  it('commits the final child and join release together before a process exits', async () => {
    const control = await peer(); const worker = await peer();
    await control.call('create', 'child', 'Child', 'Synthetic', 'worker', 'main', 0, null, 'group', 'task');
    await control.call('create', 'join', 'Join', 'Summary', 'main', 'main', 0, null, 'group', 'join', 'waiting');
    await worker.call('claim', 'worker');
    expect(await worker.call('complete', 'child', 'durable result', 'completed')).toBe(true);
    // Stop before the scheduler can make a separate releaseEligible call.
    worker.child.send({ id: 0, method: 'crash', args: [path.join(tmp, 'after-commit.txt')] });
    expect(await worker.closed).toBe(17);
    const restarted = await peer();
    expect(await restarted.call('get', 'child')).toMatchObject({ status: 'completed', result: 'durable result' });
    expect(await restarted.call('join', 'group')).toMatchObject({ status: 'queued' });
    expect((await restarted.call('join', 'group')).prompt).toContain('durable result');
  }, 30000);

  it('claims once under contention, rejects stale claimants and persists one completion across restart', async () => {
    const control = await peer();
    await control.call('epoch', 'epoch', 'fixture');
    await lease(control, 'worker', 'current');
    await control.call('create', 'task', 'Task', 'Synthetic', 'worker', 'main');
    const racers = await Promise.all([peer(), peer(), peer()]);
    const claims = await Promise.all(racers.map(item => item.call<MissionTask | null>('claim', 'worker', 'current')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await control.call('claim', 'worker', 'stale')).toBeNull();
    const task = claims.find(Boolean)!;
    const outcomes = await Promise.all(racers.map(item => item.call('complete', 'task', 'result', 'completed', undefined, fence(task))));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await control.stop();
    const restarted = await peer();
    expect(await restarted.call('get', 'task')).toMatchObject({ status: 'completed', result: 'result', claim_generation: 1 });
    expect(await restarted.call('claim', 'worker', 'current')).toBeNull();
  }, 30000);

  it('fences a replaced process and fails interrupted work without replaying its side effect', async () => {
    const control = await peer(); const worker = await peer();
    await control.call('epoch', 'epoch', 'fixture');
    await lease(control, 'worker', 'old');
    await control.call('create', 'child', 'Child', 'Synthetic', 'worker', 'main', 0, null, 'group', 'task');
    await control.call('create', 'join', 'Join', 'Summary', 'main', 'main', 0, null, 'group', 'join', 'waiting');
    const task = await worker.call<MissionTask>('claim', 'worker', 'old');
    await lease(control, 'worker', 'replacement');
    expect(await worker.call('complete', 'child', 'stale', 'completed', undefined, fence(task))).toBe(false);
    expect(await control.call('complete', 'child', 'wrong generation', 'completed', undefined,
      { ...fence(task), instanceId: 'replacement', generation: task.claim_generation + 1 })).toBe(false);
    expect(await control.call('join', 'group')).toMatchObject({ status: 'waiting' });
    const sideEffect = path.join(tmp, 'effect.txt');
    worker.child.send({ id: 0, method: 'crash', args: [sideEffect] });
    expect(await worker.closed).toBe(17);
    const restarted = await peer();
    expect(await restarted.call('reset', 'worker')).toBe(1);
    expect(await restarted.call('reset', 'worker')).toBe(0);
    expect(await restarted.call('get', 'child')).toMatchObject({ status: 'failed', result: null });
    expect((await restarted.call('get', 'child')).error).toContain('execution unknown');
    expect(await restarted.call('join', 'group')).toMatchObject({ status: 'queued' });
    expect(await restarted.call('claim', 'worker', 'replacement')).toBeNull();
    expect(fs.readFileSync(sideEffect, 'utf8')).toBe('executed\n');
  }, 30000);

  it('converges repeated handbacks and continuation edges, and persists cancellation across restart', async () => {
    const control = await peer();
    await control.call('create', 'delegated', 'Delegated', 'Synthetic', 'worker', 'main');
    await control.call('claim', 'worker');
    await control.call('create', 'root', 'Root', 'Synthetic', 'owner', 'owner');
    await control.call('claim', 'owner');
    const racers = await Promise.all([peer(), peer(), peer()]);
    const handbacks = await Promise.all(racers.map((item, i) => item.call('handback', {
      id: `handback-${i}`, title: 'Report', prompt: 'Result', agent: 'main', createdBy: 'worker', priority: 0, parentId: 'delegated',
    })));
    expect(new Set(handbacks.map(result => result.id)).size).toBe(1);
    const continuation = (id: string) => ({ id, title: 'Next', prompt: 'Synthetic', agent: 'owner', priority: 0,
      parentId: 'root', chainId: 'chain', step: 1, limit: 2, key: id });
    const edges = await Promise.all(racers.map((item, i) => item.call('continue', continuation(`next-${i}`))));
    expect(new Set(edges.map(result => result.id)).size).toBe(1);
    expect(await control.call('cancelChain', 'chain', 'owner')).toMatchObject({ cancelledTasks: 1 });
    expect(await control.call('complete', 'root', 'done', 'completed')).toBe(true);
    const restarted = await peer();
    expect(await restarted.call('chain', 'chain')).toMatchObject({ status: 'cancelled', max_steps: 2 });
    expect(await restarted.call('continue', continuation('late'))).toMatchObject({ cancelled: true });
    expect(await restarted.call('claim', 'owner')).toBeNull();
    const rows = await restarted.call<MissionTask[]>('tasks');
    expect(rows.filter(row => row.role === 'handback')).toHaveLength(1);
    expect(rows.filter(row => row.role === 'continuation')).toHaveLength(1);
  }, 30000);

  it('releases and claims one gather join with failed/cancelled children under contention', async () => {
    const control = await peer();
    for (const id of ['a', 'b']) await control.call('create', id, id, 'Synthetic', id, 'main', 0, null, 'group', 'task');
    await control.call('create', 'join', 'Join', 'Summary', 'main', 'main', 0, null, 'group', 'join', 'waiting');
    const racers = await Promise.all([peer(), peer(), peer()]);
    expect(await racers[0].call('claim', 'a')).toMatchObject({ id: 'a' });
    expect(await racers[1].call('claim', 'b')).toMatchObject({ id: 'b' });
    expect(await racers[0].call('complete', 'a', null, 'failed', 'synthetic failure')).toBe(true);
    await racers[0].call('releaseEligible', await control.call('get', 'a'));
    expect(await control.call('join', 'group')).toMatchObject({ status: 'waiting' });
    expect(await racers[1].call('cancel', 'b')).toBe(true);
    const terminalChild = await control.call('get', 'b');
    await Promise.all(racers.map(item => item.call('releaseEligible', terminalChild)));
    const join = await control.call<MissionTask>('join', 'group');
    expect(join.status).toBe('queued');
    expect(join.prompt).toContain('synthetic failure');
    expect(join.prompt).toContain('cancelled');
    const claims = await Promise.all(racers.map(item => item.call<MissionTask | null>('claim', 'main')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await control.call('tasks', 'main')).toHaveLength(1);
  }, 30000);
});
