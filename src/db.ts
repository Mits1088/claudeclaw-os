import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DB_ENCRYPTION_KEY, MEMORY_RECALL_MODE_ENV, STORE_DIR } from './config.js';
import { cosineSimilarity } from './embeddings.js';
import { logger } from './logger.js';
import { outboundOptionsForSeam } from './outbound-policy.js';
import { sanitizeOutboundText } from './outbound-sanitizer.js';

// ── Field-Level Encryption (AES-256-GCM) ────────────────────────────
// All message bodies (WhatsApp, Slack) are encrypted before storage
// and decrypted on read. The key lives in .env (DB_ENCRYPTION_KEY).

let encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  const hex = DB_ENCRYPTION_KEY;
  if (!hex || hex.length < 32) {
    throw new Error(
      'DB_ENCRYPTION_KEY is missing or too short. Run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" and add to .env',
    );
  }
  encryptionKey = Buffer.from(hex, 'hex');
  return encryptionKey;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a compact string: iv:authTag:ciphertext (all hex-encoded).
 */
export function encryptField(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string produced by encryptField().
 * Returns the original plaintext. If decryption fails (wrong key, tampered),
 * returns the raw input unchanged (graceful fallback for pre-encryption data).
 */
export function decryptField(ciphertext: string): string {
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) return ciphertext; // Not encrypted, return as-is
    const [ivHex, authTagHex, dataHex] = parts;
    if (!ivHex || !authTagHex || !dataHex) return ciphertext;

    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Decryption failed: probably pre-encryption plaintext data
    return ciphertext;
  }
}

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      prompt      TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      next_run    INTEGER NOT NULL,
      last_run    INTEGER,
      last_result TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON scheduled_tasks(status, next_run);

    CREATE TABLE IF NOT EXISTS sessions (
      chat_id    TEXT NOT NULL,
      agent_id   TEXT NOT NULL DEFAULT 'main',
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'conversation',
      raw_text      TEXT NOT NULL,
      summary       TEXT NOT NULL,
      entities      TEXT NOT NULL DEFAULT '[]',
      topics        TEXT NOT NULL DEFAULT '[]',
      connections   TEXT NOT NULL DEFAULT '[]',
      importance    REAL NOT NULL DEFAULT 0.5,
      salience      REAL NOT NULL DEFAULT 1.0,
      consolidated  INTEGER NOT NULL DEFAULT 0,
      embedding     TEXT,
      created_at    INTEGER NOT NULL,
      accessed_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS consolidations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT NOT NULL,
      source_ids    TEXT NOT NULL,
      summary       TEXT NOT NULL,
      insight       TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_consolidations_chat ON consolidations(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wa_message_map (
      telegram_msg_id INTEGER PRIMARY KEY,
      wa_chat_id      TEXT NOT NULL,
      contact_name    TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wa_outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_chat_id  TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sent_at     INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_wa_outbox_unsent ON wa_outbox(sent_at) WHERE sent_at IS NULL;

    CREATE TABLE IF NOT EXISTS wa_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON wa_messages(chat_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS conversation_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT NOT NULL,
      session_id  TEXT,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_convo_log_chat ON conversation_log(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS token_usage (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id         TEXT NOT NULL,
      session_id      TEXT,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read      INTEGER NOT NULL DEFAULT 0,
      cache_creation  INTEGER NOT NULL DEFAULT 0,
      context_tokens  INTEGER NOT NULL DEFAULT 0,
      context_window  INTEGER,
      cost_usd        REAL NOT NULL DEFAULT 0,
      -- 'provider' = a runtime priced this turn; 'unknown' = nobody did
      -- and cost_usd is a placeholder that must stay out of totals.
      cost_source     TEXT NOT NULL DEFAULT 'provider',
      did_compact     INTEGER NOT NULL DEFAULT 0,
      model           TEXT,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      duration_api_ms INTEGER NOT NULL DEFAULT 0,
      num_turns       INTEGER NOT NULL DEFAULT 0,
      stop_reason     TEXT,
      is_error        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_chat ON token_usage(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS slack_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id   TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      user_name    TEXT NOT NULL,
      body         TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      is_from_me   INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_slack_messages_channel ON slack_messages(channel_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS hive_mind (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      chat_id     TEXT NOT NULL,
      action      TEXT NOT NULL,
      summary     TEXT NOT NULL,
      artifacts   TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hive_mind_agent ON hive_mind(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hive_mind_time ON hive_mind(created_at DESC);

    CREATE TABLE IF NOT EXISTS inter_agent_tasks (
      id            TEXT PRIMARY KEY,
      from_agent    TEXT NOT NULL,
      to_agent      TEXT NOT NULL,
      chat_id       TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      result        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_inter_agent_tasks_status ON inter_agent_tasks(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS mission_tasks (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      assigned_agent  TEXT,
      status          TEXT NOT NULL DEFAULT 'queued',
      result          TEXT,
      error           TEXT,
      created_by      TEXT NOT NULL DEFAULT 'dashboard',
      priority        INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      available_at    INTEGER,
      started_at      INTEGER,
      completed_at    INTEGER,
      parent_task_id  TEXT,
      group_id        TEXT,
      role            TEXT NOT NULL DEFAULT 'task',
      chain_id        TEXT,
      continuation_step INTEGER,
      continuation_limit INTEGER,
      continuation_key TEXT,
      transition_key  TEXT,
      workflow_id     TEXT,
      claiming_instance_id TEXT,
      claim_generation INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_mission_status
      ON mission_tasks(assigned_agent, status, priority DESC, created_at ASC);

    CREATE TABLE IF NOT EXISTS mission_chains (
      id              TEXT PRIMARY KEY,
      owner_agent     TEXT NOT NULL,
      max_steps       INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      INTEGER NOT NULL,
      cancelled_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS worker_supervisor (
      singleton_id     INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      epoch            TEXT NOT NULL,
      runtime_build_id TEXT NOT NULL,
      started_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_runtime (
      agent_id          TEXT PRIMARY KEY,
      desired_state     TEXT NOT NULL DEFAULT 'inactive'
                        CHECK (desired_state IN ('active', 'inactive')),
      instance_id       TEXT,
      supervisor_epoch  TEXT,
      pid               INTEGER,
      process_started_at INTEGER,
      heartbeat_at      INTEGER,
      runtime_build_id  TEXT,
      scope_started_at  INTEGER,
      scope_work_id     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_worker_runtime_lease
      ON worker_runtime(supervisor_epoch, heartbeat_at);

    CREATE TABLE IF NOT EXISTS meet_sessions (
      id              TEXT PRIMARY KEY,         -- session id from the provider's join response
      agent_id        TEXT NOT NULL,            -- which agent is in the meeting
      meet_url        TEXT NOT NULL,
      bot_name        TEXT NOT NULL,
      platform        TEXT NOT NULL DEFAULT 'google_meet',
      provider        TEXT NOT NULL DEFAULT 'pika',  -- pika (avatar) | recall (voice-only)
      status          TEXT NOT NULL DEFAULT 'joining', -- joining | live | left | failed
      voice_id        TEXT,
      image_path      TEXT,                     -- avatar image used for this session (pika only)
      brief_path      TEXT,                     -- path to the frozen system prompt file
      created_at      INTEGER NOT NULL,
      joined_at       INTEGER,
      left_at         INTEGER,
      post_notes      TEXT,                     -- post-meeting notes, fetched after leave
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meet_status ON meet_sessions(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_meet_agent ON meet_sessions(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS warroom_meetings (
      id          TEXT PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      duration_s  INTEGER,
      mode        TEXT NOT NULL DEFAULT 'direct',  -- direct | auto
      pinned_agent TEXT DEFAULT 'main',
      entry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_meetings_time ON warroom_meetings(started_at DESC);

    CREATE TABLE IF NOT EXISTS warroom_transcript (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id  TEXT NOT NULL,
      speaker     TEXT NOT NULL,     -- 'user' | agent id | 'system'
      text        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES warroom_meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_warroom_transcript_meeting ON warroom_transcript(meeting_id, created_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL DEFAULT 'main',
      chat_id     TEXT NOT NULL DEFAULT '',
      action      TEXT NOT NULL,
      detail      TEXT NOT NULL DEFAULT '',
      blocked     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id, created_at DESC);

    -- Per-workspace personalization (workspace name, hotkey mod, mission
    -- column order/widths, etc). Simple key/value with last-write-wins;
    -- no auth scoping because the dashboard token is the auth boundary.
    CREATE TABLE IF NOT EXISTS dashboard_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Append-only version history for agent files edited from the
    -- dashboard (CLAUDE.md, agent.yaml). Replaces the single-file .backup
    -- approach so the user can browse prior versions and restore any.
    -- file_kind is the editor's tab key ('claudemd' | 'agent-yaml').
    -- Content stored inline; size cap is enforced at the API layer
    -- (200KB for CLAUDE.md, 64KB for agent.yaml).
    CREATE TABLE IF NOT EXISTS agent_file_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      file_kind   TEXT NOT NULL,
      content     TEXT NOT NULL,
      byte_size   INTEGER NOT NULL,
      sha256      TEXT NOT NULL,
      author      TEXT NOT NULL DEFAULT 'dashboard',
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_file_history_lookup
      ON agent_file_history(agent_id, file_kind, created_at DESC);

    -- LLM-generated suggestions for spinning off specialized agents.
    -- The analyzer scans hive_mind activity grouped by agent_id and
    -- spots when one agent is doing several distinct domains that
    -- would benefit from being split. Each suggestion lives until the
    -- user dismisses it (sets dismissed_at) or acts on it. We keep
    -- dismissed rows so re-running analysis doesn't keep re-suggesting
    -- the same split — the analyzer skips parents+IDs that already
    -- have a non-superseded suggestion.
    CREATE TABLE IF NOT EXISTS agent_suggestions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent            TEXT NOT NULL,
      suggested_id          TEXT NOT NULL,
      suggested_name        TEXT NOT NULL,
      suggested_description TEXT NOT NULL,
      reasoning             TEXT NOT NULL,
      activity_share_pct    INTEGER,
      created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      dismissed_at          INTEGER,
      acted_at              INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_suggestions_active
      ON agent_suggestions(from_agent, created_at DESC)
      WHERE dismissed_at IS NULL AND acted_at IS NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      summary,
      raw_text,
      entities,
      topics,
      content=memories,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
        VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
      INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
        VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
    END;

    -- Phase 2.4: Compaction event tracking
    CREATE TABLE IF NOT EXISTS compaction_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      pre_tokens  INTEGER NOT NULL DEFAULT 0,
      post_tokens INTEGER NOT NULL DEFAULT 0,
      turn_count  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compaction_session ON compaction_events(session_id, created_at DESC);

    -- Phase 4.2: Skill health checks
    CREATE TABLE IF NOT EXISTS skill_health (
      skill_id    TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'unchecked',
      error_msg   TEXT NOT NULL DEFAULT '',
      last_check  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    -- Phase 4.3: Skill usage analytics
    CREATE TABLE IF NOT EXISTS skill_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id    TEXT NOT NULL,
      chat_id     TEXT NOT NULL DEFAULT '',
      agent_id    TEXT NOT NULL DEFAULT 'main',
      triggered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      tokens_used INTEGER NOT NULL DEFAULT 0,
      succeeded   INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage(skill_id, triggered_at DESC);

    -- Phase 6.2: Session summaries
    CREATE TABLE IF NOT EXISTS session_summaries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL UNIQUE,
      summary     TEXT NOT NULL,
      key_decisions TEXT NOT NULL DEFAULT '[]',
      turn_count  INTEGER NOT NULL DEFAULT 0,
      total_cost  REAL NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

/**
 * Safety belt: under vitest, refuse to open any database outside the OS temp
 * dir (compares realpaths: macOS /var/folders is /private/var/folders).
 */
export function assertTestStoreIsHermetic(storeDir: string): void {
  if (!process.env.VITEST) return;
  const real = fs.realpathSync(storeDir);
  const tmp = fs.realpathSync(os.tmpdir());
  if (real !== tmp && !real.startsWith(tmp + path.sep)) {
    throw new Error(`refused: database outside tmpdir during tests (${real})`);
  }
}

export function initDatabase(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  assertTestStoreIsHermetic(STORE_DIR);
  const dbPath = path.join(STORE_DIR, 'claudeclaw.db');

  // Validate encryption key is available before proceeding
  getEncryptionKey();

  db = new Database(dbPath);
  // journal_mode is the one statement busy_timeout below cannot cover: switching
  // a fresh database to WAL takes an exclusive lock and returns SQLITE_BUSY
  // straight away instead of invoking the busy handler. Only the first process
  // to arrive performs the switch; the others retry, read back the WAL mode it
  // just set, and move on. Without the retry they die on the very first
  // statement of startup (see issue #255).
  withBusyRetry(() => db.pragma('journal_mode = WAL'));
  // Wait up to 5s on write locks. Multiple agent processes (main + research +
  // comms + content + ops) run initDatabase() at startup; without this a
  // concurrent ALTER can throw SQLITE_BUSY on whichever process loses the race.
  db.pragma('busy_timeout = 5000');
  createSchema(db);
  runMigrations(db);
  stampMemoryIsolationMigration(db);

  // Restrict database file permissions (owner-only read/write)
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
    fs.chmodSync(STORE_DIR, 0o700);
  } catch { /* non-fatal on platforms that don't support chmod */ }
}

/**
 * Open the database exactly once per process. In-process callers (e.g. the
 * dispatch-tool handlers in `dispatch-tools.ts`, which run inside the already-
 * booted agent runtime) need a guaranteed-open connection without paying for a
 * redundant `initDatabase()` (which re-opens a fresh better-sqlite3 handle and
 * re-runs migrations). The CLI entrypoints keep calling `initDatabase()`
 * directly since each is a short-lived one-shot process.
 */
export function ensureDatabase(): void {
  if (db) return;
  initDatabase();
}

/**
 * Add a column to a table if it doesn't already exist. Tolerates the
 * concurrent-startup race where two agent processes both observe the column
 * as missing and both attempt the ALTER; whichever loses sees "duplicate
 * column" and treats it as a no-op.
 *
 * Returns true only when this process actually added the column, so a caller
 * can log a migration without logging it again on every subsequent boot — and
 * without the losing racer claiming a migration it didn't perform.
 */
function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  typeAndDefault: string,
): boolean {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return false;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`);
    return true;
  } catch (err: any) {
    if (/duplicate column/i.test(err?.message ?? '')) return false;
    throw err;
  }
}

/** Add columns that may not exist in older databases. */
function runMigrations(database: Database.Database): void {
  // Add context_tokens column to token_usage (introduced for accurate context tracking)
  addColumnIfMissing(database, 'token_usage', 'context_tokens', 'INTEGER NOT NULL DEFAULT 0');
  // Add context_window column (the model's real window, e.g. Opus 4.8 = 1M).
  // Nullable: NULL on old rows / engines that don't report one, so consumers
  // fall back to CONTEXT_LIMIT.
  addColumnIfMissing(database, 'token_usage', 'context_window', 'INTEGER');

  // Multi-agent: migrate sessions table to composite primary key (chat_id, agent_id)
  // Check if PK is composite by looking at pk column count in pragma
  const sessionCols = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; pk: number }>;
  const pkCount = sessionCols.filter((c) => c.pk > 0).length;
  if (pkCount < 2) {
    // Need to recreate table with composite PK
    database.exec(`
      CREATE TABLE sessions_new (
        chat_id    TEXT NOT NULL,
        agent_id   TEXT NOT NULL DEFAULT 'main',
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, agent_id)
      );
      INSERT OR IGNORE INTO sessions_new (chat_id, agent_id, session_id, updated_at)
        SELECT chat_id, COALESCE(agent_id, 'main'), session_id, updated_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
    `);
  }

  addColumnIfMissing(database, 'scheduled_tasks', 'agent_id', `TEXT NOT NULL DEFAULT 'main'`);

  addColumnIfMissing(database, 'token_usage', 'agent_id', `TEXT NOT NULL DEFAULT 'main'`);
  addColumnIfMissing(database, 'token_usage', 'cache_creation', 'INTEGER NOT NULL DEFAULT 0');
  // Per-turn telemetry columns (free from the SDK result object).
  addColumnIfMissing(database, 'token_usage', 'model', 'TEXT');
  addColumnIfMissing(database, 'token_usage', 'duration_ms', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(database, 'token_usage', 'duration_api_ms', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(database, 'token_usage', 'num_turns', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(database, 'token_usage', 'stop_reason', 'TEXT');
  addColumnIfMissing(database, 'token_usage', 'is_error', 'INTEGER NOT NULL DEFAULT 0');
  // Whether cost_usd is money or a placeholder. Backfilled to 'provider'
  // because every row written before this column existed came from a runtime
  // that priced its own turns.
  addColumnIfMissing(database, 'token_usage', 'cost_source', `TEXT NOT NULL DEFAULT 'provider'`);

  addColumnIfMissing(database, 'conversation_log', 'agent_id', `TEXT NOT NULL DEFAULT 'main'`);

  // Task state machine: add started_at and last_status columns
  addColumnIfMissing(database, 'scheduled_tasks', 'started_at', 'INTEGER');
  addColumnIfMissing(database, 'scheduled_tasks', 'last_status', 'TEXT');
  addColumnIfMissing(database, 'scheduled_tasks', 'acceptance_check', 'TEXT');
  // Keep recurring activation separate from an in-flight execution. NULL on
  // legacy running rows preserves their existing active-on-recovery behavior.
  addColumnIfMissing(database, 'scheduled_tasks', 'resume_status', `TEXT CHECK (resume_status IN ('active', 'paused'))`);

  // ── Memory V2 migration ──────────────────────────────────────────────
  // Detect old schema (has 'sector' column but no 'importance') and migrate.
  const memCols = database.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  const memColNames = memCols.map((c) => c.name);
  const isOldSchema = memColNames.includes('sector') && !memColNames.includes('importance');

  if (isOldSchema) {
    database.exec(`
      -- Drop old FTS triggers first
      DROP TRIGGER IF EXISTS memories_fts_insert;
      DROP TRIGGER IF EXISTS memories_fts_delete;
      DROP TRIGGER IF EXISTS memories_fts_update;

      -- Drop old FTS table
      DROP TABLE IF EXISTS memories_fts;

      -- Drop old indexes (they'll conflict with new table's indexes)
      DROP INDEX IF EXISTS idx_memories_chat;
      DROP INDEX IF EXISTS idx_memories_sector;

      -- Backup old memories table
      ALTER TABLE memories RENAME TO memories_v1_backup;

      -- Create new memories table
      CREATE TABLE memories (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT 'conversation',
        raw_text      TEXT NOT NULL,
        summary       TEXT NOT NULL,
        entities      TEXT NOT NULL DEFAULT '[]',
        topics        TEXT NOT NULL DEFAULT '[]',
        connections   TEXT NOT NULL DEFAULT '[]',
        importance    REAL NOT NULL DEFAULT 0.5,
        salience      REAL NOT NULL DEFAULT 1.0,
        consolidated  INTEGER NOT NULL DEFAULT 0,
        embedding     TEXT,
        created_at    INTEGER NOT NULL,
        accessed_at   INTEGER NOT NULL
      );

      CREATE INDEX idx_memories_chat ON memories(chat_id, created_at DESC);
      CREATE INDEX idx_memories_importance ON memories(chat_id, importance DESC);
      CREATE INDEX idx_memories_unconsolidated ON memories(chat_id, consolidated);

      -- Create consolidations table
      CREATE TABLE IF NOT EXISTS consolidations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id       TEXT NOT NULL,
        source_ids    TEXT NOT NULL,
        summary       TEXT NOT NULL,
        insight       TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_consolidations_chat ON consolidations(chat_id, created_at DESC);

      -- Create new FTS table
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        summary,
        raw_text,
        entities,
        topics,
        content=memories,
        content_rowid=id
      );

      -- Create new triggers
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;

      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
      END;

      CREATE TRIGGER memories_fts_update AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
    `);
    logger.info('Memory V2 migration: backed up old memories, created new schema');
  }

  // Ensure memory V2 indexes exist (covers both migrated and fresh installs)
  const memColsPost = database.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  if (memColsPost.some((c) => c.name === 'importance')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(chat_id, importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated ON memories(chat_id, consolidated);
    `);
  }

  // Add embedding column if missing (V2 tables created before embedding support).
  // The `importance` condition is load-bearing: it keeps the column off a V1
  // table that the migration above didn't rewrite.
  if (memColsPost.some((c) => c.name === 'importance')) {
    if (addColumnIfMissing(database, 'memories', 'embedding', 'TEXT')) {
      logger.info('Migration: added embedding column to memories table');
    }
  }

  // Hive Mind V2: Add agent_id to memories for attribution
  if (addColumnIfMissing(database, 'memories', 'agent_id', `TEXT NOT NULL DEFAULT 'main'`)) {
    logger.info('Migration: added agent_id column to memories table');
  }

  // Hive Mind V2: Add embedding + model tracking to consolidations
  if (addColumnIfMissing(database, 'consolidations', 'embedding', 'TEXT')) {
    logger.info('Migration: added embedding column to consolidations table');
  }
  addColumnIfMissing(database, 'consolidations', 'embedding_model', `TEXT DEFAULT 'embedding-001'`);

  // Add embedding_model to memories too (future-proofing)
  addColumnIfMissing(database, 'memories', 'embedding_model', `TEXT DEFAULT 'embedding-001'`);

  // Hive Mind V2: Fix FTS5 update trigger to only fire on content column changes.
  // The old trigger fires on every UPDATE (including salience/importance-only changes),
  // causing massive write amplification during decay sweeps.
  const triggerCheck = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='memories_fts_update'`,
  ).get() as { sql: string } | undefined;
  if (triggerCheck?.sql && !triggerCheck.sql.includes('UPDATE OF')) {
    // IF NOT EXISTS on the CREATE, because DROP + CREATE is not atomic across
    // processes: two agents can both drop before either creates, and the loser
    // would otherwise die on "trigger already exists". Whoever runs last still
    // ends on a CREATE, so the rewritten trigger is always the one left behind.
    database.exec(`
      DROP TRIGGER IF EXISTS memories_fts_update;
      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF summary, raw_text, entities, topics ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text, entities, topics)
          VALUES ('delete', old.id, old.summary, old.raw_text, old.entities, old.topics);
        INSERT INTO memories_fts(rowid, summary, raw_text, entities, topics)
          VALUES (new.id, new.summary, new.raw_text, new.entities, new.topics);
      END;
    `);
    logger.info('Migration: restricted FTS5 update trigger to content columns only');
  }

  // Hive Mind V2: Add superseded_by for contradiction resolution
  if (addColumnIfMissing(database, 'memories', 'superseded_by', 'INTEGER REFERENCES memories(id)')) {
    logger.info('Migration: added superseded_by column to memories table');
  }

  // Hive Mind V2: Add pinned flag for permanent memories that never decay.
  // Memories are only pinned explicitly by the user ("remember this permanently")
  // or via /pin command. No auto-pinning: the user controls what's permanent.
  if (addColumnIfMissing(database, 'memories', 'pinned', 'INTEGER NOT NULL DEFAULT 0')) {
    logger.info('Migration: added pinned column to memories table');
  }

  // Memory isolation (#95): explicit shared tier. Memory recall is scoped to
  // the requesting agent plus rows flagged shared = 1. Existing rows default to
  // 0 (strict per-agent) so the cross-agent Hive Mind recall leak is closed
  // without retroactively sharing anyone's memories. Promote a memory to the
  // shared tier explicitly to make it visible to every agent on the chat.
  if (addColumnIfMissing(database, 'memories', 'shared', 'INTEGER NOT NULL DEFAULT 0')) {
    logger.info('Migration: added shared column to memories table');
  }

  // Mission Control: migrate assigned_agent from NOT NULL to nullable (allow unassigned tasks)
  const missionCols = database.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string; notnull: number }>;
  const assignedCol = missionCols.find((c) => c.name === 'assigned_agent');
  if (assignedCol && assignedCol.notnull === 1) {
    database.exec(`
      CREATE TABLE mission_tasks_new (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        assigned_agent TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, created_by TEXT NOT NULL DEFAULT 'dashboard',
        priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER
      );
      INSERT INTO mission_tasks_new SELECT * FROM mission_tasks;
      DROP TABLE mission_tasks;
      ALTER TABLE mission_tasks_new RENAME TO mission_tasks;
      CREATE INDEX IF NOT EXISTS idx_mission_status
        ON mission_tasks(assigned_agent, status, priority DESC, created_at ASC);
    `);
    logger.info('Migration: made mission_tasks.assigned_agent nullable');
  }

  // Tier 2 deterministic comms: add parent_task_id to chain handbacks to their originating task
  if (addColumnIfMissing(database, 'mission_tasks', 'parent_task_id', 'TEXT')) {
    logger.info('Migration: added mission_tasks.parent_task_id');
  }

  // Tier 3 gather/join primitive: group tag + role, so a scheduler-released
  // join mission can aggregate a fan-out's children once all are terminal.
  if (addColumnIfMissing(database, 'mission_tasks', 'group_id', 'TEXT')) {
    logger.info('Migration: added mission_tasks.group_id');
  }
  if (addColumnIfMissing(database, 'mission_tasks', 'role', `TEXT NOT NULL DEFAULT 'task'`)) {
    logger.info('Migration: added mission_tasks.role');
  }

  // Native one-time future missions remain queued but cannot be claimed until
  // their UTC availability gate opens. NULL preserves immediate behavior for
  // every mission created before this column existed.
  if (addColumnIfMissing(database, 'mission_tasks', 'available_at', 'INTEGER')) {
    logger.info('Migration: added mission_tasks.available_at');
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_mission_claimable
    ON mission_tasks(assigned_agent, status, available_at, priority DESC, created_at ASC)`);

  for (const [name, type] of [
    ['chain_id', 'TEXT'],
    ['continuation_step', 'INTEGER'],
    ['continuation_limit', 'INTEGER'],
    ['continuation_key', 'TEXT'],
  ] as const) {
    if (addColumnIfMissing(database, 'mission_tasks', name, type)) {
      logger.info(`Migration: added mission_tasks.${name}`);
    }
  }
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_continuation_key
    ON mission_tasks(continuation_key) WHERE continuation_key IS NOT NULL`);

  // Keep the small, reusable safety pieces from the retired workflow engine.
  // transition_key makes a worker's handback/continuation edge canonical.
  if (addColumnIfMissing(database, 'mission_tasks', 'transition_key', 'TEXT')) {
    logger.info('Migration: added mission_tasks.transition_key');
  }
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_transition_key
    ON mission_tasks(transition_key) WHERE transition_key IS NOT NULL`);

  // Compatibility marker only: new code does not create generalized workflows,
  // but an upgraded store may retain their rows. The ordinary poller must never
  // reinterpret those rows as one-shot work.
  if (addColumnIfMissing(database, 'mission_tasks', 'workflow_id', 'TEXT')) {
    logger.info('Migration: added mission_tasks.workflow_id compatibility marker');
  }

  addColumnIfMissing(database, 'mission_tasks', 'claiming_instance_id', 'TEXT');
  addColumnIfMissing(database, 'mission_tasks', 'claim_generation', 'INTEGER NOT NULL DEFAULT 0');

  // Task-scoped headless workers are armed by their first claimed mission or
  // scheduled job. Persisting that fact prevents a main-process restart from
  // turning a drained temporary worker back into an indefinitely-idle worker.
  addColumnIfMissing(database, 'worker_runtime', 'scope_started_at', 'INTEGER');
  addColumnIfMissing(database, 'worker_runtime', 'scope_work_id', 'TEXT');

  // Live Meetings: add provider column so we can track which platform
  // each session used (pika avatar vs recall voice-only). Default 'pika'
  // for existing rows so historical data keeps the right label.
  // The emptiness check is an existence check: PRAGMA table_info returns no
  // rows for a table that isn't there, and addColumnIfMissing would then ALTER
  // it and throw "no such table".
  const meetCols = database.prepare(`PRAGMA table_info(meet_sessions)`).all() as Array<{ name: string }>;
  if (meetCols.length > 0) {
    if (addColumnIfMissing(database, 'meet_sessions', 'provider', `TEXT NOT NULL DEFAULT 'pika'`)) {
      logger.info('Migration: added provider column to meet_sessions');
    }
  }

  // Text War Room: tag each meeting as voice or text so existing voice rows
  // stay untouched and the dashboard can filter. The existing `mode` column
  // on warroom_meetings is voice-only semantics (direct|auto) and can't
  // double as meeting-type.
  addColumnIfMissing(database, 'warroom_meetings', 'meeting_type', `TEXT NOT NULL DEFAULT 'voice'`);

  // Text War Room hive-mind: chat_id on warroom_meetings so a text meeting
  // knows which Telegram chat owns it, separately from the synthetic
  // SDK session key (`warroom-text:${meetingId}`). Memory/missions/conv-log
  // calls inside runAgentTurn use this real chat_id; legacy rows default
  // to '' and the bridge no-ops for them.
  addColumnIfMissing(database, 'warroom_meetings', 'chat_id', `TEXT NOT NULL DEFAULT ''`);

  // Text War Room hive-mind: tag conversation_log rows that originated from
  // the war room so they can be deduped on retry and so memory ingestion
  // can scope by source if needed. Existing Telegram rows default to
  // 'telegram'. source_meeting_id + source_turn_id back the partial unique
  // indexes below, which guard against double-persistence on retries.
  addColumnIfMissing(database, 'conversation_log', 'source', `TEXT NOT NULL DEFAULT 'telegram'`);
  addColumnIfMissing(database, 'conversation_log', 'source_meeting_id', `TEXT`);
  addColumnIfMissing(database, 'conversation_log', 'source_turn_id', `TEXT`);

  // Two partial unique indexes so a multi-agent slash turn (which produces
  // ONE user prompt + N assistant rows under one source_turn_id) doesn't
  // collide on retry. User row keyed without agent_id (singleton per turn);
  // assistant rows keyed WITH agent_id (one per speaking agent).
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_convlog_warroom_user
      ON conversation_log(source, source_meeting_id, source_turn_id)
      WHERE source != 'telegram' AND role = 'user';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_convlog_warroom_assistant
      ON conversation_log(source, source_meeting_id, source_turn_id, agent_id)
      WHERE source != 'telegram' AND role = 'assistant';
  `);
}

/** @internal - for tests only. Defaults to memory; a test file can model restart recovery. */
export function _initTestDatabase(databasePath = ':memory:'): void {
  // Use a test encryption key for field-level encryption
  encryptionKey = crypto.randomBytes(32);
  if (db?.open) db.close();
  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  createSchema(db);
  runMigrations(db);
}

/**
 * Test-only: backdate a war-room meeting's `ended_at` so retention sweep
 * tests don't have to wait real wall-clock time. Marked with the `_test`
 * prefix consistent with other test-only exports.
 */
export function _testBackdateMeetingEnd(meetingId: string, endedAtSec: number): void {
  db.prepare('UPDATE warroom_meetings SET ended_at = ? WHERE id = ?')
    .run(endedAtSec, meetingId);
}

/** Test-only compatibility seam for stores retaining rows from the removed Crew engine. */
export function _testMarkLegacyWorkflowMission(taskId: string, workflowId: string): void {
  db.prepare('UPDATE mission_tasks SET workflow_id = ? WHERE id = ?').run(workflowId, taskId);
}

export function getSession(chatId: string, agentId = 'main'): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ? AND agent_id = ?')
    .get(chatId, agentId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(chatId: string, sessionId: string, agentId = 'main'): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, agent_id, session_id, updated_at) VALUES (?, ?, ?, ?)',
  ).run(chatId, agentId, sessionId, new Date().toISOString());
}

export function clearSession(chatId: string, agentId = 'main'): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ? AND agent_id = ?').run(chatId, agentId);
}

/**
 * Clear every persisted conversation session owned by an agent.
 *
 * Provider/model changes can originate in the dashboard process while the
 * target Telegram bot is a different process. Clearing by agent makes every
 * transport/chat start its next turn against the newly persisted config.
 */
export function clearAgentSessions(agentId: string): number {
  return db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(agentId).changes;
}

// ── Memory (V2: structured with LLM extraction) ────────────────────

export interface Memory {
  id: number;
  chat_id: string;
  source: string;
  agent_id: string;
  raw_text: string;
  summary: string;
  entities: string;    // JSON array
  topics: string;      // JSON array
  connections: string; // JSON array
  importance: number;
  salience: number;
  consolidated: number;
  pinned: number;      // 1 = permanent, never decays
  shared: number;      // 1 = visible to every agent on the chat (shared tier); 0 = strict per-agent recall
  embedding: string | null; // JSON array of floats
  created_at: number;
  accessed_at: number;
}

export interface Consolidation {
  id: number;
  chat_id: string;
  source_ids: string;  // JSON array of memory IDs
  summary: string;
  insight: string;
  created_at: number;
  embedding?: string;
  embedding_model?: string;
}

export function saveStructuredMemory(
  chatId: string,
  rawText: string,
  summary: string,
  entities: string[],
  topics: string[],
  importance: number,
  source = 'conversation',
  agentId = 'main',
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO memories (chat_id, source, raw_text, summary, entities, topics, importance, agent_id, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    source,
    rawText,
    summary,
    JSON.stringify(entities),
    JSON.stringify(topics),
    importance,
    agentId,
    now,
    now,
  );
  return result.lastInsertRowid as number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'it', 'its', 'my', 'me', 'we', 'our', 'you', 'your', 'he',
  'him', 'his', 'she', 'her', 'they', 'them', 'their', 'i', 'up',
  'down', 'get', 'got', 'like', 'make', 'know', 'think', 'take',
  'come', 'go', 'see', 'look', 'find', 'give', 'tell', 'say',
  'much', 'many', 'well', 'also', 'back', 'use', 'way',
  'feel', 'mark', 'marks', 'does', 'how',
]);

/**
 * Extract meaningful keywords from a query, stripping stop words and short tokens.
 */
function extractKeywords(query: string): string[] {
  return query
    .replace(/[""]/g, '"')
    .replace(/[^\w\s]/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Search memories using embedding similarity (primary) with FTS5/LIKE fallback.
 * The queryEmbedding parameter is optional; if provided, vector search is used first.
 * If not provided (or no embeddings in DB), falls back to keyword search.
 * When `agentId` is supplied, results are strictly scoped to that agent so
 * one agent never sees another agent's private memories.
 */
export function searchMemories(
  chatId: string,
  query: string,
  limit = 5,
  queryEmbedding?: number[],
  agentId?: string,
): Memory[] {
  // Strategy 1: Vector similarity search (if embedding provided)
  if (queryEmbedding && queryEmbedding.length > 0) {
    const candidates = getMemoriesWithEmbeddings(chatId, agentId);
    if (candidates.length > 0) {
      const scored = candidates
        .map((c) => ({ id: c.id, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .filter((s) => s.score > 0.3) // minimum similarity threshold
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length > 0) {
        const ids = scored.map((s) => s.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND superseded_by IS NULL`)
          .all(...ids) as Memory[];
        // Preserve similarity-score ordering (SQL IN doesn't guarantee order)
        const rowMap = new Map(rows.map((r) => [r.id, r]));
        return ids.map((id) => rowMap.get(id)).filter(Boolean) as Memory[];
      }
    }
  }

  // Strategy 2: FTS5 keyword search with OR
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  // Strip double-quotes from each keyword before wrapping it as an FTS5
  // phrase. Without this, a keyword like `"foo` would produce the
  // malformed fragment `""foo"*` and FTS5 would either error out or, in
  // the worst case, interpret attacker-controlled characters as query
  // operators. Belt-and-braces on top of extractKeywords' own filtering.
  const ftsQuery = keywords.map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  const ftsAgentClause = agentId ? ' AND (memories.agent_id = ? OR memories.shared = 1)' : '';
  const ftsParams: unknown[] = [ftsQuery, chatId];
  if (agentId) ftsParams.push(agentId);
  ftsParams.push(limit);
  let results = db
    .prepare(
      `SELECT memories.* FROM memories
       JOIN memories_fts ON memories.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND memories.chat_id = ? AND memories.superseded_by IS NULL${ftsAgentClause}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...ftsParams) as Memory[];

  if (results.length > 0) return results;

  // Strategy 3: LIKE fallback on summary + entities + topics
  const likeConditions = keywords.map(() =>
    `(summary LIKE ? OR entities LIKE ? OR topics LIKE ? OR raw_text LIKE ?)`,
  ).join(' OR ');
  const likeParams: string[] = [];
  for (const kw of keywords) {
    const pattern = `%${kw}%`;
    likeParams.push(pattern, pattern, pattern, pattern);
  }

  const likeAgentClause = agentId ? ' AND (agent_id = ? OR shared = 1)' : '';
  const likeAllParams: unknown[] = [chatId, ...likeParams];
  if (agentId) likeAllParams.push(agentId);
  likeAllParams.push(limit);
  results = db
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ? AND superseded_by IS NULL AND (${likeConditions})${likeAgentClause}
       ORDER BY importance DESC, accessed_at DESC
       LIMIT ?`,
    )
    .all(...likeAllParams) as Memory[];

  return results;
}

export function saveMemoryEmbedding(memoryId: number, embedding: number[]): void {
  db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), memoryId);
}

/**
 * Atomically save a structured memory and its embedding in a single transaction.
 * If either step fails, both are rolled back.
 */
export function saveStructuredMemoryAtomic(
  chatId: string,
  rawText: string,
  summary: string,
  entities: string[],
  topics: string[],
  importance: number,
  embedding: number[],
  source = 'conversation',
  agentId = 'main',
): number {
  const txn = db.transaction(() => {
    const memoryId = saveStructuredMemory(chatId, rawText, summary, entities, topics, importance, source, agentId);
    if (embedding.length > 0) {
      saveMemoryEmbedding(memoryId, embedding);
    }
    return memoryId;
  });
  return txn();
}

export function getMemoriesWithEmbeddings(
  chatId: string,
  agentId?: string,
): Array<{ id: number; embedding: number[]; summary: string; importance: number }> {
  const sql = agentId
    ? 'SELECT id, embedding, summary, importance FROM memories WHERE chat_id = ? AND (agent_id = ? OR shared = 1) AND embedding IS NOT NULL AND superseded_by IS NULL'
    : 'SELECT id, embedding, summary, importance FROM memories WHERE chat_id = ? AND embedding IS NOT NULL AND superseded_by IS NULL';
  const params = agentId ? [chatId, agentId] : [chatId];
  const rows = db
    .prepare(sql)
    .all(...params) as Array<{ id: number; embedding: string; summary: string; importance: number }>;
  return rows.map((r) => ({
    id: r.id,
    embedding: JSON.parse(r.embedding) as number[],
    summary: r.summary,
    importance: r.importance,
  }));
}

export function getRecentHighImportanceMemories(
  chatId: string,
  limit = 5,
  agentId?: string,
): Memory[] {
  if (agentId) {
    return db
      .prepare(
        `SELECT * FROM memories WHERE chat_id = ? AND (agent_id = ? OR shared = 1) AND importance >= 0.5
         ORDER BY accessed_at DESC LIMIT ?`,
      )
      .all(chatId, agentId, limit) as Memory[];
  }
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND importance >= 0.5
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getRecentMemories(chatId: string, limit = 5, agentId?: string): Memory[] {
  // Memory isolation (#95/#96): when an agentId is given, scope the dump to that
  // agent's own memories plus the explicit shared tier (shared = 1). This mirrors
  // the recall path (searchMemories / getRecentHighImportanceMemories) so the
  // /memory command reflects per-agent context when agents share a chat_id.
  // Omitting agentId keeps the all-agents behaviour for back-compat.
  if (agentId) {
    return db
      .prepare(
        `SELECT * FROM memories WHERE chat_id = ? AND (agent_id = ? OR shared = 1)
         ORDER BY accessed_at DESC LIMIT ?`,
      )
      .all(chatId, agentId, limit) as Memory[];
  }
  return db
    .prepare(
      'SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?',
    )
    .all(chatId, limit) as Memory[];
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?',
  ).run(now, id);
}

export function penalizeMemory(memoryId: number): void {
  db.prepare(
    `UPDATE memories SET salience = MAX(0.05, salience - 0.05) WHERE id = ?`,
  ).run(memoryId);
}

/**
 * Batch-update salience for multiple memories in a single transaction.
 * Reduces SQLite lock contention when multiple agents finish concurrently.
 */
export function batchUpdateMemoryRelevance(
  allIds: number[],
  usefulIds: Set<number>,
): void {
  const txn = db.transaction(() => {
    for (const id of allIds) {
      if (usefulIds.has(id)) {
        touchMemory(id);
      } else {
        penalizeMemory(id);
      }
    }
  });
  txn();
}

/**
 * Importance-weighted decay. High-importance memories decay slower.
 * Pinned memories are exempt from decay entirely.
 * - pinned:             no decay (permanent)
 * - importance >= 0.8:  1% per day (retains ~460 days)
 * - importance >= 0.5:  2% per day (retains ~230 days)
 * - importance < 0.5:   5% per day (retains ~90 days)
 */
export function decayMemories(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  db.prepare(`
    UPDATE memories SET salience = salience * CASE
      WHEN importance >= 0.8 THEN 0.99
      WHEN importance >= 0.5 THEN 0.98
      ELSE 0.95
    END
    WHERE created_at < ? AND pinned = 0
  `).run(oneDayAgo);
  // Clear superseded_by references pointing to memories we're about to delete,
  // otherwise the FOREIGN KEY constraint on superseded_by -> memories(id) fails.
  db.prepare(`
    UPDATE memories SET superseded_by = NULL
    WHERE superseded_by IN (SELECT id FROM memories WHERE salience < 0.05 AND pinned = 0)
  `).run();
  db.prepare('DELETE FROM memories WHERE salience < 0.05 AND pinned = 0').run();
}

export function pinMemory(memoryId: number): void {
  db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(memoryId);
}

export function unpinMemory(memoryId: number): void {
  db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run(memoryId);
}

/** Promote a memory to the shared tier (visible to every agent on the chat),
 *  or demote it back to strict per-agent recall. See memory isolation (#95). */
export function setMemoryShared(memoryId: number, shared: boolean): void {
  db.prepare('UPDATE memories SET shared = ? WHERE id = ?').run(shared ? 1 : 0, memoryId);
}

// ── Consolidation CRUD ──────────────────────────────────────────────

export function getUnconsolidatedMemories(chatId: string, limit = 20): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND consolidated = 0
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function saveConsolidation(
  chatId: string,
  sourceIds: number[],
  summary: string,
  insight: string,
): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO consolidations (chat_id, source_ids, summary, insight, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(chatId, JSON.stringify(sourceIds), summary, insight, now);
  return result.lastInsertRowid as number;
}

export function saveConsolidationEmbedding(consolidationId: number, embedding: number[]): void {
  db.prepare('UPDATE consolidations SET embedding = ?, embedding_model = ? WHERE id = ?')
    .run(JSON.stringify(embedding), 'embedding-001', consolidationId);
}

export function getConsolidationsWithEmbeddings(chatId: string): Array<{ id: number; embedding: number[]; summary: string; insight: string }> {
  const rows = db
    .prepare('SELECT id, embedding, summary, insight FROM consolidations WHERE chat_id = ? AND embedding IS NOT NULL AND embedding_model = ?')
    .all(chatId, 'embedding-001') as Array<{ id: number; embedding: string; summary: string; insight: string }>;
  return rows.map((r) => ({ ...r, embedding: JSON.parse(r.embedding) as number[] }));
}

export function supersedeMemory(oldId: number, newId: number): void {
  db.prepare(
    `UPDATE memories SET superseded_by = ?, importance = importance * 0.3, salience = salience * 0.5 WHERE id = ?`,
  ).run(newId, oldId);
}

export function updateMemoryConnections(memoryId: number, connections: Array<{ linked_to: number; relationship: string }>): void {
  const row = db.prepare('SELECT connections FROM memories WHERE id = ?').get(memoryId) as { connections: string } | undefined;
  if (!row) return;
  const existing: Array<{ linked_to: number; relationship: string }> = JSON.parse(row.connections);
  const merged = [...existing, ...connections];
  // Deduplicate by linked_to to prevent unbounded growth on re-consolidation
  const seen = new Set<number>();
  const deduped = merged.filter((c) => {
    if (seen.has(c.linked_to)) return false;
    seen.add(c.linked_to);
    return true;
  });
  db.prepare('UPDATE memories SET connections = ? WHERE id = ?').run(JSON.stringify(deduped), memoryId);
}

export function markMemoriesConsolidated(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE memories SET consolidated = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Atomically save a consolidation, wire connections, handle contradictions,
 * and mark source memories as consolidated. If any step fails, all roll back.
 */
export function saveConsolidationAtomic(
  chatId: string,
  sourceIds: number[],
  summary: string,
  insight: string,
  connections: Array<{ from_id: number; to_id: number; relationship: string }>,
  contradictions: Array<{ stale_id: number; superseded_by: number }>,
): number {
  const txn = db.transaction(() => {
    const consolidationId = saveConsolidation(chatId, sourceIds, summary, insight);

    for (const conn of connections) {
      updateMemoryConnections(conn.from_id, [
        { linked_to: conn.to_id, relationship: conn.relationship },
      ]);
      updateMemoryConnections(conn.to_id, [
        { linked_to: conn.from_id, relationship: conn.relationship },
      ]);
    }

    for (const contra of contradictions) {
      supersedeMemory(contra.stale_id, contra.superseded_by);
    }

    markMemoriesConsolidated(sourceIds);
    return consolidationId;
  });
  return txn();
}

export function getRecentConsolidations(chatId: string, limit = 5): Consolidation[] {
  return db
    .prepare(
      `SELECT * FROM consolidations WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Consolidation[];
}

export function searchConsolidations(chatId: string, query: string, limit = 3): Consolidation[] {
  // Simple LIKE search on consolidation summaries and insights
  const pattern = `%${query.replace(/[%_]/g, '')}%`;
  return db
    .prepare(
      `SELECT * FROM consolidations
       WHERE chat_id = ? AND (summary LIKE ? OR insight LIKE ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, pattern, pattern, limit) as Consolidation[];
}

// ── Scheduled Tasks ──────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'running';
  created_at: number;
  agent_id: string;
  started_at: number | null;
  last_status: 'success' | 'failed' | 'timeout' | null;
  acceptance_check: string | null;
  /** Recurring activation to restore after execution or restart recovery. */
  resume_status: 'active' | 'paused' | null;
}

export function createScheduledTask(
  id: string,
  prompt: string,
  schedule: string,
  nextRun: number,
  agentId = 'main',
  acceptanceCheck: string | null = null,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at, agent_id, acceptance_check)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(id, prompt, schedule, nextRun, now, agentId, acceptanceCheck);
}

export function getDueTasks(agentId = 'main'): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000);
  return db
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ? AND agent_id = ? ORDER BY next_run`,
    )
    .all(now, agentId) as ScheduledTask[];
}

export function getAllScheduledTasks(agentId?: string): ScheduledTask[] {
  if (agentId) {
    return db
      .prepare('SELECT * FROM scheduled_tasks WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId) as ScheduledTask[];
  }
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

/**
 * Mark a task as running and optionally advance its next_run to the next
 * scheduled occurrence. Advancing next_run immediately prevents the scheduler
 * from re-firing the same task on subsequent ticks while it is still executing
 * (double-fire bug), and survives process restarts since the value is persisted.
 * Snapshot activation in the same write so a paused manual run remains paused
 * even if its queued callback is lost. Repeated marks retain the saved state.
 */
export function markTaskRunning(id: string, tentativeNextRun?: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (tentativeNextRun !== undefined) {
    db.prepare(
      `UPDATE scheduled_tasks SET resume_status = CASE WHEN status = 'running' THEN resume_status ELSE status END,
       status = 'running', started_at = ?, next_run = ? WHERE id = ?`,
    ).run(now, tentativeNextRun, id);
  } else {
    db.prepare(
      `UPDATE scheduled_tasks SET resume_status = CASE WHEN status = 'running' THEN resume_status ELSE status END,
       status = 'running', started_at = ? WHERE id = ?`,
    ).run(now, id);
  }
}

export function updateTaskAfterRun(
  id: string,
  nextRun: number,
  result: string,
  lastStatus: 'success' | 'failed' | 'timeout' = 'success',
): void {
  const now = Math.floor(Date.now() / 1000);
  const safeResult = sanitizeOutboundText(result, outboundOptionsForSeam('schedule.result'));
  // Retry so a post-run write never loses the lock race and leaves the task
  // stuck in 'running' with a stale next_run (same failure mode as
  // completeMissionTask, issue #155).
  withBusyRetry(() =>
    db.prepare(
      `UPDATE scheduled_tasks SET
       status = CASE WHEN status = 'running' THEN COALESCE(resume_status, 'active') ELSE status END,
       resume_status = NULL, last_run = ?, next_run = ?, last_result = ?, last_status = ?, started_at = NULL WHERE id = ?`,
    ).run(now, nextRun, safeResult.slice(0, 4000), lastStatus, id),
  );
}

export function resetStuckTasks(agentId: string): number {
  const result = db.prepare(
    `UPDATE scheduled_tasks SET status = COALESCE(resume_status, 'active'), resume_status = NULL,
     started_at = NULL WHERE status = 'running' AND agent_id = ?`,
  ).run(agentId);
  return result.changes;
}

export function deleteScheduledTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/**
 * Patch the editable fields of a scheduled task. Caller is responsible
 * for recomputing next_run when schedule changes. Pass `undefined` to
 * skip a field; pass a value to update it.
 */
export function updateScheduledTask(
  id: string,
  patch: { prompt?: string; schedule?: string; nextRun?: number; agentId?: string },
): void {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.prompt !== undefined) { sets.push('prompt = ?'); vals.push(patch.prompt); }
  if (patch.schedule !== undefined) { sets.push('schedule = ?'); vals.push(patch.schedule); }
  if (patch.nextRun !== undefined) { sets.push('next_run = ?'); vals.push(patch.nextRun); }
  if (patch.agentId !== undefined) { sets.push('agent_id = ?'); vals.push(patch.agentId); }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function pauseScheduledTask(id: string): void {
  // Changing recurring activation must not release an in-flight execution lock.
  db.prepare(`UPDATE scheduled_tasks SET
    resume_status = CASE WHEN status = 'running' THEN 'paused' ELSE NULL END,
    status = CASE WHEN status = 'running' THEN status ELSE 'paused' END WHERE id = ?`).run(id);
}

export function resumeScheduledTask(id: string): void {
  db.prepare(`UPDATE scheduled_tasks SET
    resume_status = CASE WHEN status = 'running' THEN 'active' ELSE NULL END,
    status = CASE WHEN status = 'running' THEN status ELSE 'active' END WHERE id = ?`).run(id);
}

/**
 * Get recent scheduled task outputs for a given agent.
 * Used to inject context into the next user message so Claude knows
 * what was just shown to the user via a scheduled task.
 *
 * Returns tasks that ran in the last `withinMinutes` (default 30).
 */
export function getRecentTaskOutputs(
  agentId: string,
  withinMinutes = 30,
): Array<{ prompt: string; last_result: string; last_run: number }> {
  const cutoff = Math.floor(Date.now() / 1000) - withinMinutes * 60;
  return db
    .prepare(
      `SELECT prompt, last_result, last_run FROM scheduled_tasks
       WHERE agent_id = ? AND last_status = 'success' AND last_run > ?
       ORDER BY last_run DESC LIMIT 3`,
    )
    .all(agentId, cutoff) as Array<{ prompt: string; last_result: string; last_run: number }>;
}

// ── WhatsApp message map ──────────────────────────────────────────────

export function saveWaMessageMap(telegramMsgId: number, waChatId: string, contactName: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO wa_message_map (telegram_msg_id, wa_chat_id, contact_name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(telegramMsgId, waChatId, contactName, now);
}

export function lookupWaChatId(telegramMsgId: number): { waChatId: string; contactName: string } | null {
  const row = db
    .prepare('SELECT wa_chat_id, contact_name FROM wa_message_map WHERE telegram_msg_id = ?')
    .get(telegramMsgId) as { wa_chat_id: string; contact_name: string } | undefined;
  if (!row) return null;
  return { waChatId: row.wa_chat_id, contactName: row.contact_name };
}

export function getRecentWaContacts(limit = 20): Array<{ waChatId: string; contactName: string; lastSeen: number }> {
  const rows = db.prepare(
    `SELECT wa_chat_id, contact_name, MAX(created_at) as lastSeen
     FROM wa_message_map
     GROUP BY wa_chat_id
     ORDER BY lastSeen DESC
     LIMIT ?`,
  ).all(limit) as Array<{ wa_chat_id: string; contact_name: string; lastSeen: number }>;
  return rows.map((r) => ({ waChatId: r.wa_chat_id, contactName: r.contact_name, lastSeen: r.lastSeen }));
}

// ── WhatsApp outbox ──────────────────────────────────────────────────

export interface WaOutboxItem {
  id: number;
  to_chat_id: string;
  body: string;
  created_at: number;
}

export function enqueueWaMessage(toChatId: string, body: string): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `INSERT INTO wa_outbox (to_chat_id, body, created_at) VALUES (?, ?, ?)`,
  ).run(toChatId, encryptField(body), now);
  return result.lastInsertRowid as number;
}

export function getPendingWaMessages(): WaOutboxItem[] {
  const rows = db.prepare(
    `SELECT id, to_chat_id, body, created_at FROM wa_outbox WHERE sent_at IS NULL ORDER BY created_at`,
  ).all() as WaOutboxItem[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

export function markWaMessageSent(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`UPDATE wa_outbox SET sent_at = ? WHERE id = ?`).run(now, id);
}

// ── WhatsApp messages ────────────────────────────────────────────────

/**
 * Prune WhatsApp messages older than the given number of days.
 * Covers wa_messages, wa_outbox (sent only), and wa_message_map.
 */
export function pruneWaMessages(retentionDays = 3): { messages: number; outbox: number; map: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;

  const msgResult = db.prepare(
    'DELETE FROM wa_messages WHERE created_at < ?',
  ).run(cutoff);

  const outboxResult = db.prepare(
    'DELETE FROM wa_outbox WHERE sent_at IS NOT NULL AND created_at < ?',
  ).run(cutoff);

  const mapResult = db.prepare(
    'DELETE FROM wa_message_map WHERE created_at < ?',
  ).run(cutoff);

  return {
    messages: msgResult.changes,
    outbox: outboxResult.changes,
    map: mapResult.changes,
  };
}

/**
 * Prune Slack messages older than the given number of days.
 */
export function pruneSlackMessages(retentionDays = 3): number {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const result = db.prepare(
    'DELETE FROM slack_messages WHERE created_at < ?',
  ).run(cutoff);
  return result.changes;
}

// ── Conversation Log ──────────────────────────────────────────────────

export interface ConversationTurn {
  id: number;
  chat_id: string;
  session_id: string | null;
  role: string;
  content: string;
  created_at: number;
}

export function logConversationTurn(
  chatId: string,
  role: 'user' | 'assistant',
  content: string,
  sessionId?: string,
  agentId = 'main',
): void {
  const now = Math.floor(Date.now() / 1000);
  const safeContent = role === 'assistant'
    ? sanitizeOutboundText(content, outboundOptionsForSeam('conversation.assistant'))
    : content;
  db.prepare(
    `INSERT INTO conversation_log (chat_id, session_id, role, content, created_at, agent_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, sessionId ?? null, role, safeContent, now, agentId);
}

export function getRecentConversation(
  chatId: string,
  limit = 20,
  agentId?: string,
): ConversationTurn[] {
  // IMPORTANT: filter by agent_id too. Without this, /respin in the main
  // agent bleeds in turns from research/comms/content/ops that share the
  // same chat_id, producing respins contaminated with other agents'
  // conversations. Reported by Benjamin Elkrieff in April 2026.
  if (agentId) {
    return db
      .prepare(
        `SELECT * FROM conversation_log
         WHERE chat_id = ? AND agent_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(chatId, agentId, limit) as ConversationTurn[];
  }
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

/**
 * Search conversation_log by keywords. Used when the user asks about
 * past conversations ("remember when we...", "what did we talk about").
 * Returns recent turns that match any keyword, grouped chronologically.
 */
export function searchConversationHistory(
  chatId: string,
  query: string,
  agentId?: string,
  daysBack = 7,
  limit = 20,
): ConversationTurn[] {
  const cutoff = Math.floor(Date.now() / 1000) - (daysBack * 86400);
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 8);
  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
  const params: (string | number)[] = [chatId, cutoff];
  for (const kw of keywords) {
    params.push(`%${kw}%`);
  }

  const agentFilter = agentId ? ' AND agent_id = ?' : '';
  if (agentId) params.push(agentId);

  return db
    .prepare(
      `SELECT * FROM conversation_log
       WHERE chat_id = ? AND created_at > ? AND (${conditions})${agentFilter}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as ConversationTurn[];
}

/**
 * Get a page of conversation turns for the dashboard chat overlay.
 * Returns turns in reverse chronological order (newest first).
 * Use `beforeId` for cursor-based pagination (load older messages).
 */
export function getConversationPage(
  chatId: string,
  limit = 40,
  beforeId?: number,
): ConversationTurn[] {
  if (beforeId) {
    return db
      .prepare(
        `SELECT * FROM conversation_log
         WHERE chat_id = ? AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(chatId, beforeId, limit) as ConversationTurn[];
  }
  return db
    .prepare(
      `SELECT * FROM conversation_log
       WHERE chat_id = ?
       ORDER BY id DESC LIMIT ?`,
    )
    .all(chatId, limit) as ConversationTurn[];
}

/**
 * Prune old conversation_log entries, keeping only the most recent N rows
 * per (chat_id, agent_id) pair. Scoping by agent matters because all five
 * agents share the same chat_id in a typical install, and a chatty agent
 * could otherwise evict a quieter agent's history under the shared cap.
 * Wrapped in a transaction so a mid-loop crash can't leave the table in a
 * half-pruned state.
 */
export function pruneConversationLog(keepPerChat = 500): void {
  const pairs = db
    .prepare('SELECT DISTINCT chat_id, agent_id FROM conversation_log')
    .all() as Array<{ chat_id: string; agent_id: string }>;

  const deleteStmt = db.prepare(`
    DELETE FROM conversation_log
    WHERE chat_id = ? AND agent_id = ? AND id NOT IN (
      SELECT id FROM conversation_log
      WHERE chat_id = ? AND agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `);

  const runAll = db.transaction((rows: typeof pairs) => {
    for (const row of rows) {
      deleteStmt.run(row.chat_id, row.agent_id, row.chat_id, row.agent_id, keepPerChat);
    }
  });
  runAll(pairs);
}

/**
 * Retention sweep for ended war-room meetings + their transcripts.
 *
 * Why this exists: warroom_meetings + warroom_transcript were not touched
 * by the original decay sweep. Long-running installs accumulate every
 * meeting indefinitely; transcripts can be hundreds of rows each. Cap at
 * `retentionDays` since `ended_at` (default 90). Active meetings (no
 * `ended_at`) are never pruned.
 *
 * Cascading: deleting a `warroom_meetings` row removes its
 * `warroom_transcript` rows via the FK ON DELETE CASCADE. We also clear
 * matching `conversation_log` rows tagged with the meeting's ID so the
 * "delete a meeting actually deletes its content" promise holds.
 */
export function pruneWarRoomMeetings(retentionDays = 90): { meetings: number; convLog: number } {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  return db.transaction(() => {
    const expired = db
      .prepare(`SELECT id FROM warroom_meetings WHERE ended_at IS NOT NULL AND ended_at < ?`)
      .all(cutoff) as Array<{ id: string }>;
    if (expired.length === 0) return { meetings: 0, convLog: 0 };
    const ids = expired.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    const convDel = db
      .prepare(`DELETE FROM conversation_log WHERE source_meeting_id IN (${placeholders})`)
      .run(...ids);
    // warroom_transcript rows go via the FK cascade on warroom_meetings.
    const meetDel = db
      .prepare(`DELETE FROM warroom_meetings WHERE id IN (${placeholders})`)
      .run(...ids);

    return {
      meetings: Number(meetDel.changes),
      convLog: Number(convDel.changes),
    };
  })();
}

// ── WhatsApp messages ────────────────────────────────────────────────

export function saveWaMessage(
  chatId: string,
  contactName: string,
  body: string,
  timestamp: number,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO wa_messages (chat_id, contact_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(chatId, contactName, encryptField(body), timestamp, isFromMe ? 1 : 0, now);
}

export interface WaMessageRow {
  id: number;
  chat_id: string;
  contact_name: string;
  body: string;
  timestamp: number;
  is_from_me: number;
  created_at: number;
}

export function getRecentWaMessages(chatId: string, limit = 20): WaMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM wa_messages WHERE chat_id = ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(chatId, limit) as WaMessageRow[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

// ── Slack messages ────────────────────────────────────────────────

export function saveSlackMessage(
  channelId: string,
  channelName: string,
  userName: string,
  body: string,
  timestamp: string,
  isFromMe: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO slack_messages (channel_id, channel_name, user_name, body, timestamp, is_from_me, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(channelId, channelName, userName, encryptField(body), timestamp, isFromMe ? 1 : 0, now);
}

export interface SlackMessageRow {
  id: number;
  channel_id: string;
  channel_name: string;
  user_name: string;
  body: string;
  timestamp: string;
  is_from_me: number;
  created_at: number;
}

export function getRecentSlackMessages(channelId: string, limit = 20): SlackMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM slack_messages WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit) as SlackMessageRow[];
  return rows.map((r) => ({ ...r, body: decryptField(r.body) }));
}

// ── Token Usage ──────────────────────────────────────────────────────

export function saveTokenUsage(
  chatId: string,
  sessionId: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  contextTokens: number,
  costUsd: number,
  didCompact: boolean,
  agentId = 'main',
  contextWindow: number | null = null,
  cacheCreation = 0,
  telemetry: {
    model?: string | null;
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    stopReason?: string | null;
    isError?: boolean;
    /**
     * Whether costUsd is money. Defaults to 'provider' so the six existing
     * call sites keep their meaning; a provider that cannot price its turns
     * passes 'unknown', and every aggregate below then excludes the row
     * instead of adding a misleading zero.
     */
    costSource?: 'provider' | 'unknown';
  } = {},
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO token_usage (chat_id, session_id, input_tokens, output_tokens, cache_read, context_tokens, cost_usd, did_compact, created_at, agent_id, context_window, cache_creation, model, duration_ms, duration_api_ms, num_turns, stop_reason, is_error, cost_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId, sessionId ?? null, inputTokens, outputTokens, cacheRead, contextTokens, costUsd, didCompact ? 1 : 0, now, agentId, contextWindow, cacheCreation,
    telemetry.model ?? null,
    telemetry.durationMs ?? 0,
    telemetry.durationApiMs ?? 0,
    telemetry.numTurns ?? 0,
    telemetry.stopReason ?? null,
    telemetry.isError ? 1 : 0,
    telemetry.costSource ?? 'provider',
  );
}

export interface SessionTokenSummary {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastCacheRead: number;
  lastContextTokens: number;
  /** The active model's real context window from the last turn; null if unknown. */
  lastContextWindow: number | null;
  totalCostUsd: number;
  compactions: number;
  firstTurnAt: number;
  lastTurnAt: number;
}

// ── Dashboard Queries ──────────────────────────────────────────────────

export interface DashboardMemoryStats {
  total: number;
  pinned: number;
  consolidations: number;
  avgImportance: number;
  avgSalience: number;
  importanceDistribution: { bucket: string; count: number }[];
}

export function getDashboardMemoryStats(chatId: string): DashboardMemoryStats {
  const counts = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         AVG(importance) as avgImportance,
         AVG(salience) as avgSalience
       FROM memories WHERE chat_id = ?`,
    )
    .get(chatId) as { total: number; avgImportance: number | null; avgSalience: number | null };

  const consolidationCount = db
    .prepare('SELECT COUNT(*) as cnt FROM consolidations WHERE chat_id = ?')
    .get(chatId) as { cnt: number };

  const pinnedCount = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ? AND pinned = 1')
    .get(chatId) as { cnt: number };

  const buckets = db
    .prepare(
      `SELECT
         CASE
           WHEN importance < 0.2 THEN '0-0.2'
           WHEN importance < 0.4 THEN '0.2-0.4'
           WHEN importance < 0.6 THEN '0.4-0.6'
           WHEN importance < 0.8 THEN '0.6-0.8'
           ELSE '0.8-1.0'
         END as bucket,
         COUNT(*) as count
       FROM memories WHERE chat_id = ?
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all(chatId) as { bucket: string; count: number }[];

  return {
    total: counts.total,
    pinned: pinnedCount.cnt,
    consolidations: consolidationCount.cnt,
    avgImportance: counts.avgImportance ?? 0,
    avgSalience: counts.avgSalience ?? 0,
    importanceDistribution: buckets,
  };
}

export function getDashboardPinnedMemories(chatId: string): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? AND pinned = 1 ORDER BY importance DESC')
    .all(chatId) as Memory[];
}

export function getDashboardLowSalienceMemories(chatId: string, limit = 10): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND salience < 0.5
       ORDER BY salience ASC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardTopAccessedMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND importance >= 0.5
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Memory[];
}

export function getDashboardMemoryTimeline(chatId: string, days = 30): { date: string; count: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         COUNT(*) as count
       FROM memories
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; count: number }[];
}

export function getDashboardConsolidations(chatId: string, limit = 5): Consolidation[] {
  return getRecentConsolidations(chatId, limit);
}

export interface DashboardTokenStats {
  todayInput: number;
  todayOutput: number;
  todayCost: number;
  todayTurns: number;
  allTimeCost: number;
  allTimeTurns: number;
}

export function getDashboardTokenStats(chatId: string): DashboardTokenStats {
  const today = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as todayInput,
         COALESCE(SUM(output_tokens), 0) as todayOutput,
         COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0) as todayCost,
         COUNT(*) as todayTurns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', 'start of day')`,
    )
    .get(chatId) as { todayInput: number; todayOutput: number; todayCost: number; todayTurns: number };

  const allTime = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) as allTimeInput,
         COALESCE(SUM(output_tokens), 0) as allTimeOutput,
         COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0) as allTimeCost,
         COUNT(*) as allTimeTurns
       FROM token_usage WHERE chat_id = ?`,
    )
    .get(chatId) as { allTimeInput: number; allTimeOutput: number; allTimeCost: number; allTimeTurns: number };

  return { ...today, ...allTime };
}

export function getDashboardCostTimeline(chatId: string, days = 30): { date: string; cost: number; turns: number }[] {
  return db
    .prepare(
      `SELECT
         date(created_at, 'unixepoch') as date,
         SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END) as cost,
         COUNT(*) as turns
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY date
       ORDER BY date`,
    )
    .all(chatId, `-${days} days`) as { date: string; cost: number; turns: number }[];
}

export interface CacheTokensRow {
  agentId: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
}

/**
 * Per-agent prompt-cache token usage over the last `days`, scoped to a chat.
 * Reports measured token counts only (cache read/write, input/output) plus
 * metered cost_usd — no derived "savings" figure (honest metrics only).
 */
export function getCacheTokens(chatId: string, days = 30): CacheTokensRow[] {
  return db
    .prepare(
      `SELECT
         agent_id                       as agentId,
         COUNT(*)                       as turns,
         COALESCE(SUM(input_tokens), 0) as inputTokens,
         COALESCE(SUM(output_tokens), 0) as outputTokens,
         COALESCE(SUM(cache_read), 0)   as cacheRead,
         COALESCE(SUM(cache_creation), 0) as cacheCreation,
         COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0)     as costUsd
       FROM token_usage
       WHERE chat_id = ? AND created_at >= unixepoch('now', ?)
       GROUP BY agent_id
       ORDER BY cacheRead DESC`,
    )
    .all(chatId, `-${days} days`) as CacheTokensRow[];
}

export interface RecentTokenUsageRow {
  id: number;
  chat_id: string;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  context_tokens: number;
  cost_usd: number;
  did_compact: number;
  created_at: number;
}

export function getDashboardRecentTokenUsage(chatId: string, limit = 20): RecentTokenUsageRow[] {
  return db
    .prepare(
      `SELECT * FROM token_usage WHERE chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as RecentTokenUsageRow[];
}

export function getDashboardMemoriesList(chatId: string, limit = 50, offset = 0, sortBy: 'importance' | 'salience' | 'recent' = 'importance'): { memories: Memory[]; total: number } {
  const total = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ?')
    .get(chatId) as { cnt: number };

  let orderClause: string;
  switch (sortBy) {
    case 'salience':
      orderClause = 'ORDER BY salience DESC, created_at DESC';
      break;
    case 'recent':
      orderClause = 'ORDER BY created_at DESC';
      break;
    default:
      orderClause = 'ORDER BY importance DESC, created_at DESC';
  }

  const memories = db
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? ${orderClause} LIMIT ? OFFSET ?`,
    )
    .all(chatId, limit, offset) as Memory[];
  return { memories, total: total.cnt };
}

// ── Hive Mind ──────────────────────────────────────────────────────

export interface HiveMindEntry {
  id: number;
  agent_id: string;
  chat_id: string;
  action: string;
  summary: string;
  artifacts: string | null;
  created_at: number;
}

export function logToHiveMind(
  agentId: string,
  chatId: string,
  action: string,
  summary: string,
  artifacts?: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, chatId, action, summary, artifacts ?? null, now);
}

export function getHiveMindEntries(limit = 20, agentId?: string): HiveMindEntry[] {
  if (agentId) {
    return db
      .prepare('SELECT * FROM hive_mind WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, limit) as HiveMindEntry[];
  }
  return db
    .prepare('SELECT * FROM hive_mind ORDER BY created_at DESC LIMIT ?')
    .all(limit) as HiveMindEntry[];
}

/**
 * Get recent hive_mind entries from agents OTHER than the given one.
 * Used to give each agent awareness of what teammates have been doing.
 */
export function getOtherAgentActivity(
  excludeAgentId: string,
  hoursBack = 24,
  limit = 10,
): HiveMindEntry[] {
  const cutoff = Math.floor(Date.now() / 1000) - (hoursBack * 3600);
  return db
    .prepare(
      `SELECT * FROM hive_mind
       WHERE agent_id != ? AND created_at > ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(excludeAgentId, cutoff, limit) as HiveMindEntry[];
}

/**
 * Get conversation turns for a specific session, ordered chronologically.
 * Used for hive-mind auto-commit on session end.
 */
export function getSessionConversation(sessionId: string, limit = 40): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM conversation_log WHERE session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId, limit) as ConversationTurn[];
}

export function getAgentTokenStats(agentId: string): { todayCost: number; todayTurns: number; allTimeCost: number } {
  const today = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0) as todayCost, COUNT(*) as todayTurns
       FROM token_usage
       WHERE agent_id = ? AND created_at >= unixepoch('now', 'start of day')`,
    )
    .get(agentId) as { todayCost: number; todayTurns: number };

  const allTime = db
    .prepare(`SELECT COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0) as allTimeCost FROM token_usage WHERE agent_id = ?`)
    .get(agentId) as { allTimeCost: number };

  return { ...today, allTimeCost: allTime.allTimeCost };
}

export function getAgentRecentConversation(agentId: string, chatId: string, limit = 4): ConversationTurn[] {
  return db
    .prepare(
      `SELECT * FROM conversation_log WHERE agent_id = ? AND chat_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, chatId, limit) as ConversationTurn[];
}

