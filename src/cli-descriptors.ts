/**
 * Registry of every shipped agent CLI descriptor — a self-contained LEAF DATA
 * module. Each descriptor object is defined DIRECTLY here as a `const`, so this
 * file imports ONLY the `CliDescriptor` type. It deliberately does NOT import
 * any CLI module (which would pull in db.ts and close a config → descriptors →
 * *-cli → db → config import cycle). The CLIs import their descriptor FROM here.
 *
 * This is the single list of documented CLIs, shared by:
 *   - the generator (`scripts/gen-cli-reference.ts`) and the drift/coverage
 *     guard test (`src/cli-reference.test.ts`), and
 *   - `src/config.ts`, which injects a compact CLI index into every agent's
 *     system prompt via `renderCliIndex(allDescriptors)`.
 *
 * To document a NEW CLI: define its `descriptor` here, add it to
 * `allDescriptors`, and import it in the CLI's source for `--help`. The
 * coverage guard test fails if a `src/*-cli.ts` file has no matching entry, so
 * a new CLI cannot ship undocumented.
 */

import type { CliDescriptor } from './cli-reference.js';

export const agentCreateDescriptor: CliDescriptor = {
  name: 'agent-create-cli',
  binary: 'dist/agent-create-cli.js',
  summary: 'Non-interactively create a ClaudeClaw agent (used by the Telegram agent or CI).',
  ship: true,
  commands: [
    {
      usage:
        'agent-create-cli --id ID --name NAME --description DESC [--runtime-mode messenger|headless] [--lifecycle persistent|task-scoped] [--token TOKEN] [--model MODEL] [--template TEMPLATE] [--activate]',
      description:
        'Create an agent. Messenger mode requires --token; headless mode does not. Headless lifecycle defaults to persistent; task-scoped workers drain and deactivate after their work completes.',
    },
    {
      usage: '--validate --token TOKEN',
      description: 'Only validate the Telegram bot token, then exit.',
    },
    {
      usage: '--suggest --id ID',
      description: 'Print suggested bot names for the given --id as JSON, then exit.',
    },
    {
      usage: '--templates',
      description: 'List available templates, then exit.',
    },
  ],
  notes: [
    '--id must be lowercase with no spaces; --name and --description are required for creation.',
    '--token is a Telegram bot token from @BotFather.',
    'Creating or activating a new headless worker identity requires explicit user authorization. Do not infer authorization from a request for delegation or parallelism.',
    'Task-scoped workers deactivate automatically after their work drains, but agent identity and history are never deleted automatically.',
  ],
};

export const meetDescriptor: CliDescriptor = {
  name: 'meet-cli',
  binary: 'dist/meet-cli.js',
  summary: 'Send an agent into a video meeting as a real-time AI avatar (Pika or Daily.co).',
  ship: true,
  commands: [
    {
      usage:
        'join --meet-url <url> [--agent <id>] [--brief <file>] [--auto-brief] [--context <hint>] [--bot-name <name>] [--voice-id <id>] [--meeting-password <pw>]',
      description:
        'Pika avatar mode: the bot joins an existing Google Meet / Zoom URL with a real-time AI avatar. --agent defaults to main.',
    },
    {
      usage:
        'join-daily [--agent <id>] [--mode direct|auto] [--brief <file>] [--auto-brief] [--context <hint>] [--bot-name <name>] [--room-name <slug>] [--ttl-sec <seconds>]',
      description:
        'Daily.co mode: create a new Daily room, spawn a Pipecat agent in it, and return the room URL to share. Requires DAILY_API_KEY and GOOGLE_API_KEY.',
    },
    {
      usage: 'brief --meet-url <url> [--agent <id>] [--context <hint>]',
      description:
        'Run the pre-flight research pipeline and write a system-prompt brief file to the temp dir using the agent\'s full stack.',
    },
    { usage: 'leave --session-id <id>', description: 'Make the bot leave a meeting / tear down the Daily room.' },
    { usage: 'list [--active]', description: 'List recent meet sessions, or only live ones with --active.' },
    { usage: 'show --session-id <id>', description: 'Show full detail for one meet session.' },
  ],
  notes: [
    'Output is JSON on stdout: {"ok": true, ...} on success or {"ok": false, "error": ...} on failure.',
    'Pika mode requires PIKA_DEV_KEY and resolves avatars from warroom/avatars/<agent>-meet.png (falling back to <agent>.png).',
  ],
};

