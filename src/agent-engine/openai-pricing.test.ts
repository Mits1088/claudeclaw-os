import { describe, expect, it } from 'vitest';

import { contextWindowForOpenAiModel, ratesForOpenAiModel } from './openai-pricing.js';

describe('OpenAI model pricing', () => {
  it.each([
    ['gpt-6-astra', 10, 1, 50],
    ['gpt-6-sol', 2, 0.2, 10],
    ['gpt-6-luna', 0.1, 0.01, 0.5],
    ['gpt-5.6-sol', 5, 0.5, 30],
    ['gpt-5.6-terra', 2.5, 0.25, 15],
    ['gpt-5.6-luna', 1, 0.1, 6],
  ])('uses published rates for %s', (model, inputPerM, cachedInputPerM, outputPerM) => {
    expect(ratesForOpenAiModel(model)).toEqual({ inputPerM, cachedInputPerM, outputPerM });
  });

  it('reports Astra\'s published context window', () => {
    for (const model of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) {
      expect(contextWindowForOpenAiModel(model)).toBe(1_050_000);
    }
  });
});