export function getSessionTokenUsage(sessionId: string): SessionTokenSummary | null {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)           as turns,
         SUM(input_tokens)  as totalInputTokens,
         SUM(output_tokens) as totalOutputTokens,
         SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END)      as totalCostUsd,
         SUM(did_compact)   as compactions,
         MIN(created_at)    as firstTurnAt,
         MAX(created_at)    as lastTurnAt
       FROM token_usage WHERE session_id = ?`,
    )
    .get(sessionId) as {
      turns: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      compactions: number;
      firstTurnAt: number;
      lastTurnAt: number;
    } | undefined;

  if (!row || row.turns === 0) return null;

  // Get the most recent turn's context_tokens (actual context window size from last API call)
  // Falls back to cache_read for backward compat with rows before the migration
  const lastRow = db
    .prepare(
      `SELECT cache_read, context_tokens, context_window FROM token_usage
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { cache_read: number; context_tokens: number; context_window: number | null } | undefined;

  return {
    turns: row.turns,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    lastCacheRead: lastRow?.cache_read ?? 0,
    lastContextTokens: lastRow?.context_tokens ?? lastRow?.cache_read ?? 0,
    lastContextWindow: lastRow?.context_window ?? null,
    totalCostUsd: row.totalCostUsd,
    compactions: row.compactions,
    firstTurnAt: row.firstTurnAt,
    lastTurnAt: row.lastTurnAt,
  };
}

