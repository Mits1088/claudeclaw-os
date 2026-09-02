import { describe, it, expect } from 'vitest';

import {
  parseReply,
  renderQuestion,
  feedPendingMattermostQuestion,
  hasPendingMattermostQuestion,
} from './mattermost-askuserquestion.js';
import type { AskUserQuestionItem } from './agent-engine/index.js';

const singleQ: AskUserQuestionItem = {
  header: 'Env',
  question: 'Welche Umgebung?',
  multiSelect: false,
  options: [
    { label: 'Produktion', description: 'live' },
    { label: 'Staging', description: 'test' },
    { label: 'Lokal' },
  ],
};

const multiQ: AskUserQuestionItem = { ...singleQ, multiSelect: true };

describe('parseReply', () => {
  it('maps a single number to its option label', () => {
    expect(parseReply('2', singleQ)).toEqual({ selected: ['Staging'] });
  });

  it('takes only the first number for single-select even if several given', () => {
    expect(parseReply('1,3', singleQ)).toEqual({ selected: ['Produktion'] });
  });

  it('keeps all numbers for multi-select', () => {
    expect(parseReply('1,3', multiQ)).toEqual({ selected: ['Produktion', 'Lokal'] });
  });

  it('recognises stop / abbrechen as a stop control', () => {
    expect(parseReply('stop', singleQ)).toEqual({ control: 'stop' });
    expect(parseReply('Abbrechen', singleQ)).toEqual({ control: 'stop' });
  });

  it('recognises go / weiter as a go control', () => {
    expect(parseReply('go', singleQ)).toEqual({ control: 'go' });
    expect(parseReply('weiter', singleQ)).toEqual({ control: 'go' });
  });

  it('passes free text through verbatim', () => {
    expect(parseReply('etwas ganz anderes', singleQ)).toEqual({ selected: ['etwas ganz anderes'] });
  });

  it('treats out-of-range numbers as free text', () => {
    expect(parseReply('9', singleQ)).toEqual({ selected: ['9'] });
  });
});

describe('renderQuestion', () => {
  it('renders Markdown with numbered options and a reply hint', () => {
    const out = renderQuestion(singleQ, 0, 1);
    expect(out).toContain('**Welche Umgebung?**');
    expect(out).toContain('**1.** Produktion — live');
    expect(out).toContain('**2.** Staging — test');
    expect(out).toContain('`go`');
    expect(out).toContain('`stop`');
  });

  it('adds a progress prefix when there are multiple questions', () => {
    expect(renderQuestion(singleQ, 1, 3)).toContain('(2/3)');
  });

  it('hints multi-select syntax only for multi questions', () => {
    expect(renderQuestion(multiQ, 0, 1)).toContain('mehrere mit Komma');
    expect(renderQuestion(singleQ, 0, 1)).not.toContain('mehrere mit Komma');
  });
});

describe('feedPendingMattermostQuestion', () => {
  it('returns false when no question is pending for the channel', () => {
    expect(hasPendingMattermostQuestion('chan-none')).toBe(false);
    expect(feedPendingMattermostQuestion('chan-none', 'hi')).toBe(false);
  });
});
