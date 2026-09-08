/**
 * Bounded, provider-free multi-process isolation probe for mission workflows.
 *
 * Run from the candidate worktree with:
 *   node node_modules/tsx/dist/cli.mjs scripts/probe-mission-contention.ts --source
 *
 * Source mode needs no build. The optional default artifact mode loads dist/db.js.
 * Two synthetic DB clients race writes; neither is a model/provider worker.
 * Child mode is intentionally kept in this file so the probe has one owned artifact.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import type { MissionWorkflowTransitionInput } from '../src/db.js';

const CYCLES = 108;
const scriptPath = fileURLToPath(import.meta.url);
const candidateRoot = path.resolve(path.dirname(scriptPath), '..');
const sourceMode = process.argv.includes('--source');
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const configArtifact = path.join(candidateRoot, sourceMode ? 'src' : 'dist', sourceMode ? 'config.ts' : 'config.js');
const dbArtifact = path.join(candidateRoot, sourceMode ? 'src' : 'dist', sourceMode ? 'db.ts' : 'db.js');

type JsonObject = Record<string, unknown>;
type Request = JsonObject & { requestId: string; op: string; startAt?: number };

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function waitUntil(epochMs: number | undefined): void {
  if (!epochMs) return;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < epochMs) Atomics.wait(sleeper, 0, 0, Math.max(1, epochMs - Date.now()));
}

async function loadDatabase() {
  assert.ok(!fs.existsSync(path.join(candidateRoot, '.env')), 'probe requires a candidate without .env');
  const config = await import(pathToFileURL(configArtifact).href);
  const expectedStore = path.resolve(process.env.CLAUDECLAW_STORE_DIR!);
  const expectedConfig = path.resolve(process.env.CLAUDECLAW_CONFIG!);
  assert.equal(path.resolve(config.STORE_DIR), expectedStore, 'candidate STORE_DIR escaped isolation');
  assert.equal(path.resolve(config.CLAUDECLAW_CONFIG), expectedConfig, 'candidate config dir escaped isolation');
  assert.equal(config.activeBotToken, '', 'probe must not inherit messenger credentials');
  const db = await import(pathToFileURL(dbArtifact).href);
  db.initDatabase();
  return { db, storeDir: config.STORE_DIR, configDir: config.CLAUDECLAW_CONFIG };
}

function serializeError(error: unknown): JsonObject {
  const value = error as Error & { code?: string };
  return { name: value?.name, message: value?.message ?? String(error), code: value?.code ?? null };
}

async function childMain(): Promise<void> {
  const { db, storeDir, configDir } = await loadDatabase();
  const emit = (value: JsonObject) => process.stdout.write(`${JSON.stringify(value)}\n`);
  emit({ event: 'ready', pid: process.pid, storeDir, configDir, dbArtifact, dbSha256: sha256(dbArtifact) });

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
      waitUntil(request.startAt);
      let result: unknown;
      if (request.op === 'complete') {
        result = db.completeMissionTask(request.taskId as string, request.report as string, 'completed');
      } else if (request.op === 'transition') {
        result = db.applyMissionWorkflowTransition(request.input as MissionWorkflowTransitionInput);
      } else if (request.op === 'reconcile') {
        result = db.reconcileMissionControl();
      } else if (request.op === 'snapshot') {
        const workflowId = request.workflowId as string;
        result = {
          workflow: db.getMissionWorkflow(workflowId),
          tasks: db.getMissionWorkflowTasks(workflowId),
          outcomes: db.getMissionWorkflowOutcomes(workflowId),
          transitions: db.getMissionWorkflowTransitions(workflowId),
        };
      } else if (request.op === 'crash-complete') {
        result = db.completeMissionTask(request.taskId as string, request.report as string, 'completed');
        emit({ event: 'checkpoint', requestId: request.requestId, boundary: 'after-outcome-transaction', result });
        await new Promise(() => {});
      } else if (request.op === 'crash-transition') {
        result = db.applyMissionWorkflowTransition(request.input as MissionWorkflowTransitionInput);
        emit({ event: 'checkpoint', requestId: request.requestId, boundary: 'after-transition-dispatch-transaction', result });
        await new Promise(() => {});
      } else {
        throw new Error(`Unknown child operation: ${request.op}`);
      }
      emit({ event: 'response', requestId: request.requestId, ok: true, result });
    } catch (error) {
      emit({ event: 'response', requestId: request!.requestId, ok: false, error: serializeError(error) });
    }
  }
}

interface ChildMessage extends JsonObject {
  event?: string;
  requestId?: string;
  ok?: boolean;
  result?: any;
  error?: JsonObject;
}

class ProbeChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly messages: ChildMessage[] = [];
  readonly stderr: string[] = [];
  private waiters: Array<{ predicate: (message: ChildMessage) => boolean; resolve: (message: ChildMessage) => void; reject: (error: Error) => void }> = [];

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.process = child;
    this.pid = child.pid!;
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      let message: ChildMessage;
      try { message = JSON.parse(line) as ChildMessage; } catch { return; }
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
    child.stderr.on('data', chunk => this.stderr.push(String(chunk)));
    child.on('exit', (code, signal) => {
      const error = new Error(`probe child ${this.pid} exited code=${code} signal=${signal}: ${this.stderr.join('')}`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
    child.on('error', error => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  static async start(environment: NodeJS.ProcessEnv): Promise<ProbeChild> {
    const child = spawn(process.execPath, ['--import', loader, scriptPath, '--child', ...(sourceMode ? ['--source'] : [])], {
      cwd: environment.HOME,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const wrapper = new ProbeChild(child);
    ownedChildren.add(wrapper);
    try { await wrapper.waitFor(message => message.event === 'ready'); }
    catch (error) { await wrapper.terminate(); throw error; }
    return wrapper;
  }

  waitFor(predicate: (message: ChildMessage) => boolean): Promise<ChildMessage> {
    const known = this.messages.find(predicate);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const waiter = { predicate,
        resolve: (message: ChildMessage) => { clearTimeout(timer); resolve(message); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new Error(`probe child ${this.pid} response deadline exceeded`));
      }, 10_000);
      this.waiters.push(waiter);
    });
  }

  async request(op: string, fields: JsonObject = {}): Promise<any> {
    const requestId = randomUUID();
    this.process.stdin.write(`${JSON.stringify({ requestId, op, ...fields })}\n`);
    const response = await this.waitFor(message => message.event === 'response' && message.requestId === requestId);
    if (!response.ok) {
      const error = new Error(String(response.error?.message ?? 'child operation failed')) as Error & { code?: string };
      error.code = String(response.error?.code ?? '');
      throw error;
    }
    return response.result;
  }

  async checkpoint(op: string, fields: JsonObject): Promise<ChildMessage> {
    const requestId = randomUUID();
    this.process.stdin.write(`${JSON.stringify({ requestId, op, ...fields })}\n`);
    return this.waitFor(message => message.event === 'checkpoint' && message.requestId === requestId);
  }

  async terminate(): Promise<void> {
    ownedChildren.delete(this);
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise<void>(resolve => this.process.once('exit', () => resolve()));
    this.process.kill();
    await exited;
  }
}

const ownedChildren = new Set<ProbeChild>();

function assertSingleEdges(snapshot: any, expectedDispatchId?: string): void {
  assert.equal(snapshot.outcomes.length, 1, 'expected exactly one canonical outcome');
  assert.equal(snapshot.transitions.length, expectedDispatchId ? 1 : 0, 'unexpected transition count');
  const coordinators = snapshot.tasks.filter((task: any) => task.role === 'coordinator' && task.source_outcome_id === snapshot.outcomes[0].id);
  assert.equal(coordinators.length, 1, 'expected exactly one coordinator wakeup');
  assert.equal(snapshot.outcomes[0].coordinator_task_id, coordinators[0].id, 'outcome wakeup edge mismatch');
  assert.equal(snapshot.outcomes[0].orchestration_attempts, 1, 'outcome was woken more than once');
  if (expectedDispatchId) {
    const dispatched = snapshot.tasks.filter((task: any) => task.role === 'task' && task.parent_task_id === snapshot.outcomes[0].task_id);
    assert.deepEqual(dispatched.map((task: any) => task.id), [expectedDispatchId], 'duplicate or losing dispatch persisted');
    assert.deepEqual(JSON.parse(snapshot.transitions[0].payload_json).taskIds, [expectedDispatchId]);
  }
}

async function parentMain(): Promise<void> {
  assert.ok(fs.existsSync(dbArtifact), `candidate DB artifact missing: ${dbArtifact}`);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-268-contention-'));
  const storeDir = path.join(runDir, 'store');
  const configDir = path.join(runDir, 'config');
  const fixtureHome = path.join(runDir, 'home');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(fixtureHome);
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
    HOME: fixtureHome, USERPROFILE: fixtureHome, TEMP: runDir, TMP: runDir,
    CODEX_HOME: path.join(fixtureHome, '.codex'), XDG_CONFIG_HOME: path.join(fixtureHome, '.config'),
    NODE_ENV: 'development',
    CLAUDECLAW_STORE_DIR: storeDir,
    CLAUDECLAW_CONFIG: configDir,
    CLAUDECLAW_AGENT_ID: 'probe-268',
    DB_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    CREW_MISSIONS_ENABLED: 'true', LOG_LEVEL: 'silent',
    // Fixture-only allowance for 108 sequential DB races, never provider spend.
    CREW_MISSION_TURN_BUDGET_5H: '1000',
  };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  process.chdir(fixtureHome);

  const loadedDbSha256 = sha256(dbArtifact);
  const { db, storeDir: loadedStore, configDir: loadedConfig } = await loadDatabase();
  assert.equal(path.resolve(loadedStore), path.resolve(storeDir));
  assert.equal(path.resolve(loadedConfig), path.resolve(configDir));
  assert.equal(path.resolve(storeDir), path.resolve(runDir, 'store'));
  assert.equal(path.resolve(configDir), path.resolve(runDir, 'config'));

  const workerA = await ProbeChild.start(environment);
  let workerB: ProbeChild;
  try { workerB = await ProbeChild.start(environment); }
  catch (error) { await workerA.terminate(); throw error; }
  const busyFailures: JsonObject[] = [];
  const cycleEvidence: JsonObject[] = [];
  try {
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const suffix = String(cycle).padStart(3, '0');
      const workflowId = `probe268-wf-${suffix}`;
      const rootTaskId = `probe268-root-${suffix}`;
      const workerAgent = `probe268-worker-${suffix}`;
      const ownerAgent = `probe268-owner-${suffix}`;
      db.createMissionWorkflow({
        id: workflowId, rootTaskId, title: `Contention ${suffix}`,
        objective: 'Bounded isolated contention probe', initialPrompt: 'Return deterministic evidence.',
        ownerAgent, workerAgent, priority: 5,
        maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null,
      });
      assert.equal(db.claimNextMissionTask(workerAgent)?.id, rootTaskId);

      const completionAt = Date.now() + 30;
      let completions: any[];
      try {
        completions = await Promise.all([
          workerA.request('complete', { taskId: rootTaskId, report: `winner-a-${suffix}`, startAt: completionAt }),
          workerB.request('complete', { taskId: rootTaskId, report: `winner-b-${suffix}`, startAt: completionAt }),
        ]);
      } catch (error) {
        if ((error as any)?.code === 'SQLITE_BUSY' || /database is locked/i.test(String((error as Error).message))) busyFailures.push({ cycle, edge: 'completion', error: serializeError(error) });
        throw error;
      }
      assert.deepEqual(completions.map(item => item.changed).sort(), [false, true]);
      assert.equal(new Set(completions.map(item => item.outcomeId)).size, 1);
      assert.equal(new Set(completions.map(item => item.coordinatorTaskId)).size, 1);
      const coordinatorId = completions[0].coordinatorTaskId as string;
      assert.equal(db.claimNextMissionTask(ownerAgent)?.id, coordinatorId);

      const transitionAt = Date.now() + 30;
      const inputs = ['a', 'b'].map(side => ({
        id: `probe268-transition-${side}-${suffix}`,
        coordinatorTaskId: coordinatorId,
        actor: ownerAgent,
        disposition: 'dispatch',
        idempotencyKey: `probe268-key-${side}-${suffix}`,
        dispatches: [{ id: `probe268-dispatch-${side}-${suffix}`, title: `Dispatch ${side}`, prompt: 'Bounded child.', agent: `probe268-child-${suffix}`, priority: 5 }],
      }));
      let transitions: any[];
      try {
        transitions = await Promise.all([
          workerA.request('transition', { input: inputs[0], startAt: transitionAt }),
          workerB.request('transition', { input: inputs[1], startAt: transitionAt }),
        ]);
      } catch (error) {
        if ((error as any)?.code === 'SQLITE_BUSY' || /database is locked/i.test(String((error as Error).message))) busyFailures.push({ cycle, edge: 'transition', error: serializeError(error) });
        throw error;
      }
      assert.deepEqual(transitions.map(item => item.duplicate).sort(), [false, true]);
      assert.equal(new Set(transitions.map(item => JSON.stringify(item.createdTaskIds))).size, 1);
      const dispatchId = transitions[0].createdTaskIds[0] as string;
      const snapshot = {
        workflow: db.getMissionWorkflow(workflowId), tasks: db.getMissionWorkflowTasks(workflowId),
        outcomes: db.getMissionWorkflowOutcomes(workflowId), transitions: db.getMissionWorkflowTransitions(workflowId),
      };
      assertSingleEdges(snapshot, dispatchId);
      assert.equal(snapshot.tasks.some((task: any) => inputs.some(input => input.dispatches[0].id === task.id) && task.id !== dispatchId), false);
      cycleEvidence.push({ cycle, workflowId, completionChanged: completions.map(item => item.changed), transitionDuplicate: transitions.map(item => item.duplicate), outcomeId: snapshot.outcomes[0].id, coordinatorId, dispatchId });
      db.completeMissionTask(coordinatorId, 'Race assessed', 'completed');
      db.cancelMissionWorkflow(workflowId, ownerAgent);
      // Materialize the cancelled, never-started follow-up's own outcome now,
      // so later restart assertions concern only their dedicated crash case.
      db.reconcileMissionControl();
      assert.equal(db.getMissionGovernorStatus().activeReservations, 0);
    }
  } finally {
    await Promise.all([workerA.terminate(), workerB.terminate()]);
  }
  assert.equal(busyFailures.length, 0, 'SQLITE_BUSY failures observed');

  // Crash boundary 1: completeMissionTask atomically persists terminal task,
  // outcome, and coordinator wakeup. Pause only after that transaction returns.
  const crashOutcomeWorkflow = 'probe268-crash-outcome';
  const crashOutcomeTask = 'probe268-crash-outcome-root';
  db.createMissionWorkflow({ id: crashOutcomeWorkflow, rootTaskId: crashOutcomeTask, title: 'Crash outcome', objective: 'Crash after outcome transaction', initialPrompt: 'Evidence', ownerAgent: 'probe268-crash-owner-1', workerAgent: 'probe268-crash-worker', priority: 5, maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
  assert.equal(db.claimNextMissionTask('probe268-crash-worker')?.id, crashOutcomeTask);
  const crashCompleter = await ProbeChild.start(environment);
  const outcomeCheckpoint = await crashCompleter.checkpoint('crash-complete', { taskId: crashOutcomeTask, report: 'durable outcome' });
  await crashCompleter.terminate();
  const outcomeReopener = await ProbeChild.start(environment);
  const outcomeReconcile = await outcomeReopener.request('reconcile');
  const outcomeSnapshot = await outcomeReopener.request('snapshot', { workflowId: crashOutcomeWorkflow });
  await outcomeReopener.terminate();
  assertSingleEdges(outcomeSnapshot);
  assert.deepEqual(outcomeReconcile, { expiredWorkflows: 0, recoveredOutcomes: 0, releasedJoins: 0, blockedJoins: 0, queuedCoordinators: 0, blockedOutcomes: 0 });
  db.cancelMissionWorkflow(crashOutcomeWorkflow, 'probe268-crash-owner-1');
  db.reconcileMissionControl();

  // Crash boundary 2: applyMissionWorkflowTransition atomically persists the
  // transition and dispatch. Pause only after that transaction returns.
  const crashTransitionWorkflow = 'probe268-crash-transition';
  const crashTransitionTask = 'probe268-crash-transition-root';
  db.createMissionWorkflow({ id: crashTransitionWorkflow, rootTaskId: crashTransitionTask, title: 'Crash transition', objective: 'Crash after transition transaction', initialPrompt: 'Evidence', ownerAgent: 'probe268-crash-owner-2', workerAgent: 'probe268-crash-worker-2', priority: 5, maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
  assert.equal(db.claimNextMissionTask('probe268-crash-worker-2')?.id, crashTransitionTask);
  const completed = db.completeMissionTask(crashTransitionTask, 'durable input', 'completed');
  assert.equal(completed.changed, true);
  assert.equal(db.claimNextMissionTask('probe268-crash-owner-2')?.id, completed.coordinatorTaskId);
  const crashDispatchId = 'probe268-crash-dispatch-child';
  const crashTransitioner = await ProbeChild.start(environment);
  const transitionCheckpoint = await crashTransitioner.checkpoint('crash-transition', { input: {
    id: 'probe268-crash-transition-edge', coordinatorTaskId: completed.coordinatorTaskId,
    actor: 'probe268-crash-owner-2', disposition: 'dispatch', idempotencyKey: 'probe268-crash-transition-key',
    dispatches: [{ id: crashDispatchId, title: 'Durable dispatch', prompt: 'Evidence', agent: 'probe268-child', priority: 5 }],
  } });
  await crashTransitioner.terminate();
  const transitionReopener = await ProbeChild.start(environment);
  const transitionReconcile = await transitionReopener.request('reconcile');
  const transitionSnapshot = await transitionReopener.request('snapshot', { workflowId: crashTransitionWorkflow });
  await transitionReopener.terminate();
  assertSingleEdges(transitionSnapshot, crashDispatchId);
  assert.deepEqual(transitionReconcile, { expiredWorkflows: 0, recoveredOutcomes: 0, releasedJoins: 0, blockedJoins: 0, queuedCoordinators: 0, blockedOutcomes: 0 });
  db.completeMissionTask(completed.coordinatorTaskId, 'Crash recovery assessed', 'completed');
  db.cancelMissionWorkflow(crashTransitionWorkflow, 'probe268-crash-owner-2');
  assert.equal(db.getMissionGovernorStatus().activeReservations, 0);

  const evidence = {
    passed: true,
    sourceMode, realProviderCalls: 0, messengerInstances: 0,
    nodeEnv: process.env.NODE_ENV,
    cycles: CYCLES,
    runDir,
    storeDir,
    configDir,
    databasePath: path.join(storeDir, 'claudeclaw.db'),
    dbArtifact,
    loadedDbSha256,
    busyFailures,
    cycleEvidence,
    crashes: {
      afterOutcomePersistence: { checkpoint: outcomeCheckpoint, reconcile: outcomeReconcile, snapshot: outcomeSnapshot },
      afterTransitionDispatchCommit: { checkpoint: transitionCheckpoint, reconcile: transitionReconcile, snapshot: transitionSnapshot },
    },
    limitations: [
      'completeMissionTask commits the terminal task, canonical outcome, and coordinator wakeup in one IMMEDIATE transaction; interruption between those writes is not externally representable.',
      'applyMissionWorkflowTransition commits the transition, outcome processing, workflow update, and dispatch creation in one IMMEDIATE transaction; interruption between transition and dispatch commit is not externally representable.',
      'The controlled terminations occur immediately after each exported transaction returns and its stdout checkpoint is observed.',
    ],
  };
  const evidencePath = path.join(runDir, 'evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify({ passed: true, cycles: CYCLES, evidencePath, storeDir, configDir, dbArtifact, loadedDbSha256 })}\n`);
}

if (process.argv.includes('--child')) {
  await childMain();
} else {
  try { await parentMain(); }
  finally { await Promise.all([...ownedChildren].map(child => child.terminate())); }
}