// ── Inter-Agent Tasks ──────────────────────────────────────────────────

export interface InterAgentTask {
  id: string;
  from_agent: string;
  to_agent: string;
  chat_id: string;
  prompt: string;
  status: string;
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

export function createInterAgentTask(
  id: string,
  fromAgent: string,
  toAgent: string,
  chatId: string,
  prompt: string,
): void {
  db.prepare(
    `INSERT INTO inter_agent_tasks (id, from_agent, to_agent, chat_id, prompt, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  ).run(id, fromAgent, toAgent, chatId, prompt);
}

export function completeInterAgentTask(
  id: string,
  status: 'completed' | 'failed',
  result: string | null,
): void {
  const safeResult = result === null
    ? null
    : sanitizeOutboundText(result, outboundOptionsForSeam('delegation.result'));
  db.prepare(
    `UPDATE inter_agent_tasks SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?`,
  ).run(status, safeResult?.slice(0, 2000) ?? null, id);
}

export function getInterAgentTasks(
  limit = 20,
  status?: string,
): InterAgentTask[] {
  if (status) {
    return db
      .prepare(
        'SELECT * FROM inter_agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(status, limit) as InterAgentTask[];
  }
  return db
    .prepare(
      'SELECT * FROM inter_agent_tasks ORDER BY created_at DESC LIMIT ?',
    )
    .all(limit) as InterAgentTask[];
}

// ── Mission Tasks (one-shot async tasks for Mission Control) ─────────

export interface MissionTask {
  id: string;
  title: string;
  prompt: string;
  assigned_agent: string | null;
  status: 'queued' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';
  result: string | null;
  error: string | null;
  created_by: string;
  priority: number;
  created_at: number;
  available_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  parent_task_id: string | null;
  group_id: string | null;
  role: string;
  chain_id: string | null;
  continuation_step: number | null;
  continuation_limit: number | null;
  continuation_key: string | null;
  /** Canonical outgoing edge key; retained independently of Crew workflows. */
  transition_key: string | null;
  /** Compatibility marker for historical Crew rows. New one-shot work leaves it null. */
  workflow_id: string | null;
  /** Present only when a headless worker instance owns the running claim. */
  claiming_instance_id: string | null;
  claim_generation: number;
}

export interface MissionChain {
  id: string;
  owner_agent: string;
  max_steps: number;
  status: 'active' | 'cancelled';
  created_at: number;
  cancelled_at: number | null;
}

export function createMissionTask(
  id: string,
  title: string,
  prompt: string,
  assignedAgent: string | null = null,
  createdBy = 'dashboard',
  priority = 0,
  parentTaskId: string | null = null,
  groupId: string | null = null,
  role = 'task',
  status: 'queued' | 'waiting' = 'queued',
  availableAt: number | null = null,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO mission_tasks
      (id, title, prompt, assigned_agent, status, created_by, priority, created_at,
       available_at, parent_task_id, group_id, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, prompt, assignedAgent, status, createdBy, priority, now,
    availableAt, parentTaskId, groupId, role);
}

export function createMissionHandback(input: {
  id: string; title: string; prompt: string; agent: string; createdBy: string;
  priority: number; parentId: string;
}): { id: string; duplicate: boolean; ineligibleStatus: MissionTask['status'] | null } {
  const transitionKey = `handback:${input.parentId}`;
  const txn = db.transaction(() => {
    // Recognize rows written before transition_key existed. A retry returns the
    // first durable edge instead of manufacturing another handback.
    const existing = db.prepare(
      `SELECT id FROM mission_tasks
       WHERE parent_task_id = ? AND role = 'handback'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(input.parentId) as { id: string } | undefined;
    if (existing) return { id: existing.id, duplicate: true, ineligibleStatus: null };

    const parent = db.prepare('SELECT status FROM mission_tasks WHERE id = ?').get(input.parentId) as
      { status: MissionTask['status'] } | undefined;
    if (!parent) throw new Error(`Mission parent disappeared: ${input.parentId}`);
    if (parent.status !== 'running') {
      return { id: '', duplicate: false, ineligibleStatus: parent.status };
    }

    const now = Math.floor(Date.now() / 1000);
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO mission_tasks
        (id, title, prompt, assigned_agent, status, created_by, priority, created_at,
         parent_task_id, role, transition_key)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, 'handback', ?)`,
    ).run(input.id, input.title, input.prompt, input.agent, input.createdBy,
      input.priority, now, input.parentId, transitionKey);
    if (inserted.changes === 1) return { id: input.id, duplicate: false, ineligibleStatus: null };

    const raced = db.prepare('SELECT id FROM mission_tasks WHERE transition_key = ?').get(transitionKey) as
      { id: string } | undefined;
    if (!raced) throw new Error(`Could not resolve canonical handback for ${input.parentId}`);
    return { id: raced.id, duplicate: true, ineligibleStatus: null };
  });
  return withBusyRetry(() => txn.immediate());
}

export function createMissionContinuation(input: {
  id: string; title: string; prompt: string; agent: string; priority: number;
  parentId: string; chainId: string; step: number; limit: number; key: string;
}): {
  id: string;
  duplicate: boolean;
  cancelled: boolean;
  ineligibleStatus: MissionTask['status'] | null;
} {
  const txn = db.transaction(() => {
    const transitionKey = `continuation:${input.parentId}`;
    const knownChain = db.prepare('SELECT * FROM mission_chains WHERE id = ?').get(input.chainId) as
      MissionChain | undefined;
    if (knownChain?.status === 'cancelled') {
      return { id: '', duplicate: false, cancelled: true, ineligibleStatus: null };
    }

    // One linear continuation edge per parent, including pre-migration rows.
    const existing = db.prepare(
      `SELECT id FROM mission_tasks
       WHERE parent_task_id = ? AND role = 'continuation'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(input.parentId) as { id: string } | undefined;
    if (existing) return { id: existing.id, duplicate: true, cancelled: false, ineligibleStatus: null };

    const parent = db.prepare('SELECT status FROM mission_tasks WHERE id = ?').get(input.parentId) as
      { status: MissionTask['status'] } | undefined;
    if (!parent) throw new Error(`Mission parent disappeared: ${input.parentId}`);
    if (parent.status !== 'running') {
      return { id: '', duplicate: false, cancelled: false, ineligibleStatus: parent.status };
    }

    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT OR IGNORE INTO mission_chains (id, owner_agent, max_steps, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`,
    ).run(input.chainId, input.agent, input.limit, now);
    const chain = db.prepare('SELECT * FROM mission_chains WHERE id = ?').get(input.chainId) as MissionChain;
    if (chain.status === 'cancelled') {
      return { id: '', duplicate: false, cancelled: true, ineligibleStatus: null };
    }
    if (chain.owner_agent !== input.agent || chain.max_steps !== input.limit) {
      throw new Error(`Continuation chain ${input.chainId} metadata mismatch`);
    }
    const keyReplay = db.prepare('SELECT id FROM mission_tasks WHERE continuation_key = ?').get(input.key) as
      { id: string } | undefined;
    if (keyReplay) return { id: keyReplay.id, duplicate: true, cancelled: false, ineligibleStatus: null };
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO mission_tasks
        (id, title, prompt, assigned_agent, status, created_by, priority, created_at,
         parent_task_id, role, chain_id, continuation_step, continuation_limit, continuation_key,
         transition_key)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, 'continuation', ?, ?, ?, ?, ?)`,
    ).run(input.id, input.title, input.prompt, input.agent, input.agent, input.priority, now,
      input.parentId, input.chainId, input.step, input.limit, input.key, transitionKey);
    if (inserted.changes === 1) {
      return { id: input.id, duplicate: false, cancelled: false, ineligibleStatus: null };
    }
    const raced = db.prepare('SELECT id FROM mission_tasks WHERE transition_key = ?').get(transitionKey) as
      { id: string } | undefined;
    if (!raced) throw new Error(`Could not resolve canonical continuation for ${input.parentId}`);
    return { id: raced.id, duplicate: true, cancelled: false, ineligibleStatus: null };
  });
  return withBusyRetry(() => txn.immediate());
}

