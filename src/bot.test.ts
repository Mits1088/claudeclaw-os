import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  extractFileMarkers,
  modelStatusLine,
  endsAtStreamBoundary,
  formatElapsed,
  workingGlyphFor,
  completionRoutesInline,
  composeFinalTelegramText,
  renderTurnActivity,
  resolveTelegramModelSelection,
  runtimeFooterChange,
  runtimeFooterState,
  updateTurnActivity,
  type TurnActivityEntry,
} from './bot.js';
import { completionStatusGlyph } from './completion-glyph.js';

describe('completionStatusGlyph on the Telegram routing path', () => {
  it('keeps non-streamed standalone statuses honest', () => {
    for (const status of ['failed', 'error', 'notice']) {
      expect(completionStatusGlyph(status)).not.toBe('✓');
    }
  });
});

describe('completionRoutesInline', () => {
  it('folds every completion into the persistent ledger while streaming', () => {
    expect(completionRoutesInline(true, 'completed', 'edit')).toBe(true);
    expect(completionRoutesInline(true, 'notice', 'execute')).toBe(true);
    expect(completionRoutesInline(true, 'failed', undefined)).toBe(true);
  });

  it('never inlines with streaming off — there is no line to fold into', () => {
    expect(completionRoutesInline(false, 'completed', 'edit')).toBe(false);
  });
});

describe('turn activity ledger', () => {
  it('updates a Claude task start and completion on the same row', () => {
    const entries = new Map<string, TurnActivityEntry>();
    updateTurnActivity(entries, {
      type: 'task_started',
      description: 'Typecheck',
      toolCallId: 'task-1',
    });
    expect(renderTurnActivity(entries)).toBe('Activity\n💭 Typecheck…');

    updateTurnActivity(entries, {
      type: 'task_completed',
      description: 'Typecheck',
      status: 'completed',
      toolCallId: 'task-1',
    });
    expect(entries.size).toBe(1);
    expect(renderTurnActivity(entries)).toBe('Activity\n✓ Typecheck');
  });

  it('collapses repeated identical rows into a single counted row', () => {
    const entries = new Map<string, TurnActivityEntry>();
    for (const id of ['g1', 'g2', 'g3']) {
      updateTurnActivity(entries, {
        type: 'task_completed',
        description: 'Searched code',
        status: 'completed',
        kind: 'search',
        toolCallId: id,
      });
    }
    for (const id of ['e1', 'e2']) {
      updateTurnActivity(entries, {
        type: 'task_completed',
        description: 'Edited file',
        status: 'completed',
        kind: 'edit',
        toolCallId: id,
      });
    }
    // Three search + two edit completions collapse to two counted rows in
    // first-occurrence order, not five separate lines.
    expect(renderTurnActivity(entries)).toBe(
      'Activity\n✓ Searched code (x3)\n✓ Edited file (x2)',
    );
  });

  it('collapses provider-specific detail (Codex filenames/queries) into the big-three labels', () => {
    const entries = new Map<string, TurnActivityEntry>();
    // Codex bakes per-call detail into the row text, so without normalization
    // each edit/search would be its own line. They must fold by category.
    updateTurnActivity(entries, {
      type: 'task_completed', description: 'Edited 1 file: bot.ts', status: 'completed', kind: 'edit', toolCallId: 'c1',
    });
    updateTurnActivity(entries, {
      type: 'task_completed', description: 'Edited 2 files: a.ts, b.ts', status: 'completed', kind: 'edit', toolCallId: 'c2',
    });
    updateTurnActivity(entries, {
      type: 'task_completed', description: 'Web search: cats', status: 'completed', kind: 'search', toolCallId: 'c3',
    });
    updateTurnActivity(entries, {
      type: 'task_completed', description: 'Web search: dogs', status: 'completed', kind: 'search', toolCallId: 'c4',
    });
    expect(renderTurnActivity(entries)).toBe(
      'Activity\n✓ Edited file (x2)\n✓ Web search (x2)',
    );
  });

  it('updates Claude subagent progress without creating duplicate rows', () => {
    const entries = new Map<string, TurnActivityEntry>();
    updateTurnActivity(entries, {
      type: 'task_started',
      description: 'Reviewing code',
      kind: 'subagent',
      toolCallId: 'agent-1',
    });
    updateTurnActivity(entries, {
      type: 'tool_active',
      description: 'Checking tests',
      kind: 'subagent',
      toolCallId: 'agent-1',
    });

    expect(entries.size).toBe(1);
    expect(renderTurnActivity(entries)).toBe('Activity\n🤝 Checking tests…');
  });

  it('renders OpenAI plans as checklist rows and updates their state', () => {
    const entries = new Map<string, TurnActivityEntry>();
    updateTurnActivity(entries, {
      type: 'plan',
      description: 'Plan updated',
      planEntries: [
        { content: 'Inspect implementation', status: 'completed' },
        { content: 'Run validation', status: 'in_progress' },
      ],
    });
    expect(renderTurnActivity(entries)).toBe(
      'Activity\n✓ Inspect implementation\n📋 Run validation…',
    );

    updateTurnActivity(entries, {
      type: 'plan',
      description: 'Plan updated',
      planEntries: [
        { content: 'Inspect implementation', status: 'completed' },
        { content: 'Run validation', status: 'completed' },
      ],
    });
    expect(entries.size).toBe(2);
    expect(renderTurnActivity(entries)).toBe(
      'Activity\n✓ Inspect implementation\n✓ Run validation',
    );
  });

  it('retains compaction as a durable activity notice', () => {
    const entries = new Map<string, TurnActivityEntry>();
    updateTurnActivity(entries, {
      type: 'task_completed',
      description: 'Context compacted',
      status: 'notice',
      kind: 'compact',
      toolCallId: 'context-compaction',
    });
    expect(renderTurnActivity(entries)).toBe('Activity\nℹ️ Context compacted');
  });

  it('retains OpenAI command advisories without a standalone reply', () => {
    const entries = new Map<string, TurnActivityEntry>();
    updateTurnActivity(entries, {
      type: 'task_completed',
      description: 'rg -n pattern src · exit 1',
      status: 'notice',
      kind: 'execute',
      toolCallId: 'command-1',
    });
    expect(renderTurnActivity(entries)).toBe('Activity\nℹ️ rg -n pattern src · exit 1');
  });

  it('keeps the model footer below the activity ledger', () => {
    const result = composeFinalTelegramText(
      'Answer',
      '\n\n[GPT-5.6 Sol · medium]',
      'Activity\n✓ Web search',
    );
    expect(result).toBe(
      'Answer\n\n**Activity**\n✓ Web search\n\n[GPT-5.6 Sol · medium]',
    );
  });
});

