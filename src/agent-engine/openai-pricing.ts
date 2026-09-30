import { readEnvFile } from '../env.js';

/**
 * Local cost estimation for the native OpenAI (Codex SDK) provider.
 *
 * The Codex CLI reports token usage per turn (input / cached-input / output /
 * reasoning) but no dollar cost — unlike the Claude SDK's `total_cost_usd`.
 * We compute an ESTIMATE from a per-1M-token rate table so the cost footer,
 * daily budget, and /savings observability keep working on GPT turns.
 *
 * Callers should treat the result as approximate: ChatGPT-subscription auth
 * (`codex login`) is flat-rate, so the estimate then represents what the turn
 * WOULD have cost on API billing, not an actual charge.
 *
 * Rates are overridable without a code change via OPENAI_PRICING_JSON in .env:
 *   OPENAI_PRICING_JSON={"gpt-5.5":{"inputPerM":1.25,"cachedInputPerM":0.125,"outputPerM":10}}
 * Keys match on longest prefix of the model id, so "gpt-5.5" also covers
 * "gpt-5.5-codex" unless a more specific key is present.
 */
export interface OpenAiModelRates {
  /** USD per 1M non-cached input tokens. */
  inputPerM: number;
  /** USD per 1M cached input tokens. */
  cachedInputPerM: number;
  /** USD per 1M output tokens (reasoning tokens are billed as output). */
  outputPerM: number;
}

// OpenAI API list prices per 1M tokens. GPT-5.x rates were verified July 2026;
// GPT-6 Astra was verified September 2026. The base tier
// tracks gpt-5.5 ($5 in / $0.50 cached / $30 out). Point releases keep their
// tier's pricing, so these tier defaults cover unknown future ids; exact
// per-model rates can always be pinned via OPENAI_PRICING_JSON. NOTE: these
// power the cost ESTIMATE only — on ChatGPT-subscription auth the real marginal
// cost is $0; for API-key billing they should be kept current.
const TIER_BASE: OpenAiModelRates = { inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30 };
const TIER_MINI: OpenAiModelRates = { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 8 };
const TIER_NANO: OpenAiModelRates = { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2 };

// Exact per-model overrides (longest-prefix match, so 'gpt-5.5-pro' and
// 'gpt-5.4-mini' correctly beat 'gpt-5.5'/'gpt-5.4'). Verified July 2026;
// cached rate is OpenAI's standard 10% of input where not separately published.
// Override any of these via OPENAI_PRICING_JSON.
const MODEL_RATES: Record<string, OpenAiModelRates> = {
  // Standard API rates verified 2026-09-22: https://developers.openai.com/api/docs/pricing
  // GPT-6.1 Sol rates verified 2026-09-29 against its official model page.
  'gpt-6.1-sol': { inputPerM: 2, cachedInputPerM: 0.1, outputPerM: 10 },
  'gpt-6-sol': { inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 10 },
  'gpt-6-luna': { inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.5 },
  'gpt-6-astra': { inputPerM: 10, cachedInputPerM: 1, outputPerM: 50 },
  'gpt-5.6-sol': { inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30 },
  'gpt-5.6-terra': { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15 },
  'gpt-5.6-luna': { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 6 },
  'gpt-5.5-pro': { inputPerM: 30, cachedInputPerM: 3, outputPerM: 180 },
  'gpt-5.5': { inputPerM: 5, cachedInputPerM: 0.5, outputPerM: 30 },
  'gpt-5.4-mini': { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
  'gpt-5.4': { inputPerM: 2.5, cachedInputPerM: 0.25, outputPerM: 15 },
};

// NOTE: GPT-5.x applies a long-context surcharge (2x input / 1.5x output) when
// a single REQUEST exceeds 272k input tokens. We deliberately do NOT apply it
// here: Codex's turn.completed reports usage AGGREGATED across every model call
// in the agentic turn, so a multi-call tool loop can sum past 272k without any
// individual request crossing it — applying the surcharge on the aggregate
// would over-bill and trip budgets early. Per-request usage isn't exposed, so
// the estimate omits the surcharge (and thus slightly under-counts genuinely
// huge single requests) rather than over-count the common case.

let envOverridesCache: Record<string, Partial<OpenAiModelRates>> | undefined;

// Lazily loaded on the first pricing lookup (i.e. the first GPT turn) rather
// than at import — this module is imported unconditionally via the engine
// factory, so eager loading would make every boot (including Claude-only
// installs that never touch OpenAI) re-read and parse .env for a key that is
// almost always unset. Cached after the first read; an .env pricing edit needs
// a restart, same as every other config value.
function envOverrides(): Record<string, Partial<OpenAiModelRates>> {
  if (envOverridesCache) return envOverridesCache;
  const raw = process.env.OPENAI_PRICING_JSON || readEnvFile(['OPENAI_PRICING_JSON']).OPENAI_PRICING_JSON;
  if (!raw) return (envOverridesCache = {});
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<OpenAiModelRates>>;
    return (envOverridesCache = parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    return (envOverridesCache = {});
  }
}

function longestPrefixMatch<T>(id: string, table: Record<string, T>): T | undefined {
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (!id.startsWith(key.toLowerCase())) continue;
    if (!bestKey || key.length > bestKey.length) bestKey = key;
  }
  return bestKey ? table[bestKey] : undefined;
}