export function cancelMissionChain(chainId: string, ownerAgent: string): {
  found: boolean; alreadyCancelled: boolean; cancelledTasks: number;
} {
  return db.transaction(() => {
    const chain = db.prepare('SELECT * FROM mission_chains WHERE id = ?').get(chainId) as MissionChain | undefined;
    if (!chain || chain.owner_agent !== ownerAgent) {
      return { found: false, alreadyCancelled: false, cancelledTasks: 0 };
    }
    const now = Math.floor(Date.now() / 1000);
    const alreadyCancelled = chain.status === 'cancelled';
    if (!alreadyCancelled) {
      db.prepare(`UPDATE mission_chains SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(now, chainId);
    }
    const result = db.prepare(
      `UPDATE mission_tasks SET status = 'cancelled', completed_at = ?
       WHERE chain_id = ? AND role = 'continuation' AND status IN ('queued', 'waiting')`,
    ).run(now, chainId);
    return { found: true, alreadyCancelled, cancelledTasks: result.changes };
  })();
}

export function getMissionChain(id: string): MissionChain | null {
  return (db.prepare('SELECT * FROM mission_chains WHERE id = ?').get(id) as MissionChain) ?? null;
}

export function getUnassignedMissionTasks(): MissionTask[] {
  return db
    .prepare(
      `SELECT * FROM mission_tasks WHERE assigned_agent IS NULL AND status = 'queued'
       ORDER BY priority DESC, created_at ASC`,
    )
    .all() as MissionTask[];
}

export function getMissionTasks(agentId?: string, status?: string): MissionTask[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (agentId) {
    conditions.push('assigned_agent = ?');
    params.push(agentId);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
  return db
    .prepare(
      `SELECT * FROM mission_tasks${where}
       ORDER BY
         CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
         priority DESC, created_at DESC`,
    )
    .all(...params) as MissionTask[];
}

export function getMissionTask(id: string): MissionTask | null {
  return (db.prepare('SELECT * FROM mission_tasks WHERE id = ?').get(id) as MissionTask) ?? null;
}

// Synchronous sleep (better-sqlite3 is synchronous). Uses Atomics.wait so we
// block the thread without a busy spin.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Bounded retry around a synchronous DB write for SQLITE_BUSY. WAL + busy_timeout
// (db.ts init) cover most contention, but a lock UPGRADE inside a transaction can
// still return SQLITE_BUSY immediately without honoring busy_timeout — hence both
// the IMMEDIATE transactions below AND this retry as a backstop for pathological
// multi-writer bursts (see issue #155).
function withBusyRetry<T>(fn: () => T, attempts = 4): T {
  let delay = 40;
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      const busy = code === 'SQLITE_BUSY' || /database is locked/i.test((err as Error)?.message ?? '');
      if (!busy || i >= attempts - 1) throw err;
      sleepSync(delay);
      delay *= 2;
    }
  }
}

export interface MissionClaimFence {
  agentId: string;
  instanceId: string;
  generation: number;
}

function missionClaimMatches(task: MissionTask, fence?: MissionClaimFence): boolean {
  if (!task.claiming_instance_id) return fence === undefined;
  return Boolean(fence
    && task.assigned_agent === fence.agentId
    && task.claiming_instance_id === fence.instanceId
    && task.claim_generation === fence.generation
    && isWorkerLeaseCurrent(fence.agentId, fence.instanceId));
}

/** Recheck ownership immediately before a queued callback begins provider work. */
export function missionClaimIsCurrent(taskId: string, fence?: MissionClaimFence): boolean {
  const task = getMissionTask(taskId);
  return Boolean(task && task.status === 'running' && missionClaimMatches(task, fence));
}

export function claimNextMissionTask(agentId: string, workerInstanceId?: string): MissionTask | null {
  // IMMEDIATE so the write lock is taken up front — a DEFERRED transaction takes a
  // read lock on the SELECT then upgrades on the UPDATE, and SQLite returns
  // SQLITE_BUSY on the upgrade WITHOUT honoring busy_timeout (issue #155).
  const txn = db.transaction(() => {
    if (workerInstanceId && !isWorkerLeaseCurrent(agentId, workerInstanceId)) return null;
    const now = Math.floor(Date.now() / 1000);
    // One-running-per-agent guard: don't claim while this agent already has a task
    // executing. Tasks are marked 'running' at claim/enqueue time and execution is
    // serialized per chat by the message queue, so without this guard a later tick
    // claims a second task and the DB briefly shows 2 'running' (1 executing + 1
    // enqueued) — inflated concurrency (issue #155). Race-safe under the IMMEDIATE
    // transaction below; a stuck 'running' can't wedge the agent because
    // TASK_TIMEOUT_MS aborts+completes and resetStuckMissionTasks clears on boot.
    const running = db
      .prepare(
        `SELECT 1 FROM mission_tasks
         WHERE assigned_agent = ? AND status = 'running' AND workflow_id IS NULL LIMIT 1`,
      )
      .get(agentId);
    if (running) return null;
    const task = db
      .prepare(
      `SELECT * FROM mission_tasks
         WHERE assigned_agent = ? AND status = 'queued'
           AND (available_at IS NULL OR available_at <= ?)
           AND workflow_id IS NULL
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
      )
      .get(agentId, now) as MissionTask | undefined;
    if (!task) return null;
    const startedAt = now;
    const generation = task.claim_generation + 1;
    db.prepare(
      `UPDATE mission_tasks
       SET status = 'running', started_at = ?, claiming_instance_id = ?, claim_generation = ?
       WHERE id = ?`,
    ).run(startedAt, workerInstanceId ?? null, generation, task.id);
    return {
      ...task,
      status: 'running' as const,
      started_at: startedAt,
      claiming_instance_id: workerInstanceId ?? null,
      claim_generation: generation,
    };
  });
  return withBusyRetry(() => txn.immediate());
}

export interface WorkerRuntimeState {
  agent_id: string;
  desired_state: 'active' | 'inactive';
  instance_id: string | null;
  supervisor_epoch: string | null;
  pid: number | null;
  process_started_at: number | null;
  heartbeat_at: number | null;
  runtime_build_id: string | null;
  scope_started_at: number | null;
  scope_work_id: string | null;
}

const WORKER_LEASE_MAX_AGE_SEC = 45;

export function beginWorkerSupervisorEpoch(epoch: string, runtimeBuildId: string, expectedEpoch?: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  return db.transaction(() => {
    if (expectedEpoch !== undefined && getWorkerSupervisor()?.epoch !== expectedEpoch) return false;
    db.prepare(
      `INSERT INTO worker_supervisor (singleton_id, epoch, runtime_build_id, started_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         epoch = excluded.epoch,
         runtime_build_id = excluded.runtime_build_id,
         started_at = excluded.started_at`,
    ).run(epoch, runtimeBuildId, now);
    db.prepare(
      `UPDATE worker_runtime SET instance_id = NULL, supervisor_epoch = NULL,
       pid = NULL, process_started_at = NULL, heartbeat_at = NULL,
      runtime_build_id = NULL`,
    ).run();
    return true;
  })();
}

export function getWorkerSupervisor(): { epoch: string; runtime_build_id: string; started_at: number } | null {
  return (db.prepare(
    `SELECT epoch, runtime_build_id, started_at FROM worker_supervisor WHERE singleton_id = 1`,
  ).get() as { epoch: string; runtime_build_id: string; started_at: number } | undefined) ?? null;
}

export function ensureWorkerDesiredState(agentId: string, desired: 'active' | 'inactive'): void {
  db.prepare(
    `INSERT INTO worker_runtime (agent_id, desired_state) VALUES (?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       desired_state = excluded.desired_state,
       instance_id = CASE WHEN excluded.desired_state = 'inactive' THEN NULL ELSE worker_runtime.instance_id END,
       supervisor_epoch = CASE WHEN excluded.desired_state = 'inactive' THEN NULL ELSE worker_runtime.supervisor_epoch END,
       pid = CASE WHEN excluded.desired_state = 'inactive' THEN NULL ELSE worker_runtime.pid END,
       process_started_at = CASE WHEN excluded.desired_state = 'inactive' THEN NULL ELSE worker_runtime.process_started_at END,
       heartbeat_at = CASE WHEN excluded.desired_state = 'inactive' THEN NULL ELSE worker_runtime.heartbeat_at END,
       runtime_build_id = CASE WHEN excluded.desired_state = 'inactive' THEN NULL ELSE worker_runtime.runtime_build_id END,
       scope_started_at = CASE
         WHEN worker_runtime.desired_state = 'inactive' AND excluded.desired_state = 'active' THEN NULL
         ELSE worker_runtime.scope_started_at
       END,
       scope_work_id = CASE
         WHEN worker_runtime.desired_state = 'inactive' AND excluded.desired_state = 'active' THEN NULL
         ELSE worker_runtime.scope_work_id
       END`,
  ).run(agentId, desired);
}

export function getWorkerRuntime(agentId: string): WorkerRuntimeState | null {
  return (db.prepare(`SELECT * FROM worker_runtime WHERE agent_id = ?`).get(agentId) as WorkerRuntimeState | undefined) ?? null;
}

export function listWorkerRuntime(): WorkerRuntimeState[] {
  return db.prepare(`SELECT * FROM worker_runtime ORDER BY agent_id`).all() as WorkerRuntimeState[];
}

export function deleteWorkerRuntime(agentId: string): void {
  db.prepare(`DELETE FROM worker_runtime WHERE agent_id = ?`).run(agentId);
}

export function acquireWorkerLease(input: {
  agentId: string;
  instanceId: string;
  supervisorEpoch: string;
  pid: number;
  processStartedAt: number;
  runtimeBuildId: string;
}): boolean {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `UPDATE worker_runtime
     SET instance_id = ?, supervisor_epoch = ?, pid = ?, process_started_at = ?,
         heartbeat_at = ?, runtime_build_id = ?
     WHERE agent_id = ? AND desired_state = 'active' AND instance_id IS NULL
       AND ? = (SELECT epoch FROM worker_supervisor WHERE singleton_id = 1)
       AND ? = (SELECT runtime_build_id FROM worker_supervisor WHERE singleton_id = 1)`,
  ).run(
    input.instanceId,
    input.supervisorEpoch,
    input.pid,
    input.processStartedAt,
    now,
    input.runtimeBuildId,
    input.agentId,
    input.supervisorEpoch,
    input.runtimeBuildId,
  );
  return result.changes === 1;
}