describe('workingGlyphFor', () => {
  it('gives each activity kind its own glyph', () => {
    expect(workingGlyphFor('execute')).toBe('⚡');
    expect(workingGlyphFor('mcp')).toBe('🔌');
    expect(workingGlyphFor('thinking')).toBe('💭');
  });

  it('falls back to the thinking glyph rather than an empty prefix', () => {
    expect(workingGlyphFor(undefined)).toBe('💭');
    expect(workingGlyphFor('some-future-kind')).toBe('💭');
  });
});

describe('formatElapsed', () => {
  it('stays in seconds below two minutes', () => {
    expect(formatElapsed(9)).toBe('9s');
    expect(formatElapsed(119)).toBe('119s');
  });

  it('switches to minutes at two minutes, dropping a zero-seconds remainder', () => {
    expect(formatElapsed(120)).toBe('2m');
    expect(formatElapsed(200)).toBe('3m20s');
  });
});

describe('endsAtStreamBoundary', () => {
  it('rejects the mid-quote stub that used to get published at 20 chars', () => {
    expect(endsAtStreamBoundary('"Caller A" and "Caller ')).toBe(false);
  });

  it('rejects mid-sentence and mid-structure text', () => {
    expect(endsAtStreamBoundary('Caller A and Caller B mean two ClaudeClaw turn')).toBe(false);
    expect(endsAtStreamBoundary('| Codex App Server | One persistent')).toBe(false);
    expect(endsAtStreamBoundary('ends in comma,')).toBe(false);
  });

  it('accepts sentence-final punctuation with or without trailing space', () => {
    expect(endsAtStreamBoundary('They are two ClaudeClaw invocations.')).toBe(true);
    expect(endsAtStreamBoundary('should therefore run sequentially. ')).toBe(true);
    expect(endsAtStreamBoundary('Question here?')).toBe(true);
  });

  it('accepts newline and paragraph breaks so lists and tables flush per line', () => {
    expect(endsAtStreamBoundary('- Direct `AgentEngine.invoke()` calls\n')).toBe(true);
    expect(endsAtStreamBoundary('first paragraph\n\n')).toBe(true);
  });
});

