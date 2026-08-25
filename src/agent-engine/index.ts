import { CODEX_TRANSPORT, ENABLE_ACP } from '../config.js';
import type { ProviderConfig } from '../provider.js';
import { providerRunnable } from '../provider-registry.js';
import { AcpEngineAdapter } from './acp-adapter.js';
import { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';
import { CodexAppServerEngineAdapter } from './codex-app-server-adapter.js';
import { CodexSdkEngineAdapter } from './codex-sdk-adapter.js';
import { OpenRouterEngineAdapter } from './openrouter-adapter.js';
import type { AgentEngine } from './types.js';

export * from './types.js';
export { AcpEngineAdapter, getAcpCommand } from './acp-adapter.js';
export { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';
export { CodexAppServerEngineAdapter } from './codex-app-server-adapter.js';
export { CodexSdkEngineAdapter } from './codex-sdk-adapter.js';
export { OpenRouterEngineAdapter } from './openrouter-adapter.js';

export class EngineFactory {
  static forProvider(provider: ProviderConfig): AgentEngine {
    // Single gate (src/provider-registry.ts): a provider that isn't runnable —
    // an experimental (ACP-family) type while ENABLE_ACP is off — falls back to
    // the Claude SDK adapter so a stale saved config can't reach a
    // half-configured engine. Stable providers (Claude, OpenAI) always run.
    if (!providerRunnable(provider.type)) return new ClaudeSdkEngineAdapter();
    switch (provider.type) {
      case 'claude': return new ClaudeSdkEngineAdapter();
      // Same adapter as Claude, and that is the whole design: the Claude SDK
      // already spawns the real Claude Code subprocess, so pointing that
      // subprocess at an anthropic-compatible endpoint needs a different
      // environment, not a different engine. An explicit case rather than
      // falling through — `default` is ACP, which would be silently wrong.
      case 'anthropic-compatible': return new ClaudeSdkEngineAdapter();
      // Native OpenAI: SDK by default; App Server behind the opt-in transport flag
      // so the rollback is a config change, not a deploy.
      case 'openai':
        return CODEX_TRANSPORT === 'app-server'
          ? new CodexAppServerEngineAdapter()
          : new CodexSdkEngineAdapter();
      case 'openrouter': return new OpenRouterEngineAdapter();
      default: return new AcpEngineAdapter();
    }
  }
}

/**
 * Whether the engine selected for `provider` models a system prompt. The Claude
 * SDK, native OpenAI, and OpenRouter engines do, so the persona is pinned there
 * and callers must NOT also inject it in-band. ACP does not, so callers deliver
 * the persona in the message (e.g. a turn-1 injection). Mirrors the
 * fallback in `EngineFactory.forProvider`: a non-runnable provider resolves to
 * the Claude adapter, which models it.
 *
 * Conservative on missing info: with ACP enabled and no provider, returns false
 * so callers keep injecting rather than risk an ACP turn with no persona.
 */
export function engineSupportsSystemPrompt(provider: ProviderConfig | undefined): boolean {
  if (!provider) return !ENABLE_ACP; // no provider → Claude-only world unless ACP is on
  if (!providerRunnable(provider.type)) return true; // falls back to the Claude adapter
  // anthropic-compatible runs on the Claude SDK adapter, so it models a system
  // prompt like Claude does. Without this it would be treated as ACP and the
  // caller would skip the persona entirely — an agent with no identity.
  return provider.type === 'claude' || provider.type === 'openai'
    || provider.type === 'openrouter' || provider.type === 'anthropic-compatible';
}