export const hiveDescriptor: CliDescriptor = {
  name: 'hive-cli',
  binary: 'dist/hive-cli.js',
  summary: 'Store-aware hive-mind accessor — the ONLY sanctioned way to read/write hive_mind.',
  ship: true,
  commands: [
    {
      usage: 'path',
      description:
        'Print the resolved hive-mind DB absolute path. Does NOT open the DB (works without DB_ENCRYPTION_KEY) — answers "where is my store?".',
      tool: { name: 'hive_path', params: [] },
    },
    {
      usage: 'read [--limit N]',
      description: 'Print the most recent hive_mind entries (default 10).',
      tool: {
        name: 'hive_read',
        params: [
          { name: 'limit', type: 'number', required: false, description: 'Max entries to return (default 10).' },
        ],
      },
    },
    {
      usage: 'log --action <action> --summary <summary> [--agent <id>]',
      description:
        'Append a hive_mind entry. --agent defaults to CLAUDECLAW_AGENT_ID (or "main"). Log after any meaningful action so the fleet can see it.',
      tool: {
        name: 'hive_log',
        params: [
          { name: 'action', type: 'string', required: true, description: 'Short action label for the entry.' },
          { name: 'summary', type: 'string', required: true, description: 'One-line summary of what happened.' },
          { name: 'agent', type: 'string', required: false, description: 'Agent id to attribute (defaults to CLAUDECLAW_AGENT_ID or "main").' },
        ],
      },
    },
  ],
  notes: [
    'Resolves the store via config.ts STORE_DIR (honors the .env CLAUDECLAW_STORE_DIR pin) — never re-derives from process.env.',
    'Never touch hive_mind with a raw sqlite3 call against a build-relative path; it can silently hit the wrong (e.g. live) DB when the store is relocated.',
  ],
};

