import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODEL_OPTIONS,
  OPENAI_MODEL_OPTIONS,
  claudeThinkingForModel,
  modelDisplayLabel,
  normalizedEffortForProvider,
  reconcileRuntimeOptions,
  resetProviderModelSelection,
  staticRuntimeOptionsFor,
  validateProviderModelOptions,
} from './model-catalog.js';

describe('model catalog', () => {
  it('surfaces the frontier models with provider-neutral labels', () => {
    expect(CLAUDE_MODEL_OPTIONS).toContainEqual({ id: 'claude-opus-5', label: 'Opus 5' });
    expect(CLAUDE_MODEL_OPTIONS).toContainEqual({ id: 'claude-fable-5-1', label: 'Fable 5.1' });
    expect(OPENAI_MODEL_OPTIONS).toEqual(expect.arrayContaining([
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ]));
    expect(modelDisplayLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelDisplayLabel('unknown-model')).toBe('unknown-model');
  });

  it('keeps defaults as omission while making the effective default visible', () => {
    const claude = staticRuntimeOptionsFor({ type: 'claude', model: 'claude-opus-5' });
    const openai = staticRuntimeOptionsFor({ type: 'openai', model: 'gpt-5.6-sol' });
    expect(claude?.modeOptions[0]).toEqual({ id: '', label: 'Default (high)' });
    expect(openai?.thinkingOptions[0]).toEqual({ id: '', label: 'Default (medium)' });
  });

  it('uses the model-specific effort matrix', () => {
    const sonnet46 = staticRuntimeOptionsFor({ type: 'claude', model: 'claude-sonnet-4-6' });
    expect(sonnet46?.modeOptions.map((option) => option.id)).toEqual(['', 'low', 'medium', 'high', 'max']);

    const opus5 = staticRuntimeOptionsFor({ type: 'claude', model: 'claude-opus-5' });
    expect(opus5?.modeOptions.map((option) => option.id)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(opus5?.thinkingOptions).toEqual([]);

    const fable51 = staticRuntimeOptionsFor({ type: 'claude', model: 'claude-fable-5-1' });
    expect(fable51?.modeOptions.map((option) => option.id)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(fable51?.thinkingOptions).toEqual([]);

    const haiku = staticRuntimeOptionsFor({ type: 'claude', model: 'claude-haiku-4-5' });
    expect(haiku?.modeOptions).toEqual([]);

    const gpt56 = staticRuntimeOptionsFor({ type: 'openai', model: 'gpt-5.6-terra' });
    expect(gpt56?.thinkingOptions.map((option) => option.id))
      .toEqual(['', 'none', 'low', 'medium', 'high', 'xhigh', 'max']);

    const gpt55 = staticRuntimeOptionsFor({ type: 'openai', model: 'gpt-5.5' });
    expect(gpt55?.thinkingOptions.map((option) => option.id))
      .toEqual(['', 'low', 'medium', 'high', 'xhigh']);
  });

  it('normalizes legacy speed names but drops values invalid for the model', () => {
    expect(normalizedEffortForProvider({ type: 'claude', model: 'claude-opus-5' }, 'deep')).toBe('high');
    expect(normalizedEffortForProvider({ type: 'claude', model: 'claude-sonnet-4-6' }, 'xhigh')).toBeUndefined();
    expect(normalizedEffortForProvider({ type: 'openai', model: 'gpt-5.6-luna' }, 'none')).toBe('none');
  });

  it('never emits legacy extended thinking for adaptive-only frontier models', () => {
    expect(claudeThinkingForModel('claude-opus-5', 'on', 'high')).toEqual({ type: 'adaptive' });
    expect(claudeThinkingForModel('claude-opus-5', 'off', 'xhigh')).toBeUndefined();
    expect(claudeThinkingForModel('claude-fable-5-1', 'on', 'high')).toBeUndefined();
    expect(claudeThinkingForModel('claude-fable-5', 'on', 'high')).toBeUndefined();
    expect(claudeThinkingForModel('claude-haiku-4-5', 'on', undefined))
      .toEqual({ type: 'enabled', budgetTokens: 16000 });
  });

  it('rejects direct API combinations the selected model does not support', () => {
    expect(validateProviderModelOptions({
      type: 'claude',
      model: 'claude-sonnet-4-6',
      runtimeMode: 'xhigh',
    })).toMatch(/unsupported effort/i);
    expect(validateProviderModelOptions({
      type: 'openai',
      model: 'gpt-5.5',
      thinkingMode: 'max',
    })).toMatch(/unsupported reasoning effort/i);
    expect(validateProviderModelOptions({
      type: 'openai',
      model: 'gpt-5.6-sol',
      thinkingMode: 'max',
    })).toBeNull();
  });
});

// The Vite-built dashboard cannot import this module, so web/src/lib/modelLabels.ts
// mirrors the label map by hand. That mirror silently drifted once already
// (it was missing every gpt-5.4/5.3/5.2 entry, so those rendered as raw ids).
// Parse the mirror off disk and assert it still agrees.
describe('web label mirror', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mirrorSource = fs.readFileSync(
    path.join(here, '..', 'web', 'src', 'lib', 'modelLabels.ts'),
    'utf-8',
  );

  function parseMirrorMap(): Record<string, string> {
    const body = mirrorSource.split('const MODEL_LABELS: Record<string, string> = {')[1]?.split('};')[0];
    if (!body) throw new Error('could not locate MODEL_LABELS in web/src/lib/modelLabels.ts');
    const map: Record<string, string> = {};
    for (const line of body.split('\n')) {
      const match = line.match(/^\s*'([^']+)':\s*'([^']+)',/);
      if (match) map[match[1]] = match[2];
    }
    return map;
  }

  it('labels every catalog model exactly as the server does', () => {
    const mirror = parseMirrorMap();
    for (const option of [...CLAUDE_MODEL_OPTIONS, ...OPENAI_MODEL_OPTIONS]) {
      expect(mirror[option.id], `web mirror is missing or misspells ${option.id}`).toBe(option.label);
    }
  });

  it('does not invent labels the server catalog disagrees with', () => {
    for (const [id, label] of Object.entries(parseMirrorMap())) {
      expect(modelDisplayLabel(id), `web mirror disagrees on ${id}`).toBe(label);
    }
  });

  it('mirrors the selectable Claude ids', () => {
    const body = mirrorSource.split('export const CLAUDE_MODEL_IDS = [')[1]?.split('];')[0] ?? '';
    const ids = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect([...ids].sort()).toEqual([...CLAUDE_MODEL_OPTIONS.map((o) => o.id)].sort());
  });
});

describe('reconcileRuntimeOptions', () => {
  it('keeps an effort the new model still supports', () => {
    const { provider, cleared } = reconcileRuntimeOptions({ type: 'claude', model: 'claude-opus-4-8', runtimeMode: 'high' } as any);
    expect(provider.runtimeMode).toBe('high');
    expect(cleared).toEqual([]);
  });

  it('drops xhigh when switching to a model without it', () => {
    const { provider, cleared } = reconcileRuntimeOptions({ type: 'claude', model: 'claude-sonnet-4-6', runtimeMode: 'xhigh' } as any);
    expect(provider.runtimeMode).toBeUndefined();
    expect(cleared).toEqual([{ field: 'runtimeMode', label: 'Effort', value: 'xhigh' }]);
  });

  it('drops an explicit thinking mode on adaptive-thinking models', () => {
    const { provider, cleared } = reconcileRuntimeOptions({ type: 'claude', model: 'claude-opus-5', thinkingMode: 'on' } as any);
    expect(provider.thinkingMode).toBeUndefined();
    expect(cleared.map((c) => c.field)).toEqual(['thinkingMode']);
  });

  it('drops effort but keeps a valid thinking mode on Sonnet 4.5', () => {
    const { provider, cleared } = reconcileRuntimeOptions({ type: 'claude', model: 'claude-sonnet-4-5', runtimeMode: 'high', thinkingMode: 'off' } as any);
    expect(provider.runtimeMode).toBeUndefined();
    expect(provider.thinkingMode).toBe('off');
    expect(cleared.map((c) => c.field)).toEqual(['runtimeMode']);
  });

  it('leaves a reconciled config valid by construction', () => {
    for (const model of CLAUDE_MODEL_OPTIONS.map((o) => o.id)) {
      const { provider } = reconcileRuntimeOptions({ type: 'claude', model, runtimeMode: 'xhigh', thinkingMode: 'on' } as any);
      expect(validateProviderModelOptions(provider), `reconciled ${model} should validate`).toBeNull();
    }
  });

  it('drops a Sol-only reasoning effort when switching OpenAI to GPT-5.5', () => {
    const { provider, cleared } = reconcileRuntimeOptions({
      type: 'openai',
      model: 'gpt-5.5',
      thinkingMode: 'max',
    });
    expect(provider.thinkingMode).toBeUndefined();
    expect(cleared).toEqual([
      { field: 'thinkingMode', label: 'Reasoning effort', value: 'max' },
    ]);
  });

  it('does not touch providers that own their runtime config', () => {
    const input = { type: 'opencode', runtimeMode: 'whatever' } as any;
    const { provider, cleared } = reconcileRuntimeOptions(input);
    expect(provider.runtimeMode).toBe('whatever');
    expect(cleared).toEqual([]);
  });
});

describe('resetProviderModelSelection', () => {
  it('clears the OpenAI model and reasoning effort together', () => {
    expect(resetProviderModelSelection({
      type: 'openai',
      model: 'gpt-5.6-sol',
      thinkingMode: 'xhigh',
    })).toEqual({ type: 'openai' });
  });

  it('clears both Claude runtime dials with the model', () => {
    expect(resetProviderModelSelection({
      type: 'claude',
      model: 'claude-opus-4-8',
      runtimeMode: 'high',
      thinkingMode: 'on',
    })).toEqual({ type: 'claude' });
  });

  it('preserves provider settings unrelated to model selection', () => {
    expect(resetProviderModelSelection({
      type: 'openai',
      model: 'gpt-5.6-sol',
      thinkingMode: 'medium',
      dangerouslySkipPermissions: true,
    })).toEqual({ type: 'openai', dangerouslySkipPermissions: true });
  });
});
