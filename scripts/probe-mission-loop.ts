// Opt-in real-provider acceptance probe. All mission state and identities are disposable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const direction = process.argv[2] ?? 'openai';
const failover = process.argv[6] === 'failover';
if (!['openai', 'claude'].includes(direction)) throw new Error('Expected openai or claude');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-loop-'));
// Disposable missions must never inherit their launching crew task's identity.
delete process.env.CLAUDECLAW_MISSION_TASK_ID;
delete process.env.CLAUDECLAW_MISSION_ACTOR;
delete process.env.CLAUDECLAW_MISSION_ENTRY_KEY;
process.env.CLAUDECLAW_CONFIG = path.join(runDir, 'config');
process.env.CLAUDECLAW_STORE_DIR = path.join(runDir, 'store');
process.env.CLAUDECLAW_AGENT_ID = 'coordinator';
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const transport = process.argv[4] ?? 'sdk';
if (!['sdk', 'app-server'].includes(transport)) throw new Error('Invalid transport');
process.env.CODEX_TRANSPORT = transport;
process.env.AGENT_MAX_TURNS = '8';
process.env.AGENT_MAX_RUNTIME_MS = '180000';
process.env.AGENT_IDLE_TIMEOUT_MS = '90000';
const workspace = path.join(runDir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const primaryPath = path.join(workspace, 'release-manifest.txt');
const secondaryPath = path.join(workspace, 'secondary-note.txt');
const conflictingPath = path.join(workspace, 'conflicting-notes.txt');
fs.writeFileSync(primaryPath, 'Synthetic acceptance fixture.\nThe fixture release version is 1.10.0.\n');
fs.writeFileSync(secondaryPath, 'A teammate says the fixture version is 1.10.0. This secondary note contains no primary-source quote.\n');
fs.writeFileSync(conflictingPath, 'Secondary note A claims version 1.9.0. Secondary note B claims version 1.10.0. Neither supplies primary evidence.\n');
for (const id of ['coordinator', 'researcher', 'verifier']) {
  const dir = path.join(process.env.CLAUDECLAW_CONFIG, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  const providerType = id === 'coordinator' ? direction : direction === 'openai' ? 'claude' : 'openai';
  // Native OpenAI defaults to managed permissions. On this Windows host that
  // correctly denies command execution, including shell-backed file reads. The
  // disposable workers need an explicit execution grant to exercise real fixture
  // reads; the coordinator deliberately never receives it.
  const workerExecutionGrant = id !== 'coordinator' && providerType === 'openai';
  fs.writeFileSync(path.join(dir, 'agent.yaml'), [
    `name: ${id}`,
    'provider:',
    `  type: ${providerType}`,
    ...(workerExecutionGrant ? ['  dangerouslySkipPermissions: true'] : []),
    '',
  ].join('\n'));
}
const config = await import('../src/config.js');
if (path.resolve(config.STORE_DIR) !== path.join(runDir, 'store')) throw new Error('Store isolation failed');
const db = await import('../src/db.js');
const { runAgent, isFailedTurn } = await import('../src/agent.js');
const { registerDispatchTools } = await import('../src/dispatch-tools.js');
const { missionExecutionPrompt, initScheduler, runDueTasks } = await import('../src/scheduler.js');
const { messageQueue } = await import('../src/message-queue.js');
const { missionCoordinatorToolPolicy } = await import('../src/mission-coordinator-policy.js');
const { runWithMissionExecutionContext } = await import('../src/mission-execution-context.js');
db.initDatabase();
registerDispatchTools();
const id = randomUUID();
const scenario = process.argv[3] ?? 'incomplete';
const satisfied = scenario === 'satisfied';
const contradictory = scenario === 'contradictory';
const fallback = direction === 'openai'
  ? { type: 'claude', model: 'claude-opus-4-8', runtimeMode: 'medium' }
  : { type: 'openai', model: 'gpt-5.6-sol', thinkingMode: 'medium' };
if (failover) fs.appendFileSync(path.join(process.env.CLAUDECLAW_CONFIG!, 'agents', 'coordinator', 'agent.yaml'),
  `fallback:\n  providers: ${JSON.stringify([fallback])}\n  cooldown_seconds: 300\n`);
const faults: unknown[] = [];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFiles = (fs.readdirSync(path.join(root, 'src'), { recursive: true }) as string[])
  .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).sort();
const sourceHash = createHash('sha256');
for (const file of sourceFiles) sourceHash.update(file).update(fs.readFileSync(path.join(root, 'src', file)));
const sourceSha256 = sourceHash.digest('hex');
const dispatchBuildSha256 = createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', 'dispatch-tools.js'))).digest('hex');
db.createMissionWorkflow({
  id, rootTaskId: `${id}-root`, title: 'Verify fixture release version',
  objective: `Produce the fixture release version with a named primary source and exact supporting quote. Findings without both are insufficient. Source-backed findings from either worker satisfy the criteria; a second independent review is not required. The host created real fixture files: primary source ${primaryPath}, secondary note ${secondaryPath}, and conflicting notes ${conflictingPath}. These files have different evidence quality; an incomplete secondary note does not imply that no primary source exists. Authorized scope: read these fixture files only. Available workers: researcher and verifier. The verifier may read the primary source to obtain missing evidence or resolve contradictions. Commission only missing evidence, then complete when criteria are met. No external actions.`,
  initialPrompt: satisfied
    ? `Read ${primaryPath}. Return its version, source name and exact supporting quote.`
    : contradictory
      ? `For this initial step, read only ${conflictingPath} and report its contradiction without inventing support. The verifier can read the separate primary source during a later step.`
      : `For this initial step, read only ${secondaryPath}. Report what it supports and what evidence is missing from that note. The verifier can read the separate primary source during a later step.`,
  ownerAgent: 'coordinator', workerAgent: 'researcher', priority: 5,
  maxDepth: 2, maxTasks: 3, maxFanout: 1, deadlineAt: Math.floor(Date.now() / 1000) + 900,
});
const turns: unknown[] = [];
const messages: string[] = [];
const driver = process.argv[5] ?? 'scheduler';
const send = async (text: string) => { messages.push(text); };
const snapshot = () => {
  const report = { runDir, direction, scenario, satisfied, transport, driver, sourceSha256, dispatchBuildSha256, faults, workflow: db.getMissionWorkflow(id), tasks: db.getMissionWorkflowTasks(id), outcomes: db.getMissionWorkflowOutcomes(id), transitions: db.getMissionWorkflowTransitions(id), turns, messages,
    usage: db.getDashboardRecentTokenUsage(`mission:${id}`, 30) };
  fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify(report, null, 2));
  return report;
};
console.log(JSON.stringify({ runDir, direction, workflowId: id }));
try {
  for (let step = 0; step < 10; step++) {
    const workflow = db.getMissionWorkflow(id)!;
    if (!['active', 'coordinating'].includes(workflow.status)) break;
    const next = db.getMissionWorkflowTasks(id).find(task => task.status === 'queued');
    if (!next?.assigned_agent) throw new Error('Active workflow has no queued progress');
    const task = driver === 'scheduler' ? next : db.claimNextMissionTask(next.assigned_agent)!;
    if (failover && task.role === 'coordinator' && db.getMissionWorkflowTransitions(id).length > 0 && faults.length === 0) {
      // Isolated shared-health injection before a new assignment, never a replay
      // of an uncertain call. Subsequent selection/execution is the real scheduler.
      const key = `${direction}:default:${direction === 'openai' ? 'gpt-5.6-sol' : 'claude-opus-4-8'}`;
      const now = Math.floor(Date.now() / 1000);
      for (const token of ['fixture-outage-1', 'fixture-outage-2']) {
        db.claimProviderHealth(key, token, now);
        db.recordProviderHealth(key, token, now, 300, '503 isolated health fixture');
      }
      faults.push({ key, taskId: task.id, at: now, kind: 'shared-circuit-open-before-next-coordinator' });
    }
    const coordinator = task.role === 'coordinator';
    const providerType = coordinator ? direction : direction === 'openai' ? 'claude' : 'openai';
    const provider = providerType === 'openai'
      ? { type: 'openai' as const, model: 'gpt-5.6-sol', thinkingMode: 'medium',
          // Probe-only grant: worker file reads use Codex's shell. Coordinator
          // turns remain governed by missionCoordinatorToolPolicy below.
          ...(coordinator ? {} : { dangerouslySkipPermissions: true }) }
      : { type: 'claude' as const, model: 'claude-opus-4-8', runtimeMode: 'medium' };
    process.env.CLAUDECLAW_AGENT_ID = next.assigned_agent;
    config.setAgentOverrides({ agentId: next.assigned_agent, botToken: '', cwd: workspace, provider,
      systemPrompt: `You are a disposable read-only acceptance agent. Use the host-created fixture files under ${workspace}. Workers must read the assigned files and return findings with source attribution; do not invent file contents. Coordinators assess worker evidence and use mission_transition. No external actions.` });
    if (driver === 'scheduler') {
      const stop = initScheduler(send, next.assigned_agent);
      stop();
      const callbacks: Array<() => Promise<void>> = [];
      const enqueue = messageQueue.enqueue;
      messageQueue.enqueue = (_chat, callback) => { callbacks.push(callback); };
      try {
        await runDueTasks();
        if (callbacks.length !== 1) throw new Error(`Expected one scheduler execution, received ${callbacks.length}`);
        await callbacks[0]();
      } finally { messageQueue.enqueue = enqueue; }
      turns.push({ taskId: task.id, role: task.role, provider, result: db.getMissionTask(task.id) });
      snapshot();
      console.log(JSON.stringify({ step, taskId: task.id, status: db.getMissionWorkflow(id)?.status, driver }));
      continue;
    }
    const prompt = missionExecutionPrompt(task);
    const events: unknown[] = [];
    const result = await runWithMissionExecutionContext({ taskId: task.id, actor: next.assigned_agent }, () =>
      runAgent(prompt, undefined, () => {}, event => events.push(event), undefined,
        new AbortController(), undefined, [], provider, coordinator ? missionCoordinatorToolPolicy : undefined));
    turns.push({ taskId: task.id, role: task.role, provider, result, events });
    db.completeMissionTask(task.id, result.text, isFailedTurn(result) || result.aborted ? 'failed' : 'completed', isFailedTurn(result) ? result.text ?? result.stopReason : undefined);
    snapshot();
    console.log(JSON.stringify({ step, taskId: task.id, provider, status: db.getMissionWorkflow(id)?.status, stopReason: result.stopReason }));
    if (isFailedTurn(result) || result.aborted) break;
  }
  if (driver === 'scheduler') {
    const stop = initScheduler(send, 'coordinator');
    stop();
    await runDueTasks();
  }
  const report = snapshot();
  const dispositions = report.transitions.map(t => t.disposition);
  const passed = report.workflow?.status === 'completed' && dispositions.at(-1) === 'complete'
    && report.workflow.terminal_reason?.includes('release-manifest.txt')
    && report.workflow.terminal_reason?.includes('The fixture release version is 1.10.0.')
    && (satisfied ? dispositions.length === 1 : dispositions.some(d => d === 'dispatch' || d === 'gather'))
    && (driver !== 'scheduler' || messages.length === 1)
    && (!failover || (faults.length === 1 && new Set(report.usage.filter(row => row.agent_id === 'coordinator').map(row => row.model)).size === 2));
  console.log(JSON.stringify({ passed, evidence: path.join(runDir, 'evidence.json'), dispositions }));
  await (await import('../src/agent-engine/codex-app-server-manager.js')).CodexAppServerManager.resetShared();
  process.exit(passed ? 0 : 1);
} catch (error) {
  snapshot();
  console.error(error);
  await (await import('../src/agent-engine/codex-app-server-manager.js')).CodexAppServerManager.resetShared();
  process.exit(1);
}
