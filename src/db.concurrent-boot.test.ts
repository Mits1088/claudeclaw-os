// Every agent service (main + research + comms + content + ops) calls
// initDatabase() when the process manager starts them together, so on a fresh
// install several processes run createSchema + runMigrations against the same
// empty file at once. These tests pin the two ways that used to kill the losers
// of that race: a bare ALTER seeing a column a sibling just added, and the
// journal_mode switch returning SQLITE_BUSY without honoring busy_timeout.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(HERE, '..');
const DB_MODULE = pathToFileURL(path.join(HERE, 'db.ts')).href;

const RACERS = 5;

// Columns createSchema does not create, so runMigrations adds them — the ALTERs
// that actually execute on a fresh database. Asserting they exist afterwards is
// stable even if a column later moves into createSchema: the point is that the
// running code finds them, not how they got there.
const MIGRATED_COLUMNS: Array<[string, string]> = [
  ['scheduled_tasks', 'agent_id'],
  ['scheduled_tasks', 'started_at'],
  ['scheduled_tasks', 'last_status'],
  ['scheduled_tasks', 'acceptance_check'],
  ['token_usage', 'agent_id'],
  ['conversation_log', 'agent_id'],
  ['memories', 'agent_id'],
  ['memories', 'embedding_model'],
  ['memories', 'superseded_by'],
  ['memories', 'pinned'],
  ['memories', 'shared'],
  ['consolidations', 'embedding'],
  ['consolidations', 'embedding_model'],
];

/** One racer: a process that does nothing but reach initDatabase(), like a booting service. */
function bootOnce(childScript: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childScript, DB_MODULE], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => resolve({ code, stderr: stderr.trim() }));
  });
}

describe('concurrent first boot', () => {
  it('brings every agent process up against one fresh database', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-boot-race-'));
    const storeDir = path.join(tmp, 'store');
    fs.mkdirSync(storeDir);

    // Written as .mts so tsx loads it as ESM from outside the project tree.
    const childScript = path.join(tmp, 'boot-probe.mts');
    fs.writeFileSync(
      childScript,
      `const { initDatabase } = await import(process.argv[2]);\n` +
      `try {\n` +
      `  initDatabase();\n` +
      `  process.exit(0);\n` +
      `} catch (err: any) {\n` +
      `  process.stderr.write(String(err?.message ?? err));\n` +
      `  process.exit(1);\n` +
      `}\n`,
    );

    const env = {
      ...process.env,
      CLAUDECLAW_STORE_DIR: storeDir,
      // One key for all racers: they open the same encrypted database.
      DB_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    };

    try {
      const results = await Promise.all(
        Array.from({ length: RACERS }, () => bootOnce(childScript, env)),
      );

      const failures = results.filter((r) => r.code !== 0).map((r) => r.stderr || `exit ${r.code}`);
      expect(failures, `racers that failed to boot:\n${failures.join('\n')}`).toEqual([]);

      const db = new Database(path.join(storeDir, 'claudeclaw.db'), { readonly: true });
      try {
        for (const [table, column] of MIGRATED_COLUMNS) {
          const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          expect(cols.map((c) => c.name), `${table}.${column} missing after concurrent boot`)
            .toContain(column);
        }

        // The FTS5 update trigger must already be in its content-columns-only
        // form. When createSchema emitted the broader `AFTER UPDATE` version,
        // every fresh boot re-ran the migration that rewrites it — a DROP plus
        // CREATE that is not atomic across processes.
        const trigger = db.prepare(
          `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_fts_update'`,
        ).get() as { sql: string } | undefined;
        expect(trigger?.sql).toContain('UPDATE OF');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('runMigrations', () => {
  it('adds every column through addColumnIfMissing', () => {
    const source = fs.readFileSync(path.join(HERE, 'db.ts'), 'utf-8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function runMigrations(');
    expect(start, 'runMigrations not found in db.ts').toBeGreaterThan(-1);
    // The function body ends at the first closing brace in column 0.
    const end = source.indexOf('\n}\n', start);
    const body = source.slice(start, end);

    const bare = body
      .split('\n')
      .filter((line) => /ADD\s+COLUMN/i.test(line))
      .map((line) => line.trim());

    expect(
      bare,
      'A bare ALTER TABLE ... ADD COLUMN in runMigrations kills whichever agent '
        + 'process loses the startup race: it reads PRAGMA table_info, a sibling '
        + 'adds the column, and the ALTER then throws "duplicate column name". '
        + 'Use addColumnIfMissing, which tolerates that.',
    ).toEqual([]);
  });
});
