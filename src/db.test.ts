import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  _initTestDatabase,
  migrateDbFile,
  setSession,
  getSession,
  clearSession,
  clearAgentSessions,
  saveStructuredMemory,
  searchMemories,
  setMemoryShared,
  getMemoryRecallMode,
  setMemoryRecallMode,
  getMemoryMigrationNotice,
  setMemoryMigrationNotice,
  stampMemoryIsolationMigration,
  getRecentMemories,
  getRecentHighImportanceMemories,
  touchMemory,
  decayMemories,
  getUnconsolidatedMemories,
  saveConsolidation,
  markMemoriesConsolidated,
  getRecentConsolidations,
  searchConsolidations,
  updateMemoryConnections,
  getDashboardMemoryStats,
  getDashboardLowSalienceMemories,
  getDashboardTopAccessedMemories,
  getDashboardMemoriesList,
  getDashboardMemoryTimeline,
  createMissionTask,
  claimNextMissionTask,
  completeMissionTask,
  getMissionTask,
  beginWorkerSupervisorEpoch,
  ensureWorkerDesiredState,
  acquireWorkerLease,
  heartbeatWorkerLease,
  isWorkerLeaseCurrent,
  getAgentDeletionBlockers,
  failStuckMissionTasks,
  getWorkerRuntime,
  markWorkerTaskScopeStarted,
  deactivateWorkerIfTaskScopeDrained,
  createScheduledTask,
  logConversationTurn,
  getSessionConversation,
} from './db.js';