export function heartbeatWorkerLease(agentId: string, instanceId: string): boolean {
  const result = db.prepare(
    `UPDATE worker_runtime SET heartbeat_at = ?
     WHERE agent_id = ? AND instance_id = ? AND desired_state = 'active'
       AND supervisor_epoch = (SELECT epoch FROM worker_supervisor WHERE singleton_id = 1)`,
  ).run(Math.floor(Date.now() / 1000), agentId, instanceId);
  return result.changes === 1;
}

export function releaseWorkerLease(agentId: string, instanceId: string): void {
  db.prepare(
    `UPDATE worker_runtime SET instance_id = NULL, supervisor_epoch = NULL,
       pid = NULL, process_started_at = NULL, heartbeat_at = NULL,
       runtime_build_id = NULL WHERE agent_id = ? AND instance_id = ?`,
  ).run(agentId, instanceId);
}

export interface AgentDeletionBlockers {
  open_missions: number;
  retained_schedules: number;
}

/**
 * Return durable responsibilities that would be orphaned if an agent were
 * deleted. A mission created by the agent also counts because its gather or
 * handback still routes through that creator.
 */
export function getAgentDeletionBlockers(agentId: string): AgentDeletionBlockers {
  const openMissions = db.prepare(
    `SELECT COUNT(*) AS count FROM mission_tasks
     WHERE (assigned_agent = ? OR created_by = ?)
       AND status NOT IN ('completed', 'failed', 'cancelled')`,
  ).get(agentId, agentId) as { count: number };
  const retainedSchedules = db.prepare(
    `SELECT COUNT(*) AS count FROM scheduled_tasks
     WHERE agent_id = ? AND status IN ('active', 'running', 'paused')`,
  ).get(agentId) as { count: number };
  return {
    open_missions: openMissions.count,
    retained_schedules: retainedSchedules.count,
  };
}

