// A turn nobody priced must not be counted as a free turn.
//
// The anthropic-compatible provider runs on the Claude SDK, which keeps
// emitting a `total_cost_usd` — Anthropic list pricing applied to a
// third-party model. That number looks like money and is not: measured
// 2026-08-20, a two-word "PONG" turn against GLM was reported as $0.0219.
// Storing it would misreport spend; storing a bare 0 would report a paid turn
// as free. Hence the marker, and hence every aggregate filtering on it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { buildCostFooter } from './cost-footer.js';
import type { UsageInfo } from './agent.js';

function usage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    totalCostUsd: 0.0219, costSource: 'provider', didCompact: false, preCompactTokens: null,
    lastCallCacheRead: 0, lastCallCacheCreation: 0, lastCallInputTokens: 1000,
    contextWindow: 1_000_000, model: 'glm-5.3[1m]', durationMs: 1, durationApiMs: 1,
    numTurns: 1, stopReasonDetail: null, isError: false,
    ...overrides,
  } as UsageInfo;
}

describe('cost footer', () => {
  it('shows a price when the runtime priced the turn', () => {
    expect(buildCostFooter('cost', usage(), 'glm-5.3')).toContain('$0.02');
  });

  it('shows an em dash, never $0.00, when nobody priced it', () => {
    const footer = buildCostFooter('cost', usage({ costSource: 'unknown', totalCostUsd: 0 }), 'glm-5.3');
    expect(footer).toContain('—');
    expect(footer).not.toContain('$');
  });

  it('does the same in the full footer', () => {
    const footer = buildCostFooter('full', usage({ costSource: 'unknown', totalCostUsd: 0 }), 'glm-5.3');
    expect(footer).toContain('—');
    expect(footer).not.toContain('$0.00');
    expect(footer).toContain('in');
  });
});

// The aggregates are exercised against a real SQLite file rather than mocks:
// the property under test is a SQL clause, and a mock cannot get it wrong.
describe('cost aggregates exclude unpriced turns', () => {
  function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-costsource-'));
    const db = new Database(path.join(dir, 'test.db'));
    db.exec(`
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL DEFAULT 'main',
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    return { db, dir };
  }

  it('an added column defaults old rows to priced, so history is unchanged', () => {
    const { db, dir } = tempDb();
    try {
      db.prepare('INSERT INTO token_usage (cost_usd, created_at) VALUES (?, ?)').run(0.5, 1);
      // Exactly the migration runMigrations performs.
      db.exec(`ALTER TABLE token_usage ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'provider'`);
      const row = db.prepare('SELECT cost_source FROM token_usage').get() as { cost_source: string };
      expect(row.cost_source).toBe('provider');

      const total = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0) AS c FROM token_usage`,
      ).get() as { c: number };
      expect(total.c).toBe(0.5);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the same ALTER run twice is a no-op, as concurrent service starts require', () => {
    const { db, dir } = tempDb();
    try {
      db.exec(`ALTER TABLE token_usage ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'provider'`);
      expect(() => db.exec(`ALTER TABLE token_usage ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'provider'`))
        .toThrow(/duplicate column/i);
      // …which is precisely what addColumnIfMissing swallows, so the losing
      // racer among nine booting services carries on instead of dying.
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unpriced turn adds nothing to the total, and a priced one still does', () => {
    const { db, dir } = tempDb();
    try {
      db.exec(`ALTER TABLE token_usage ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'provider'`);
      const ins = db.prepare('INSERT INTO token_usage (cost_usd, created_at, cost_source) VALUES (?, ?, ?)');
      ins.run(0.5, 1, 'provider');
      ins.run(0.0219, 2, 'unknown'); // what the SDK would have claimed for GLM
      ins.run(0.25, 3, 'provider');

      const filtered = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0) AS c FROM token_usage`,
      ).get() as { c: number };
      const unfiltered = db.prepare('SELECT SUM(cost_usd) AS c FROM token_usage').get() as { c: number };

      expect(filtered.c).toBeCloseTo(0.75, 6);
      // The unfiltered sum is what the old query would have reported — proof
      // the filter is doing something, not decorating.
      expect(unfiltered.c).toBeGreaterThan(filtered.c);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
