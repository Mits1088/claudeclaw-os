// Where the new provider type has to be wired, and what breaks if it is not.
//
// Two of these facts are enforced by the compiler already (the two
// Record<ProviderType, …> tables). The rest are not, and each has a specific
// wrong-but-plausible outcome: the ACP adapter instead of the Claude one, an
// agent with no persona, a provider hidden behind a flag that has nothing to
// do with it.

import { describe, expect, it } from 'vitest';

import { engineSupportsSystemPrompt, EngineFactory } from './agent-engine/index.js';
import { ClaudeSdkEngineAdapter } from './agent-engine/claude-sdk-adapter.js';
import { CHAT_TOOL_PROFILES, chatToolProfileFor, STRICTEST_CHAT_TOOL_PROFILE } from './chat-tool-policy.js';
import { PROVIDER_REGISTRY, providerRunnable, providerVisible } from './provider-registry.js';
import {
  getProviderDisplay,
  normalizeProviderConfig,
  normalizeProviderType,
  providerToYaml,
  effectiveSkipPermissions,
} from './provider.js';

const compat = { type: 'anthropic-compatible' as const };

describe('provider identity', () => {
  it('normalizes from persisted config', () => {
    expect(normalizeProviderType('anthropic-compatible')).toBe('anthropic-compatible');
    expect(normalizeProviderType('  ANTHROPIC-COMPATIBLE ')).toBe('anthropic-compatible');
  });

  it('is not reachable through a legacy spelling', () => {
    expect(normalizeProviderType('anthropic_compatible')).toBeUndefined();
    expect(normalizeProviderType('glm')).toBeUndefined();
  });
});

describe('endpoint round-trip through agent.yaml', () => {
  it('reads and writes baseUrl', () => {
    const cfg = normalizeProviderConfig({ type: 'anthropic-compatible', baseUrl: 'https://api.moonshot.ai/anthropic' });
    expect(cfg.baseUrl).toBe('https://api.moonshot.ai/anthropic');
    expect(providerToYaml(cfg)).toEqual({ type: 'anthropic-compatible', baseUrl: 'https://api.moonshot.ai/anthropic' });
  });

  // A baseUrl left over on a Claude block would be invisible config that
  // becomes live the moment someone switches the type back.
  it('drops baseUrl on every other provider type', () => {
    expect(normalizeProviderConfig({ type: 'claude', baseUrl: 'https://boese.invalid' }).baseUrl).toBeUndefined();
    expect(providerToYaml({ type: 'claude', baseUrl: 'https://boese.invalid' })).toEqual({ type: 'claude' });
  });

  it('names the endpoint in the display string', () => {
    expect(getProviderDisplay({ type: 'anthropic-compatible', baseUrl: 'https://api.moonshot.ai/anthropic' }))
      .toContain('api.moonshot.ai');
    // No pinned baseUrl means the built-in default — the label names the
    // vendor the user configured rather than a generic endpoint phrase.
    expect(getProviderDisplay(compat)).toContain('Z.ai (GLM)');
  });
});

describe('engine selection', () => {
  // The switch in EngineFactory ends in `default: AcpEngineAdapter`. Without an
  // explicit case the turn would silently run on ACP — a protocol this
  // provider does not speak.
  it('resolves to the Claude SDK adapter, not ACP', () => {
    expect(EngineFactory.forProvider(compat)).toBeInstanceOf(ClaudeSdkEngineAdapter);
  });

  // Without this the caller treats the turn as ACP and skips the persona
  // entirely, leaving the agent with no identity.
  it('models a system prompt', () => {
    expect(engineSupportsSystemPrompt(compat)).toBe(true);
  });
});

describe('registry placement', () => {
  it('is experimental in tier but not gated behind the ACP beta flag', () => {
    const d = PROVIDER_REGISTRY['anthropic-compatible'];
    expect(d.tier).toBe('experimental');
    expect(d.enablement).toBe('auth');
    // Runnable and offered regardless of ENABLE_ACP: it is not an ACP provider
    // and has none of that family's protocol caveats.
    expect(providerRunnable('anthropic-compatible')).toBe(true);
    expect(providerVisible('anthropic-compatible')).toBe(true);
  });
});

describe('chat surface', () => {
  // Running the same engine as Claude buys ENFORCEABILITY of a tool policy, not
  // JUDGEMENT about what to do with a casual message. The model is not Claude
  // and is swappable per .env, so no track record accrues.
  it('is the strictest profile, like every unvetted provider', () => {
    expect(CHAT_TOOL_PROFILES['anthropic-compatible']).toBe(STRICTEST_CHAT_TOOL_PROFILE);
    expect(chatToolProfileFor(compat)).toEqual(STRICTEST_CHAT_TOOL_PROFILE);
  });
});

describe('permissions', () => {
  // Measured 2026-08-20 against the live endpoint: permissionMode
  // 'bypassPermissions' with allowDangerouslySkipPermissions=false — exactly
  // what agent.ts passes for a non-Claude provider — runs and executes tools.
  // So the asymmetric default needs no exception, and the risky `true` path
  // stays closed.
  it('keeps the conservative default, which the endpoint accepts', () => {
    expect(effectiveSkipPermissions(compat)).toBe(false);
    expect(effectiveSkipPermissions({ ...compat, dangerouslySkipPermissions: true })).toBe(true);
  });
});
