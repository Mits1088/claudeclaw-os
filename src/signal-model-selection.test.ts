import { describe, expect, it } from 'vitest';

import { resolveSignalTurnModel } from './signal-bot.js';

describe('resolveSignalTurnModel', () => {
  it('uses Claude configuration for Claude turns', () => {
    expect(resolveSignalTurnModel({ type: 'claude' }, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it.each(['sdk', 'app-server'] as const)('uses the OpenAI provider model for %s transport', () => {
    expect(resolveSignalTurnModel({ type: 'openai', model: 'gpt-5.6-sol' }, 'claude-opus-4-8'))
      .toBe('gpt-5.6-sol');
  });

  it('does not pass the Claude selection to an externally managed provider', () => {
    expect(resolveSignalTurnModel({ type: 'openrouter', model: 'vendor/model' }, 'claude-opus-4-8'))
      .toBe('vendor/model');
  });
});
