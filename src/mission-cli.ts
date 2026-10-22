#!/usr/bin/env node
/**
 * ClaudeClaw Mission CLI
 *
 * Used by Claude assistants to create and manage one-shot mission tasks
 * that are picked up and executed by the target agent's scheduler.
 *
 * This is a THIN argv front-end: it parses flags and formats output, but the
 * business logic lives in `cli-actions.ts` — the SAME functions the in-process
 * dispatch tools call, so the CLI and the tool can never drift. Recoverable
 * failures (unknown agent, missing task) come back as `CliActionError`, which we
 * print to stderr and exit non-zero on, exactly as before.
 *
 * Usage:
 *   node dist/mission-cli.js create --agent research --title "Label" [--at <RFC3339>] "Full prompt"
 *   node dist/mission-cli.js handback <task-id> "Report text"   (replies to the task's originator)
 *   node dist/mission-cli.js list [--status queued]
 *   node dist/mission-cli.js result <id>
 *   node dist/mission-cli.js cancel <id>
 *   node dist/mission-cli.js gather --summary-agent research --title "Label" \
 *     --task "agentA:prompt for A" --task "agentB:prompt for B" "Join/summary prompt"
 *     (fan out N tasks, park a join mission the scheduler releases once all children finish)
 */

import { pathToFileURL } from 'url';

import { renderHelp } from './cli-reference.js';
import { missionDescriptor as descriptor } from './cli-descriptors.js';
import {
  CliActionError,
  actionCancelMission,
  actionCancelMissionChain,
  actionContinueMission,
  actionCreateMission,
  actionGather,
  actionHandbackMission,
  actionListMissions,
  actionMissionResult,
} from './cli-actions.js';

// Only run the CLI when invoked directly, so importing `descriptor` (for docs
// generation and the drift-guard test) does not trigger DB init or arg parsing.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(renderHelp(descriptor));
    process.exit(0);
  }
  runCli();
}

function formatDate(unix: number | null): string {
  if (!unix) return '-';
  return new Date(unix * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * Collect every occurrence of a repeated flag (e.g. `--task "a:b"` used
 * multiple times) and return its indices so they can be stripped from argv
 * before positional parsing, along with the collected values in order.
 */
function collectRepeatedFlag(argv: string[], flag: string): { values: string[]; indices: number[] } {
  const values: string[] = [];
  const indices: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      indices.push(i, i + 1);
      values.push(argv[i + 1] ?? '');
    }
  }
  return { values, indices };
}

