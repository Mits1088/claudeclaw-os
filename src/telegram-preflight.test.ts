import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ token: '', boot: vi.fn(), error: vi.fn() }));
vi.mock('./crash-guard.js', () => ({}));
vi.mock('./bot.js', () => ({ createBot: vi.fn(), splitMessage: vi.fn() }));
vi.mock('./config.js', () => ({ get activeBotToken() { return state.token; }, ALLOWED_CHAT_ID: '' }));
vi.mock('./logger.js', () => ({ logger: { error: state.error } }));
vi.mock('./messenger.js', () => ({ bootMessenger: state.boot }));
vi.mock('./state.js', () => ({ setTelegramConnected: vi.fn(), setBotInfo: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); state.boot.mockClear(); state.error.mockClear(); });

describe('Telegram entry preflight', () => {
  it.each(['main', 'research'])('rejects an empty token for %s', async (agentId) => {
    state.token = '';
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await import('./index.js');
    const factory = state.boot.mock.calls[0][0];
    expect(() => factory.preflight(agentId)).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(state.error).toHaveBeenCalled();
  });

  it('accepts a configured specialist token', async () => {
    state.token = 'configured-token';
    const exit = vi.spyOn(process, 'exit');
    await import('./index.js');
    expect(() => state.boot.mock.calls[0][0].preflight('research')).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
