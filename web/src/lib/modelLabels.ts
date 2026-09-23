// Web-side mirror of src/model-catalog.ts. This bundle is built by Vite and
// cannot import the server module, so the map is duplicated by necessity —
// src/model-catalog.test.ts asserts the two stay identical, so a model added
// to the catalog fails the suite until it is added here too.
const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'gpt-6-astra': 'GPT-6 Astra',
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

// Selectable Claude ids in picker order. Mirrors CLAUDE_MODEL_OPTIONS.
export const CLAUDE_MODEL_IDS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
];

export function modelLabel(model?: string): string {
  return model ? (MODEL_LABELS[model] ?? model) : 'default';
}

export const MODEL_LABEL_MAP = MODEL_LABELS;
