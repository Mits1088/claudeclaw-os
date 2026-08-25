import type { CostFooterMode } from './config.js';
import type { UsageInfo } from './agent.js';
import { modelDisplayLabel } from './model-catalog.js';

/**
 * Format token counts for display.
 * 45000 -> "45k", 1200000 -> "1.2M", 500 -> "500"
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Build a cost footer string to append to Telegram responses.
 * Returns empty string if mode is 'off' or no usage data.
 *
 * Modes:
 *   'compact' - model name only (good for subscription users)
 *   'verbose' - model + token counts
 *   'cost'    - model + cost (for pay-per-use users)
 *   'full'    - model + tokens + cost
 *   'off'     - nothing
 */
export function buildCostFooter(
  mode: CostFooterMode,
  usage: UsageInfo | null,
  model?: string,
  effort?: string,
  runtimeChange?: string,
): string {
  if (mode === 'off' || !usage) return '';

  // Catalog label ("Opus 5", "GPT-5.6 Sol"); an unknown id or a provider-type
  // fallback ("openai") passes through as-is. Effort rides along when the turn
  // ran with one so the tag reports the dial, not just the model.
  const base = model ? modelDisplayLabel(model) : 'unknown';
  const runtimeLabel = effort ? `${base} · ${effort}` : base;
  const modelLabel = runtimeChange ? `${runtimeLabel} | ${runtimeChange}` : runtimeLabel;

  if (mode === 'compact') {
    return `\n\n[${modelLabel}]`;
  }

  if (mode === 'verbose') {
    const inTokens = formatTokens(usage.inputTokens);
    const outTokens = formatTokens(usage.outputTokens);
    return `\n\n[${modelLabel} | ${inTokens} in | ${outTokens} out]`;
  }

  // An em dash, not "$0.00": a turn nobody priced is not a free turn, and the
  // footer is the one place a reader forms an intuition about what a turn cost.
  const cost = usage.costSource === 'provider' ? `$${usage.totalCostUsd.toFixed(2)}` : '—';

  if (mode === 'cost') {
    return `\n\n[${modelLabel} | ${cost}]`;
  }

  if (mode === 'full') {
    const inTokens = formatTokens(usage.inputTokens);
    const outTokens = formatTokens(usage.outputTokens);
    return `\n\n[${modelLabel} | ${inTokens} in | ${outTokens} out | ${cost}]`;
  }

  return '';
}
