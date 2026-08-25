#!/usr/bin/env node
/**
 * Non-interactive CLI for creating ClaudeClaw agents.
 * Designed to be called by the Telegram agent or CI scripts.
 *
 * Usage:
 *   node dist/agent-create-cli.js \
 *     --id analytics \
 *     --name "Analytics" \
 *     --description "Data analysis and reporting" \
 *     --model claude-sonnet-4-6 \
 *     --template research \
 *     --token "123456789:ABCdef..." \
 *     --activate
 *
 * Flags:
 *   --id          Canonical agent id (required, lowercase, no spaces). Permanent —
 *                 it's the primary key every task/history row is stored under and
 *                 never changes, so renames don't orphan history.
 *   --name        Display name (required). Mutable later via the dashboard; the
 *                 previous name is retained as an alias so old references still
 *                 resolve. Must not collide with any existing agent's id, display
 *                 name, or alias.
 *   --description What this agent does (required)
 *   --model       Model override (default: claude-sonnet-4-6)
 *   --template    Template to copy from (default: _template)
 *   --token       Telegram bot token from BotFather (required for messenger mode)
 *   --runtime-mode messenger or headless (default: messenger)
 *   --lifecycle    persistent or task-scoped (headless only; default: persistent)
 *   --activate    Install launchd/systemd service and start immediately
 *   --validate    Only validate the token, don't create anything
 *   --suggest     Only print suggested bot names for the given --id
 */

import { pathToFileURL } from 'url';

import { createAgent, validateBotToken, validateAgentId, activateAgent, suggestBotNames, listTemplates } from './agent-create.js';
import { renderHelp } from './cli-reference.js';
import { agentCreateDescriptor as descriptor } from './cli-descriptors.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--activate') {
      args.activate = true;
    } else if (arg === '--validate') {
      args.validate = true;
    } else if (arg === '--suggest') {
      args.suggest = true;
    } else if (arg === '--templates') {
      args.templates = true;
    } else if (arg.startsWith('--') && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(renderHelp(descriptor));
    process.exit(0);
  }

  // --templates: list and exit
  if (args.templates) {
    const templates = listTemplates();
    for (const t of templates) {
      console.log(`  ${t.id.padEnd(12)} ${t.name.padEnd(12)} ${t.description}`);
    }
    process.exit(0);
  }

  // --suggest: print names and exit
  if (args.suggest) {
    const id = args.id as string;
    if (!id) { console.error('--id required with --suggest'); process.exit(1); }
    const names = suggestBotNames(id);
    console.log(JSON.stringify(names, null, 2));
    process.exit(0);
  }

  // --validate: check token and exit
  if (args.validate) {
    const token = args.token as string;
    if (!token) { console.error('--token required with --validate'); process.exit(1); }
    const result = await validateBotToken(token);
    if (result.ok) {
      console.log(`Valid: @${result.botInfo!.username} (${result.botInfo!.first_name})`);
    } else {
      console.error(`Invalid: ${result.error}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Full creation flow
  const id = args.id as string;
  const name = args.name as string;
  const description = args.description as string;
  const token = args.token as string;
  const runtimeMode = (args['runtime-mode'] as string) || 'messenger';
  const lifecycleMode = (args.lifecycle as string) || 'persistent';

  if (!id || !name || !description || (runtimeMode === 'messenger' && !token)) {
    console.error('Missing required flags. Use --help for usage.');
    process.exit(1);
  }
  if (runtimeMode !== 'messenger' && runtimeMode !== 'headless') {
    console.error('--runtime-mode must be messenger or headless');
    process.exit(1);
  }
  if (lifecycleMode !== 'persistent' && lifecycleMode !== 'task-scoped') {
    console.error('--lifecycle must be persistent or task-scoped');
    process.exit(1);
  }
  if (runtimeMode !== 'headless' && lifecycleMode === 'task-scoped') {
    console.error('--lifecycle task-scoped requires --runtime-mode headless');
    process.exit(1);
  }

  // Pre-validate ID
  const idCheck = validateAgentId(id);
  if (!idCheck.ok) {
    console.error(`Invalid agent ID: ${idCheck.error}`);
    process.exit(1);
  }

  console.log(`Creating agent "${id}"...`);

  try {
    const result = await createAgent({
      id,
      name,
      description,
      model: (args.model as string) || undefined,
      template: (args.template as string) || undefined,
      botToken: token,
      runtimeMode,
      lifecycleMode,
    });

    console.log(`Agent created successfully.`);
    console.log(`  Directory: ${result.agentDir}`);
    console.log(`  Runtime:   ${runtimeMode}`);
    if (runtimeMode === 'headless') console.log(`  Lifecycle: ${lifecycleMode}`);
    if (result.envKey) console.log(`  Env key:   ${result.envKey}`);
    if (result.botInfo) console.log(`  Bot:       @${result.botInfo.username}`);
    if (result.plistPath) {
      console.log(`  Service:   ${result.plistPath}`);
    }

    if (args.activate) {
      console.log(`\nActivating...`);
      const activation = activateAgent(id);
      if (activation.ok) {
        console.log(`Agent activated.${activation.pid ? ` PID: ${activation.pid}` : ''}`);
      } else {
        console.error(`Activation failed: ${activation.error}`);
        process.exit(1);
      }
    } else {
      console.log(`\nTo activate: node dist/agent-create-cli.js --id ${id} --activate`);
      console.log(`Or manually: npm start -- --agent ${id}`);
    }
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Only run the CLI when invoked directly, so importing `descriptor` (for docs
// generation and the drift-guard test) does not trigger the creation flow.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
