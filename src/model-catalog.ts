import type { ProviderConfig } from './provider.js';

export interface ModelOption {
  id: string;
  label: string;
}

export interface RuntimeOption {
  id: string;
  label: string;
}

export interface StaticRuntimeOptions {
  modeLabel?: string;
  thinkingLabel?: string;
  modeOptions: RuntimeOption[];
  thinkingOptions: RuntimeOption[];
}

const MODEL_LABELS: Readonly<Record<string, string>> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.2': 'GPT-5.2',
};

export function modelDisplayLabel(model: string | undefined): string {
  if (!model) return 'default';
  return MODEL_LABELS[model] ?? model;
}

function uniqueOptions(ids: string[]): ModelOption[] {
  return Array.from(new Set(ids)).map((id) => ({ id, label: modelDisplayLabel(id) }));
}

// Keep older supported models selectable; remove only against provider retirement notices.
// Catalogs reviewed 2026-10-12.
export const CLAUDE_MODEL_OPTIONS: readonly ModelOption[] = uniqueOptions([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]);

export const OPENAI_MODEL_OPTIONS: readonly ModelOption[] = uniqueOptions([
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
]);

export const VALID_CLAUDE_MODELS = CLAUDE_MODEL_OPTIONS.map((option) => option.id);

const CLAUDE_EFFORT_DEFAULT_HIGH = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const CLAUDE_EFFORT_NO_XHIGH = ['', 'low', 'medium', 'high', 'max'] as const;
const OPENAI_ASTRA_EFFORT = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_SOL_LUNA_EFFORT = ['', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const OPENAI_LEGACY_EFFORT = ['', 'low', 'medium', 'high', 'xhigh'] as const;

function effortOptions(values: readonly string[], defaultEffort: 'high' | 'medium'): RuntimeOption[] {
  return values.map((id) => ({
    id,
    label: id === ''
      ? `Default (${defaultEffort})`
      : id === 'xhigh'
        ? 'Extra high'
        : id.charAt(0).toUpperCase() + id.slice(1),
  }));
}

function claudeEffortIds(model: string): readonly string[] {
  if (model === 'claude-haiku-4-5' || model === 'claude-sonnet-4-5') return [];
  if (model === 'claude-opus-4-6' || model === 'claude-sonnet-4-6') {
    return CLAUDE_EFFORT_NO_XHIGH;
  }
  return CLAUDE_EFFORT_DEFAULT_HIGH;
}

function claudeThinkingOptions(model: string): RuntimeOption[] {
  // These models use adaptive thinking as part of their model contract. The
  // model default is safer than exposing the legacy extended-thinking switch.
  if (model === 'claude-opus-5-5'
    || model === 'claude-opus-5'
    || model === 'claude-fable-5-1'
    || model === 'claude-fable-5'
    || model === 'claude-haiku-5-5'
    || model === 'claude-sonnet-5-5'
    || model === 'claude-sonnet-5') {
    return [];
  }
  if (model === 'claude-haiku-4-5' || model === 'claude-sonnet-4-5') {
    return [
      { id: '', label: 'Default (off)' },
      { id: 'off', label: 'Off' },
      { id: 'on', label: 'On' },
    ];
  }
  return [
    { id: '', label: 'Default' },
    { id: 'off', label: 'Off' },
    { id: 'on', label: 'On (adaptive)' },
  ];
}

export function staticRuntimeOptionsFor(provider: ProviderConfig, requestedModel?: string): StaticRuntimeOptions | null {
  const model = requestedModel || provider.model;
  if (provider.type === 'claude') {
    const effectiveModel = model || 'claude-opus-5-5';
    return {
      modeLabel: 'Effort',
      thinkingLabel: 'Thinking',
      modeOptions: effortOptions(claudeEffortIds(effectiveModel), (effectiveModel === 'claude-opus-5-5' || effectiveModel === 'claude-haiku-5-5') ? 'medium' : 'high'),
      thinkingOptions: claudeThinkingOptions(effectiveModel),
    };
  }
  if (provider.type === 'openai') {
    const effectiveModel = model || 'gpt-6-sol';
    return {
      thinkingLabel: 'Reasoning effort',
      modeOptions: [],
      thinkingOptions: effortOptions(
        (effectiveModel === 'gpt-6-astra' || effectiveModel === 'gpt-6.1-sol')
          ? OPENAI_ASTRA_EFFORT
          : (effectiveModel === 'gpt-6-sol' || effectiveModel === 'gpt-6-luna' || effectiveModel.startsWith('gpt-5.6-'))
            ? OPENAI_SOL_LUNA_EFFORT
            : OPENAI_LEGACY_EFFORT,
        'medium',
      ),
    };
  }
  return null;
}

function normalizedMode(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized || normalized === 'auto' || normalized === 'default') return undefined;
  if (normalized === 'fast') return 'low';
  if (normalized === 'normal' || normalized === 'balanced') return 'medium';
  if (normalized === 'deep') return 'high';
  if (normalized === 'extra_high') return 'xhigh';
  return normalized;
}

export function normalizedEffortForProvider(
  provider: Pick<ProviderConfig, 'type' | 'model'>,
  value: string | undefined,
): string | undefined {
  const normalized = normalizedMode(value);
  if (!normalized) return undefined;
  const options = staticRuntimeOptionsFor(provider as ProviderConfig, provider.model);
  const allowed = provider.type === 'claude' ? options?.modeOptions : options?.thinkingOptions;
  return allowed?.some((option) => option.id === normalized) ? normalized : undefined;
}

