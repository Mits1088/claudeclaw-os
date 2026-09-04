import { describe, expect, it } from 'vitest';

import { contextWindowForOpenAiModel, ratesForOpenAiModel } from './openai-pricing.js';

describe('OpenAI model pricing', () => {
  it.each([
    ['gpt-6-astra', 10, 1, 50],
    ['gpt-5.6-sol', 5, 0.5, 30],
    ['gpt-5.6-terra', 2.5, 0.25, 15],
    ['gpt-5.6-luna', 1, 0.1, 6],
  ])('uses published rates for %s', (model, inputPerM, cachedInputPerM, outputPerM) => {
    expect(ratesForOpenAiModel(model)).toEqual({ inputPerM, cachedInputPerM, outputPerM });
  });

  it('reports Astra\'s published context window', () => {
    expect(contextWindowForOpenAiModel('gpt-6-astra')).toBe(1_050_000);
  });
});