function runCli(): void {
  try {
    dispatch();
  } catch (err) {
    // Recoverable, user-facing action failures print their message to stderr and
    // exit non-zero, writing nothing — identical surface to the old inline
    // resolve-then-store guard. Programmer errors keep their stack trace.
    if (err instanceof CliActionError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

function dispatch(): void {
  // Parse --agent flag (null = unassigned, use auto-assign on dashboard)
  const agentFlagIdx = process.argv.indexOf('--agent');
  const targetAgent = agentFlagIdx !== -1
    ? process.argv[agentFlagIdx + 1] ?? null
    : null;

  // Parse --title flag
  const titleFlagIdx = process.argv.indexOf('--title');
  const titleArg = titleFlagIdx !== -1
    ? process.argv[titleFlagIdx + 1] ?? ''
    : '';

  // Parse --status flag
  const statusFlagIdx = process.argv.indexOf('--status');
  const statusFilter = statusFlagIdx !== -1
    ? process.argv[statusFlagIdx + 1] ?? undefined
    : undefined;

  // Parse --priority flag
  const priorityFlagIdx = process.argv.indexOf('--priority');
  const priorityArg = priorityFlagIdx !== -1
    ? parseInt(process.argv[priorityFlagIdx + 1] ?? '0', 10)
    : 5;
  const keyFlagIdx = process.argv.indexOf('--key');
  const keyArg = keyFlagIdx !== -1 ? process.argv[keyFlagIdx + 1] ?? '' : '';
  const maxStepsFlagIdx = process.argv.indexOf('--max-steps');
  const maxStepsArg = maxStepsFlagIdx !== -1 ? parseInt(process.argv[maxStepsFlagIdx + 1] ?? '0', 10) : undefined;
  const atFlagIdx = process.argv.indexOf('--at');
  const atArg = atFlagIdx !== -1 ? process.argv[atFlagIdx + 1] ?? '' : undefined;

  // Parse --summary-agent flag (gather command's join assignee)
  const summaryAgentFlagIdx = process.argv.indexOf('--summary-agent');
  const summaryAgentArg = summaryAgentFlagIdx !== -1
    ? process.argv[summaryAgentFlagIdx + 1] ?? null
    : null;

  const { values: taskArgs, indices: taskFlagIndices } = collectRepeatedFlag(process.argv, '--task');

  // Who created this task
  const createdBy = process.env.CLAUDECLAW_AGENT_ID ?? 'main';

  // Clean argv: remove all flag pairs
  const flagIndices = new Set<number>();
  [agentFlagIdx, titleFlagIdx, statusFlagIdx, priorityFlagIdx, summaryAgentFlagIdx, keyFlagIdx, maxStepsFlagIdx, atFlagIdx].forEach(idx => {
    if (idx !== -1) { flagIndices.add(idx); flagIndices.add(idx + 1); }
  });
  taskFlagIndices.forEach((idx) => flagIndices.add(idx));
  const cleanedArgv = process.argv.filter((_, i) => !flagIndices.has(i));
  const [, , command, ...rest] = cleanedArgv;

  // Reject unknown --flags rather than swallowing them as positional prompt text.
  // Known flag pairs are stripped above; any leftover token starting with `--` is
  // a typo'd/unsupported flag (e.g. `--body`). Without this guard it would be
  // silently accepted as the prompt/report body and corrupt the task. See #162.
  const KNOWN_FLAGS = [
    '--agent', '--title', '--priority', '--status', '--summary-agent', '--task',
    '--key', '--max-steps', '--at', '--help',
  ];
  const unknownFlags = rest.filter((tok) => tok.startsWith('--'));
  if (unknownFlags.length > 0) {
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`);
    console.error(`Known flags: ${KNOWN_FLAGS.join(', ')}`);
    console.error('If this was meant as prompt text, drop the leading "--".');
    process.exit(1);
  }

  switch (command) {
    case 'create': {
      const prompt = rest[0];
      if (!prompt) {
        console.error('Usage: mission-cli create --agent <id> --title "Label" [--at <RFC3339>] "Full prompt text"');
        process.exit(1);
      }
      if (!targetAgent && process.env.CLAUDECLAW_AGENT_ID?.trim()) {
        console.error('An agent must pass --agent <id>. Unassigned missions wait in the Inbox for dashboard assignment.');
        process.exit(1);
      }
      const r = actionCreateMission({
        prompt,
        agent: targetAgent,
        title: titleArg,
        priority: priorityArg,
        createdBy,
        at: atArg,
      });
      console.log(`Mission task created: ${r.id}`);
      console.log(`  Title:    ${r.title}`);
      console.log(`  Agent:    ${r.agent || 'unassigned (use dashboard to assign)'}`);
      console.log(`  Priority: ${r.priority}`);
      if (r.availableAt) console.log(`  Run at:   ${new Date(r.availableAt * 1000).toISOString()}`);
      console.log(`  Prompt:   ${r.prompt.slice(0, 100)}${r.prompt.length > 100 ? '...' : ''}`);
      break;
    }

    case 'handback': {
      const parentId = rest[0];
      const report = rest[1];
      if (!parentId || !report) {
        console.error('Usage: mission-cli handback <task-id> "Report text"');
        process.exit(1);
      }
      const r = actionHandbackMission({ taskId: parentId, report, priority: priorityArg, createdBy });
      if (r.kind === 'agent') {
        console.log(`Handback delivered to @${r.dest} (originator of ${r.parentId}).`);
        console.log(`  Mission: ${r.missionId}`);
      } else {
        // Reserved origin (dashboard/human/scheduled) has no mission inbox —
        // surfaced to the human via the runtime's primary agent.
        console.log(`Handback routed to @${r.dest} to surface to the human (${r.reason}).`);
        console.log(`  Mission: ${r.missionId}`);
      }
      break;
    }

    case 'continue': {
      const parentId = rest[0];
      const prompt = rest[1];
      if (!parentId || !prompt || !keyArg) {
        console.error('Usage: mission-cli continue <task-id> "Next-step prompt" --key <idempotency-key> [--max-steps N]');
        process.exit(1);
      }
      const r = actionContinueMission({
        taskId: parentId, prompt, idempotencyKey: keyArg, maxSteps: maxStepsArg,
        priority: priorityFlagIdx !== -1 ? priorityArg : undefined, createdBy,
      });
      console.log(`${r.duplicate ? 'Existing' : 'Queued'} continuation ${r.step}/${r.limit} in chain ${r.chainId}.`);
      console.log(`  Mission: ${r.missionId}`);
      break;
    }

    case 'cancel-chain': {
      const chainId = rest[0];
      if (!chainId) {
        console.error('Usage: mission-cli cancel-chain <chain-id>');
        process.exit(1);
      }
      const r = actionCancelMissionChain({ chainId, createdBy });
      console.log(r.alreadyCancelled
        ? `Continuation chain ${r.chainId} is already cancelled.`
        : `Cancelled continuation chain ${r.chainId}; ${r.cancelledTasks} queued task(s) stopped.`);
      break;
    }

    case 'list': {
      const tasks = actionListMissions({ status: statusFilter });
      if (tasks.length === 0) {
        console.log('No mission tasks' + (statusFilter ? ` with status "${statusFilter}"` : '') + '.');
        break;
      }
      console.log(`${tasks.length} mission task${tasks.length === 1 ? '' : 's'}:\n`);
      for (const t of tasks) {
        console.log(`${t.id} [${t.status}] @${t.assigned_agent}`);
        console.log(`  Title:   ${t.title}`);
        console.log(`  Created: ${formatDate(t.created_at)}`);
        if (t.available_at) console.log(`  Run at:  ${formatDate(t.available_at)}`);
        if (t.completed_at) console.log(`  Done:    ${formatDate(t.completed_at)}`);
        console.log();
      }
      break;
    }

    case 'result': {
      const id = rest[0];
      if (!id) { console.error('Usage: mission-cli result <id>'); process.exit(1); }
      const task = actionMissionResult({ id });
      console.log(`Task:   ${task.id} [${task.status}]`);
      console.log(`Title:  ${task.title}`);
      console.log(`Agent:  ${task.assigned_agent}`);
      if (task.result) {
        console.log(`\nResult:\n${task.result}`);
      } else if (task.error) {
        console.log(`\nError: ${task.error}`);
      } else {
        console.log('\nNo result yet.');
      }
      break;
    }

    case 'cancel': {
      const id = rest[0];
      if (!id) { console.error('Usage: mission-cli cancel <id>'); process.exit(1); }
      const ok = actionCancelMission({ id });
      console.log(ok ? `Cancelled task: ${id}` : `Could not cancel (may already be completed): ${id}`);
      break;
    }

    case 'gather': {
      if (!summaryAgentArg) {
        console.error('Usage: mission-cli gather --summary-agent <agent> --title "Label" --task "agent:prompt" [--task ...] "join/summary prompt"');
        process.exit(1);
      }
      if (taskArgs.length === 0) {
        console.error('gather requires at least one --task "agent:prompt"');
        process.exit(1);
      }
      const r = actionGather({
        summaryAgent: summaryAgentArg,
        tasks: taskArgs,
        joinPrompt: rest[0],
        title: titleArg,
        priority: priorityArg,
        createdBy,
      });
      console.log(`Gather group created: ${r.groupId}`);
      console.log(`  Children: ${r.childIds.join(', ')}`);
      console.log(`  Join (parked, waiting): ${r.joinId} -> @${r.summaryAgent}`);
      break;
    }

    default:
      console.error('Commands: create | handback | continue | cancel-chain | list | result | cancel | gather');
      process.exit(1);
  }
}