// Which persisted field carries "effort" depends on the provider: Claude spends
// `runtimeMode` on it, while OpenAI has no mode list at all (reconcile clears any
// runtimeMode it carries) and the dashboard writes its "Reasoning effort" pill
// into `thinkingMode` — the field the codex adapters read. This helper is the
// single place that knows the asymmetry; the identity line and the cost footer
// both resolve through it so they report the dial the turn actually runs on.
export function selectedEffortForProvider(
  provider: Pick<ProviderConfig, 'type' | 'model' | 'runtimeMode' | 'thinkingMode'>,
  model?: string,
): string | undefined {
  const source = provider.type === 'openai' ? provider.thinkingMode : provider.runtimeMode;
  return normalizedEffortForProvider({ type: provider.type, model: model ?? provider.model }, source);
}

export type ClaudeThinking =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' };

// Switching model can strand an effort/thinking value the new model doesn't
// support (xhigh is valid on Opus 4.8, not on Sonnet 4.6). Drop only the
// stranded fields, keep the rest, and report what was dropped so the caller
// can tell the user instead of silently changing behaviour.
export function reconcileRuntimeOptions(
  provider: ProviderConfig,
): { provider: ProviderConfig; cleared: Array<{ field: 'runtimeMode' | 'thinkingMode'; label: string; value: string }> } {
  const next: ProviderConfig = { ...provider };
  const cleared: Array<{ field: 'runtimeMode' | 'thinkingMode'; label: string; value: string }> = [];
  const options = staticRuntimeOptionsFor(next, next.model);
  if (!options) return { provider: next, cleared };

  // Claude spends runtimeMode on effort; OpenAI has no mode list at all, so any
  // value it carries is stale and reconciles away with the rest.
  if (next.runtimeMode) {
    const allowed = next.type === 'claude' ? options.modeOptions : [];
    if (!allowed.some((option) => option.id === normalizedMode(next.runtimeMode))) {
      cleared.push({ field: 'runtimeMode', label: options.modeLabel || 'Effort', value: next.runtimeMode });
      delete next.runtimeMode;
    }
  }
  if (next.thinkingMode) {
    if (!options.thinkingOptions.some((option) => option.id === normalizedMode(next.thinkingMode))) {
      cleared.push({ field: 'thinkingMode', label: options.thinkingLabel || 'Thinking', value: next.thinkingMode });
      delete next.thinkingMode;
    }
  }
  return { provider: next, cleared };
}

// `/model reset` means the whole model-specific selection returns to provider
// defaults, not just the model id. Effort and thinking are persisted beside the
// model and otherwise survive a reset, which leaves the dashboard and the next
// provider turn visibly pinned to the old runtime behavior.
export function resetProviderModelSelection(provider: ProviderConfig): ProviderConfig {
  const next: ProviderConfig = { ...provider };
  delete next.model;
  delete next.runtimeMode;
  delete next.thinkingMode;
  return next;
}

export function claudeThinkingForModel(
  model: string,
  requested: string | undefined,
  effort: string | undefined,
): ClaudeThinking | undefined {
  const mode = normalizedMode(requested);
  if (!mode) return undefined;

  if (model === 'claude-haiku-5-5' || model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5' || model === 'claude-fable-5-1' || model === 'claude-fable-5') return undefined;
  if (model === 'claude-opus-5') {
    if (mode === 'off') {
      return effort === 'xhigh' || effort === 'max' ? undefined : { type: 'disabled' };
    }
    return mode === 'on' || mode === 'adaptive' ? { type: 'adaptive' } : undefined;
  }
  if (model === 'claude-sonnet-5') {
    if (mode === 'off') return { type: 'disabled' };
    return mode === 'on' || mode === 'adaptive' ? { type: 'adaptive' } : undefined;
  }
  if (model === 'claude-haiku-4-5' || model === 'claude-sonnet-4-5') {
    if (mode === 'off') return { type: 'disabled' };
    return mode === 'on' || mode === 'enabled' ? { type: 'enabled', budgetTokens: 16000 } : undefined;
  }
  if (mode === 'off') return { type: 'disabled' };
  return mode === 'on' || mode === 'adaptive' || mode === 'enabled' ? { type: 'adaptive' } : undefined;
}

export function validateProviderModelOptions(provider: ProviderConfig): string | null {
  if (provider.type === 'claude') {
    if (provider.runtimeMode && normalizedEffortForProvider(provider, provider.runtimeMode) === undefined) {
      return `Unsupported effort "${provider.runtimeMode}" for ${modelDisplayLabel(provider.model)}`;
    }
    const thinkingOptions = staticRuntimeOptionsFor(provider, provider.model)?.thinkingOptions ?? [];
    if (provider.thinkingMode && !thinkingOptions.some((option) => option.id === normalizedMode(provider.thinkingMode))) {
      return `Unsupported thinking mode "${provider.thinkingMode}" for ${modelDisplayLabel(provider.model)}`;
    }
  }
  if (provider.type === 'openai'
    && provider.thinkingMode
    && normalizedEffortForProvider(provider, provider.thinkingMode) === undefined) {
    return `Unsupported reasoning effort "${provider.thinkingMode}" for ${modelDisplayLabel(provider.model)}`;
  }
  return null;
}