export function isWorkerLeaseCurrent(agentId: string, instanceId: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const row = db.prepare(
    `SELECT 1 FROM worker_runtime wr
     JOIN worker_supervisor ws ON ws.singleton_id = 1
     WHERE wr.agent_id = ? AND wr.instance_id = ? AND wr.desired_state = 'active'
       AND wr.supervisor_epoch = ws.epoch
       AND wr.runtime_build_id = ws.runtime_build_id
       AND wr.heartbeat_at >= ?`,
  ).get(agentId, instanceId, nowSec - WORKER_LEASE_MAX_AGE_SEC);
  return Boolean(row);
}

/** Persist the first unit of work handled by a task-scoped worker instance. */
export function markWorkerTaskScopeStarted(agentId: string, instanceId: string, workId: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `UPDATE worker_runtime
     SET scope_started_at = COALESCE(scope_started_at, ?),
         scope_work_id = COALESCE(scope_work_id, ?)
     WHERE agent_id = ? AND instance_id = ? AND desired_state = 'active'
       AND supervisor_epoch = (SELECT epoch FROM worker_supervisor WHERE singleton_id = 1)
       AND runtime_build_id = (SELECT runtime_build_id FROM worker_supervisor WHERE singleton_id = 1)`,
  ).run(now, workId, agentId, instanceId);
  return result.changes === 1;
}

/**
 * Atomically deactivate an armed task-scoped worker only after its work has
 * drained. Work includes missions assigned to the worker, missions it created
 * for other agents (including gathers/handbacks), and any retained schedule.
 * The IMMEDIATE transaction prevents a concurrent mission creation from
 * landing between the empty check and desired-state transition.
 */
export function deactivateWorkerIfTaskScopeDrained(agentId: string, instanceId: string): boolean {
  const txn = db.transaction(() => {
    const runtime = db.prepare(
      `SELECT scope_started_at FROM worker_runtime
       WHERE agent_id = ? AND instance_id = ? AND desired_state = 'active'`,
    ).get(agentId, instanceId) as { scope_started_at: number | null } | undefined;
    if (!runtime?.scope_started_at || !isWorkerLeaseCurrent(agentId, instanceId)) return false;

    const blockers = getAgentDeletionBlockers(agentId);
    if (blockers.open_missions > 0 || blockers.retained_schedules > 0) return false;

    const result = db.prepare(
      `UPDATE worker_runtime SET desired_state = 'inactive'
       WHERE agent_id = ? AND instance_id = ? AND desired_state = 'active'`,
    ).run(agentId, instanceId);
    return result.changes === 1;
  });
  return withBusyRetry(() => txn.immediate());
}

export function completeMissionTask(
  id: string,
  result: string | null,
  status: 'completed' | 'failed',
  error?: string,
  fence?: MissionClaimFence,
): boolean {
  const outputPolicy = outboundOptionsForSeam('mission.result');
  if (result !== null) result = sanitizeOutboundText(result, outputPolicy);
  if (error !== undefined) error = sanitizeOutboundText(error, outputPolicy);
  // Retry so a completion write never loses the lock race and leaves the task
  // stuck in 'running' with no completed_at (issue #155).
  return withBusyRetry(() => db.transaction(() => {
    const task = getMissionTask(id);
    if (!task || task.status !== 'running' || !missionClaimMatches(task, fence)) return false;
    const now = Math.floor(Date.now() / 1000);
    const changed = db.prepare(
      `UPDATE mission_tasks
       SET status = ?, result = ?, error = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(status, result, error ?? null, now, id).changes === 1;
    // A process can exit immediately after this commit. Release an ordinary
    // gather's eligible join in the same transaction so its result cannot be
    // durable while the join remains stranded waiting for a scheduler callback.
    if (changed && !task.workflow_id) maybeReleaseJoinForMission(task);
    return changed;
  }).immediate());
}

export function cancelMissionTask(id: string): boolean {
  return withBusyRetry(() => db.transaction(() => {
    const result = db.prepare(
      `UPDATE mission_tasks SET status = 'cancelled', completed_at = ?
       WHERE id = ? AND status IN ('queued', 'waiting', 'running')`,
    ).run(Math.floor(Date.now() / 1000), id);
    if (result.changes > 0) {
      // Cancellation and eligible join release share the commit boundary.
      const task = getMissionTask(id);
      // Historical Crew rows are quarantined records, not ordinary gather work.
      if (task && !task.workflow_id) maybeReleaseJoinForMission(task);
    }
    return result.changes > 0;
  }).immediate());
}

/**
 * Tier 3 gather/join: when a group-tagged 'task' mission reaches a terminal
 * status, check whether every sibling in its group is now terminal too. If
 * so, assemble the children's results into the parked 'waiting' join
 * mission's prompt and atomically release it (waiting -> queued). Defensive:
 * a non-grouped mission, or a group with no join mission, is a no-op.
 */
export function maybeReleaseJoinForMission(mission: MissionTask): void {
  if (!mission.group_id || mission.role !== 'task') return;
  const groupId = mission.group_id;
  const release = db.transaction((): { released: boolean; joinId?: string; missingJoin?: boolean } => {
    const children = getGroupChildren(groupId);
    if (children.length === 0 || children.some((c) => !['completed', 'failed', 'cancelled'].includes(c.status))) {
      return { released: false };
    }

    const join = getJoinMission(groupId);
    if (!join) return { released: false, missingJoin: true };
    if (!releaseJoinMission(groupId)) return { released: false };

    const assembled = children
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => {
        const output = c.status === 'cancelled'
          ? '(cancelled)'
          : c.result ?? c.error ?? '(no output)';
        return `=== ${c.title} (@${c.assigned_agent ?? 'unassigned'}) ===\n${output}`;
      })
      .join('\n\n');
    updateMissionPrompt(join.id, `${join.prompt}\n\n--- Collected results ---\n${assembled}`);
    return { released: true, joinId: join.id };
  });
  const outcome = withBusyRetry(() => release.immediate());

  if (outcome.missingJoin) {
    logger.warn({ groupId }, 'Gather group has no join mission to release');
    return;
  }
  const released = outcome.released;
  if (released) {
    logger.info({ groupId, joinId: outcome.joinId }, 'Released join mission for gather group');
  }
}

export function deleteMissionTask(id: string): boolean {
  const result = db.prepare(
    `DELETE FROM mission_tasks WHERE id = ? AND status IN ('completed', 'cancelled', 'failed')`,
  ).run(id);
  return result.changes > 0;
}

export function cleanupOldMissionTasks(olderThanDays = 7): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const result = db.prepare(
    `DELETE FROM mission_tasks
     WHERE status IN ('completed', 'cancelled', 'failed')
       AND completed_at < ?
       AND workflow_id IS NULL`,
  ).run(cutoff);
  return result.changes;
}

export function reassignMissionTask(id: string, newAgent: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET assigned_agent = ? WHERE id = ? AND status = 'queued'`,
  ).run(newAgent, id);
  return result.changes > 0;
}

export function assignMissionTask(id: string, agent: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET assigned_agent = ? WHERE id = ? AND assigned_agent IS NULL AND status = 'queued'`,
  ).run(agent, id);
  return result.changes > 0;
}

export function getMissionTaskHistory(limit = 30, offset = 0): { tasks: MissionTask[]; total: number } {
  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM mission_tasks WHERE status IN ('completed', 'failed', 'cancelled')`,
  ).get() as { c: number }).c;
  const tasks = db.prepare(
    `SELECT * FROM mission_tasks WHERE status IN ('completed', 'failed', 'cancelled')
     ORDER BY completed_at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset) as MissionTask[];
  return { tasks, total };
}

/**
 * Fail an interrupted assignment without replaying work whose external effects
 * are unknown. A current headless lease still owns its claim and is left alone.
 * Any queued continuation already emitted by the interrupted parent is stopped
 * with the chain so it cannot advance after an ambiguous result.
 */
function failInterruptedMission(taskId: string, agentId: string, error: string): boolean {
  const failedTask = withBusyRetry(() => db.transaction((): MissionTask | null => {
    const task = getMissionTask(taskId);
    if (
      !task
      || task.status !== 'running'
      || task.assigned_agent !== agentId
      || task.workflow_id !== null
    ) return null;
    if (task.claiming_instance_id && isWorkerLeaseCurrent(agentId, task.claiming_instance_id)) return null;

    const now = Math.floor(Date.now() / 1000);
    const settled = db.prepare(
      `UPDATE mission_tasks
       SET status = 'failed', result = NULL, error = ?, completed_at = ?, claiming_instance_id = NULL
       WHERE id = ? AND status = 'running'`,
    ).run(error, now, taskId);
    if (settled.changes !== 1) return null;

    // A root does not carry chain_id; its first continuation does. Looking at
    // both the task and its direct child covers every point in a linear chain.
    const chains = db.prepare(
      `SELECT DISTINCT chain_id FROM mission_tasks
       WHERE chain_id IS NOT NULL AND (id = ? OR parent_task_id = ?)`,
    ).all(taskId, taskId) as Array<{ chain_id: string }>;
    for (const { chain_id: chainId } of chains) {
      db.prepare(
        `UPDATE mission_chains SET status = 'cancelled', cancelled_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(now, chainId);
      db.prepare(
        `UPDATE mission_tasks SET status = 'cancelled', completed_at = ?
         WHERE chain_id = ? AND status IN ('queued', 'waiting')`,
      ).run(now, chainId);
    }
    // Keep recovery and join release atomic just like ordinary completion.
    maybeReleaseJoinForMission(task);
    return { ...task, status: 'failed', result: null, error, completed_at: now, claiming_instance_id: null };
  }).immediate());
  return failedTask !== null;
}

