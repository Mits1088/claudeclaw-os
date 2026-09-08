// Opt-in real-provider acceptance probe for durable-workflow entry.
//
// The probe creates only disposable identities and state below the OS temp
// directory. It deliberately reaches workflow creation through two production
// entry paths: a future one-shot mission and one firing of a recurring job.
// The provider, not this driver, invokes mission_workflow_create.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--run')) {
  console.log('Opt-in probe; no provider was called. Re-run with: npx tsx scripts/probe-mission-entry.ts --run');
  process.exit(0);
}

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-entry-'));
process.env.CLAUDECLAW_CONFIG = path.join(runDir, 'config');
process.env.CLAUDECLAW_STORE_DIR = path.join(runDir, 'store');
process.env.CLAUDECLAW_AGENT_ID = 'entry-initiator';
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.CODEX_TRANSPORT = process.argv.includes('--app-server') ? 'app-server' : 'sdk';
// Each of the two initiating provider invocations needs two tool rounds and a
// final response. Four is a hard per-invocation ceiling: eight total turns.
process.env.AGENT_MAX_TURNS = '4';
process.env.AGENT_IDLE_TIMEOUT_MS = '90000';
process.env.AGENT_MAX_RUNTIME_MS = '180000';
process.env.SCHEDULER_IDLE_TIMEOUT_MS = '90000';
process.env.SCHEDULER_MAX_RUNTIME_MS = '180000';

const workspace = path.join(runDir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
for (const id of ['entry-initiator', 'entry-worker']) {
  const dir = path.join(process.env.CLAUDECLAW_CONFIG, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), [
    `name: ${id}`,
    'provider:',
    '  type: openai',
    '  model: gpt-5.6-sol',
    '  thinkingMode: medium',
    '',
  ].join('\n'));
}

const config = await import('../src/config.js');
assert.equal(path.resolve(config.STORE_DIR), path.join(runDir, 'store'), 'store isolation failed');
assert.equal(path.resolve(config.CLAUDECLAW_CONFIG), path.join(runDir, 'config'), 'config isolation failed');
const db = await import('../src/db.js');
const { actionCreateMission } = await import('../src/cli-actions.js');
const { registerDispatchTools } = await import('../src/dispatch-tools.js');
const { initScheduler, runDueTasks } = await import('../src/scheduler.js');
const { messageQueue } = await import('../src/message-queue.js');
const { getSelectedProviderConfig } = await import('../src/active-provider.js');

db.initDatabase();
registerDispatchTools();
const requestedProvider = { type: 'openai' as const, model: 'gpt-5.6-sol', thinkingMode: 'medium' };
config.setAgentOverrides({
  agentId: 'entry-initiator',
  botToken: '',
  cwd: workspace,
  model: requestedProvider.model,
  provider: requestedProvider,
  systemPrompt: [
    'You are a disposable acceptance-probe initiator.',
    'Follow the supplied workflow-creation instructions literally.',
    'Use the mission_workflow_create dispatch tool; do not use a shell or CLI.',
    'Do not execute, coordinate, transition, or decide the created workflow.',
  ].join(' '),
});
assert.deepEqual(getSelectedProviderConfig(), requestedProvider, 'effective provider selection drifted');

const now = Date.now();
const missionDueAt = new Date(now + 3_000).toISOString();
const missionRootAt = new Date(now + 10 * 60_000).toISOString();
const scheduleRootAt = new Date(now + 12 * 60_000).toISOString();
const exactMissionAvailability = Math.floor(Date.parse(missionRootAt) / 1000);
const exactScheduleAvailability = Math.floor(Date.parse(scheduleRootAt) / 1000);
const duplicateInstructions = (label: string, rootAt: string) => [
  `Create the ${label} durable workflow by calling mission_workflow_create exactly twice.`,
  'Both calls must use objective "Verify isolated entry evidence", prompt "Inspect the disposable fixture and return the exact marker.", agent "entry-worker", owner "entry-initiator", max_depth 2, max_tasks 3, and max_fanout 1.',
  `Both calls must use at "${rootAt}".`,
  `Use idempotency_key "${label}-first" on the first call and "${label}-retry" on the second.`,
  'Do not call mission_transition or any other state-changing tool. After both calls, report the two returned workflow IDs.',
].join(' ');

const initiatingMission = actionCreateMission({
  title: 'Future workflow entry probe',
  prompt: duplicateInstructions('future-mission', missionRootAt),
  agent: 'entry-initiator',
  createdBy: 'probe-origin',
  at: missionDueAt,
});
assert.equal(db.getMissionTask(initiatingMission.id)?.available_at, Math.floor(Date.parse(missionDueAt) / 1000));
assert.equal(db.getDueTasks('entry-initiator').length, 0);
assert.equal(db.getMissionWorkflows().length, 0);

