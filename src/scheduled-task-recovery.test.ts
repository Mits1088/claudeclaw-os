import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _initTestDatabase,
  createScheduledTask,
  getAllScheduledTasks,
  getDueTasks,
  markTaskRunning,
  migrateDbFile,
  pauseScheduledTask,
  resetStuckTasks,
  resumeScheduledTask,
  updateTaskAfterRun,
} from './db.js';

describe('scheduled task activation across manual runs and recovery', () => {
  beforeEach(() => _initTestDatabase());

  function pausedOverdueTask(id = 'paused', agent = 'main') {
    const nextRun = Math.floor(Date.now() / 1000) - 60;
    createScheduledTask(id, 'prepare report', '0 9 * * *', nextRun, agent);
    pauseScheduledTask(id);
    return nextRun;
  }

  it('recovers an overdue paused manual run without making it due', () => {
    const nextRun = pausedOverdueTask();
    // Run now takes the durable lock before its execution callback is queued.
    markTaskRunning('paused');
    expect(getAllScheduledTasks()[0]).toMatchObject({ status: 'running', resume_status: 'paused', next_run: nextRun });
    expect(getDueTasks()).toEqual([]);

    // The callback is lost on restart. Recovery must need only the database.
    expect(resetStuckTasks('main')).toBe(1);
    expect(getAllScheduledTasks()[0]).toMatchObject({
      status: 'paused', resume_status: null, started_at: null, next_run: nextRun,
    });
    expect(getDueTasks()).toEqual([]);
    expect(resetStuckTasks('main')).toBe(0);
  });

  it.each(['success', 'failed', 'timeout'] as const)('atomically restores a paused job after %s', (outcome) => {
    const nextRun = pausedOverdueTask();
    markTaskRunning('paused');
    updateTaskAfterRun('paused', nextRun, 'manual result', outcome);
    // No follow-up pause write is necessary, including on failure or timeout.
    expect(getAllScheduledTasks()[0]).toMatchObject({
      status: 'paused', resume_status: null, started_at: null, next_run: nextRun, last_status: outcome,
    });
    expect(getDueTasks()).toEqual([]);
    expect(resetStuckTasks('main')).toBe(0);
  });

  it('does not overwrite the persisted paused state when already marked running', () => {
    pausedOverdueTask();
    markTaskRunning('paused');
    markTaskRunning('paused');
    resetStuckTasks('main');
    expect(getAllScheduledTasks()[0].status).toBe('paused');
    expect(getDueTasks()).toEqual([]);
  });

  it.each(['active', 'paused'] as const)('restores an explicit %s choice made during a run', (activation) => {
    const nextRun = pausedOverdueTask();
    if (activation === 'paused') resumeScheduledTask('paused');
    markTaskRunning('paused');
    if (activation === 'active') resumeScheduledTask('paused');
    else pauseScheduledTask('paused');
    expect(getAllScheduledTasks()[0]).toMatchObject({ status: 'running', resume_status: activation });
    expect(getDueTasks()).toEqual([]);

    updateTaskAfterRun('paused', nextRun, 'done');
    expect(getAllScheduledTasks()[0]).toMatchObject({ status: activation, resume_status: null });
    // Run now intentionally preserves the overdue next_run of an enabled job.
    expect(getDueTasks()).toHaveLength(activation === 'active' ? 1 : 0);
  });

  it.each(['active', 'paused'] as const)('recovers an explicit %s choice made during a run', (activation) => {
    pausedOverdueTask();
    if (activation === 'paused') resumeScheduledTask('paused');
    markTaskRunning('paused');
    if (activation === 'active') resumeScheduledTask('paused');
    else pauseScheduledTask('paused');
    expect(resetStuckTasks('main')).toBe(1);
    expect(getAllScheduledTasks()[0]).toMatchObject({ status: activation, resume_status: null, started_at: null });
    expect(getDueTasks()).toHaveLength(activation === 'active' ? 1 : 0);
  });

  it('preserves active manual runs and the advanced next_run of automatic runs', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = past + 3600;
    createScheduledTask('manual', 'manual', '0 9 * * *', past);
    createScheduledTask('automatic', 'automatic', '0 9 * * *', past);
    markTaskRunning('manual');
    markTaskRunning('automatic', future);
    expect(resetStuckTasks('main')).toBe(2);
    expect(getAllScheduledTasks().find((task) => task.id === 'automatic')).toMatchObject({ status: 'active', next_run: future });
    expect(getDueTasks().map((task) => task.id)).toEqual(['manual']);
  });

  it('recovers only the requested agent and clears the saved state before another run', () => {
    pausedOverdueTask('main-task');
    pausedOverdueTask('other-task', 'other');
    markTaskRunning('main-task');
    markTaskRunning('other-task');
    expect(resetStuckTasks('main')).toBe(1);
    expect(getAllScheduledTasks('other')[0]).toMatchObject({ status: 'running', resume_status: 'paused' });
    resumeScheduledTask('main-task');
    markTaskRunning('main-task');
    resetStuckTasks('main');
    expect(getAllScheduledTasks('main')[0]).toMatchObject({ status: 'active', resume_status: null });
    expect(getDueTasks('main')).toHaveLength(1);
    expect(resetStuckTasks('other')).toBe(1);
    expect(getDueTasks('other')).toEqual([]);
  });
});

describe('scheduled task activation on disk', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-recovery-test-')); });
  afterEach(() => {
    _initTestDatabase(); // Close the test file before deleting it on Windows.
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps a paused manual run paused after reopening its database', () => {
    const file = path.join(directory, 'test.db');
    const nextRun = Math.floor(Date.now() / 1000) - 60;
    _initTestDatabase(file);
    createScheduledTask('paused', 'report', '0 9 * * *', nextRun);
    pauseScheduledTask('paused');
    markTaskRunning('paused');

    // Close and reopen the file: no execution callback or saved JS state survives.
    _initTestDatabase(file);
    expect(resetStuckTasks('main')).toBe(1);
    expect(getAllScheduledTasks()[0]).toMatchObject({ status: 'paused', next_run: nextRun, resume_status: null, started_at: null });
    expect(getDueTasks()).toEqual([]);
  });

  it('adds a nullable recovery state to existing jobs and is idempotent', () => {
    const file = path.join(directory, 'test.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, prompt TEXT NOT NULL, schedule TEXT NOT NULL,
        next_run INTEGER NOT NULL, last_run INTEGER, last_result TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
      );
      INSERT INTO scheduled_tasks (id, prompt, schedule, next_run, status, created_at)
      VALUES ('legacy', 'report', '0 9 * * *', 1, 'running', 1);
    `);
    legacy.close();
    migrateDbFile(file);
    migrateDbFile(file);
    const migrated = new Database(file);
    try {
      expect(migrated.prepare('SELECT status, resume_status FROM scheduled_tasks').get()).toEqual({ status: 'running', resume_status: null });
    } finally {
      migrated.close();
    }
    _initTestDatabase(file);
    expect(resetStuckTasks('main')).toBe(1);
    // Old running rows have no stored activation; retain their previous recovery policy.
    expect(getAllScheduledTasks()[0]).toMatchObject({ status: 'active', resume_status: null, started_at: null });
    expect(getDueTasks().map((task) => task.id)).toEqual(['legacy']);
  });
});