export const missionDescriptor: CliDescriptor = {
  name: 'mission-cli',
  binary: 'dist/mission-cli.js',
  summary: 'Create and manage one-shot mission tasks executed by a target agent.',
  ship: true,
  commands: [
    {
      usage: 'create [--agent <id>] [--title "Label"] [--priority N] [--at <RFC3339>] "Full prompt text"',
      description:
        'Queue a one-shot mission task immediately, or gate it until a future RFC 3339 timestamp with --at. The timestamp must include Z or an explicit UTC offset. --agent assigns it (omit to leave unassigned for dashboard auto-assign); --title defaults to the first 60 chars of the prompt; --priority defaults to 5.',
      tool: {
        name: 'mission_create',
        params: [
          { name: 'prompt', type: 'string', required: true, description: 'Full prompt text for the mission.' },
          { name: 'agent', type: 'string', required: false, description: 'Target agent id/name/alias; omit to leave unassigned for dashboard auto-assign.' },
          { name: 'title', type: 'string', required: false, description: 'Short label (defaults to the first 60 chars of the prompt).' },
          { name: 'priority', type: 'number', required: false, description: 'Priority (default 5).' },
          { name: 'at', type: 'string', required: false, description: 'Future RFC 3339 timestamp with Z or an explicit UTC offset.' },
        ],
      },
    },
    {
      usage: 'handback <task-id> "Report text"',
      description:
        'Report back on a task you were assigned. Routes deterministically to the task\'s originator (created_by) — another agent, or the human via the primary agent. Use this to close the loop; never guess the recipient.',
      tool: {
        name: 'mission_handback',
        params: [
          { name: 'task_id', type: 'string', required: true, description: 'Id of the task you were assigned.' },
          { name: 'report', type: 'string', required: true, description: 'Report text to hand back to the originator.' },
          { name: 'priority', type: 'number', required: false, description: 'Priority of the handback mission (default 5).' },
        ],
      },
    },
    {
      usage: 'continue <task-id> "Next-step prompt" --key <idempotency-key> [--max-steps N]',
      description: 'Queue the next step of an explicitly bounded self-directed chain. The first step fixes the chain limit; every request requires a stable idempotency key.',
      tool: {
        name: 'mission_continue',
        params: [
          { name: 'task_id', type: 'string', required: true, description: 'Current self-directed task id.' },
          { name: 'prompt', type: 'string', required: true, description: 'Prompt for the next step.' },
          { name: 'idempotency_key', type: 'string', required: true, description: 'Stable key preventing duplicate next steps.' },
          { name: 'max_steps', type: 'number', required: false, description: 'Total chain limit, required on the first continuation.' },
          { name: 'priority', type: 'number', required: false, description: 'Priority (inherits the parent by default).' },
        ],
      },
    },
    {
      usage: 'cancel-chain <chain-id>',
      description: 'Persistently stop a self-directed continuation chain and cancel its queued next steps. A running step may finish but cannot advance the cancelled chain.',
      tool: {
        name: 'mission_cancel_chain',
        params: [
          { name: 'chain_id', type: 'string', required: true, description: 'Continuation chain id returned by mission_continue.' },
        ],
      },
    },
    {
      usage:
        'gather --summary-agent <id> --title "Label" --task "agent:prompt" [--task "agent:prompt" ...] "join/summary prompt"',
      description:
        'Non-blocking fan-out: queue one child task per --task, then a parked join task for --summary-agent. The scheduler releases the join with all child results once the last child finishes, producing ONE consolidated summary. Children finish with their findings as output — they do NOT handback.',
      tool: {
        name: 'mission_gather',
        params: [
          { name: 'summary_agent', type: 'string', required: true, description: 'Agent assigned the parked join/summary task.' },
          { name: 'tasks', type: 'string[]', required: true, description: 'Child tasks, each as "agent:prompt".' },
          { name: 'join_prompt', type: 'string', required: false, description: 'Prompt for the join/summary task.' },
          { name: 'title', type: 'string', required: false, description: 'Group label (default "Gather").' },
          { name: 'priority', type: 'number', required: false, description: 'Priority for all tasks (default 5).' },
        ],
      },
    },
    {
      usage: 'list [--status <status>]',
      description: 'List mission tasks, optionally filtered by status (e.g. queued).',
      tool: {
        name: 'mission_list',
        params: [
          { name: 'status', type: 'string', required: false, description: 'Filter by status (e.g. "queued").' },
        ],
      },
    },
    {
      usage: 'result <id>',
      description: 'Show a task with its status and result (or error) once it has run.',
      tool: {
        name: 'mission_result',
        params: [
          { name: 'id', type: 'string', required: true, description: 'Mission task id.' },
        ],
      },
    },
    {
      usage: 'cancel <id>',
      description: 'Cancel a queued task (no-op if it already completed).',
      tool: {
        name: 'mission_cancel',
        params: [
          { name: 'id', type: 'string', required: true, description: 'Mission task id to cancel.' },
        ],
      },
    },
  ],
  notes: [
    'Immediate tasks are normally claimed within ~60s. Tasks created with --at stay queued until the UTC availability gate opens.',
    'Every mission runs once, reaches a terminal status, and auto-purges after 7 days through normal mission retention.',
    'The creating agent is recorded from CLAUDECLAW_AGENT_ID (defaults to "main").',
    'Orchestration modes: delegate (create, 1->1 async), await (orchestrator fires N creates and waits inline — no CLI verb), gather (1->N non-blocking join). Handbacks resolve to the originator.',
  ],
};

