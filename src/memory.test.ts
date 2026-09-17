import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  searchMemories: vi.fn(),
  getRecentHighImportanceMemories: vi.fn(),
  getMemoryRecallMode: vi.fn(() => 'isolated'),
  getOtherAgentActivity: vi.fn(() => []),
  getConsolidationsWithEmbeddings: vi.fn(() => []),
  touchMemory: vi.fn(),
  penalizeMemory: vi.fn(),
  batchUpdateMemoryRelevance: vi.fn(),
  decayMemories: vi.fn(),
  logConversationTurn: vi.fn(),
  pruneConversationLog: vi.fn(),
  pruneWaMessages: vi.fn(() => ({ messages: 0, outbox: 0, map: 0 })),
  pruneSlackMessages: vi.fn(() => 0),
  pruneWarRoomMeetings: vi.fn(() => ({ meetings: 0, convLog: 0 })),
  searchConsolidations: vi.fn(),
  getRecentConsolidations: vi.fn(),
}));

vi.mock('./memory-ingest.js', () => ({
  ingestConversationTurn: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(() => Promise.resolve([])),
  cosineSimilarity: vi.fn(() => 0),
}));

vi.mock('./gemini.js', () => ({
  generateContent: vi.fn(() => Promise.resolve('[]')),
  parseJsonResponse: vi.fn(() => []),
}));

import {
  buildMemoryContext,
  saveConversationTurn,
  runDecaySweep,
} from './memory.js';

import {
  searchMemories,
  getRecentHighImportanceMemories,
  getMemoryRecallMode,
  touchMemory,
  decayMemories,
  logConversationTurn,
  searchConsolidations,
  getRecentConsolidations,
} from './db.js';

import { ingestConversationTurn } from './memory-ingest.js';

const mockSearchMemories = vi.mocked(searchMemories);
const mockGetRecentHighImportance = vi.mocked(getRecentHighImportanceMemories);
const mockTouchMemory = vi.mocked(touchMemory);
const mockDecayMemories = vi.mocked(decayMemories);
const mockLogConversationTurn = vi.mocked(logConversationTurn);
const mockSearchConsolidations = vi.mocked(searchConsolidations);
const mockGetRecentConsolidations = vi.mocked(getRecentConsolidations);
const mockIngest = vi.mocked(ingestConversationTurn);

function makeMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    chat_id: 'chat1',
    source: 'conversation',
    agent_id: 'main',
    raw_text: 'raw text',
    summary: 'A test memory',
    entities: '[]',
    topics: '[]',
    connections: '[]',
    importance: 0.7,
    salience: 1.0,
    consolidated: 0,
    pinned: 0,
    shared: 0,
    embedding: null,
    created_at: 100,
    accessed_at: 100,
    ...overrides,
  };
}

describe('buildMemoryContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);
  });

  it('returns empty string when no memories found', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'hello');
    expect(contextText).toBe('');
  });

  it('returns formatted string when FTS results exist', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'User enjoys pizza', topics: '["food"]', importance: 0.8 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'pizza');
    expect(contextText).toContain('[Memory context]');
    expect(contextText).toContain('User enjoys pizza');
    expect(contextText).toContain('food');
    expect(contextText).toContain('[0.8]');
    expect(contextText).toContain('[End memory context]');
  });

  it('deduplicates between FTS and recent results', async () => {
    const mem = makeMemory({ summary: 'shared memory' });
    mockSearchMemories.mockReturnValue([mem]);
    mockGetRecentHighImportance.mockReturnValue([mem]);

    const { contextText } = await buildMemoryContext('chat1', 'shared');
    const occurrences = contextText.split('shared memory').length - 1;
    expect(occurrences).toBe(1);
  });

  it('scopes recall to the calling agent by default (memory isolation #95)', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);

    await buildMemoryContext('chat1', 'hello', 'naomi');

    // Layer 1 + Layer 2 must be constrained to the calling agent's scope
    // (5th arg of searchMemories, 3rd arg of getRecentHighImportanceMemories).
    expect(mockSearchMemories.mock.calls[0][4]).toBe('naomi');
    expect(mockGetRecentHighImportance.mock.calls[0][2]).toBe('naomi');
  });

  it('defaults the recall scope to main when no agent is given', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);

    await buildMemoryContext('chat1', 'hello');

    expect(mockSearchMemories.mock.calls[0][4]).toBe('main');
    expect(mockGetRecentHighImportance.mock.calls[0][2]).toBe('main');
  });

  it('strictAgentId still constrains recall scope (war-room callers)', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);

    await buildMemoryContext('chat1', 'hello', 'main', { strictAgentId: 'drummer' });

    expect(mockSearchMemories.mock.calls[0][4]).toBe('drummer');
    expect(mockGetRecentHighImportance.mock.calls[0][2]).toBe('drummer');
  });

  it('shared recall mode drops the agent scope (pre-#96 behaviour, #96 follow-up)', async () => {
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);
    vi.mocked(getMemoryRecallMode).mockReturnValueOnce('shared');

    await buildMemoryContext('chat1', 'hello', 'naomi');

    // In shared mode recall draws from every agent: scope is undefined.
    expect(mockSearchMemories.mock.calls[0][4]).toBeUndefined();
    expect(mockGetRecentHighImportance.mock.calls[0][2]).toBeUndefined();
  });

  it('does NOT touch memories at retrieval (feedback loop handles this)', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ id: 10 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([
      makeMemory({ id: 20 }),
    ]);

    const { surfacedMemoryIds, surfacedMemorySummaries } = await buildMemoryContext('chat1', 'test');
    expect(mockTouchMemory).not.toHaveBeenCalled();
    expect(surfacedMemoryIds).toContain(10);
    expect(surfacedMemoryIds).toContain(20);
    expect(surfacedMemorySummaries.get(10)).toBe('A test memory');
  });
});

