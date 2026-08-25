import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  installed: new Set<string>(),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn((_lookup: string, args: string[]) => ({
    status: state.installed.has(args[0]) ? 0 : 1,
  })),
}));

vi.mock('./config.js', () => ({
  STORE_DIR: '/tmp/test',
  CODEX_TRANSPORT: 'sdk',
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
}));

// The openai/openrouter availability checks fall back to reading .env; return
// an empty file so results don't depend on the developer's local .env.
vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

import { checkProviderAvailability } from './provider.js';

describe('checkProviderAvailability', () => {
  beforeEach(() => {
    state.installed.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('claude', () => {
    it('reports ok when claude CLI is on PATH', () => {
      state.installed.add('claude');
      const result = checkProviderAvailability({ type: 'claude' });
      expect(result.ok).toBe(true);
    });

    it('reports ok via the bundled SDK even when the claude CLI is not on PATH', () => {
      // The claude-agent-sdk bundles its own Claude Code runtime, so the provider
      // is available whenever the SDK package resolves (it does in this repo)
      // regardless of whether a standalone `claude` is on PATH. This mirrors the
      // realistic daemon case where PATH lacks the global CLI dir.
      const result = checkProviderAvailability({ type: 'claude' });
      expect(result.ok).toBe(true);
    });
  });

  describe('opencode', () => {
    it('reports ok when opencode CLI is on PATH', () => {
      state.installed.add('opencode');
      const result = checkProviderAvailability({ type: 'opencode' });
      expect(result.ok).toBe(true);
    });

    it('returns install command and auth login hint when missing', () => {
      const result = checkProviderAvailability({ type: 'opencode' });
      expect(result.ok).toBe(false);
      expect(result.installCommand).toContain('opencode-ai');
      expect(result.setupHint).toContain('opencode auth login');
    });
  });

  describe('gemini', () => {
    it('reports ok when gemini CLI is on PATH', () => {
      state.installed.add('gemini');
      const result = checkProviderAvailability({ type: 'gemini' });
      expect(result.ok).toBe(true);
    });

    it('returns install command and auth hint when missing', () => {
      const result = checkProviderAvailability({ type: 'gemini' });
      expect(result.ok).toBe(false);
      expect(result.installCommand).toContain('@google/gemini-cli');
      expect(result.setupHint).toMatch(/gemini/i);
    });
  });

  describe('acp-codex (Codex over ACP)', () => {
    it('reports ok when codex CLI is on PATH', () => {
      state.installed.add('codex');
      const result = checkProviderAvailability({ type: 'acp-codex' });
      expect(result.ok).toBe(true);
    });

    it('returns install command and auth hint when missing', () => {
      const result = checkProviderAvailability({ type: 'acp-codex' });
      expect(result.ok).toBe(false);
      expect(result.installCommand).toContain('@openai/codex');
      expect(result.setupHint).toMatch(/codex/i);
    });
  });

  describe('openai (native Codex SDK)', () => {
    // The SDK package resolves in this repo (bundled dependency), so
    // availability turns purely on auth: codex login state or OPENAI_API_KEY.
    const savedCodexHome = process.env.CODEX_HOME;
    const savedOpenAiKey = process.env.OPENAI_API_KEY;

    beforeEach(() => {
      delete process.env.OPENAI_API_KEY;
      // Point CODEX_HOME at a directory with no auth.json so the developer's
      // real ~/.codex login can't leak into the assertions.
      process.env.CODEX_HOME = '/tmp/definitely-missing-codex-home';
    });

    afterEach(() => {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
    });

    it('reports ok when OPENAI_API_KEY is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const result = checkProviderAvailability({ type: 'openai' });
      expect(result.ok).toBe(true);
    });

    it('returns codex login / API key hints when unauthenticated', () => {
      const result = checkProviderAvailability({ type: 'openai' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not authenticated/i);
      expect(result.setupHint).toContain('codex login');
      expect(result.setupHint).toContain('OPENAI_API_KEY');
    });
  });

  describe('acp (custom)', () => {
    it('reports ok when the custom command is on PATH', () => {
      state.installed.add('my-agent');
      const result = checkProviderAvailability({ type: 'acp', command: 'my-agent', args: ['--acp'] });
      expect(result.ok).toBe(true);
    });

    it('rejects when no command is provided', () => {
      const result = checkProviderAvailability({ type: 'acp' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/requires a command/i);
    });

    it('rejects when the custom command is not on PATH', () => {
      const result = checkProviderAvailability({ type: 'acp', command: 'missing-tool' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('missing-tool');
      expect(result.setupHint).toBeTruthy();
    });
  });
});
