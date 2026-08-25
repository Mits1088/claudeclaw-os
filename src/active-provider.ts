import { compatModelName } from './anthropic-compat-env.js';
import { agentProvider, DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL } from './config.js';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_PROVIDER,
  getMainProviderConfig,
  type ProviderConfig,
} from './provider.js';
import { providerRunnable } from './provider-registry.js';

/**
 * The provider that should actually run this turn. Resolves the saved config
 * (per-agent override, else main) and falls back to Claude when that provider
 * isn't runnable — an experimental (ACP-family) type while ENABLE_ACP is off.
 * This is the ONE place execution paths resolve the provider, so the engine and
 * the model always come from the same decision (no gated-off provider ever
 * reaches the Claude adapter carrying, say, a `gpt-5.5` model).
 */
export function getSelectedProviderConfig(): ProviderConfig {
  const saved = agentProvider ?? getMainProviderConfig();
  return providerRunnable(saved.type) ? saved : { ...DEFAULT_PROVIDER };
}

export function defaultModelForProvider(
  provider: ProviderConfig,
  claudeDefault = DEFAULT_CLAUDE_MODEL,
): string | undefined {
  if (provider.model) return provider.model;
  switch (provider.type) {
    case 'claude': return claudeDefault;
    case 'openai': return DEFAULT_OPENAI_MODEL;
    case 'acp-codex': return DEFAULT_CODEX_MODEL;
    case 'openrouter': return DEFAULT_OPENROUTER_MODEL;
    // The model name is also set in the subprocess env (ANTHROPIC_MODEL et al.);
    // returning it here keeps the reported runtime identity and the dashboard
    // honest about which model actually ran.
    case 'anthropic-compatible': return compatModelName();
    default: return undefined;
  }
}