describe('saveConversationTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs both user and assistant messages to conversation log', () => {
    saveConversationTurn('chat1', 'hello world from the user!!!', 'Noted.');
    expect(mockLogConversationTurn).toHaveBeenCalledWith('chat1', 'user', 'hello world from the user!!!', undefined, 'main');
    expect(mockLogConversationTurn).toHaveBeenCalledWith('chat1', 'assistant', 'Noted.', undefined, 'main');
  });

  it('fires async ingestion', () => {
    saveConversationTurn('chat1', 'I prefer TypeScript over JavaScript always and forever', 'Noted.');
    expect(mockIngest).toHaveBeenCalledWith('chat1', 'I prefer TypeScript over JavaScript always and forever', 'Noted.', 'main');
  });
});

describe('buildMemoryContext with consolidations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchMemories.mockReturnValue([]);
    mockGetRecentHighImportance.mockReturnValue([]);
  });

  it('includes consolidation insights when searchConsolidations returns results', async () => {
    mockSearchConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1,2]', summary: 'Morning routine synthesis', insight: 'User has structured morning workflow', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'morning routine');
    expect(contextText).toContain('Insights:');
    expect(contextText).toContain('User has structured morning workflow');
  });

  it('falls back to recent consolidations when search returns empty', async () => {
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1]', summary: 'General insight', insight: 'User values productivity', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'unrelated query');
    expect(contextText).toContain('User values productivity');
  });

  it('returns empty when no memories and no insights exist', async () => {
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'anything');
    expect(contextText).toBe('');
  });

  it('includes both memories and insights when both exist', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Prefers dark mode', importance: 0.8, topics: '["UI"]' }),
    ]);
    mockSearchConsolidations.mockReturnValue([
      { id: 1, chat_id: 'chat1', source_ids: '[1]', summary: 'UI summary', insight: 'User cares deeply about UI aesthetics', created_at: 100 },
    ]);

    const { contextText } = await buildMemoryContext('chat1', 'UI preferences');
    expect(contextText).toContain('Prefers dark mode');
    expect(contextText).toContain('User cares deeply about UI aesthetics');
    expect(contextText).toContain('Relevant memories:');
    expect(contextText).toContain('Insights:');
  });
});

describe('buildMemoryContext topic formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchConsolidations.mockReturnValue([]);
    mockGetRecentConsolidations.mockReturnValue([]);
  });

  it('includes parsed topics in the formatted output', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Likes hiking', topics: '["outdoor", "fitness"]', importance: 0.7 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'hiking');
    expect(contextText).toContain('outdoor');
    expect(contextText).toContain('fitness');
  });

  it('handles empty topics gracefully', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'No topics memory', topics: '[]', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('No topics memory');
    // Should not have trailing topic parentheses
    expect(contextText).not.toContain('()');
  });

  it('handles malformed topics JSON gracefully', async () => {
    mockSearchMemories.mockReturnValue([
      makeMemory({ summary: 'Bad topics', topics: 'not-json', importance: 0.6 }),
    ]);
    mockGetRecentHighImportance.mockReturnValue([]);

    const { contextText } = await buildMemoryContext('chat1', 'query');
    expect(contextText).toContain('Bad topics');
    // Should not crash
  });
});

describe('runDecaySweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls decayMemories once', () => {
    runDecaySweep();
    expect(mockDecayMemories).toHaveBeenCalledOnce();
  });
});

it('logs only the assistant when the opening steering input was already recorded', () => {
  mockLogConversationTurn.mockClear();
  saveConversationTurn('chat1', 'opening', 'answer', 'session1', 'main', true);
  expect(mockLogConversationTurn.mock.calls).toEqual([['chat1', 'assistant', 'answer', 'session1', 'main']]);
});
