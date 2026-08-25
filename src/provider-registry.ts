import { ENABLE_ACP } from './config.js';
import type { ProviderType } from './provider.js';

/**
 * Single source of truth for provider metadata and enablement.
 *
 * Providers fall into two tiers:
 *  - `stable`       — first-class, supported: Claude (the default catalyst) and
 *                     native OpenAI (Codex SDK). Always offered; never behind a
 *                     casual beta flag.
 *  - `experimental` — the ACP family (acp-codex, Gemini, OpenCode, OpenRouter,
 *                     custom). Opt-in via ENABLE_ACP; model behavior is less
 *                     proven and latency is higher. Deferred for later polish.
 *
 * Enablement drives both "can this run" and "should the UI offer it":
 *  - `always`  — usable unconditionally (Claude: the SDK is bundled).
 *  - `auth`    — usable when authenticated; auth is enforced at call time by
 *                the engine adapter (which surfaces an actionable error), NOT
 *                as a runtime gate, so OpenAI is ungated and first-class.
 *  - `acp-beta`— usable only when ENABLE_ACP is set (the experimental opt-in).
 *
 * Everything provider-keyed — the engine factory, provider selection, model
 * resolution, the dashboard, and the web UI — reads from here, so adding or
 * regrading a provider is one edit and engine/model decisions can never drift
 * apart.
 */
export type ProviderTier = 'stable' | 'experimental';
export type ProviderEnablement = 'always' | 'auth' | 'acp-beta';

export interface ProviderDescriptor {
  type: ProviderType;
  /** Human-readable name for pickers, badges, and status lines. */
  label: string;
  tier: ProviderTier;
  enablement: ProviderEnablement;
}

export const PROVIDER_REGISTRY: Record<ProviderType, ProviderDescriptor> = {
  claude: { type: 'claude', label: 'Claude', tier: 'stable', enablement: 'always' },
  openai: { type: 'openai', label: 'OpenAI', tier: 'stable', enablement: 'auth' },
  // Experimental TIER (unproven model behavior on this runtime) but `auth`
  // ENABLEMENT, not `acp-beta`: it is not an ACP provider and has none of the
  // ACP family's latency or protocol caveats, so gating it behind ENABLE_ACP
  // would be filing it under the wrong problem. Auth is enforced at call time
  // — a missing key fails the turn loudly rather than silently downgrading.
  //
  // The user-facing feature is Z.ai / GLM — the built-in, tested endpoint and
  // the default models. `anthropic-compatible` is the internal abstraction the
  // type id keeps; other endpoints speaking the same protocol remain available
  // as advanced configuration (.env), which is why the label names the vendor
  // users actually configure, not the wire protocol.
  'anthropic-compatible': {
    type: 'anthropic-compatible',
    label: 'Z.ai (GLM)',
    tier: 'experimental',
    enablement: 'auth',
  },
  'acp-codex': { type: 'acp-codex', label: 'Codex (ACP)', tier: 'experimental', enablement: 'acp-beta' },
  gemini: { type: 'gemini', label: 'Gemini', tier: 'experimental', enablement: 'acp-beta' },
  opencode: { type: 'opencode', label: 'OpenCode', tier: 'experimental', enablement: 'acp-beta' },
  openrouter: { type: 'openrouter', label: 'OpenRouter', tier: 'experimental', enablement: 'acp-beta' },
  acp: { type: 'acp', label: 'Custom ACP', tier: 'experimental', enablement: 'acp-beta' },
};

export function providerDescriptor(type: ProviderType): ProviderDescriptor {
  return PROVIDER_REGISTRY[type] ?? PROVIDER_REGISTRY.claude;
}

/**
 * Whether the engine for `type` may run a turn now. Stable providers (`always`
 * / `auth`) always run — for `auth` providers the adapter enforces auth at call
 * time with a friendly error, so there is no runtime gate to leak past.
 * Experimental (`acp-beta`) providers require the ENABLE_ACP opt-in.
 *
 * This is THE gate: the engine factory, `getSelectedProviderConfig`, and model
 * resolution all consult it, so a gated-off provider can never reach its engine
 * with its (wrong-for-the-fallback) model.
 */
export function providerRunnable(type: ProviderType): boolean {
  return providerDescriptor(type).enablement !== 'acp-beta' || ENABLE_ACP;
}

/**
 * Whether to offer `type` in the provider picker. Same rule as runnable today
 * (stable always, experimental under the beta flag) — kept as its own function
 * because visibility and runnability can diverge later (e.g. a "coming soon"
 * tier that is visible but not yet runnable).
 */
export function providerVisible(type: ProviderType): boolean {
  return providerRunnable(type);
}

/** Descriptors for every provider the picker should currently offer. */
export function selectableProviders(): ProviderDescriptor[] {
  return Object.values(PROVIDER_REGISTRY).filter((p) => providerVisible(p.type));
}
