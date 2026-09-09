import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DISPATCH_ALLOW_HIVE_READ } from './config.js';
import {
  _initTestDatabase,
  getAllScheduledTasks,
  getHiveMindEntries,
  getMissionTasks,
} from './db.js';
import { dispatchToolEntries } from './dispatch-tools.js';
import {
  EGRESS_GATED_TOOLS,
  dispatchMcpServerToolDefinitions,
  resolveDispatchAgentId,
} from './dispatch-mcp-server.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  // Use the widest tool set so any tool (incl. hive_read) is reachable in tests.
  const def = dispatchMcpServerToolDefinitions({ allowHiveRead: true }).find((d) => d.name === name);
  if (!def) throw new Error(`no dispatch tool named '${name}'`);
  return def.handler(args) as Promise<ToolResult>;
}

const asText = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');

// ── tool set + governance gating ─────────────────────────────────────────────

describe('dispatch stdio bridge tool set', () => {
  it('exposes hive_log and the mission/schedule verbs, and withholds hive_read by default', () => {
    const names = dispatchMcpServerToolDefinitions({ allowHiveRead: false }).map((d) => d.name);
    expect(names).toContain('hive_log');
    expect(names).toContain('hive_path');
    expect(names).toContain('mission_create');
    expect(names).toContain('schedule_create');
    // hive_read egresses shared memory — off unless explicitly enabled.
    expect(names).not.toContain('hive_read');
  });

  it('exposes hive_read only when hive-read egress is enabled', () => {
    const on = dispatchMcpServerToolDefinitions({ allowHiveRead: true }).map((d) => d.name);
    expect(on).toContain('hive_read');
  });

  it('gates exactly the egress-sensitive tools (hive_read)', () => {
    const off = new Set(dispatchMcpServerToolDefinitions({ allowHiveRead: false }).map((d) => d.name));
    const on = new Set(dispatchMcpServerToolDefinitions({ allowHiveRead: true }).map((d) => d.name));
    const gated = [...on].filter((n) => !off.has(n));
    expect(new Set(gated)).toEqual(EGRESS_GATED_TOOLS);
  });

  it('the no-arg default follows the DISPATCH_ALLOW_HIVE_READ config flag', () => {
    const names = dispatchMcpServerToolDefinitions().map((d) => d.name);
    expect(names.includes('hive_read')).toBe(DISPATCH_ALLOW_HIVE_READ);
  });
});

// ── schema derivation (guards drift from the descriptors) ────────────────────

describe('dispatch stdio bridge derives schemas from the descriptor specs', () => {
  it('each exposed tool schema mirrors its descriptor spec params', () => {
    const entriesByName = new Map(dispatchToolEntries().map((e) => [e.spec.name, e]));
    for (const def of dispatchMcpServerToolDefinitions({ allowHiveRead: true })) {
      const entry = entriesByName.get(def.name);
      expect(entry, `no descriptor entry for ${def.name}`).toBeDefined();
      expect(Object.keys(def.schema).sort()).toEqual(entry!.spec.params.map((p) => p.name).sort());
    }
  });
});

// ── agent identity resolution ────────────────────────────────────────────────

describe('resolveDispatchAgentId', () => {
  it('prefers CLAUDECLAW_DISPATCH_AGENT, then CLAUDECLAW_AGENT_ID, then main', () => {
    expect(resolveDispatchAgentId({ CLAUDECLAW_DISPATCH_AGENT: 'lawrence', CLAUDECLAW_AGENT_ID: 'x' })).toBe('lawrence');
    expect(resolveDispatchAgentId({ CLAUDECLAW_AGENT_ID: 'amos' })).toBe('amos');
    expect(resolveDispatchAgentId({})).toBe('main');
  });
});

// ── handlers route to cli-actions on an isolated store ───────────────────────

describe('dispatch stdio bridge handlers reuse the db layer on an isolated store', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('mission_create queues a task via the shared action', async () => {
    const r = await callTool('mission_create', { prompt: 'via bridge', agent: 'main', title: 'B' });
    expect(r.isError).toBeFalsy();
    const tasks = getMissionTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_agent).toBe('main');
    expect(tasks[0].title).toBe('B');
  });

  it('mission_create rejects an unknown agent and writes nothing', async () => {
    const r = await callTool('mission_create', { prompt: 'x', agent: 'not-real' });
    expect(r.isError).toBe(true);
    expect(asText(r)).toContain("unknown agent 'not-real'");
    expect(getMissionTasks()).toHaveLength(0);
  });

  it('schedule_create rejects an invalid cron and writes nothing', async () => {
    const r = await callTool('schedule_create', { prompt: 'p', cron: 'nope', agent: 'main' });
    expect(r.isError).toBe(true);
    expect(getAllScheduledTasks()).toHaveLength(0);
  });

  it('hive_log attributes authorship to the stamped acting agent (env identity)', async () => {
    const prev = process.env.CLAUDECLAW_AGENT_ID;
    // main() stamps CLAUDECLAW_AGENT_ID from CLAUDECLAW_DISPATCH_AGENT; simulate that.
    process.env.CLAUDECLAW_AGENT_ID = resolveDispatchAgentId({ CLAUDECLAW_DISPATCH_AGENT: 'lawrence' });
    try {
      const r = await callTool('hive_log', { action: 'act', summary: 'from the bridge' });
      expect(r.isError).toBeFalsy();
      const [entry] = getHiveMindEntries(5);
      expect(entry.agent_id).toBe('lawrence');
      expect(entry.summary).toBe('from the bridge');
    } finally {
      if (prev === undefined) delete process.env.CLAUDECLAW_AGENT_ID;
      else process.env.CLAUDECLAW_AGENT_ID = prev;
    }
  });

  it('hive_read (when enabled) returns entries via the shared action', async () => {
    await callTool('hive_log', { action: 'seed', summary: 'seed entry', agent: 'main' });
    const r = await callTool('hive_read', { limit: 5 });
    expect(asText(r)).toContain('seed entry');
  });
});