/**
 * Resolve rates for a model id. Tier is picked by keyword (nano/mini/base) so
 * point releases like "gpt-5.4-mini" price correctly without a table entry.
 * OPENAI_PRICING_JSON overrides merge over the tier via longest-prefix match,
 * so a partial override (e.g. just outputPerM) keeps the other rates.
 */
export function ratesForOpenAiModel(model: string | undefined): OpenAiModelRates {
  const id = (model ?? '').toLowerCase().trim();
  const tier = id.includes('nano') ? TIER_NANO : id.includes('mini') ? TIER_MINI : TIER_BASE;
  // Exact model rates beat the tier default; env overrides beat everything.
  const modelSpecific = longestPrefixMatch(id, MODEL_RATES);
  const override = longestPrefixMatch(id, envOverrides());
  return { ...tier, ...modelSpecific, ...override };
}

/** Token counts as reported by the Codex CLI's turn.completed event. */
export interface OpenAiTurnTokens {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

/**
 * Estimate the USD cost of one turn. `input_tokens` includes the cached
 * portion (OpenAI usage-object convention), so cached tokens are subtracted
 * from the full-rate bucket and billed at the cached rate instead. When the
 * turn's input crosses the long-context threshold, GPT-5.x bills the whole
 * turn at the surcharge multipliers.
 */
export function estimateOpenAiCostUsd(model: string | undefined, usage: OpenAiTurnTokens): number {
  const rates = ratesForOpenAiModel(model);
  const cached = Math.max(0, usage.cached_input_tokens || 0);
  const uncached = Math.max(0, (usage.input_tokens || 0) - cached);
  const output = Math.max(0, usage.output_tokens || 0);
  return (
    (uncached * rates.inputPerM + cached * rates.cachedInputPerM + output * rates.outputPerM) / 1_000_000
  );
}

/**
 * Context-window size (tokens) surfaced through AgentEngineUsage.contextWindow
 * so the dashboard gauge is GPT-appropriate instead of the Claude-sized
 * CONTEXT_LIMIT. Defaults to 272k: the GPT-5.5 API window is larger (~1.05M),
 * but 272k is the documented threshold where per-token pricing steps up (2x
 * input / 1.5x output) — a genuinely useful "you're now in expensive territory"
 * line to gauge against, and conservative so the meter never shows phantom
 * headroom. Fully model-specific windows aren't modeled here; override with
 * OPENAI_CONTEXT_WINDOW for a specific deployment.
 */
const DEFAULT_OPENAI_CONTEXT_WINDOW = 272_000;

const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'gpt-6-astra': 1_050_000,
  'gpt-6.1-sol': 1_050_000,
  'gpt-6-sol': 1_050_000,
  'gpt-6-luna': 1_050_000,
};

export function contextWindowForOpenAiModel(model: string | undefined): number {
  const raw = process.env.OPENAI_CONTEXT_WINDOW || readEnvFile(['OPENAI_CONTEXT_WINDOW']).OPENAI_CONTEXT_WINDOW;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return MODEL_CONTEXT_WINDOWS[(model ?? '').toLowerCase().trim()] ?? DEFAULT_OPENAI_CONTEXT_WINDOW;
}