export function resetStuckMissionTasks(agentId: string): number {
  const tasks = db.prepare(
    `SELECT id FROM mission_tasks
     WHERE status = 'running' AND assigned_agent = ? AND workflow_id IS NULL`,
  ).all(agentId) as Array<{ id: string }>;
  let changed = 0;
  for (const task of tasks) {
    if (failInterruptedMission(
      task.id,
      agentId,
      'Process interrupted; execution unknown. Inspect side effects before any retry.',
    )) changed++;
  }
  return changed;
}

export function failStuckMissionTasks(agentId: string, error: string): number {
  const tasks = db.prepare(
    `SELECT id FROM mission_tasks
     WHERE status = 'running' AND assigned_agent = ? AND workflow_id IS NULL`,
  ).all(agentId) as Array<{ id: string }>;
  let changed = 0;
  for (const task of tasks) {
    if (failInterruptedMission(task.id, agentId, error)) changed++;
  }
  return changed;
}

// ── Gather / join primitive (Tier 3) ────────────────────────────────

/** All 'task'-role children of a fan-out group. */
export function getGroupChildren(groupId: string): MissionTask[] {
  return db
    .prepare(`SELECT * FROM mission_tasks WHERE group_id = ? AND role = 'task'`)
    .all(groupId) as MissionTask[];
}

/** True if every 'task'-role child of the group has reached a terminal status. */
export function areAllGroupChildrenTerminal(groupId: string): boolean {
  const children = getGroupChildren(groupId);
  if (children.length === 0) return false;
  return children.every((c) => c.status === 'completed' || c.status === 'failed' || c.status === 'cancelled');
}

/**
 * Atomically release a group's parked join mission ('waiting' -> 'queued').
 * Only the caller that observes changes()===1 owns the release; a second
 * concurrent call (e.g. two children finishing near-simultaneously) sees
 * changes()===0 and must not act again. This is the race guard.
 */
export function releaseJoinMission(groupId: string): boolean {
  const result = db.prepare(
    `UPDATE mission_tasks SET status = 'queued' WHERE group_id = ? AND role = 'join' AND status = 'waiting'`,
  ).run(groupId);
  return result.changes === 1;
}

/** The 'join'-role mission for a group, if any. */
export function getJoinMission(groupId: string): MissionTask | null {
  return (
    (db.prepare(`SELECT * FROM mission_tasks WHERE group_id = ? AND role = 'join'`).get(groupId) as MissionTask) ??
    null
  );
}

/** Overwrite a mission's prompt (used to inject assembled child results before releasing a join). */
export function updateMissionPrompt(id: string, prompt: string): void {
  db.prepare(`UPDATE mission_tasks SET prompt = ? WHERE id = ?`).run(prompt, id);
}

// ── Meet Sessions (Pika video meeting skill) ────────────────────────

export type MeetProvider = 'pika' | 'recall' | 'daily';

export interface MeetSession {
  id: string;
  agent_id: string;
  meet_url: string;
  bot_name: string;
  platform: string;
  provider: MeetProvider;
  status: 'joining' | 'live' | 'left' | 'failed';
  voice_id: string | null;
  image_path: string | null;
  brief_path: string | null;
  created_at: number;
  joined_at: number | null;
  left_at: number | null;
  post_notes: string | null;
  error: string | null;
}

export function createMeetSession(session: {
  id: string;
  agentId: string;
  meetUrl: string;
  botName: string;
  platform?: string;
  provider?: MeetProvider;
  voiceId?: string | null;
  imagePath?: string | null;
  briefPath?: string | null;
}): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO meet_sessions (id, agent_id, meet_url, bot_name, platform, provider, status, voice_id, image_path, brief_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'joining', ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.agentId,
    session.meetUrl,
    session.botName,
    session.platform ?? 'google_meet',
    session.provider ?? 'pika',
    session.voiceId ?? null,
    session.imagePath ?? null,
    session.briefPath ?? null,
    now,
  );
}

export function markMeetSessionLive(id: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'live', joined_at = ? WHERE id = ?`,
  ).run(now, id);
}

export function markMeetSessionLeft(id: string, postNotes?: string | null): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'left', left_at = ?, post_notes = ? WHERE id = ?`,
  ).run(now, postNotes ?? null, id);
}

export function markMeetSessionFailed(id: string, error: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE meet_sessions SET status = 'failed', left_at = ?, error = ? WHERE id = ?`,
  ).run(now, error.slice(0, 2000), id);
}

export function getMeetSession(id: string): MeetSession | null {
  return (db.prepare('SELECT * FROM meet_sessions WHERE id = ?').get(id) as MeetSession) ?? null;
}

export function listActiveMeetSessions(): MeetSession[] {
  return db.prepare(
    `SELECT * FROM meet_sessions WHERE status IN ('joining', 'live') ORDER BY created_at DESC`,
  ).all() as MeetSession[];
}

export function listRecentMeetSessions(limit = 20): MeetSession[] {
  return db.prepare(
    `SELECT * FROM meet_sessions ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as MeetSession[];
}

// ── Audit Log ────────────────────────────────────────────────────────

export function insertAuditLog(
  agentId: string,
  chatId: string,
  action: string,
  detail: string,
  blocked: boolean,
): void {
  db.prepare(
    `INSERT INTO audit_log (agent_id, chat_id, action, detail, blocked, created_at) VALUES (?, ?, ?, ?, ?, strftime('%s','now'))`,
  ).run(agentId, chatId, action, detail.slice(0, 2000), blocked ? 1 : 0);
}

export interface AuditLogEntry {
  id: number;
  agent_id: string;
  chat_id: string;
  action: string;
  detail: string;
  blocked: number;
  created_at: number;
}

export function getAuditLog(limit = 50, offset = 0, agentId?: string): AuditLogEntry[] {
  if (agentId) {
    return db.prepare(
      `SELECT * FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(agentId, limit, offset) as AuditLogEntry[];
  }
  return db.prepare(
    `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(limit, offset) as AuditLogEntry[];
}

export function getAuditLogCount(agentId?: string): number {
  if (agentId) {
    return (db.prepare('SELECT COUNT(*) as c FROM audit_log WHERE agent_id = ?').get(agentId) as { c: number }).c;
  }
  return (db.prepare('SELECT COUNT(*) as c FROM audit_log').get() as { c: number }).c;
}

export function getRecentBlockedActions(limit = 10): AuditLogEntry[] {
  return db.prepare(
    `SELECT * FROM audit_log WHERE blocked = 1 ORDER BY created_at DESC LIMIT ?`,
  ).all(limit) as AuditLogEntry[];
}

// ── Phase 2: Compaction events ────────────────────────────────────────

export function saveCompactionEvent(
  sessionId: string,
  preTokens: number,
  postTokens: number,
  turnCount: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO compaction_events (session_id, pre_tokens, post_tokens, turn_count, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, preTokens, postTokens, turnCount, now);
}

export function getCompactionCount(sessionId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) as c FROM compaction_events WHERE session_id = ?',
  ).get(sessionId) as { c: number }).c;
}

export function getCompactionHistory(sessionId: string): Array<{
  id: number; session_id: string; pre_tokens: number; post_tokens: number;
  turn_count: number; created_at: number;
}> {
  return db.prepare(
    'SELECT * FROM compaction_events WHERE session_id = ? ORDER BY created_at DESC',
  ).all(sessionId) as Array<{
    id: number; session_id: string; pre_tokens: number; post_tokens: number;
    turn_count: number; created_at: number;
  }>;
}

// ── Phase 2: Session stats for /convolife ──────────────────────────────

export function getSessionStats(sessionId: string): {
  turnCount: number;
  totalCost: number;
  compactionCount: number;
  maxContextTokens: number;
} {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as turnCount,
      COALESCE(SUM(CASE WHEN cost_source = 'provider' THEN cost_usd ELSE 0 END), 0) as totalCost,
      COALESCE(SUM(did_compact), 0) as compactionCount,
      COALESCE(MAX(context_tokens), 0) as maxContextTokens
    FROM token_usage WHERE session_id = ?
  `).get(sessionId) as {
    turnCount: number; totalCost: number;
    compactionCount: number; maxContextTokens: number;
  } | undefined;

  return stats ?? { turnCount: 0, totalCost: 0, compactionCount: 0, maxContextTokens: 0 };
}

// ── Phase 2: Memory nudge support ──────────────────────────────────────

export function getLastMemorySaveTime(chatId: string, agentId = 'main'): number | null {
  const row = db.prepare(
    'SELECT created_at FROM memories WHERE chat_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(chatId, agentId) as { created_at: number } | undefined;
  return row?.created_at ?? null;
}

export function getTurnCountSinceTimestamp(chatId: string, sinceTimestamp: number, agentId = 'main'): number {
  const row = db.prepare(
    'SELECT COUNT(*) as c FROM conversation_log WHERE chat_id = ? AND agent_id = ? AND role = ? AND created_at > ?',
  ).get(chatId, agentId, 'user', sinceTimestamp) as { c: number };
  return row.c;
}

// ── Phase 4: Skill health & usage ────────────────────────────────────

export function upsertSkillHealth(
  skillId: string,
  status: string,
  errorMsg = '',
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO skill_health (skill_id, status, error_msg, last_check, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET status = ?, error_msg = ?, last_check = ?
  `).run(skillId, status, errorMsg, now, now, status, errorMsg, now);
}

export function getSkillHealth(skillId: string): { status: string; error_msg: string; last_check: number } | undefined {
  return db.prepare('SELECT status, error_msg, last_check FROM skill_health WHERE skill_id = ?')
    .get(skillId) as { status: string; error_msg: string; last_check: number } | undefined;
}

export function getAllSkillHealth(): Array<{ skill_id: string; status: string; error_msg: string; last_check: number }> {
  return db.prepare('SELECT * FROM skill_health ORDER BY skill_id').all() as Array<{
    skill_id: string; status: string; error_msg: string; last_check: number;
  }>;
}

export function logSkillUsage(
  skillId: string,
  chatId: string,
  agentId: string,
  tokensUsed: number,
  succeeded: boolean,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO skill_usage (skill_id, chat_id, agent_id, triggered_at, tokens_used, succeeded)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(skillId, chatId, agentId, now, tokensUsed, succeeded ? 1 : 0);
}

export function getSkillUsageStats(): Array<{
  skill_id: string; count: number; last_used: number; total_tokens: number;
}> {
  return db.prepare(`
    SELECT skill_id,
           COUNT(*) as count,
           MAX(triggered_at) as last_used,
           SUM(tokens_used) as total_tokens
    FROM skill_usage
    GROUP BY skill_id
    ORDER BY count DESC
  `).all() as Array<{
    skill_id: string; count: number; last_used: number; total_tokens: number;
  }>;
}

// ── Phase 6: Session summaries ────────────────────────────────────────

export function saveSessionSummary(
  sessionId: string,
  summary: string,
  keyDecisions: string[],
  turnCount: number,
  totalCost: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO session_summaries (session_id, summary, key_decisions, turn_count, total_cost, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET summary = ?, key_decisions = ?, turn_count = ?, total_cost = ?, created_at = ?
  `).run(sessionId, summary, JSON.stringify(keyDecisions), turnCount, totalCost, now,
    summary, JSON.stringify(keyDecisions), turnCount, totalCost, now);
}

export function getSessionSummary(sessionId: string): {
  summary: string; key_decisions: string; turn_count: number; total_cost: number;
} | undefined {
  return db.prepare('SELECT summary, key_decisions, turn_count, total_cost FROM session_summaries WHERE session_id = ?')
    .get(sessionId) as { summary: string; key_decisions: string; turn_count: number; total_cost: number } | undefined;
}

// ── War Room meeting history ─────────────────────────────────────────────

export function createWarRoomMeeting(id: string, mode: string, pinnedAgent: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO warroom_meetings (id, started_at, mode, pinned_agent) VALUES (?, ?, ?, ?)',
  ).run(id, Math.floor(Date.now() / 1000), mode, pinnedAgent);
}

export function endWarRoomMeeting(id: string, entryCount: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE warroom_meetings SET ended_at = ?, duration_s = ? - started_at, entry_count = ? WHERE id = ?',
  ).run(now, now, entryCount, id);
}

export function addWarRoomTranscript(
  meetingId: string,
  speaker: string,
  text: string,
): { id: number; created_at: number } {
  const created_at = Math.floor(Date.now() / 1000);
  const safeText = sanitizeOutboundText(text, outboundOptionsForSeam('warroom.transcript'));
  const info = db.prepare(
    'INSERT INTO warroom_transcript (meeting_id, speaker, text, created_at) VALUES (?, ?, ?, ?)',
  ).run(meetingId, speaker, safeText, created_at);
  return { id: Number(info.lastInsertRowid), created_at };
}

// Voice-only history. Text meetings live in the same table (with
// meeting_type = 'text') and have their own /warroom/text picker — they
// must not leak into the voice meeting list.
export function getWarRoomMeetings(limit = 20): Array<{
  id: string; started_at: number; ended_at: number | null; duration_s: number | null;
  mode: string; pinned_agent: string; entry_count: number;
}> {
  return db.prepare(
    `SELECT * FROM warroom_meetings
      WHERE meeting_type IS NULL OR meeting_type = 'voice'
      ORDER BY started_at DESC LIMIT ?`,
  ).all(limit) as any[];
}

export function getWarRoomTranscript(
  meetingId: string,
  opts: { limit?: number; beforeTs?: number; beforeId?: number } = {},
): Array<{
  id: number; speaker: string; text: string; created_at: number;
}> {
  const { limit, beforeTs, beforeId } = opts;
  // When limit is omitted, preserve the legacy "return everything ASC"
  // behavior for the voice War Room caller in dashboard.ts.
  if (limit === undefined && beforeTs === undefined && beforeId === undefined) {
    return db.prepare(
      'SELECT id, speaker, text, created_at FROM warroom_transcript WHERE meeting_id = ? ORDER BY created_at, id',
    ).all(meetingId) as any[];
  }
  // Paginated path: composite cursor on (created_at, id) so multiple rows
  // with the same created_at second don't get skipped. Callers pass
  // beforeTs+beforeId (the oldest already-loaded row's values); we return
  // rows strictly older than that cursor, newest-first, and the caller
  // reverses for display order.
  const cap = Math.max(1, Math.min(1000, limit ?? 200));
  if (beforeTs !== undefined) {
    const bId = beforeId ?? Number.MAX_SAFE_INTEGER;
    return db.prepare(
      `SELECT id, speaker, text, created_at
         FROM warroom_transcript
        WHERE meeting_id = ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).all(meetingId, beforeTs, beforeTs, bId, cap) as any[];
  }
  return db.prepare(
    'SELECT id, speaker, text, created_at FROM warroom_transcript WHERE meeting_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(meetingId, cap) as any[];
}

// ── War Room hive-mind bridges ───────────────────────────────────────

/** Persist a war-room turn to conversation_log atomically and idempotently.
 *  - User row written ONCE per turn (singleton via partial unique index).
 *  - One assistant row per agent (per-agent unique via index).
 *  - On retry, INSERT OR IGNORE detects existing rows; only fresh inserts
 *    are reported back, so the caller can gate memory ingestion on the
 *    assistant row being NEW (not a no-op replay).
 *  - chatId === '' (legacy meetings) → caller should skip this entirely.
 */
export function saveWarRoomConversationTurn(args: {
  chatId: string;
  agentId: string;
  originalUserText: string;
  agentReply: string;
  meetingId: string;
  turnId: string;
}): { userInserted: boolean; assistantInserted: boolean } {
  const { chatId, agentId, originalUserText, agentReply, meetingId, turnId } = args;
  if (!meetingId || !turnId) {
    throw new Error('saveWarRoomConversationTurn: meetingId and turnId required');
  }
  const safeAgentReply = sanitizeOutboundText(
    agentReply,
    outboundOptionsForSeam('warroom.conversation'),
  );
  const now = Math.floor(Date.now() / 1000);
  const userStmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_log
       (chat_id, session_id, role, content, created_at, agent_id, source, source_meeting_id, source_turn_id)
     VALUES (?, NULL, 'user', ?, ?, ?, 'warroom-text', ?, ?)`,
  );
  const asstStmt = db.prepare(
    `INSERT OR IGNORE INTO conversation_log
       (chat_id, session_id, role, content, created_at, agent_id, source, source_meeting_id, source_turn_id)
     VALUES (?, NULL, 'assistant', ?, ?, ?, 'warroom-text', ?, ?)`,
  );
  const txn = db.transaction(() => {
    const u = userStmt.run(chatId, originalUserText, now, agentId, meetingId, turnId);
    const a = asstStmt.run(chatId, safeAgentReply, now, agentId, meetingId, turnId);
    return {
      userInserted: u.changes > 0,
      assistantInserted: a.changes > 0,
    };
  });
  return txn();
}

/** Bounded mission lookup. Existing getMissionTasks is unbounded; this
 *  variant takes a sinceTs cutoff and a hard limit so /standup never
 *  pulls a runaway result set. */
export function getRecentMissionTasks(
  agentId: string,
  status: string | undefined,
  sinceTs: number,
  limit = 10,
): MissionTask[] {
  const conds: string[] = ['assigned_agent = ?', 'created_at >= ?'];
  const params: unknown[] = [agentId, sinceTs];
  if (status) { conds.push('status = ?'); params.push(status); }
  params.push(limit);
  return db
    .prepare(
      `SELECT * FROM mission_tasks WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as MissionTask[];
}

