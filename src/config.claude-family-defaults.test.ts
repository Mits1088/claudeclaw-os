import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('Claude family defaults', () => {
  it('routes plain family aliases to 5.5 and preserves explicit older selections', async () => {
    for (const key of ['CLAUDE_MODEL_OPUS', 'CLAUDE_MODEL_SONNET', 'CLAUDE_MODEL_HAIKU', 'DEFAULT_CLAUDE_MODEL']) vi.stubEnv(key, '');
    vi.resetModules();
    const config = await import('./config.js');
    const { resolveTelegramModelSelection } = await import('./bot.js');
    expect(config.DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5-5');
    for (const family of ['opus', 'sonnet', 'haiku']) {
      expect(resolveTelegramModelSelection({ type: 'claude' }, family).model).toBe('claude-' + family + '-5-5');
    }
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      expect(resolveTelegramModelSelection({ type: 'claude' }, model).model).toBe(model);
    }
    expect(resolveTelegramModelSelection({ type: 'claude' }, 'haiku55').model).toBe('claude-haiku-5-5');
  });
  it('preserves environment-pinned family and default overrides', async () => {
    vi.stubEnv('CLAUDE_MODEL_OPUS', 'claude-opus-4-6');
    vi.stubEnv('CLAUDE_MODEL_SONNET', 'claude-sonnet-4-6');
    vi.stubEnv('CLAUDE_MODEL_HAIKU', 'claude-haiku-4-5');
    vi.stubEnv('DEFAULT_CLAUDE_MODEL', 'claude-sonnet-4-5');
    vi.resetModules();
    const config = await import('./config.js');
    const { resolveTelegramModelSelection } = await import('./bot.js');
    expect(config.DEFAULT_CLAUDE_MODEL).toBe('claude-sonnet-4-5');
    for (const [family, model] of [['opus', 'claude-opus-4-6'], ['sonnet', 'claude-sonnet-4-6'], ['haiku', 'claude-haiku-4-5']]) {
      expect(resolveTelegramModelSelection({ type: 'claude' }, family).model).toBe(model);
    }
  });
});