describe('modelStatusLine', () => {
  it('reports Codex model instead of the OpenCode fallback text', () => {
    expect(modelStatusLine({ type: 'acp-codex', model: 'gpt-5.5' }, 'chat-1')).toBe('Model: GPT-5.5');
  });

  it('reports provider-specific defaults for non-Claude providers', () => {
    expect(modelStatusLine({ type: 'acp-codex' }, 'chat-1')).toBe('Model: Codex default');
    expect(modelStatusLine({ type: 'gemini' }, 'chat-1')).toBe('Model: Gemini CLI default');
    expect(modelStatusLine({ type: 'opencode' }, 'chat-1')).toBe('Model: OpenCode default');
    expect(modelStatusLine({ type: 'acp', command: 'my-agent' }, 'chat-1')).toBe('Model: Provider default');
  });
});

describe('runtime footer change detection', () => {
  it('reports an OpenAI reasoning change on the same model', () => {
    const before = runtimeFooterState({ type: 'openai', model: 'gpt-5.6-sol', thinkingMode: 'xhigh' }, 'gpt-5.6-sol');
    const after = runtimeFooterState({ type: 'openai', model: 'gpt-5.6-sol', thinkingMode: 'medium' }, 'gpt-5.6-sol');
    expect(runtimeFooterChange(before, after)).toBe('reasoning xhigh → medium');
  });

  it('reports Claude effort and thinking changes together', () => {
    const before = runtimeFooterState({ type: 'claude', model: 'claude-opus-4-8', runtimeMode: 'high', thinkingMode: 'on' }, 'claude-opus-4-8');
    const after = runtimeFooterState({ type: 'claude', model: 'claude-opus-4-8', runtimeMode: 'medium', thinkingMode: 'off' }, 'claude-opus-4-8');
    expect(runtimeFooterChange(before, after)).toBe('effort high → medium, thinking on → off');
  });

  it('does not describe a model switch as a runtime-dial change', () => {
    const before = runtimeFooterState({ type: 'openai', model: 'gpt-5.6-sol', thinkingMode: 'xhigh' }, 'gpt-5.6-sol');
    const after = runtimeFooterState({ type: 'openai', model: 'gpt-5.6-terra', thinkingMode: 'medium' }, 'gpt-5.6-terra');
    expect(runtimeFooterChange(before, after)).toBeUndefined();
  });

  it('does not emit a notice on the first observed turn', () => {
    const current = runtimeFooterState({ type: 'openai', model: 'gpt-5.6-sol', thinkingMode: 'medium' }, 'gpt-5.6-sol');
    expect(runtimeFooterChange(undefined, current)).toBeUndefined();
  });
});

describe('resolveTelegramModelSelection', () => {
  it('resolves native OpenAI shortcuts used by Telegram', () => {
    const provider = { type: 'openai' as const, model: 'gpt-5.5' };
    expect(resolveTelegramModelSelection(provider, 'ASTRA').model).toBe('gpt-6-astra');
    expect(resolveTelegramModelSelection(provider, 'sol').model).toBe('gpt-5.6-sol');
    expect(resolveTelegramModelSelection(provider, 'Terra').model).toBe('gpt-5.6-terra');
    expect(resolveTelegramModelSelection(provider, ' luna ').model).toBe('gpt-5.6-luna');
  });

  it('accepts catalogued OpenAI ids and rejects unknown ids', () => {
    const provider = { type: 'openai' as const };
    expect(resolveTelegramModelSelection(provider, 'gpt-5.5').model).toBe('gpt-5.5');
    expect(resolveTelegramModelSelection(provider, 'gpt-made-up').error).toBe(
      'Unknown OpenAI model: gpt-made-up',
    );
  });

  it('keeps existing Claude aliases and full model ids working', () => {
    const provider = { type: 'claude' as const };
    expect(resolveTelegramModelSelection(provider, 'opus').model).toBeTruthy();
    expect(resolveTelegramModelSelection(provider, 'fable51').model).toBe('claude-fable-5-1');
    expect(resolveTelegramModelSelection(provider, 'claude-sonnet-4-5').model).toBe('claude-sonnet-4-5');
  });

  it('rejects providers whose models are managed externally', () => {
    expect(resolveTelegramModelSelection({ type: 'gemini' }, 'anything').error).toMatch(
      /manages its model outside ClaudeClaw/,
    );
  });
});

