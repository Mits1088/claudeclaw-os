import { describe, it, expect, beforeEach, vi } from 'vitest';

// config.ts reads .env at module load; keep it off the real filesystem.
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

// The CLI index is appended to the agent's persona, so each case sets the
// overrides and reads the resulting system prompt back.
describe('obsidian-cli is advertised only when usable', () => {
  const base = {
    agentId: 'research',
    botToken: '',
    cwd: '/tmp',
    systemPrompt: 'You are Research.',
  };

  beforeEach(() => {
    vi.resetModules();
  });

  it('lists obsidian-cli when enabled and the agent has scope', async () => {
    const config = await import('./config.js');
    config.setAgentOverrides({
      ...base,
      obsidian: { folders: ['Notes'], writeFolders: ['Notes'] },
      obsidianEnabled: true,
    });
    expect(config.agentSystemPrompt).toContain('obsidian-cli');
  });

  it('omits obsidian-cli when the install has Obsidian disabled', async () => {
    const config = await import('./config.js');
    config.setAgentOverrides({
      ...base,
      obsidian: { folders: ['Notes'], writeFolders: ['Notes'] },
      obsidianEnabled: false,
    });
    expect(config.agentSystemPrompt).not.toContain('obsidian-cli');
    // The rest of the index is untouched.
    expect(config.agentSystemPrompt).toContain('mission-cli');
  });

  it('omits obsidian-cli for an agent with no obsidian block', async () => {
    const config = await import('./config.js');
    config.setAgentOverrides({ ...base, obsidianEnabled: true });
    expect(config.agentSystemPrompt).not.toContain('obsidian-cli');
  });

  it('omits obsidian-cli for an agent whose scopes are all empty', async () => {
    const config = await import('./config.js');
    config.setAgentOverrides({
      ...base,
      obsidian: { folders: [], readOnly: [], writeFolders: [] },
      obsidianEnabled: true,
    });
    expect(config.agentSystemPrompt).not.toContain('obsidian-cli');
  });
});