export const scheduleDescriptor: CliDescriptor = {
  name: 'schedule-cli',
  binary: 'dist/schedule-cli.js',
  summary: 'Manage RECURRING scheduled tasks (cron) that fire in an agent process.',
  ship: true,
  commands: [
    {
      usage: 'create "prompt text" "cron expression" [--agent <id>]',
      description:
        'Create a recurring task from a prompt and a cron expression. Rejects invalid cron. --agent defaults to CLAUDECLAW_AGENT_ID or "main".',
      tool: {
        name: 'schedule_create',
        params: [
          { name: 'prompt', type: 'string', required: true, description: 'Prompt text the scheduled turn runs.' },
          { name: 'cron', type: 'string', required: true, description: 'Cron expression, e.g. "0 9 * * 1".' },
          { name: 'agent', type: 'string', required: false, description: 'Agent id/name/alias (defaults to CLAUDECLAW_AGENT_ID or "main").' },
        ],
      },
    },
    {
      usage: 'list [--agent <id>]',
      description:
        'List scheduled tasks with next/last run times. "main" lists all agents; any other --agent scopes to that agent.',
      tool: {
        name: 'schedule_list',
        params: [
          { name: 'agent', type: 'string', required: false, description: 'Scope to an agent; "main" (default) lists all.' },
        ],
      },
    },
    {
      usage: 'delete <id>',
      description: 'Delete a scheduled task.',
      tool: { name: 'schedule_delete', params: [{ name: 'id', type: 'string', required: true, description: 'Scheduled task id to delete.' }] },
    },
    {
      usage: 'pause <id>',
      description: 'Pause a scheduled task without deleting it.',
      tool: { name: 'schedule_pause', params: [{ name: 'id', type: 'string', required: true, description: 'Scheduled task id to pause.' }] },
    },
    {
      usage: 'resume <id>',
      description: 'Resume a paused scheduled task.',
      tool: { name: 'schedule_resume', params: [{ name: 'id', type: 'string', required: true, description: 'Scheduled task id to resume.' }] },
    },
  ],
  notes: [
    'For RECURRING jobs (cron). For one-shot tasks, use mission-cli instead.',
    'Cron examples: "0 9 * * 1" (Mon 9am), "0 8 * * *" (daily 8am), "0 */4 * * *" (every 4h).',
    'Tasks fire from the resolved agent\'s scheduler, not the main bot.',
  ],
};

export const slackDescriptor: CliDescriptor = {
  name: 'slack-cli',
  binary: 'dist/slack-cli.js',
  summary: 'Read and post to Slack from an agent (JSON output).',
  ship: true,
  commands: [
    {
      usage: 'list [--limit N]',
      description: 'List Slack conversations (default limit 20). Prints JSON.',
    },
    {
      usage: 'read <channel_id> [--limit N]',
      description: 'Read recent messages from a channel (default limit 15). Prints JSON.',
    },
    {
      usage: 'send <channel_id> "message" [--thread-ts TS]',
      description: 'Send a message to a channel, optionally replying in a thread.',
    },
    {
      usage: 'search <query>',
      description: 'Find conversations whose name contains the query (case-insensitive). Prints JSON.',
    },
  ],
};

export const dispatchMcpServerDescriptor: CliDescriptor = {
  name: 'dispatch-mcp-server',
  binary: 'dist/dispatch-mcp-server.js',
  summary:
    'Standalone stdio MCP server exposing the mission/schedule/hive dispatch tools to out-of-process (non-Claude) providers.',
  // ship=false: NOT an agent-facing CLI. Agents never run this — a provider
  // adapter spawns it over stdio and the model reaches its tools via MCP. It is
  // excluded from the generated reference and the injected CLI index, but the
  // coverage guard still requires this descriptor so the entrypoint cannot ship
  // undocumented.
  ship: false,
  commands: [
    {
      usage: '(stdio, spawned by a provider adapter)',
      description:
        'Serve the mission/schedule/hive dispatch tools over an MCP stdio transport, backed by the same cli-actions handlers as the CLIs and the in-process tools. Tool names/schemas derive from the mission/schedule/hive descriptors. Acting agent comes from CLAUDECLAW_DISPATCH_AGENT (falling back to CLAUDECLAW_AGENT_ID, then "main"). hive_read is withheld unless DISPATCH_ALLOW_HIVE_READ is set.',
    },
  ],
  notes: [
    'Claude keeps the faster in-process createSdkMcpServer path; this bridge is purely for providers that consume MCP over a real transport.',
    'hive_read egresses shared cross-agent memory to the provider vendor, so it is gated behind DISPATCH_ALLOW_HIVE_READ (default off).',
  ],
};

export const allDescriptors: CliDescriptor[] = [
  agentCreateDescriptor,
  dispatchMcpServerDescriptor,
  hiveDescriptor,
  meetDescriptor,
  missionDescriptor,
  scheduleDescriptor,
  slackDescriptor,
];