describe('splitMessage', () => {
  it('returns single-element array for short messages', () => {
    const result = splitMessage('Hello, world!');
    expect(result).toEqual(['Hello, world!']);
  });

  it('returns single-element array for empty string', () => {
    const result = splitMessage('');
    expect(result).toEqual(['']);
  });

  it('returns single-element array for exact 4096 char message', () => {
    const msg = 'x'.repeat(4096); // Non-hex text, outside the credential detector.
    const result = splitMessage(msg);
    expect(result).toEqual([msg]);
  });

  it('splits 4097 char message into two parts', () => {
    const msg = 'x'.repeat(4097);
    const result = splitMessage(msg);
    expect(result.length).toBe(2);
    // Reconstruct the original - parts should cover all chars
    expect(result.join('').length).toBe(4097);
  });

  it('never produces chunks longer than 4096 chars', () => {
    const msg = 'x'.repeat(10000);
    const result = splitMessage(msg);
    for (const part of result) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
  });

  it('splits on newline boundaries when possible', () => {
    // Create a message with newlines where the total exceeds 4096
    const line = 'x'.repeat(2000);
    const msg = `${line}\n${line}\n${line}`;
    // Total: 2000 + 1 + 2000 + 1 + 2000 = 6002
    const result = splitMessage(msg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // First chunk should end at a newline boundary
    // (i.e., should be 2000 + 1 + 2000 = 4001 which fits in 4096)
    expect(result[0]).toContain('\n');
  });

  it('handles message with many short lines', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `Line ${i}`);
    const msg = lines.join('\n');
    const result = splitMessage(msg);
    for (const part of result) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
    // All content should be preserved
    expect(result.join('').replace(/^\s+/gm, '')).toBeTruthy();
  });

  it('handles message with no newlines that exceeds limit', () => {
    const msg = 'x'.repeat(8192);
    const result = splitMessage(msg);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(4096);
    expect(result[1].length).toBe(4096);
  });
});