const messages: Array<{ phase: string; text: string }> = [];
const callbacks: Array<() => Promise<void>> = [];
let phase = 'future-mission';
const enqueue = messageQueue.enqueue;
messageQueue.enqueue = (_chat, callback) => { callbacks.push(callback); };
const stop = initScheduler(async (text) => { messages.push({ phase, text }); }, 'entry-initiator', undefined, 'persistent', undefined, false);
stop();

async function drainOne(label: string): Promise<void> {
  await runDueTasks();
  assert.equal(callbacks.length, 1, `${label}: expected exactly one scheduler callback`);
  const callback = callbacks.shift()!;
  await callback();
}

const waitMs = Math.max(0, (initiatingMission.availableAt ?? 0) * 1000 - Date.now() + 50);
if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

try {
  await drainOne('future mission');
  assert.equal(db.getMissionTask(initiatingMission.id)?.status, 'completed');

  phase = 'recurring-job';
  const jobId = `entry-job-${randomUUID().slice(0, 8)}`;
  const jobFireAt = Math.floor(Date.now() / 1000);
  db.createScheduledTask(
    jobId,
    duplicateInstructions('recurring-job', scheduleRootAt),
    '*/10 * * * *',
    jobFireAt,
    'entry-initiator',
  );
  await drainOne('recurring job');

  const workflows = db.getMissionWorkflows();
  assert.equal(workflows.length, 2, 'duplicate tool invocations created more than one canonical workflow per entry');
  const roots = workflows.map(workflow => {
    const tasks = db.getMissionWorkflowTasks(workflow.id);
    assert.equal(tasks.length, 1, `workflow ${workflow.id} did not retain exactly one canonical root`);
    assert.equal(tasks[0].id, `${workflow.id}-root`);
    return tasks[0];
  });
  assert.deepEqual(roots.map(root => root.available_at).sort((a, b) => Number(a) - Number(b)),
    [exactMissionAvailability, exactScheduleAvailability]);
  assert(roots.every(root => root.status === 'queued'), 'future root became runnable early');
  assert.equal(db.claimNextMissionTask('entry-worker'), null, 'future availability gate was bypassed');

  const job = db.getAllScheduledTasks('entry-initiator').find(task => task.id === jobId);
  assert(job);
  assert.equal(job.status, 'active');
  assert.equal(job.last_status, 'success');
  assert(job.next_run > jobFireAt, 'recurring job did not advance to its next fire');

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tracked = ['src/agent.ts', 'src/cli-actions.ts', 'src/db.ts', 'src/dispatch-tools.ts', 'src/mission-entry-key.ts', 'src/scheduler.ts'];
  const sourceSha256 = createHash('sha256');
  for (const file of tracked) sourceSha256.update(file).update(fs.readFileSync(path.join(root, file)));
  const report = {
    passed: true,
    runDir,
    isolation: { config: config.CLAUDECLAW_CONFIG, store: config.STORE_DIR, workspace },
    effectiveProvider: getSelectedProviderConfig(),
    transport: process.env.CODEX_TRANSPORT,
    maxTurnsPerInvocation: config.AGENT_MAX_TURNS,
    initiatingMission: db.getMissionTask(initiatingMission.id),
    recurringJob: job,
    workflows: workflows.map(workflow => ({ workflow, tasks: db.getMissionWorkflowTasks(workflow.id) })),
    expectedRootAvailability: { futureMission: exactMissionAvailability, recurringJob: exactScheduleAvailability },
    usage: db.getDashboardRecentTokenUsage(`mission:${initiatingMission.id}`, 10),
    messages,
    sourceSha256: sourceSha256.digest('hex'),
    dispatchBuildSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', 'dispatch-tools.js'))).digest('hex'),
  };
  const evidence = path.join(runDir, 'evidence.json');
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, workflowIds: workflows.map(w => w.id), effectiveProvider: report.effectiveProvider }));
} catch (error) {
  const evidence = path.join(runDir, 'failure.json');
  fs.writeFileSync(evidence, JSON.stringify({
    passed: false,
    runDir,
    effectiveProvider: getSelectedProviderConfig(),
    initiatingMission: db.getMissionTask(initiatingMission.id),
    workflows: db.getMissionWorkflows().map(workflow => ({ workflow, tasks: db.getMissionWorkflowTasks(workflow.id) })),
    schedules: db.getAllScheduledTasks('entry-initiator'),
    messages,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  }, null, 2));
  console.error(JSON.stringify({ passed: false, evidence, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  messageQueue.enqueue = enqueue;
  if (process.env.CODEX_TRANSPORT === 'app-server') {
    await (await import('../src/agent-engine/codex-app-server-manager.js')).CodexAppServerManager.resetShared();
  }
}
