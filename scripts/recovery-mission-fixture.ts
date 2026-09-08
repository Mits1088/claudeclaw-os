/** Source-only, provider-free coordinator/worker DB contract fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

async function database() {
  assert.ok(!fs.existsSync(path.join(root, '.env')), 'fixture requires a candidate without .env');
  const config = await import('../src/config.js');
  assert.equal(path.resolve(config.STORE_DIR), path.resolve(process.env.CLAUDECLAW_STORE_DIR!));
  assert.equal(config.activeBotToken, '');
  const db = await import('../src/db.js');
  db.initDatabase();
  return db;
}

if (process.argv.includes('--worker')) {
  const db = await database();
  assert.equal(db.claimNextMissionTask('unaddressed'), null);
  const task = db.claimNextMissionTask('fixture-worker');
  assert.ok(task);
  if (process.argv.includes('--crash')) {
    process.stdout.write('FIXTURE_CLAIMED\n', () => process.exit(23));
    await new Promise(() => {});
  }
  if (process.argv.includes('--cancel')) {
    const resumed = once(process.stdin, 'data');
    process.stdout.write('FIXTURE_CLAIMED\n');
    await resumed;
    assert.equal(db.completeMissionTask(task.id, 'late cancelled result', 'completed').changed, false);
    process.stdout.write('FIXTURE_CANCEL_REJECTED\n');
    process.stdin.destroy();
  } else {
    // Deliberately omit usage: this must consume the conservative reservation.
    assert.ok(db.completeMissionTask(task.id, 'synthetic evidence', 'completed').changed);
    process.stdout.write('FIXTURE_WORKER_COMPLETE\n');
  }
} else {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-recovery-fixture-'));
  const store = path.join(runDir, 'store');
  const config = path.join(runDir, 'config');
  const home = path.join(runDir, 'home');
  for (const dir of [store, config, home]) fs.mkdirSync(dir);
  const env: NodeJS.ProcessEnv = {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    TEMP: runDir, TMP: runDir, HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'),
    NODE_ENV: 'development', CLAUDECLAW_STORE_DIR: store, CLAUDECLAW_CONFIG: config,
    DB_ENCRYPTION_KEY: randomBytes(32).toString('hex'), CREW_MISSIONS_ENABLED: 'true',
    // Three sequential synthetic scenarios share a store. This fixture-only
    // allocation never invokes a provider or changes the product defaults.
    CREW_MISSION_TURN_BUDGET_5H: '48', LOG_LEVEL: 'silent',
  };
  // This is a standalone fixture process. Clear inherited credentials and task
  // identity before importing candidate modules, including in the coordinator.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(runDir);
  const db = await database();
  db.createMissionWorkflow({ id: 'fixture', rootTaskId: 'root', title: 'Fixture',
    objective: 'Verify addressed execution', initialPrompt: 'Synthetic only',
    ownerAgent: 'fixture-owner', workerAgent: 'fixture-worker', priority: 5,
    maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });

  const runWorker = (mode: 'complete' | 'crash' | 'cancel', onClaim?: () => void) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, script, '--worker', `--${mode}`], {
      cwd: runDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let claimHandled = false;
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (mode === 'cancel' && !claimHandled && output.includes('FIXTURE_CLAIMED')) {
        claimHandled = true;
        try { onClaim!(); child.stdin.end('CONTINUE\n'); }
        catch (error) { child.kill(); reject(error); }
      }
    });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture worker deadline exceeded')); }, 20000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      const expectedCode = mode === 'crash' ? 23 : 0;
      const marker = mode === 'crash' ? 'FIXTURE_CLAIMED'
        : mode === 'cancel' ? 'FIXTURE_CANCEL_REJECTED' : 'FIXTURE_WORKER_COMPLETE';
      if (code === expectedCode && output.includes(marker)) resolve();
      else reject(new Error(`Fixture worker failed (${code}): ${output}`));
    });
  });
  await runWorker('complete');
  assert.equal(db.getMissionGovernorReservation('root')?.charged_turns, 3);
  assert.equal(db.getMissionWorkflowOutcomes('fixture').length, 1);
  const review = db.claimNextMissionTask('fixture-owner');
  assert.equal(review?.role, 'coordinator');
  db.applyMissionWorkflowTransition({ id: 'accept', coordinatorTaskId: review!.id,
    actor: 'fixture-owner', disposition: 'complete', idempotencyKey: 'accept' });
  db.completeMissionTask(review!.id, 'accepted', 'completed');
  assert.equal(db.getMissionWorkflow('fixture')?.status, 'completed');
  assert.equal(db.getMissionGovernorStatus().activeReservations, 0);

  db.createMissionWorkflow({ id: 'crash', rootTaskId: 'crash-root', title: 'Crash fixture',
    objective: 'Record interrupted execution', initialPrompt: 'Synthetic only',
    ownerAgent: 'fixture-owner', workerAgent: 'fixture-worker', priority: 5,
    maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
  await runWorker('crash');
  assert.equal(db.getMissionTask('crash-root')?.status, 'running');
  assert.equal(db.failStuckMissionTasks('fixture-worker', 'Process interrupted; execution unknown'), 1);
  assert.equal(db.completeMissionTask('crash-root', 'late stale result', 'completed').changed, false);
  assert.equal(db.claimNextMissionTask('fixture-worker'), null);
  assert.equal(db.getMissionWorkflowOutcomes('crash').length, 1);
  db.cancelMissionWorkflow('crash', 'fixture-owner');
  assert.equal(db.getMissionGovernorStatus().activeReservations, 0);

  db.createMissionWorkflow({ id: 'cancel', rootTaskId: 'cancel-root', title: 'Cancellation fixture',
    objective: 'Reject late completion', initialPrompt: 'Synthetic only',
    ownerAgent: 'fixture-owner', workerAgent: 'fixture-worker', priority: 5,
    maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null });
  await runWorker('cancel', () => {
    assert.equal(db.getMissionTask('cancel-root')?.status, 'running');
    db.cancelMissionWorkflow('cancel', 'fixture-owner');
    assert.equal(db.cancelMissionTask('cancel-root'), true);
  });
  assert.equal(db.getMissionTask('cancel-root')?.status, 'cancelled');
  assert.equal(db.getMissionWorkflowOutcomes('cancel').length, 1);
  assert.equal(db.getMissionGovernorStatus().activeReservations, 0);

  const evidence = { passed: true, sourceRoot: root, runDir, workerProcesses: 3, maxConcurrentWorkers: 1,
    realProviderCalls: 0, messengerInstances: 0, assertions: ['addressed claim',
      'durable cross-process outcome', 'missing usage charged', 'coordinator completion', 'reservations released',
      'worker crash remains unknown without replay', 'cross-process cancellation rejects late completion'] };
  fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}
