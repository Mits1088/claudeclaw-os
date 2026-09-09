import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from './agent-engine/types.js';

const state = vi.hoisted(() => ({
  capturedInputs: [] as AgentTurnInput[],
  activeProvider: { type: 'opencode' as const },
  mainProvider: { type: 'claude' as const, model: 'claude-opus-4-6' },
}));

vi.mock('./config.js', () => ({
  AGENT_MAX_TURNS: 30,
  AGENT_IDLE_TIMEOUT_MS: 900000,
  AGENT_MAX_RUNTIME_MS: 3600000,
  PROJECT_ROOT: '/tmp/test',
  agentCwd: undefined,
  agentProvider: state.activeProvider,
  agentSystemPrompt: undefined,
  ENABLE_ACP: true,
  EXFILTRATION_GUARD_ENABLED: true,
  PROTECTED_ENV_VARS: [],
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./security.js', () => ({
  getScrubbedSdkEnv: vi.fn(() => ({})),
}));

vi.mock('./kill-switches.js', () => ({
  requireEnabled: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./provider.js', () => ({
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-6',
  DEFAULT_CODEX_MODEL: 'gpt-5.5',
  getMainProviderConfig: vi.fn(() => state.mainProvider),
  sessionBelongsToProvider: vi.fn(() => false),
  decodeProviderSession: vi.fn((_, sessionId) => sessionId),
  encodeProviderSession: vi.fn((provider, sessionId) => sessionId ? `${provider.type}:${sessionId}` : undefined),
  effectiveSkipPermissions: vi.fn((provider) => provider.dangerouslySkipPermissions ?? provider.type === 'claude'),
}));

vi.mock('./agent-engine/index.js', () => ({
  EngineFactory: {
    forProvider: vi.fn((provider) => ({
      async *invoke(input: AgentTurnInput) {
        state.capturedInputs.push(input);
        yield { type: 'session' as const, sessionId: `${provider.type}-session` };
        yield { type: 'result' as const, text: 'ok', usage: null };
      },
    })),
  },
}));

import { runAgent } from './agent.js';

describe('runAgent provider selection', () => {
  beforeEach(() => {
    state.capturedInputs.length = 0;
  });

  it('uses the active agent provider when no provider is passed', async () => {
    const result = await runAgent('scheduled task', undefined, () => {});

    expect(result.text).toBe('ok');
    expect(state.capturedInputs[0].provider).toEqual({ type: 'opencode' });
    expect(state.capturedInputs[0].model).toBeUndefined();
    expect(state.capturedInputs[0].runtimeIdentity).toBe(
      'You are currently running on the provider-selected default model (provider: opencode).',
    );
  });

  it('lets an explicit provider override the active provider', async () => {
    await runAgent('direct task', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, { type: 'claude' });

    expect(state.capturedInputs[0].provider).toEqual({ type: 'claude' });
    expect(state.capturedInputs[0].model).toBe('claude-opus-4-6');
    expect(state.capturedInputs[0].runtimeIdentity).toBe(
      'You are currently running on Opus 4.6 (provider: claude).',
    );
  });

  it('captures provider and identity per turn so a later swap cannot rewrite the first input', async () => {
    await runAgent('first', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, { type: 'openai', model: 'gpt-5.6-sol' });
    await runAgent('second', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, { type: 'openai', model: 'gpt-5.6-luna' });

    expect(state.capturedInputs[0].runtimeIdentity).toBe('You are currently running on GPT-5.6 Sol (provider: openai).');
    expect(state.capturedInputs[1].runtimeIdentity).toBe('You are currently running on GPT-5.6 Luna (provider: openai).');
  });

  it('reports Claude effort from runtimeMode', async () => {
    await runAgent('t', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, {
      type: 'claude',
      model: 'claude-opus-5',
      runtimeMode: 'medium',
    });

    // Opus 5 is adaptive-only, so there is no thinking clause to print.
    expect(state.capturedInputs[0].runtimeIdentity).toBe(
      'You are currently running on Opus 5 (provider: claude, effort: medium).',
    );
  });

  it('reports Claude effort and thinking together when the model exposes both', async () => {
    await runAgent('t', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, {
      type: 'claude',
      model: 'claude-opus-4-8',
      runtimeMode: 'high',
      thinkingMode: 'on',
    });

    expect(state.capturedInputs[0].runtimeIdentity).toMatch(
      /^You are currently running on Opus 4\.8 \(provider: claude, effort: high, thinking: /,
    );
  });

  it('omits the clause entirely when no effort or thinking is selected', async () => {
    await runAgent('t', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, {
      type: 'claude',
      model: 'claude-opus-5',
    });

    expect(state.capturedInputs[0].runtimeIdentity).toBe(
      'You are currently running on Opus 5 (provider: claude).',
    );
  });

  it('reads OpenAI reasoning effort from thinkingMode, the field the dashboard writes', async () => {
    await runAgent('t', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, {
      type: 'openai',
      model: 'gpt-5.6-sol',
      thinkingMode: 'xhigh',
    });

    expect(state.capturedInputs[0].runtimeIdentity).toBe(
      'You are currently running on GPT-5.6 Sol (provider: openai, reasoning effort: xhigh).',
    );
    expect(state.capturedInputs[0].effort).toBe('xhigh');
    expect(state.capturedInputs[0].thinkingMode).toBe('xhigh');
  });

  it('drops an OpenAI effort the model does not support rather than reporting a lie', async () => {
    // xhigh is not in OPENAI_LEGACY_EFFORT for gpt-5.4.
    await runAgent('t', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, {
      type: 'openai',
      model: 'gpt-5.4-mini',
      thinkingMode: 'max',
    });

    expect(state.capturedInputs[0].runtimeIdentity).toBe(
      'You are currently running on GPT-5.4 Mini (provider: openai).',
    );
    expect(state.capturedInputs[0].effort).toBeUndefined();
    expect(state.capturedInputs[0].thinkingMode).toBeUndefined();
  });

  it('forwards an explicit toolPolicy to the engine', async () => {
    await runAgent(
      'chat msg',
      undefined,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { type: 'acp-codex' },
      { allowedTools: ['Read', 'Grep', 'Glob'] },
    );

    expect(state.capturedInputs[0].allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(state.capturedInputs[0].disallowedTools).toBeUndefined();
  });

  it('omits allowedTools/disallowedTools when no toolPolicy is passed (mission tasks keep full access)', async () => {
    await runAgent('scheduled task', undefined, () => {});

    expect(state.capturedInputs[0].allowedTools).toBeUndefined();
    expect(state.capturedInputs[0].disallowedTools).toBeUndefined();
  });
});