/** Last N war-room transcript rows for a chat across all its meetings,
 *  optionally excluding the meeting that's currently building context.
 *  Used by buildMemoryContext to bridge war room → Telegram so a Telegram
 *  follow-up can cite what was said earlier in a war room. */
export function getRecentWarRoomTranscriptForChat(
  chatId: string,
  opts: { limit?: number; sinceTs?: number; excludeMeetingId?: string } = {},
): Array<{ id: number; meeting_id: string; speaker: string; text: string; created_at: number }> {
  const { limit = 10, sinceTs, excludeMeetingId } = opts;
  const conds: string[] = ['m.meeting_type = ?', 'm.chat_id = ?'];
  const params: unknown[] = ['text', chatId];
  if (sinceTs !== undefined) { conds.push('t.created_at >= ?'); params.push(sinceTs); }
  if (excludeMeetingId) { conds.push('t.meeting_id != ?'); params.push(excludeMeetingId); }
  params.push(limit);
  return db
    .prepare(
      `SELECT t.id, t.meeting_id, t.speaker, t.text, t.created_at
         FROM warroom_transcript t
         JOIN warroom_meetings m ON m.id = t.meeting_id
        WHERE ${conds.join(' AND ')}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ?`,
    )
    .all(...params) as Array<{ id: number; meeting_id: string; speaker: string; text: string; created_at: number }>;
}

// ── Text War Room helpers ────────────────────────────────────────────
// Kept separate from createWarRoomMeeting so the text path can't accidentally
// inherit the voice default of pinned_agent='main'. A text meeting starts
// with NO pinned agent so the router is allowed to pick primary.

export function createTextMeeting(id: string, chatId = ''): void {
  db.prepare(
    `INSERT OR IGNORE INTO warroom_meetings
       (id, started_at, mode, pinned_agent, meeting_type, chat_id)
     VALUES (?, ?, 'direct', NULL, 'text', ?)`,
  ).run(id, Math.floor(Date.now() / 1000), chatId);
}

export function getTextMeeting(id: string): {
  id: string; started_at: number; ended_at: number | null; duration_s: number | null;
  mode: string; pinned_agent: string | null; entry_count: number; meeting_type: string;
  chat_id: string;
} | null {
  const row = db.prepare(
    `SELECT id, started_at, ended_at, duration_s, mode, pinned_agent, entry_count, meeting_type, chat_id
       FROM warroom_meetings WHERE id = ? AND meeting_type = 'text'`,
  ).get(id) as any;
  return row ?? null;
}

export function setMeetingPin(meetingId: string, agentId: string | null): void {
  db.prepare(
    `UPDATE warroom_meetings SET pinned_agent = ? WHERE id = ? AND meeting_type = 'text'`,
  ).run(agentId, meetingId);
}

/** Returns ids of every still-open text meeting except the optional
 *  exclusion. Optionally scope by chat_id so creating a new meeting in
 *  chat A does not auto-end open meetings belonging to chat B. The
 *  dashboard uses this to force-end stale meetings when the user creates
 *  a new one (refresh = clean slate within the same chat). */
export function getOpenTextMeetingIds(exceptId?: string, chatId?: string): string[] {
  const conds: string[] = [`meeting_type = 'text'`, `ended_at IS NULL`];
  const params: unknown[] = [];
  if (exceptId) { conds.push('id != ?'); params.push(exceptId); }
  if (chatId !== undefined) { conds.push('chat_id = ?'); params.push(chatId); }
  const rows = db.prepare(
    `SELECT id FROM warroom_meetings WHERE ${conds.join(' AND ')}`,
  ).all(...params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Recent text meetings, newest first. Includes a short preview of the
 *  first user message so the picker can show a recognizable label.
 *  Optionally scope by chat_id so the picker only shows meetings for the
 *  current chat. Pass chatId='' to see legacy/unscoped meetings; omit
 *  to include everything (admin/debug). */
export function getTextMeetings(limit = 20, chatId?: string): Array<{
  id: string;
  started_at: number;
  ended_at: number | null;
  entry_count: number;
  preview: string;
}> {
  const params: unknown[] = [];
  let where = `meeting_type = 'text'`;
  if (chatId !== undefined) { where += ` AND chat_id = ?`; params.push(chatId); }
  params.push(limit);
  const rows = db.prepare(
    `SELECT id, started_at, ended_at, entry_count
       FROM warroom_meetings
      WHERE ${where}
      ORDER BY started_at DESC
      LIMIT ?`,
  ).all(...params) as Array<{ id: string; started_at: number; ended_at: number | null; entry_count: number }>;
  if (rows.length === 0) return [];
  const previewStmt = db.prepare(
    `SELECT text FROM warroom_transcript
      WHERE meeting_id = ? AND speaker = 'user'
      ORDER BY created_at, id LIMIT 1`,
  );
  return rows.map((r) => {
    const p = previewStmt.get(r.id) as { text: string } | undefined;
    const preview = (p?.text ?? '').slice(0, 140);
    return { ...r, preview };
  });
}

export function clearMeetingSessions(meetingId: string, agentIds: string[]): number {
  if (agentIds.length === 0) return 0;
  const chatId = `warroom-text:${meetingId}`;
  const placeholders = agentIds.map(() => '?').join(',');
  const info = db.prepare(
    `DELETE FROM sessions WHERE chat_id = ? AND agent_id IN (${placeholders})`,
  ).run(chatId, ...agentIds);
  return info.changes;
}

// ── Client message dedup (in-memory LRU) ─────────────────────────────
// Sized for 10k concurrent conversations with rapid resends. 24h TTL means
// a user that retries a message a day later gets re-processed (acceptable).
// Not persisted across bot restarts — worst case a retry after restart
// double-processes; acceptable tradeoff vs a DB table for something this
// ephemeral.

const CLIENT_MSG_TTL_MS = 24 * 60 * 60 * 1000;
const CLIENT_MSG_MAX_ENTRIES = 10_000;
const _clientMsgSeen = new Map<string, number>(); // id -> expires_at

export function rememberClientMsgId(id: string, ttlMs = CLIENT_MSG_TTL_MS): boolean {
  const now = Date.now();
  // Reject anything that isn't a v4 UUID. Malformed IDs would otherwise
  // cache unbounded and become a DoS vector.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return false;
  }
  const existing = _clientMsgSeen.get(id);
  if (existing !== undefined && existing > now) return false; // duplicate
  _clientMsgSeen.set(id, now + ttlMs);
  // Opportunistic eviction: evict expired entries whenever we cross the cap.
  if (_clientMsgSeen.size > CLIENT_MSG_MAX_ENTRIES) {
    for (const [k, exp] of _clientMsgSeen) {
      if (exp <= now) _clientMsgSeen.delete(k);
      if (_clientMsgSeen.size <= CLIENT_MSG_MAX_ENTRIES) break;
    }
    // If still over cap after evicting expired entries, drop oldest-inserted
    // (Map iteration order is insertion order in ES2015+).
    while (_clientMsgSeen.size > CLIENT_MSG_MAX_ENTRIES) {
      const oldest = _clientMsgSeen.keys().next().value;
      if (oldest === undefined) break;
      _clientMsgSeen.delete(oldest);
    }
  }
  return true;
}

/** @internal for tests — clear the dedup cache. */
export function _resetClientMsgCache(): void {
  _clientMsgSeen.clear();
}

// ── Dashboard settings (personalization KV) ─────────────────────────

export function getDashboardSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM dashboard_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setDashboardSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function getAllDashboardSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM dashboard_settings`).all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

// ── Memory recall mode (#96 follow-up) ──────────────────────────────
// PR #96 made recall strictly per-agent (isolated) for everyone. This is the
// correct default and what new installs get. Existing multi-agent installs can
// opt back into the pre-#96 behaviour — recall draws from every agent on the
// chat — via /keep-shared. Stored in dashboard_settings so it survives restarts
// and is shared across all agent processes pointing at the same store.
//
// Precedence: an explicit dashboard_settings row (the live /keep-shared toggle)
// always wins. When no row has been set, fall back to the MEMORY_RECALL_MODE env
// seed (config.ts) so an upgrading install can preserve old behaviour with one
// .env line instead of a post-upgrade sqlite command. Absent both, default to
// 'isolated'.
export type MemoryRecallMode = 'isolated' | 'shared';
const MEMORY_RECALL_MODE_KEY = 'memory_recall_mode';
const MEMORY_MIGRATION_NOTICE_KEY = 'memory_migration_notice';
const MEMORY_ISOLATION_STAMPED_KEY = 'memory_isolation_migrated';

export function getMemoryRecallMode(): MemoryRecallMode {
  const stored = getDashboardSetting(MEMORY_RECALL_MODE_KEY);
  if (stored === 'shared') return 'shared';
  if (stored === 'isolated') return 'isolated';
  // No explicit dashboard toggle yet — fall back to the env seed (default 'isolated').
  return MEMORY_RECALL_MODE_ENV;
}

export function setMemoryRecallMode(mode: MemoryRecallMode): void {
  setDashboardSetting(MEMORY_RECALL_MODE_KEY, mode);
}

/** Notice state for the one-time existing-multi-agent-install heads-up.
 *  'pending' → the primary agent should surface it; 'sent' → already shown. */
export function getMemoryMigrationNotice(): 'pending' | 'sent' | null {
  const v = getDashboardSetting(MEMORY_MIGRATION_NOTICE_KEY);
  return v === 'pending' || v === 'sent' ? v : null;
}

export function setMemoryMigrationNotice(state: 'pending' | 'sent'): void {
  setDashboardSetting(MEMORY_MIGRATION_NOTICE_KEY, state);
}

/**
 * One-time detection: did this install exist with MORE THAN ONE agent before
 * the #96 isolation change landed? Those users had cross-agent shared recall as
 * their lived-in behaviour, so we flag a notice (surfaced once by the primary
 * agent) offering /keep-shared. Fresh and single-agent installs are a no-op:
 * isolation is identical to their prior behaviour, so they get no notice.
 *
 * Evaluates exactly once per install. The stamp marker is claimed ATOMICALLY
 * (INSERT ... ON CONFLICT DO NOTHING): only the single process that actually
 * inserts it proceeds to evaluate and set the notice. This matters because all
 * agent processes share one store and start concurrently — a plain
 * read-then-write check would let a slow agent's stamp run AFTER the primary
 * has already shown and cleared the notice, rewriting 'pending' back over
 * 'sent' and re-nagging on the next restart. Losers of the claim bail here and
 * never touch the notice flag.
 */
export function stampMemoryIsolationMigration(database: Database.Database = db): void {
  const claim = database
    .prepare(
      `INSERT INTO dashboard_settings (key, value, updated_at)
       VALUES (?, '1', strftime('%s','now')) ON CONFLICT(key) DO NOTHING`,
    )
    .run(MEMORY_ISOLATION_STAMPED_KEY);
  if (claim.changes === 0) return; // another process already stamped this install

  const row = database
    .prepare(`SELECT COUNT(DISTINCT agent_id) AS n FROM memories`)
    .get() as { n: number };
  if ((row?.n ?? 0) > 1) {
    // Existing multi-agent install: flag the one-time heads-up for the primary.
    database
      .prepare(
        `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, 'pending', strftime('%s','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(MEMORY_MIGRATION_NOTICE_KEY);
  }
}

/**
 * Migrate an arbitrary ClaudeClaw database file to the current schema, in place.
 *
 * Opens `dbPath` with the same pragmas as initDatabase(), then applies
 * createSchema (IF NOT EXISTS), runMigrations (idempotent ADD COLUMN) and
 * stampMemoryIsolationMigration on that handle. Unlike initDatabase() this does
 * NOT depend on STORE_DIR and does NOT touch the process-wide `db` connection,
 * so migration tooling can upgrade a snapshot copy without disturbing a running
 * instance.
 *
 * Idempotent: safe to run repeatedly. Memory isolation is preserved — existing
 * rows keep their `shared` value (new rows default to 0) and nothing is ever
 * shared retroactively. The file is opened with a fresh connection that is
 * always closed before returning, even on error.
 */
export function migrateDbFile(dbPath: string): void {
  const database = new Database(dbPath);
  try {
    withBusyRetry(() => database.pragma('journal_mode = WAL'));
    database.pragma('busy_timeout = 5000');
    createSchema(database);
    runMigrations(database);
    stampMemoryIsolationMigration(database);
  } finally {
    database.close();
  }
}

// ── Agent file history (versioned backups in SQLite) ────────────────

export type AgentFileKind = 'claudemd' | 'agent-yaml';

export interface AgentFileHistoryRow {
  id: number;
  agent_id: string;
  file_kind: AgentFileKind;
  content: string;
  byte_size: number;
  sha256: string;
  author: string;
  created_at: number;
}

export function appendAgentFileHistory(
  agentId: string,
  fileKind: AgentFileKind,
  content: string,
  sha256: string,
  author = 'dashboard',
): number {
  const result = db.prepare(
    `INSERT INTO agent_file_history (agent_id, file_kind, content, byte_size, sha256, author)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, fileKind, content, Buffer.byteLength(content, 'utf8'), sha256, author);
  return Number(result.lastInsertRowid);
}

/** List versions newest-first. Excludes content by default to keep the
 *  payload small; callers fetch full content via getAgentFileHistory(id). */
export function listAgentFileHistory(
  agentId: string,
  fileKind: AgentFileKind,
  limit = 50,
): Array<Omit<AgentFileHistoryRow, 'content'>> {
  return db.prepare(
    `SELECT id, agent_id, file_kind, byte_size, sha256, author, created_at
     FROM agent_file_history
     WHERE agent_id = ? AND file_kind = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(agentId, fileKind, limit) as Array<Omit<AgentFileHistoryRow, 'content'>>;
}

export function getAgentFileHistory(id: number): AgentFileHistoryRow | null {
  const row = db.prepare(
    `SELECT * FROM agent_file_history WHERE id = ?`,
  ).get(id) as AgentFileHistoryRow | undefined;
  return row ?? null;
}

// ── Agent suggestions ──────────────────────────────────────────────

export interface AgentSuggestion {
  id: number;
  from_agent: string;
  suggested_id: string;
  suggested_name: string;
  suggested_description: string;
  reasoning: string;
  activity_share_pct: number | null;
  created_at: number;
  dismissed_at: number | null;
  acted_at: number | null;
}

export function insertAgentSuggestion(s: Omit<AgentSuggestion, 'id' | 'created_at' | 'dismissed_at' | 'acted_at'>): number {
  const r = db.prepare(
    `INSERT INTO agent_suggestions
       (from_agent, suggested_id, suggested_name, suggested_description, reasoning, activity_share_pct)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(s.from_agent, s.suggested_id, s.suggested_name, s.suggested_description, s.reasoning, s.activity_share_pct);
  return Number(r.lastInsertRowid);
}

export function listActiveAgentSuggestions(): AgentSuggestion[] {
  return db.prepare(
    `SELECT * FROM agent_suggestions
     WHERE dismissed_at IS NULL AND acted_at IS NULL
     ORDER BY created_at DESC`,
  ).all() as AgentSuggestion[];
}

export function dismissAgentSuggestion(id: number): boolean {
  const r = db.prepare(
    `UPDATE agent_suggestions SET dismissed_at = strftime('%s','now')
     WHERE id = ? AND dismissed_at IS NULL AND acted_at IS NULL`,
  ).run(id);
  return r.changes > 0;
}

export function markAgentSuggestionActed(id: number): boolean {
  const r = db.prepare(
    `UPDATE agent_suggestions SET acted_at = strftime('%s','now')
     WHERE id = ? AND acted_at IS NULL`,
  ).run(id);
  return r.changes > 0;
}

/** Used by the analyzer to skip re-suggesting splits the user already
 *  rejected or acted on. Returns the set of (from_agent, suggested_id)
 *  pairs that have any historical suggestion (active or not). */
export function getRecentlySuggestedSplits(daysBack = 30): Array<{ from_agent: string; suggested_id: string }> {
  return db.prepare(
    `SELECT from_agent, suggested_id FROM agent_suggestions
     WHERE created_at > strftime('%s','now') - (? * 86400)`,
  ).all(daysBack) as Array<{ from_agent: string; suggested_id: string }>;
}

/** Hard cap on retained versions per (agent, kind) so the table doesn't
 *  grow unboundedly. Called after each insert. */
export function pruneAgentFileHistory(
  agentId: string,
  fileKind: AgentFileKind,
  keep = 100,
): number {
  const result = db.prepare(
    `DELETE FROM agent_file_history
     WHERE id IN (
       SELECT id FROM agent_file_history
       WHERE agent_id = ? AND file_kind = ?
       ORDER BY created_at DESC, id DESC
       LIMIT -1 OFFSET ?
     )`,
  ).run(agentId, fileKind, keep);
  return result.changes;
}

/** Clear only the dead instance observed by activation; never newer state or a stop. */
export function clearDeadWorkerLease(agentId: string, instanceId: string, pid: number): boolean {
  return db.prepare(`UPDATE worker_runtime SET instance_id = NULL, supervisor_epoch = NULL,
    pid = NULL, process_started_at = NULL, heartbeat_at = NULL, runtime_build_id = NULL
    WHERE agent_id = ? AND instance_id = ? AND pid = ? AND desired_state = 'active'`)
    .run(agentId, instanceId, pid).changes === 1;
}