describe('database', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  describe('session conversation', () => {
    it('returns the newest limited turns in chronological order', () => {
      for (let i = 1; i <= 45; i += 1) {
        logConversationTurn('chat', i % 2 ? 'user' : 'assistant', `turn-${i}`, 'session-215');
      }
      const turns = getSessionConversation('session-215', 40);
      expect(turns).toHaveLength(40);
      expect(turns[0].content).toBe('turn-6');
      expect(turns.at(-1)?.content).toBe('turn-45');
    });
  });

  // ── Sessions ────────────────────────────────────────────────────

  describe('sessions', () => {
    it('returns undefined for missing session', () => {
      expect(getSession('unknown')).toBeUndefined();
    });

    it('setSession then getSession returns the session ID', () => {
      setSession('chat1', 'sess-abc');
      expect(getSession('chat1')).toBe('sess-abc');
    });

    it('setSession overwrites existing session', () => {
      setSession('chat1', 'sess-1');
      setSession('chat1', 'sess-2');
      expect(getSession('chat1')).toBe('sess-2');
    });

    it('clearSession removes the session', () => {
      setSession('chat1', 'sess-abc');
      clearSession('chat1');
      expect(getSession('chat1')).toBeUndefined();
    });

    it('clearSession on missing session does not throw', () => {
      expect(() => clearSession('nonexistent')).not.toThrow();
    });

    it('clearAgentSessions removes every chat for only the selected agent', () => {
      setSession('chat1', 'main-1', 'main');
      setSession('chat2', 'main-2', 'main');
      setSession('chat1', 'naomi-1', 'naomi');

      expect(clearAgentSessions('main')).toBe(2);
      expect(getSession('chat1', 'main')).toBeUndefined();
      expect(getSession('chat2', 'main')).toBeUndefined();
      expect(getSession('chat1', 'naomi')).toBe('naomi-1');
    });
  });

  // ── Structured Memories ────────────────────────────────────────

  describe('saveStructuredMemory', () => {
    it('saves a memory with all fields persisted', () => {
      saveStructuredMemory('chat1', 'I like pizza', 'User enjoys pizza', ['pizza'], ['food', 'preferences'], 0.7);
      const mems = getRecentMemories('chat1', 10);
      expect(mems).toHaveLength(1);
      expect(mems[0].chat_id).toBe('chat1');
      expect(mems[0].raw_text).toBe('I like pizza');
      expect(mems[0].summary).toBe('User enjoys pizza');
      expect(JSON.parse(mems[0].entities)).toEqual(['pizza']);
      expect(JSON.parse(mems[0].topics)).toEqual(['food', 'preferences']);
      expect(mems[0].importance).toBe(0.7);
      expect(mems[0].salience).toBe(1.0);
      expect(mems[0].consolidated).toBe(0);
      expect(mems[0].source).toBe('conversation');
      expect(mems[0].created_at).toBeGreaterThan(0);
    });

    it('returns the memory ID', () => {
      const id = saveStructuredMemory('chat1', 'test', 'test summary', [], [], 0.5);
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('searchMemories', () => {
    it('finds matching summary via FTS5', () => {
      saveStructuredMemory('chat1', 'raw text about TypeScript', 'User enjoys TypeScript programming', ['TypeScript'], ['coding'], 0.6);
      saveStructuredMemory('chat1', 'weather stuff', 'The weather is nice today', [], ['weather'], 0.3);
      const results = searchMemories('chat1', 'TypeScript', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].summary).toContain('TypeScript');
    });

    it('returns empty array for no match', () => {
      saveStructuredMemory('chat1', 'raw', 'I love TypeScript', [], [], 0.5);
      const results = searchMemories('chat1', 'xyznonexistent', 5);
      expect(results).toEqual([]);
    });

    it('returns empty array for empty query', () => {
      saveStructuredMemory('chat1', 'raw', 'something', [], [], 0.5);
      const results = searchMemories('chat1', '', 5);
      expect(results).toEqual([]);
    });

    it('does not return memories from other chats', () => {
      saveStructuredMemory('chat1', 'raw', 'I love TypeScript', [], [], 0.5);
      saveStructuredMemory('chat2', 'raw', 'I love Python', [], [], 0.5);
      const results = searchMemories('chat1', 'Python', 5);
      expect(results).toEqual([]);
    });

    it('respects limit parameter', () => {
      saveStructuredMemory('chat1', 'raw', 'first topic about coding', [], ['coding'], 0.5);
      saveStructuredMemory('chat1', 'raw', 'second topic about coding', [], ['coding'], 0.5);
      saveStructuredMemory('chat1', 'raw', 'third topic about coding', [], ['coding'], 0.5);
      const results = searchMemories('chat1', 'coding', 2);
      expect(results).toHaveLength(2);
    });
  });

  describe('getRecentHighImportanceMemories', () => {
    it('only returns memories with importance >= 0.5', () => {
      saveStructuredMemory('chat1', 'raw', 'low importance', [], [], 0.3);
      saveStructuredMemory('chat1', 'raw', 'high importance', [], [], 0.8);
      const mems = getRecentHighImportanceMemories('chat1', 10);
      expect(mems).toHaveLength(1);
      expect(mems[0].summary).toBe('high importance');
    });
  });

  // Memory isolation (#95): recall scoped by agent_id + explicit shared tier.
  describe('agent-scoped recall + shared tier', () => {
    it('searchMemories scoped to an agent excludes other agents memories', () => {
      saveStructuredMemory('chat1', 'raw', 'naomi knows about embroidery', [], [], 0.6, 'conversation', 'naomi');
      saveStructuredMemory('chat1', 'raw', 'main knows about embroidery', [], [], 0.6, 'conversation', 'main');
      const results = searchMemories('chat1', 'embroidery', 5, undefined, 'naomi');
      expect(results.length).toBe(1);
      expect(results[0].agent_id).toBe('naomi');
    });

    it('searchMemories scoped to an agent still returns shared memories from other agents', () => {
      const sharedId = saveStructuredMemory('chat1', 'raw', 'dashboard runs on port 3141 widget', [], [], 0.6, 'conversation', 'main');
      setMemoryShared(sharedId, true);
      const results = searchMemories('chat1', 'widget', 5, undefined, 'naomi');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(sharedId);
      expect(results[0].shared).toBe(1);
    });

    it('searchMemories with no agent scope returns all agents (back-compat)', () => {
      saveStructuredMemory('chat1', 'raw', 'naomi octopus fact', [], [], 0.6, 'conversation', 'naomi');
      saveStructuredMemory('chat1', 'raw', 'main octopus fact', [], [], 0.6, 'conversation', 'main');
      const results = searchMemories('chat1', 'octopus', 5);
      expect(results.length).toBe(2);
    });

    it('getRecentHighImportanceMemories scoped to an agent excludes others but keeps own + shared', () => {
      saveStructuredMemory('chat1', 'raw', 'naomi recent', [], [], 0.8, 'conversation', 'naomi');
      saveStructuredMemory('chat1', 'raw', 'drummer recent', [], [], 0.8, 'conversation', 'drummer');
      const sharedId = saveStructuredMemory('chat1', 'raw', 'shared recent', [], [], 0.8, 'conversation', 'main');
      setMemoryShared(sharedId, true);
      const mems = getRecentHighImportanceMemories('chat1', 10, 'naomi');
      const summaries = mems.map((m) => m.summary).sort();
      expect(summaries).toEqual(['naomi recent', 'shared recent']);
    });

    it('getRecentMemories scoped to an agent excludes others but keeps own + shared', () => {
      saveStructuredMemory('chat1', 'raw', 'naomi dump', [], [], 0.6, 'conversation', 'naomi');
      saveStructuredMemory('chat1', 'raw', 'drummer dump', [], [], 0.6, 'conversation', 'drummer');
      const sharedId = saveStructuredMemory('chat1', 'raw', 'shared dump', [], [], 0.6, 'conversation', 'main');
      setMemoryShared(sharedId, true);
      const mems = getRecentMemories('chat1', 10, 'naomi');
      const summaries = mems.map((m) => m.summary).sort();
      expect(summaries).toEqual(['naomi dump', 'shared dump']);
    });

    it('getRecentMemories with no agent scope returns all agents (back-compat)', () => {
      saveStructuredMemory('chat1', 'raw', 'naomi all', [], [], 0.6, 'conversation', 'naomi');
      saveStructuredMemory('chat1', 'raw', 'drummer all', [], [], 0.6, 'conversation', 'drummer');
      const mems = getRecentMemories('chat1', 10);
      expect(mems.length).toBe(2);
    });

    it('new memories default to not shared (strict per-agent)', () => {
      const id = saveStructuredMemory('chat1', 'raw', 'private note', [], [], 0.6, 'conversation', 'main');
      const mem = getRecentMemories('chat1', 1)[0];
      expect(mem.id).toBe(id);
      expect(mem.shared).toBe(0);
    });
  });

  // #96 follow-up: recall mode + one-time migration notice for existing
  // multi-agent installs.
  describe('memory recall mode + isolation migration notice', () => {
    it('defaults recall mode to isolated', () => {
      expect(getMemoryRecallMode()).toBe('isolated');
    });

    it('setMemoryRecallMode round-trips and only accepts known modes', () => {
      setMemoryRecallMode('shared');
      expect(getMemoryRecallMode()).toBe('shared');
      setMemoryRecallMode('isolated');
      expect(getMemoryRecallMode()).toBe('isolated');
    });

    it('stamp flags a pending notice for a multi-agent install', () => {
      saveStructuredMemory('chat1', 'raw', 'naomi note', [], [], 0.6, 'conversation', 'naomi');
      saveStructuredMemory('chat1', 'raw', 'main note', [], [], 0.6, 'conversation', 'main');
      stampMemoryIsolationMigration();
      expect(getMemoryMigrationNotice()).toBe('pending');
    });

    it('stamp does NOT flag a single-agent install', () => {
      saveStructuredMemory('chat1', 'raw', 'only main', [], [], 0.6, 'conversation', 'main');
      stampMemoryIsolationMigration();
      expect(getMemoryMigrationNotice()).toBeNull();
    });

    it('stamp does NOT flag a fresh install with no memories', () => {
      stampMemoryIsolationMigration();
      expect(getMemoryMigrationNotice()).toBeNull();
    });

    it('stamp runs exactly once — a second multi-agent state does not re-flag after dismissal', () => {
      saveStructuredMemory('chat1', 'raw', 'naomi note', [], [], 0.6, 'conversation', 'naomi');
      saveStructuredMemory('chat1', 'raw', 'main note', [], [], 0.6, 'conversation', 'main');
      stampMemoryIsolationMigration();
      setMemoryMigrationNotice('sent');
      stampMemoryIsolationMigration();
      expect(getMemoryMigrationNotice()).toBe('sent');
    });
  });

  describe('touchMemory', () => {
    it('increments salience by 0.1', () => {
      saveStructuredMemory('chat1', 'raw', 'test memory', [], [], 0.5);
      const before = getRecentMemories('chat1', 1)[0];
      expect(before.salience).toBe(1.0);

      touchMemory(before.id);
      const after = getRecentMemories('chat1', 1)[0];
      expect(after.salience).toBeCloseTo(1.1, 5);
    });

    it('caps salience at 5.0', () => {
      saveStructuredMemory('chat1', 'raw', 'test memory', [], [], 0.5);
      const mem = getRecentMemories('chat1', 1)[0];

      for (let i = 0; i < 50; i++) {
        touchMemory(mem.id);
      }

      const after = getRecentMemories('chat1', 1)[0];
      expect(after.salience).toBe(5.0);
    });
  });

  describe('decayMemories', () => {
    it('does not throw on empty database', () => {
      expect(() => decayMemories()).not.toThrow();
    });

    it('does not decay recent memories', () => {
      saveStructuredMemory('chat1', 'raw', 'fresh memory', [], [], 0.5);
      const before = getRecentMemories('chat1', 1)[0];

      decayMemories();

      const after = getRecentMemories('chat1', 1)[0];
      expect(after.salience).toBe(before.salience);
    });
  });

  // ── Consolidation ────────────────────────────────────────────────

  describe('consolidation', () => {
    it('getUnconsolidatedMemories returns only unconsolidated', () => {
      saveStructuredMemory('chat1', 'raw', 'mem1', [], [], 0.5);
      saveStructuredMemory('chat1', 'raw', 'mem2', [], [], 0.6);
      const uncon = getUnconsolidatedMemories('chat1', 10);
      expect(uncon).toHaveLength(2);
    });

    it('markMemoriesConsolidated marks them', () => {
      const id1 = saveStructuredMemory('chat1', 'raw', 'mem1', [], [], 0.5);
      const id2 = saveStructuredMemory('chat1', 'raw', 'mem2', [], [], 0.6);
      markMemoriesConsolidated([id1, id2]);
      const uncon = getUnconsolidatedMemories('chat1', 10);
      expect(uncon).toHaveLength(0);
    });

    it('saveConsolidation creates a record', () => {
      const id1 = saveStructuredMemory('chat1', 'raw', 'mem1', [], [], 0.5);
      const id2 = saveStructuredMemory('chat1', 'raw', 'mem2', [], [], 0.6);
      saveConsolidation('chat1', [id1, id2], 'Both relate to work', 'User is focused on productivity');
      const cons = getRecentConsolidations('chat1', 5);
      expect(cons).toHaveLength(1);
      expect(cons[0].insight).toBe('User is focused on productivity');
      expect(JSON.parse(cons[0].source_ids)).toEqual([id1, id2]);
    });

    it('getUnconsolidatedMemories respects limit', () => {
      for (let i = 0; i < 5; i++) {
        saveStructuredMemory('chat1', 'raw', `mem${i}`, [], [], 0.5);
      }
      const uncon = getUnconsolidatedMemories('chat1', 3);
      expect(uncon).toHaveLength(3);
    });

    it('getUnconsolidatedMemories does not return memories from other chats', () => {
      saveStructuredMemory('chat1', 'raw', 'mine', [], [], 0.5);
      saveStructuredMemory('chat2', 'raw', 'theirs', [], [], 0.5);
      const uncon = getUnconsolidatedMemories('chat1', 10);
      expect(uncon).toHaveLength(1);
      expect(uncon[0].summary).toBe('mine');
    });

    it('markMemoriesConsolidated handles empty array', () => {
      expect(() => markMemoriesConsolidated([])).not.toThrow();
    });

    it('getRecentConsolidations respects limit', () => {
      const id1 = saveStructuredMemory('chat1', 'raw', 'mem1', [], [], 0.5);
      saveConsolidation('chat1', [id1], 'summary1', 'insight1');
      saveConsolidation('chat1', [id1], 'summary2', 'insight2');
      saveConsolidation('chat1', [id1], 'summary3', 'insight3');
      const cons = getRecentConsolidations('chat1', 2);
      expect(cons).toHaveLength(2);
    });

    it('getRecentConsolidations returns empty for chat with no consolidations', () => {
      const cons = getRecentConsolidations('empty-chat', 5);
      expect(cons).toEqual([]);
    });
  });

  // ── searchConsolidations ──────────────────────────────────────────

  describe('searchConsolidations', () => {
    it('finds consolidations matching summary', () => {
      const id1 = saveStructuredMemory('chat1', 'raw', 'mem', [], [], 0.5);
      saveConsolidation('chat1', [id1], 'Morning email routine is important', 'User has structured mornings');
      const results = searchConsolidations('chat1', 'email', 5);
      expect(results).toHaveLength(1);
      expect(results[0].summary).toContain('email');
    });

    it('finds consolidations matching insight', () => {
      const id1 = saveStructuredMemory('chat1', 'raw', 'mem', [], [], 0.5);
      saveConsolidation('chat1', [id1], 'General summary', 'User prefers TypeScript for all projects');
      const results = searchConsolidations('chat1', 'TypeScript', 5);
      expect(results).toHaveLength(1);
    });

    it('returns empty for no match', () => {
      const id1 = saveStructuredMemory('chat1', 'raw', 'mem', [], [], 0.5);
      saveConsolidation('chat1', [id1], 'About coding', 'Coding insight');
      const results = searchConsolidations('chat1', 'xyznonexistent', 5);
      expect(results).toEqual([]);
    });
  });

  // ── updateMemoryConnections ───────────────────────────────────────

  describe('updateMemoryConnections', () => {
    it('appends connections to an existing memory', () => {
      const id = saveStructuredMemory('chat1', 'raw', 'mem', [], [], 0.5);
      updateMemoryConnections(id, [{ linked_to: 99, relationship: 'related to' }]);
      const mem = getRecentMemories('chat1', 1)[0];
      const conns = JSON.parse(mem.connections);
      expect(conns).toHaveLength(1);
      expect(conns[0]).toEqual({ linked_to: 99, relationship: 'related to' });
    });

    it('appends to existing connections without overwriting', () => {
      const id = saveStructuredMemory('chat1', 'raw', 'mem', [], [], 0.5);
      updateMemoryConnections(id, [{ linked_to: 10, relationship: 'first' }]);
      updateMemoryConnections(id, [{ linked_to: 20, relationship: 'second' }]);
      const mem = getRecentMemories('chat1', 1)[0];
      const conns = JSON.parse(mem.connections);
      expect(conns).toHaveLength(2);
      expect(conns[0].linked_to).toBe(10);
      expect(conns[1].linked_to).toBe(20);
    });

    it('does not throw for nonexistent memory ID', () => {
      expect(() => updateMemoryConnections(99999, [{ linked_to: 1, relationship: 'test' }])).not.toThrow();
    });
  });

  // ── FTS5 multi-column search ──────────────────────────────────────

  describe('FTS5 multi-column search', () => {
    it('finds memory by entity match', () => {
      saveStructuredMemory('chat1', 'raw text', 'summary text', ['OpenAI', 'GPT-4'], ['AI'], 0.6);
      const results = searchMemories('chat1', 'OpenAI', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('finds memory by topic match', () => {
      saveStructuredMemory('chat1', 'raw text', 'summary text', [], ['productivity', 'workflow'], 0.6);
      const results = searchMemories('chat1', 'productivity', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('finds memory by raw_text match', () => {
      saveStructuredMemory('chat1', 'I absolutely love hiking in the mountains', 'User enjoys outdoor activities', ['hiking'], ['hobbies'], 0.5);
      const results = searchMemories('chat1', 'hiking mountains', 5);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('handles special characters in search query', () => {
      saveStructuredMemory('chat1', 'raw', 'summary', [], [], 0.5);
      const results = searchMemories('chat1', '!!!???', 5);
      expect(results).toEqual([]);
    });
  });

  // ── getRecentHighImportanceMemories edge cases ────────────────────

  describe('getRecentHighImportanceMemories edge cases', () => {
    it('includes memories with importance exactly 0.5', () => {
      saveStructuredMemory('chat1', 'raw', 'borderline', [], [], 0.5);
      const mems = getRecentHighImportanceMemories('chat1', 10);
      expect(mems).toHaveLength(1);
    });

    it('excludes memories with importance 0.49', () => {
      saveStructuredMemory('chat1', 'raw', 'just below', [], [], 0.49);
      const mems = getRecentHighImportanceMemories('chat1', 10);
      expect(mems).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        saveStructuredMemory('chat1', 'raw', `high${i}`, [], [], 0.8);
      }
      const mems = getRecentHighImportanceMemories('chat1', 3);
      expect(mems).toHaveLength(3);
    });
  });

  // ── Dashboard queries ─────────────────────────────────────────────

  describe('dashboard queries', () => {
    it('getDashboardMemoryStats returns correct totals', () => {
      saveStructuredMemory('chat1', 'raw', 'high', [], [], 0.9);
      saveStructuredMemory('chat1', 'raw', 'mid', [], [], 0.6);
      saveStructuredMemory('chat1', 'raw', 'low', [], [], 0.3);
      saveConsolidation('chat1', [1], 'summary', 'insight');

      const stats = getDashboardMemoryStats('chat1');
      expect(stats.total).toBe(3);
      expect(stats.consolidations).toBe(1);
      expect(stats.avgImportance).toBeCloseTo(0.6, 1);
      expect(stats.importanceDistribution.length).toBeGreaterThan(0);
    });

    it('getDashboardMemoryStats returns zeroes for empty chat', () => {
      const stats = getDashboardMemoryStats('empty');
      expect(stats.total).toBe(0);
      expect(stats.consolidations).toBe(0);
    });

    it('getDashboardLowSalienceMemories returns nothing for fresh memories', () => {
      saveStructuredMemory('chat1', 'raw', 'fresh', [], [], 0.5);
      const fading = getDashboardLowSalienceMemories('chat1', 10);
      // Fresh memory has salience 1.0, threshold is 0.5
      expect(fading).toHaveLength(0);
    });

    it('getDashboardTopAccessedMemories only returns importance >= 0.5', () => {
      saveStructuredMemory('chat1', 'raw', 'low imp', [], [], 0.3);
      saveStructuredMemory('chat1', 'raw', 'high imp', [], [], 0.7);
      const top = getDashboardTopAccessedMemories('chat1', 10);
      expect(top).toHaveLength(1);
      expect(top[0].summary).toBe('high imp');
    });

    it('getDashboardMemoriesList sorts by importance', () => {
      saveStructuredMemory('chat1', 'raw', 'low', [], [], 0.2);
      saveStructuredMemory('chat1', 'raw', 'high', [], [], 0.9);
      saveStructuredMemory('chat1', 'raw', 'mid', [], [], 0.5);

      const result = getDashboardMemoriesList('chat1', 10, 0, 'importance');
      expect(result.total).toBe(3);
      expect(result.memories[0].summary).toBe('high');
      expect(result.memories[1].summary).toBe('mid');
      expect(result.memories[2].summary).toBe('low');
    });

    it('getDashboardMemoriesList supports pagination', () => {
      for (let i = 0; i < 5; i++) {
        saveStructuredMemory('chat1', 'raw', `mem${i}`, [], [], 0.5);
      }
      const page1 = getDashboardMemoriesList('chat1', 2, 0);
      const page2 = getDashboardMemoriesList('chat1', 2, 2);
      expect(page1.memories).toHaveLength(2);
      expect(page2.memories).toHaveLength(2);
      expect(page1.total).toBe(5);
      // No overlap between pages
      const ids1 = page1.memories.map(m => m.id);
      const ids2 = page2.memories.map(m => m.id);
      expect(ids1.filter(id => ids2.includes(id))).toHaveLength(0);
    });

    it('getDashboardMemoryTimeline returns data', () => {
      saveStructuredMemory('chat1', 'raw', 'today', [], [], 0.5);
      const timeline = getDashboardMemoryTimeline('chat1', 30);
      expect(timeline.length).toBeGreaterThanOrEqual(1);
      expect(timeline[0]).toHaveProperty('date');
      expect(timeline[0]).toHaveProperty('count');
    });
  });
});

// ── Mission task claim/complete under lock contention (issue #155) ──
describe('mission task claim/complete', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('claims the next queued task for an agent and marks it running', () => {
    createMissionTask('m1', 'T1', 'do a thing', 'amos');
    const claimed = claimNextMissionTask('amos');
    expect(claimed?.id).toBe('m1');
    expect(claimed?.status).toBe('running');
    expect(claimed?.started_at).toBeGreaterThan(0);
    expect(getMissionTask('m1')?.status).toBe('running');
  });

  it('returns null when the agent has no queued tasks', () => {
    expect(claimNextMissionTask('amos')).toBeNull();
  });

  it('does not claim another agent\'s task', () => {
    createMissionTask('m2', 'T2', 'naomi work', 'naomi');
    expect(claimNextMissionTask('amos')).toBeNull();
    expect(getMissionTask('m2')?.status).toBe('queued');
  });

  it('respects priority then FIFO order', () => {
    createMissionTask('lo', 'lo', 'low', 'amos', 'dashboard', 1);
    createMissionTask('hi', 'hi', 'high', 'amos', 'dashboard', 9);
    // Higher priority is claimed first. The one-running-per-agent guard (#155)
    // means the first must complete before the next is claimable, so release it
    // before asserting the FIFO ordering of the remainder.
    expect(claimNextMissionTask('amos')?.id).toBe('hi');
    completeMissionTask('hi', 'ok', 'completed');
    expect(claimNextMissionTask('amos')?.id).toBe('lo');
  });

  it('does not claim a future mission until its availability gate opens', () => {
    const now = Math.floor(Date.now() / 1000);
    createMissionTask('future', 'future', 'later', 'amos', 'dashboard', 9,
      null, null, 'task', 'queued', now + 3600);
    createMissionTask('ready', 'ready', 'now', 'amos', 'dashboard', 1,
      null, null, 'task', 'queued', now - 1);

    expect(getMissionTask('future')?.available_at).toBe(now + 3600);
    expect(claimNextMissionTask('amos')?.id).toBe('ready');
    completeMissionTask('ready', 'ok', 'completed');
    expect(claimNextMissionTask('amos')).toBeNull();
    expect(getMissionTask('future')?.status).toBe('queued');
  });

  it('completeMissionTask sets status and completed_at (no stuck running)', () => {
    createMissionTask('m3', 'T3', 'finish me', 'amos');
    claimNextMissionTask('amos');
    completeMissionTask('m3', 'all done', 'completed');
    const t = getMissionTask('m3');
    expect(t?.status).toBe('completed');
    expect(t?.result).toBe('all done');
    expect(t?.completed_at).toBeGreaterThan(0);
  });

  it('does not claim a second task while the agent already has one running (one-running guard)', () => {
    createMissionTask('r1', 'R1', 'first', 'amos');
    createMissionTask('r2', 'R2', 'second', 'amos');
    const first = claimNextMissionTask('amos');
    expect(first?.id).toBe('r1');
    // r1 is now 'running' — the guard must block claiming r2.
    expect(claimNextMissionTask('amos')).toBeNull();
    expect(getMissionTask('r2')?.status).toBe('queued');
    // After r1 completes, r2 becomes claimable.
    completeMissionTask('r1', 'ok', 'completed');
    expect(claimNextMissionTask('amos')?.id).toBe('r2');
  });

  it('the running guard is per-agent (one agent running does not block another)', () => {
    createMissionTask('a1', 'A1', 'amos work', 'amos');
    createMissionTask('n1', 'N1', 'naomi work', 'naomi');
    claimNextMissionTask('amos'); // amos now running
    expect(claimNextMissionTask('naomi')?.id).toBe('n1');
  });

  it('completeMissionTask records failures with error text', () => {
    createMissionTask('m4', 'T4', 'will fail', 'amos');
    claimNextMissionTask('amos');
    completeMissionTask('m4', null, 'failed', 'boom');
    const t = getMissionTask('m4');
    expect(t?.status).toBe('failed');
    expect(t?.error).toBe('boom');
    expect(t?.completed_at).toBeGreaterThan(0);
  });
});

describe('headless worker lease fencing', () => {
  beforeEach(() => {
    _initTestDatabase();
    ensureWorkerDesiredState('ashford', 'active');
    beginWorkerSupervisorEpoch('epoch-1', 'build-1');
  });

  it('allows the current leased instance to claim a mission', () => {
    expect(acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-1', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    })).toBe(true);
    createMissionTask('lease-ok', 'leased', 'run it', 'ashford');

    expect(claimNextMissionTask('ashford', 'worker-1')?.id).toBe('lease-ok');
  });

  it('fences the old process immediately when the supervisor epoch changes', () => {
    acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-old', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    });
    createMissionTask('lease-fenced', 'fenced', 'do not run', 'ashford');

    beginWorkerSupervisorEpoch('epoch-2', 'build-2');

    expect(heartbeatWorkerLease('ashford', 'worker-old')).toBe(false);
    expect(isWorkerLeaseCurrent('ashford', 'worker-old')).toBe(false);
    expect(claimNextMissionTask('ashford', 'worker-old')).toBeNull();
    expect(getMissionTask('lease-fenced')?.status).toBe('queued');
  });

  it('rejects a lease from a stale epoch or build', () => {
    expect(acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-old', supervisorEpoch: 'epoch-old',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    })).toBe(false);
    expect(acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-old', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-old',
    })).toBe(false);
  });

  it('treats an expired heartbeat as offline', () => {
    acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-1', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    });
    const future = Math.floor(Date.now() / 1000) + 46;
    expect(isWorkerLeaseCurrent('ashford', 'worker-1', future)).toBe(false);
  });

  it('atomically clears lease metadata when explicitly deactivated', () => {
    expect(acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-1', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    })).toBe(true);

    ensureWorkerDesiredState('ashford', 'inactive');

    expect(getWorkerRuntime('ashford')).toMatchObject({
      desired_state: 'inactive',
      instance_id: null,
      supervisor_epoch: null,
      pid: null,
      process_started_at: null,
      heartbeat_at: null,
      runtime_build_id: null,
    });
    expect(isWorkerLeaseCurrent('ashford', 'worker-1')).toBe(false);
  });

  it('reports missions and schedules that would be orphaned by deletion', () => {
    createMissionTask('assigned', 'Assigned', 'work', 'ashford');
    createMissionTask('created', 'Created', 'delegated work', 'dawes', 'ashford');
    createMissionTask('finished', 'Finished', 'done', 'ashford');
    claimNextMissionTask('ashford');
    completeMissionTask('assigned', 'done', 'completed');
    createScheduledTask('retained', 'retained job', '* * * * *', Math.floor(Date.now() / 1000) + 60, 'ashford');

    expect(getAgentDeletionBlockers('ashford')).toEqual({
      open_missions: 2,
      retained_schedules: 1,
    });
  });

  it('marks an interrupted worker mission failed instead of rerunning it blindly', () => {
    createMissionTask('side-effect', 'external write', 'change remote state', 'ashford');
    expect(claimNextMissionTask('ashford')?.status).toBe('running');

    expect(failStuckMissionTasks('ashford', 'inspect before retry')).toBe(1);
    expect(getMissionTask('side-effect')).toMatchObject({
      status: 'failed',
      error: 'inspect before retry',
    });
  });

  it('deactivates an armed task scope after its assigned and delegated work drains', () => {
    expect(acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-1', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    })).toBe(true);
    expect(markWorkerTaskScopeStarted('ashford', 'worker-1', 'root')).toBe(true);
    createMissionTask('root', 'Root', 'root work', 'ashford');
    createMissionTask('child', 'Child', 'delegated work', 'dawes', 'ashford');

    expect(deactivateWorkerIfTaskScopeDrained('ashford', 'worker-1')).toBe(false);
    expect(getWorkerRuntime('ashford')?.desired_state).toBe('active');

    claimNextMissionTask('ashford', 'worker-1');
    completeMissionTask('root', 'done', 'completed');
    claimNextMissionTask('dawes');
    completeMissionTask('child', 'done', 'completed');

    expect(deactivateWorkerIfTaskScopeDrained('ashford', 'worker-1')).toBe(true);
    expect(getWorkerRuntime('ashford')?.desired_state).toBe('inactive');
  });

  it('does not deactivate an unarmed task scope or one retaining a schedule', () => {
    expect(acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-1', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    })).toBe(true);
    expect(deactivateWorkerIfTaskScopeDrained('ashford', 'worker-1')).toBe(false);

    markWorkerTaskScopeStarted('ashford', 'worker-1', 'job-1');
    createScheduledTask('job-1', 'retained job', '* * * * *', Math.floor(Date.now() / 1000) + 60, 'ashford');
    expect(deactivateWorkerIfTaskScopeDrained('ashford', 'worker-1')).toBe(false);
    expect(getWorkerRuntime('ashford')?.desired_state).toBe('active');
  });

  it('re-arms a task-scoped runtime when an inactive worker is explicitly activated', () => {
    acquireWorkerLease({
      agentId: 'ashford', instanceId: 'worker-1', supervisorEpoch: 'epoch-1',
      pid: 123, processStartedAt: 100, runtimeBuildId: 'build-1',
    });
    markWorkerTaskScopeStarted('ashford', 'worker-1', 'root');
    expect(deactivateWorkerIfTaskScopeDrained('ashford', 'worker-1')).toBe(true);

    ensureWorkerDesiredState('ashford', 'active');
    expect(getWorkerRuntime('ashford')).toMatchObject({
      desired_state: 'active',
      scope_started_at: null,
      scope_work_id: null,
    });
  });
});

describe('migrateDbFile', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-db-'));
    dbPath = path.join(dir, 'legacy.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Build a pre-isolation "legacy" memories table: no `shared` column,
   *  populated across two agents, plus an unrelated existing table. */
  function seedLegacyDb(): void {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        summary     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `);
    const insert = legacy.prepare(
      `INSERT INTO memories (chat_id, agent_id, summary, created_at) VALUES (?, ?, ?, ?)`,
    );
    insert.run('chat1', 'rc1', 'rc1 fact', 100);
    insert.run('chat1', 'rc2', 'rc2 fact', 101);
    insert.run('chat1', 'rc1', 'rc1 fact 2', 102);
    legacy.close();
  }

  it('adds the isolation `shared` column without sharing anything retroactively', () => {
    seedLegacyDb();
    migrateDbFile(dbPath);

    const db = new Database(dbPath);
    const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'shared')).toBe(true);

    const shared = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE shared = 1`).get() as { n: number };
    expect(shared.n).toBe(0); // strict isolation preserved — nothing shared on migrate
    db.close();
  });

  it('preserves existing rows and their data', () => {
    seedLegacyDb();
    migrateDbFile(dbPath);

    const db = new Database(dbPath);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
    expect(count.n).toBe(3);
    const summaries = db.prepare(`SELECT summary FROM memories ORDER BY id`).all() as Array<{ summary: string }>;
    expect(summaries.map((r) => r.summary)).toEqual(['rc1 fact', 'rc2 fact', 'rc1 fact 2']);
    db.close();
  });

  it('is idempotent — a second run is a no-op and does not throw', () => {
    seedLegacyDb();
    migrateDbFile(dbPath);
    expect(() => migrateDbFile(dbPath)).not.toThrow();

    const db = new Database(dbPath);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
    expect(count.n).toBe(3);
    db.close();
  });

  it('creates the full schema on an empty database file', () => {
    migrateDbFile(dbPath); // no seed — fresh file
    const db = new Database(dbPath);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('memories');
    expect(names).toContain('dashboard_settings');
    db.close();
  });

  it('adds mission availability and transition gates without changing existing tasks', () => {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE mission_tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL,
        assigned_agent TEXT, status TEXT NOT NULL DEFAULT 'queued',
        result TEXT, error TEXT, created_by TEXT NOT NULL DEFAULT 'dashboard',
        priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        started_at INTEGER, completed_at INTEGER
      );
      INSERT INTO mission_tasks
        (id, title, prompt, assigned_agent, status, created_by, priority, created_at)
      VALUES ('legacy-mission', 'Legacy', 'run now', 'main', 'queued', 'dashboard', 5, 100);
    `);
    legacy.close();

    migrateDbFile(dbPath);

    const migrated = new Database(dbPath);
    const cols = migrated.prepare(`PRAGMA table_info(mission_tasks)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'available_at')).toBe(true);
    expect(cols.some((c) => c.name === 'transition_key')).toBe(true);
    expect(cols.some((c) => c.name === 'workflow_id')).toBe(true);
    expect(cols.some((c) => c.name === 'workflow_depth')).toBe(true);
    expect(cols.some((c) => c.name === 'source_outcome_id')).toBe(true);
    expect(migrated.prepare(
      `SELECT id, status, available_at FROM mission_tasks WHERE id = 'legacy-mission'`,
    ).get()).toEqual({ id: 'legacy-mission', status: 'queued', available_at: null });
    const index = migrated.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mission_claimable'`,
    ).get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_mission_claimable');
    const transitionIndex = migrated.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mission_transition_key'`,
    ).get() as { name: string } | undefined;
    expect(transitionIndex?.name).toBe('idx_mission_transition_key');
    const workflowTables = migrated.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('mission_workflows', 'mission_outcomes', 'mission_transitions')`,
    ).all() as Array<{ name: string }>;
    expect(workflowTables.map((row) => row.name).sort()).toEqual([
      'mission_outcomes', 'mission_transitions', 'mission_workflows',
    ]);
    migrated.close();
  });
});

describe('mission task poller matches canonical id only', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('claims a row stored with the canonical id', () => {
    // The resolver runs upstream (CLI/dashboard); by the time a row hits the DB
    // its assigned_agent is a canonical id, so the poller claims it.
    createMissionTask('t-main', 'title', 'prompt', 'main', 'dashboard', 5);
    const claimed = claimNextMissionTask('main');
    expect(claimed?.id).toBe('t-main');
    expect(claimed?.status).toBe('running');
  });

  it('does NOT claim a row whose assigned_agent is an unresolved display name', () => {
    // This is exactly the fdfec14a dead-letter: a row stored as 'holden' never
    // matches the poller's WHERE assigned_agent = 'main'. The fix is storing the
    // canonical id upstream — the poller itself is deliberately left unchanged.
    createMissionTask('t-holden', 'title', 'prompt', 'holden', 'dashboard', 5);
    expect(claimNextMissionTask('main')).toBeNull();
    expect(claimNextMissionTask('holden')?.id).toBe('t-holden');
  });
});