describe('extractFileMarkers', () => {
  // ── Basic extraction ──────────────────────────────────────────────

  it('returns text unchanged when no markers present', () => {
    const input = 'Here is your report. Let me know if you need anything else.';
    const result = extractFileMarkers(input);
    expect(result.text).toBe(input);
    expect(result.files).toEqual([]);
  });

  it('extracts a single SEND_FILE marker', () => {
    const input = 'Here is the PDF.\n[SEND_FILE:/tmp/report.pdf]\nLet me know if you need changes.';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      type: 'document',
      filePath: '/tmp/report.pdf',
      caption: undefined,
    });
    expect(result.text).toBe('Here is the PDF.\n\nLet me know if you need changes.');
  });

  it('extracts a single SEND_PHOTO marker', () => {
    const input = 'Here is the chart.\n[SEND_PHOTO:/tmp/chart.png]';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      type: 'photo',
      filePath: '/tmp/chart.png',
      caption: undefined,
    });
    expect(result.text).toBe('Here is the chart.');
  });

  // ── Captions ──────────────────────────────────────────────────────

  it('extracts caption from pipe separator', () => {
    const input = '[SEND_FILE:/tmp/report.pdf|Q1 Financial Report]';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      type: 'document',
      filePath: '/tmp/report.pdf',
      caption: 'Q1 Financial Report',
    });
  });

  it('trims whitespace from caption and path', () => {
    const input = '[SEND_FILE: /tmp/report.pdf | Q1 Report ]';
    const result = extractFileMarkers(input);
    expect(result.files[0].filePath).toBe('/tmp/report.pdf');
    expect(result.files[0].caption).toBe('Q1 Report');
  });

  it('treats empty caption as undefined', () => {
    const input = '[SEND_FILE:/tmp/report.pdf|]';
    const result = extractFileMarkers(input);
    expect(result.files[0].caption).toBeUndefined();
  });

  // ── Multiple files ────────────────────────────────────────────────

  it('extracts multiple file markers', () => {
    const input = 'Here are both files.\n[SEND_FILE:/tmp/report.pdf]\n[SEND_PHOTO:/tmp/chart.png]\nDone.';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].type).toBe('document');
    expect(result.files[0].filePath).toBe('/tmp/report.pdf');
    expect(result.files[1].type).toBe('photo');
    expect(result.files[1].filePath).toBe('/tmp/chart.png');
    expect(result.text).toBe('Here are both files.\n\nDone.');
  });

  it('extracts multiple files with captions', () => {
    const input = '[SEND_FILE:/tmp/a.pdf|First doc]\n[SEND_FILE:/tmp/b.xlsx|Second doc]';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].caption).toBe('First doc');
    expect(result.files[1].caption).toBe('Second doc');
  });

  // ── Path variations ───────────────────────────────────────────────

  it('handles paths with spaces', () => {
    const input = '[SEND_FILE:/tmp/test/My Report.pdf]';
    const result = extractFileMarkers(input);
    expect(result.files[0].filePath).toBe('/tmp/test/My Report.pdf');
  });

  it('handles deep nested paths', () => {
    const input = '[SEND_FILE:/tmp/test/output/nested/deep/file.csv]';
    const result = extractFileMarkers(input);
    expect(result.files[0].filePath).toBe('/tmp/test/output/nested/deep/file.csv');
  });

  it('handles various file extensions', () => {
    const extensions = ['pdf', 'xlsx', 'csv', 'png', 'jpg', 'zip', 'docx', 'mp4', 'txt'];
    for (const ext of extensions) {
      const input = `[SEND_FILE:/tmp/file.${ext}]`;
      const result = extractFileMarkers(input);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].filePath).toBe(`/tmp/file.${ext}`);
    }
  });

  // ── Text cleanup ──────────────────────────────────────────────────

  it('collapses triple+ newlines left after marker removal', () => {
    const input = 'Before.\n\n\n[SEND_FILE:/tmp/f.pdf]\n\n\nAfter.';
    const result = extractFileMarkers(input);
    // Should not have more than two consecutive newlines
    expect(result.text).not.toMatch(/\n{3,}/);
    expect(result.text).toContain('Before.');
    expect(result.text).toContain('After.');
  });

  it('trims leading/trailing whitespace from cleaned text', () => {
    const input = '\n\n[SEND_FILE:/tmp/f.pdf]\n\nHere you go.';
    const result = extractFileMarkers(input);
    expect(result.text).toBe('Here you go.');
  });

  it('returns empty string when response is only a marker', () => {
    const input = '[SEND_FILE:/tmp/report.pdf]';
    const result = extractFileMarkers(input);
    expect(result.text).toBe('');
    expect(result.files).toHaveLength(1);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it('extracts unbracketed markers with absolute paths', () => {
    // The dashboard demo failed when an agent emitted a marker
    // without surrounding brackets (`SEND_PHOTO|https://...`). The
    // tolerant matcher now extracts those so the chat doesn't show
    // the raw command string. We require an absolute path or a URL
    // so unrelated prose like "SEND_FILE:later" doesn't match.
    const input = 'SEND_FILE:/tmp/report.pdf';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ type: 'document', filePath: '/tmp/report.pdf' });
  });

  it('extracts unbracketed SEND_PHOTO with pipe and http URL', () => {
    const input = 'Here it is. SEND_PHOTO|https://example.com/photo.png|nice shot';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      type: 'photo',
      filePath: 'https://example.com/photo.png',
      caption: 'nice shot',
    });
  });

  it('does not match unknown marker types', () => {
    const input = '[SEND_VIDEO:/tmp/video.mp4]';
    const result = extractFileMarkers(input);
    expect(result.files).toEqual([]);
    expect(result.text).toBe(input);
  });

  it('does not match markers with empty path', () => {
    const input = '[SEND_FILE:]';
    const result = extractFileMarkers(input);
    // The regex requires at least one char in the path group
    expect(result.files).toEqual([]);
  });

  it('handles marker embedded in a sentence', () => {
    const input = 'I created the file [SEND_FILE:/tmp/out.pdf] for you.';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filePath).toBe('/tmp/out.pdf');
    expect(result.text).toBe('I created the file  for you.');
  });

  it('preserves text around multiple markers on separate lines', () => {
    const input = 'Line 1\n[SEND_FILE:/a.pdf]\nLine 2\n[SEND_FILE:/b.pdf]\nLine 3';
    const result = extractFileMarkers(input);
    expect(result.files).toHaveLength(2);
    expect(result.text).toContain('Line 1');
    expect(result.text).toContain('Line 2');
    expect(result.text).toContain('Line 3');
  });
});
