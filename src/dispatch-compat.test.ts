// Dispatch for an anthropic-compatible turn.
//
// Two properties, both of which a naive implementation gets wrong:
//
//  1. Off by default. Dispatch lets a turn create missions, schedule future
//     work and read the shared hive. A third-party model gets that only when
//     an operator says so.
//  2. hive_read stays withheld even then — and the withholding must survive
//     concurrent turns. The obvious implementation (filter the shared tool
//     list) is a race: a Claude turn and a compat turn are in flight in the
//     same process, and whichever ran last decides what the OTHER one sees.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDispatchSdkTools,
  dispatchMcpServersFor,
  EGRESS_GATED_TOOLS,
  getDispatchMcpServer,
} from './dispatch-tools.js';
import { resetCompatConfigCache } from './anthropic-compat-env.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  delete process.env.ANTHROPIC_COMPAT_ALLOW_DISPATCH;
  resetCompatConfigCache();
});

afterEach(() => {
  if (savedEnv.ANTHROPIC_COMPAT_ALLOW_DISPATCH === undefined) delete process.env.ANTHROPIC_COMPAT_ALLOW_DISPATCH;
  else process.env.ANTHROPIC_COMPAT_ALLOW_DISPATCH = savedEnv.ANTHROPIC_COMPAT_ALLOW_DISPATCH;
  resetCompatConfigCache();
});

const compatTurn = { provider: { type: 'anthropic-compatible' as const } };
const claudeTurn = { provider: { type: 'claude' as const } };

describe('dispatch is off for a compat turn until it is opted in', () => {
  it('grants nothing by default', () => {
    expect(dispatchMcpServersFor(compatTurn)).toEqual({});
  });

  it('grants the in-process server once opted in', () => {
    process.env.ANTHROPIC_COMPAT_ALLOW_DISPATCH = 'true';
    resetCompatConfigCache();
    expect(Object.keys(dispatchMcpServersFor(compatTurn))).toHaveLength(1);
  });

  it('still grants nothing when the turn states a restricted tool policy', () => {
    process.env.ANTHROPIC_COMPAT_ALLOW_DISPATCH = 'true';
    resetCompatConfigCache();
    expect(dispatchMcpServersFor({ ...compatTurn, allowedTools: ['Read'] })).toEqual({});
  });

  it('leaves the Claude path exactly as it was', () => {
    expect(Object.keys(dispatchMcpServersFor(claudeTurn))).toHaveLength(1);
  });
});

describe('hive_read stays withheld from a compat turn', () => {
  function toolNames(opts: { allowHiveRead?: boolean } = {}) {
    return buildDispatchSdkTools(opts).map((t) => (t as { name: string }).name);
  }

  it('is present in the default (Claude) tool set', () => {
    expect(toolNames()).toContain('hive_read');
  });

  it('is absent from the withheld set, and nothing else is', () => {
    const full = toolNames();
    const restricted = toolNames({ allowHiveRead: false });
    expect(restricted).not.toContain('hive_read');
    const missing = full.filter((n) => !restricted.includes(n));
    expect(missing).toEqual([...EGRESS_GATED_TOOLS]);
  });

  it('the compat turn receives the withheld instance', () => {
    process.env.ANTHROPIC_COMPAT_ALLOW_DISPATCH = 'true';
    resetCompatConfigCache();
    const compatServer = Object.values(dispatchMcpServersFor(compatTurn))[0];
    const claudeServer = Object.values(dispatchMcpServersFor(claudeTurn))[0];
    // Different objects, not one object filtered after the fact.
    expect(compatServer).not.toBe(claudeServer);
    expect(compatServer).toBe(getDispatchMcpServer({ allowHiveRead: false }));
    expect(claudeServer).toBe(getDispatchMcpServer());
  });

  // The race this design removes: with a single shared instance whose tool
  // list gets filtered per turn, interleaving these two resolutions would let
  // one turn's policy decide the other's tools. Here, interleaving cannot
  // change anything, because the policies never share an object.
  it('survives interleaved compat and Claude turns', async () => {
    process.env.ANTHROPIC_COMPAT_ALLOW_DISPATCH = 'true';
    resetCompatConfigCache();

    const barrier = new Promise<void>((resolve) => setTimeout(resolve, 0));
    const runs = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        await barrier;
        const ctx = i % 2 === 0 ? compatTurn : claudeTurn;
        return { i, server: Object.values(dispatchMcpServersFor(ctx))[0] };
      }),
    );

    const compatInstances = new Set(runs.filter((l) => l.i % 2 === 0).map((l) => l.server));
    const claudeInstances = new Set(runs.filter((l) => l.i % 2 === 1).map((l) => l.server));
    expect(compatInstances.size).toBe(1);
    expect(claudeInstances.size).toBe(1);
    expect([...compatInstances][0]).not.toBe([...claudeInstances][0]);
  });
});
