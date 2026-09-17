import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

let tmpRoot: string;
let projectRoot: string;
let claudeclawConfig: string;
let storeDir: string;

// Mock config BEFORE importing agent-config so STORE_DIR/PROJECT_ROOT point at tmp.
vi.mock('./config.js', () => {
  return {
    get CLAUDECLAW_CONFIG() { return claudeclawConfig; },
    get PROJECT_ROOT() { return projectRoot; },
    get STORE_DIR() { return storeDir; },
    get WARROOM_TMP_DIR() { return path.join(storeDir, 'tmp'); },
    DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
    CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
    CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
    CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
  };
});

// Mock env reader so loadAgentConfig doesn't fail on missing bot token.
vi.mock('./env.js', () => ({
  readEnvFile: () => ({ TEST_BOT_TOKEN: 'dummy' }),
}));

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-agent-config-'));
  projectRoot = path.join(tmpRoot, 'project');
  claudeclawConfig = path.join(tmpRoot, 'config');
  storeDir = path.join(tmpRoot, 'store');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(claudeclawConfig, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  process.env.TEST_BOT_TOKEN = 'dummy';
});

afterEach(() => {
  delete process.env.TEST_BOT_TOKEN;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeAgentYaml(agentId: string, content: Record<string, unknown>): string {
  const agentDir = path.join(projectRoot, 'agents', agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  const yamlPath = path.join(agentDir, 'agent.yaml');
  fs.writeFileSync(yamlPath, yaml.dump(content), 'utf-8');
  return yamlPath;
}

describe('loadAgentConfig interactive flag', () => {
  it('defaults interactive to true when the field is absent', async () => {
    writeAgentYaml('raka', {
      name: 'Raka',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('raka').interactive).toBe(true);
  });

  it('honours interactive: false (automation-only agent)', async () => {
    writeAgentYaml('cron', {
      name: 'Cron',
      description: 'scheduler',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      interactive: false,
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('cron').interactive).toBe(false);
  });

  it('treats interactive: true explicitly as true', async () => {
    writeAgentYaml('raka', {
      name: 'Raka',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      interactive: true,
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('raka').interactive).toBe(true);
  });
});

describe('loadAgentConfig runtime mode', () => {
  it.each([undefined, 'UNSET_SPECIALIST_TOKEN'])('loads a messenger specialist with absent token configuration %s', async (tokenEnv) => {
    vi.stubEnv('UNSET_SPECIALIST_TOKEN', '');
    try {
      writeAgentYaml('research', {
        name: 'Research',
        runtime: { mode: 'messenger' },
        ...(tokenEnv ? { telegram_bot_token_env: tokenEnv } : {}),
      });
      const { loadAgentConfig } = await import('./agent-config.js');
      const config = loadAgentConfig('research');
      expect(config.runtimeMode).toBe('messenger');
      expect(config.botTokenEnv).toBe(tokenEnv ?? '');
      expect(config.botToken).toBe('');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loads a headless worker without a Telegram token', async () => {
    writeAgentYaml('worker', {
      name: 'Worker',
      description: 'mission worker',
      runtime: { mode: 'headless' },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    const config = loadAgentConfig('worker');
    expect(config.runtimeMode).toBe('headless');
    expect(config.lifecycleMode).toBe('persistent');
    expect(config.botTokenEnv).toBe('');
    expect(config.botToken).toBe('');
  });

  it('loads an explicitly task-scoped headless worker', async () => {
    writeAgentYaml('temporary-worker', {
      name: 'Temporary Worker',
      description: 'one bounded task tree',
      runtime: { mode: 'headless' },
      lifecycle: { mode: 'task-scoped' },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    const config = loadAgentConfig('temporary-worker');
    expect(config.runtimeMode).toBe('headless');
    expect(config.lifecycleMode).toBe('task-scoped');
  });

  it('defaults existing agents to messenger mode', async () => {
    writeAgentYaml('legacy', { name: 'Legacy', telegram_bot_token_env: 'TEST_BOT_TOKEN' });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('legacy').runtimeMode).toBe('messenger');
    expect(loadAgentConfig('legacy').lifecycleMode).toBe('persistent');
  });

  it('rejects an unknown runtime mode', async () => {
    writeAgentYaml('badmode', { name: 'Bad', runtime: { mode: 'carrier-pigeon' } });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(() => loadAgentConfig('badmode')).toThrow(/invalid runtime\.mode/);
  });

  it('rejects an unknown lifecycle mode', async () => {
    writeAgentYaml('badlife', {
      name: 'Bad',
      runtime: { mode: 'headless' },
      lifecycle: { mode: 'surprise-me' },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(() => loadAgentConfig('badlife')).toThrow(/invalid lifecycle\.mode/);
  });

  it('rejects task-scoped lifecycle on a messenger agent', async () => {
    writeAgentYaml('chat-worker', {
      name: 'Chat Worker',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      lifecycle: { mode: 'task-scoped' },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(() => loadAgentConfig('chat-worker')).toThrow(/only with runtime\.mode 'headless'/);
  });
});

describe('loadAgentConfig obsidian block', () => {
  it('leaves vault unset when omitted, so the configured vault is used', async () => {
    // agent-config deliberately does NOT resolve the default vault: that
    // depends on the dashboard setting, and reading it here would make agent
    // config loading depend on the database. obsidian-config.resolveVaultDir
    // does the resolving instead.
    writeAgentYaml('research', {
      name: 'Research',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      obsidian: { folders: ['Notes'] },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('research').obsidian?.vault).toBeUndefined();
    expect(loadAgentConfig('research').obsidian?.folders).toEqual(['Notes']);
  });

  it('does not warn when no explicit vault is configured', async () => {
    writeAgentYaml('research', {
      name: 'Research',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      obsidian: { folders: ['Notes'] },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { loadAgentConfig } = await import('./agent-config.js');
    loadAgentConfig('research');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('honours an explicit vault override', async () => {
    const customVault = path.join(tmpRoot, 'my-vault');
    fs.mkdirSync(customVault, { recursive: true });
    writeAgentYaml('research', {
      name: 'Research',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      obsidian: { vault: customVault, folders: ['Notes'] },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('research').obsidian?.vault).toBe(customVault);
  });

  it('parses write_folders into writeFolders', async () => {
    writeAgentYaml('research', {
      name: 'Research',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      obsidian: { folders: ['Notes'], write_folders: ['Notes/Drafts'] },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('research').obsidian?.writeFolders).toEqual(['Notes/Drafts']);
  });

  it('defaults writeFolders to an empty array when absent', async () => {
    writeAgentYaml('research', {
      name: 'Research',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      obsidian: { folders: ['Notes'] },
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('research').obsidian?.writeFolders).toEqual([]);
  });

  it('leaves obsidian undefined when the agent.yaml has no obsidian block', async () => {
    writeAgentYaml('ops', {
      name: 'Ops',
      description: 'desc',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('ops').obsidian).toBeUndefined();
  });
});

describe('setAgentDescription', () => {
  it('updates the description field in agent.yaml', async () => {
    const yamlPath = writeAgentYaml('raka', {
      name: 'Raka',
      description: 'Old description',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      model: 'claude-haiku-4-5',
    });

    const { setAgentDescription, loadAgentConfig } = await import('./agent-config.js');
    setAgentDescription('raka', 'New research librarian');

    const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, unknown>;
    expect(raw.description).toBe('New research librarian');
    expect(raw.model).toBe('claude-haiku-4-5');
    expect(raw.name).toBe('Raka');

    const config = loadAgentConfig('raka');
    expect(config.description).toBe('New research librarian');
  });

  it('trims whitespace before saving', async () => {
    writeAgentYaml('raka', {
      name: 'Raka',
      description: 'old',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });

    const { setAgentDescription, loadAgentConfig } = await import('./agent-config.js');
    setAgentDescription('raka', '  padded value  ');

    expect(loadAgentConfig('raka').description).toBe('padded value');
  });

  it('rejects empty description', async () => {
    writeAgentYaml('raka', {
      name: 'Raka',
      description: 'keep me',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });

    const { setAgentDescription, loadAgentConfig } = await import('./agent-config.js');
    expect(() => setAgentDescription('raka', '   ')).toThrow(/empty/);
    expect(loadAgentConfig('raka').description).toBe('keep me');
  });

  it('throws when agent does not exist', async () => {
    const { setAgentDescription } = await import('./agent-config.js');
    expect(() => setAgentDescription('ghost', 'hi')).toThrow(/not found/);
  });
});

describe('main description', () => {
  it('returns default when no config file exists', async () => {
    const { getMainDescription, DEFAULT_MAIN_DESCRIPTION } = await import('./agent-config.js');
    expect(getMainDescription()).toBe(DEFAULT_MAIN_DESCRIPTION);
  });

  it('persists and reads back the description', async () => {
    const { setMainDescription, getMainDescription } = await import('./agent-config.js');
    setMainDescription('My personal assistant');
    expect(getMainDescription()).toBe('My personal assistant');
  });

  it('trims whitespace on save', async () => {
    const { setMainDescription, getMainDescription } = await import('./agent-config.js');
    setMainDescription('  trimmed  ');
    expect(getMainDescription()).toBe('trimmed');
  });

  it('rejects empty description', async () => {
    const { setMainDescription } = await import('./agent-config.js');
    expect(() => setMainDescription('   ')).toThrow(/empty/);
  });

  it('falls back to default when file is corrupt', async () => {
    fs.writeFileSync(path.join(storeDir, 'main-config.json'), 'not valid json', 'utf-8');
    const { getMainDescription, DEFAULT_MAIN_DESCRIPTION } = await import('./agent-config.js');
    expect(getMainDescription()).toBe(DEFAULT_MAIN_DESCRIPTION);
  });

  it('preserves other keys in main-config.json', async () => {
    const configPath = path.join(storeDir, 'main-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ other: 'value' }), 'utf-8');

    const { setMainDescription } = await import('./agent-config.js');
    setMainDescription('hello');

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.description).toBe('hello');
    expect(raw.other).toBe('value');
  });

  it('reads the description from agents/main/agent.yaml when present (normalized shape)', async () => {
    writeAgentYaml('main', { name: 'Holden', description: 'From the yaml' });
    const { getMainDescription } = await import('./agent-config.js');
    expect(getMainDescription()).toBe('From the yaml');
  });

  it('agent.yaml wins over the legacy main-config.json', async () => {
    writeAgentYaml('main', { name: 'Holden', description: 'Yaml description' });
    fs.writeFileSync(path.join(storeDir, 'main-config.json'), JSON.stringify({ description: 'Legacy json' }), 'utf-8');
    const { getMainDescription } = await import('./agent-config.js');
    expect(getMainDescription()).toBe('Yaml description');
  });

  it('setMainDescription writes agents/main/agent.yaml when it exists, not the json', async () => {
    const yamlPath = writeAgentYaml('main', { name: 'Holden', description: 'old' });
    const { setMainDescription, getMainDescription } = await import('./agent-config.js');
    setMainDescription('updated via yaml');

    const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, unknown>;
    expect(raw.description).toBe('updated via yaml');
    expect(raw.name).toBe('Holden');
    expect(fs.existsSync(path.join(storeDir, 'main-config.json'))).toBe(false);
    expect(getMainDescription()).toBe('updated via yaml');
  });
});

describe('resolveAgentDisplayName', () => {
  it('returns the configured name when agent.yaml has a name field', async () => {
    writeAgentYaml('felix', {
      name: 'Felix',
      description: 'Test agent',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });

    const { resolveAgentDisplayName } = await import('./agent-config.js');
    expect(resolveAgentDisplayName('felix')).toBe('Felix');
  });

  it('returns capitalized id when agent.yaml has no name field', async () => {
    // Write a minimal agent.yaml with name set (required by loadAgentConfig)
    // but test the fallback path by writing yaml without name
    const agentDir = path.join(projectRoot, 'agents', 'noname');
    fs.mkdirSync(agentDir, { recursive: true });
    // loadAgentConfig requires 'name', so if name is missing it throws.
    // resolveAgentDisplayName catches the throw and falls back to capitalize(id).
    fs.writeFileSync(
      path.join(agentDir, 'agent.yaml'),
      yaml.dump({ description: 'no name here', telegram_bot_token_env: 'TEST_BOT_TOKEN' }),
      'utf-8',
    );

    const { resolveAgentDisplayName } = await import('./agent-config.js');
    expect(resolveAgentDisplayName('noname')).toBe('Noname');
  });

  it('returns capitalized id when agent.yaml does not exist (no throw)', async () => {
    const { resolveAgentDisplayName } = await import('./agent-config.js');
    // 'ghost' has no agent.yaml anywhere
    expect(resolveAgentDisplayName('ghost')).toBe('Ghost');
  });
});

describe('loadAgentConfig main fallback', () => {
  it('succeeds without telegram_bot_token_env when TELEGRAM_BOT_TOKEN env var is set', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'fallback-token';

    writeAgentYaml('main', {
      name: 'Holden',
      description: 'Hub agent',
      // No telegram_bot_token_env - should fall back to TELEGRAM_BOT_TOKEN
    });

    const { loadAgentConfig } = await import('./agent-config.js');
    const config = loadAgentConfig('main');
    expect(config.name).toBe('Holden');
    expect(config.botToken).toBe('fallback-token');

    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('uses the name from agent.yaml', async () => {
    writeAgentYaml('main', {
      name: 'Holden',
      description: 'Hub agent',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });

    const { loadAgentConfig } = await import('./agent-config.js');
    const config = loadAgentConfig('main');
    expect(config.name).toBe('Holden');
  });
});

describe('provider config', () => {
  it('keeps legacy installs on Claude when no provider is configured', async () => {
    const { getMainProviderConfig } = await import('./provider.js');
    expect(getMainProviderConfig()).toEqual({ type: 'claude', model: 'claude-opus-4-8' });
  });

  it('maps legacy Claude model to Claude provider', async () => {
    writeAgentYaml('legacy', {
      name: 'Legacy',
      description: 'old',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      model: 'claude-sonnet-4-6',
    });

    const { loadAgentConfig } = await import('./agent-config.js');
    const config = loadAgentConfig('legacy');
    expect(config.provider).toEqual({ type: 'claude', model: 'claude-sonnet-4-6' });
  });

  it('loads explicit OpenCode provider without a model override', async () => {
    writeAgentYaml('open', {
      name: 'Open',
      description: 'new',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      provider: { type: 'opencode' },
    });

    const { loadAgentConfig } = await import('./agent-config.js');
    const config = loadAgentConfig('open');
    expect(config.provider).toEqual({ type: 'opencode' });
    expect(config.model).toBeUndefined();
  });

  it('loads built-in ACP provider presets', async () => {
    writeAgentYaml('gemini-agent', {
      name: 'Gemini Agent',
      description: 'gemini',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      provider: { type: 'gemini' },
    });
    writeAgentYaml('codex-agent', {
      name: 'Codex Agent',
      description: 'codex',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      provider: { type: 'acp-codex' },
    });
    // A sub-agent yaml written before the rename still carries `codex`.
    writeAgentYaml('legacy-codex-agent', {
      name: 'Legacy Codex Agent',
      description: 'codex',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      provider: { type: 'codex' },
    });

    const { loadAgentConfig } = await import('./agent-config.js');
    expect(loadAgentConfig('gemini-agent').provider).toEqual({ type: 'gemini' });
    expect(loadAgentConfig('codex-agent').provider).toEqual({ type: 'acp-codex' });
    expect(loadAgentConfig('legacy-codex-agent').provider).toEqual({ type: 'acp-codex' });
  });

  it('persists provider model and removes legacy model', async () => {
    const yamlPath = writeAgentYaml('switcher', {
      name: 'Switcher',
      description: 'switch',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      model: 'claude-haiku-4-5',
    });

    const { setAgentProvider, loadAgentConfig } = await import('./agent-config.js');
    setAgentProvider('switcher', {
      type: 'opencode',
      model: 'opencode/gpt-5.3-codex',
      runtimeMode: 'deep',
      thinkingMode: 'on',
    });

    const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, unknown>;
    expect(raw.model).toBeUndefined();
    expect(raw.provider).toEqual({
      type: 'opencode',
      model: 'opencode/gpt-5.3-codex',
      runtimeMode: 'deep',
      thinkingMode: 'on',
    });
    expect(loadAgentConfig('switcher').provider).toEqual({
      type: 'opencode',
      model: 'opencode/gpt-5.3-codex',
      runtimeMode: 'deep',
      thinkingMode: 'on',
    });
  });

  it('namespaces sessions by provider so switched providers start fresh', async () => {
    const {
      encodeProviderSession,
      decodeProviderSession,
      sessionBelongsToProvider,
    } = await import('./provider.js');

    const claudeSession = encodeProviderSession({ type: 'claude' }, 'abc');
    expect(claudeSession).toBe('claude:abc');
    expect(sessionBelongsToProvider(claudeSession, { type: 'opencode' })).toBe(false);
    expect(decodeProviderSession({ type: 'opencode' }, claudeSession)).toBeUndefined();
    expect(decodeProviderSession({ type: 'claude' }, claudeSession)).toBe('abc');
  });

  it('namespaces built-in ACP provider sessions separately', async () => {
    const {
      encodeProviderSession,
      decodeProviderSession,
      sessionBelongsToProvider,
    } = await import('./provider.js');

    const geminiSession = encodeProviderSession({ type: 'gemini' }, 'abc');
    expect(geminiSession).toBe('gemini:abc');
    expect(sessionBelongsToProvider(geminiSession, { type: 'acp-codex' })).toBe(false);
    expect(decodeProviderSession({ type: 'acp-codex' }, geminiSession)).toBeUndefined();
    expect(decodeProviderSession({ type: 'gemini' }, geminiSession)).toBe('abc');
  });
});

describe('resolveAgentId', () => {
  // A small roster mirroring the live fleet: canonical id != display name.
  function seedRoster() {
    writeAgentYaml('main', { name: 'Holden', description: 'hub' });
    writeAgentYaml('amos', {
      name: 'Amos',
      description: 'ops',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
    writeAgentYaml('naomi', {
      name: 'Naomi',
      description: 'research',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
  }

  it('passes a canonical id straight through', async () => {
    seedRoster();
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('main')).toBe('main');
    expect(resolveAgentId('amos')).toBe('amos');
  });

  it('resolves main even when its agent.yaml is absent (legacy install)', async () => {
    // No main yaml written — main is always a valid id.
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('main')).toBe('main');
  });

  it('resolves a display name to its canonical id (regression for fdfec14a)', async () => {
    seedRoster();
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('Holden')).toBe('main');
    expect(resolveAgentId('holden')).toBe('main');
    expect(resolveAgentId('Naomi')).toBe('naomi');
  });

  it('is case- and whitespace-insensitive', async () => {
    seedRoster();
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('  HOLDEN  ')).toBe('main');
    expect(resolveAgentId('\tAmOs\n')).toBe('amos');
  });

  it('resolves a historical alias after a rename append', async () => {
    // Naomi renamed to Nova; the outgoing display name is retained as an alias.
    writeAgentYaml('naomi', {
      name: 'Nova',
      description: 'research',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      aliases: ['Naomi'],
    });
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('Nova')).toBe('naomi'); // current display name
    expect(resolveAgentId('Naomi')).toBe('naomi'); // historical alias
    expect(resolveAgentId('naomi')).toBe('naomi'); // canonical id
  });

  it('returns null for an unknown agent', async () => {
    seedRoster();
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('bogus')).toBeNull();
  });

  it('returns null for empty / whitespace-only input', async () => {
    seedRoster();
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('')).toBeNull();
    expect(resolveAgentId('   ')).toBeNull();
  });

  it('resolves id-first when a display name collides with another agent id', async () => {
    // The uniqueness guard (commit 3) prevents this being created, but the
    // resolver precedence (id > name > alias) is the documented backstop.
    writeAgentYaml('amos', {
      name: 'Amos',
      description: 'ops',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
    // A second agent whose *display name* equals amos's canonical id.
    writeAgentYaml('impostor', {
      name: 'amos',
      description: 'collides',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
    const { resolveAgentId } = await import('./agent-config.js');
    expect(resolveAgentId('amos')).toBe('amos');
  });
});

describe('getAgentAliases', () => {
  it('returns the aliases array from agent.yaml', async () => {
    writeAgentYaml('naomi', {
      name: 'Nova',
      description: 'research',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      aliases: ['Naomi', 'Research'],
    });
    const { getAgentAliases } = await import('./agent-config.js');
    expect(getAgentAliases('naomi')).toEqual(['Naomi', 'Research']);
  });

  it('returns [] when there are no aliases or no yaml', async () => {
    writeAgentYaml('amos', {
      name: 'Amos',
      description: 'ops',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });
    const { getAgentAliases } = await import('./agent-config.js');
    expect(getAgentAliases('amos')).toEqual([]);
    expect(getAgentAliases('ghost')).toEqual([]);
  });
});

describe('findAgentIdentityCollision', () => {
  beforeEach(() => {
    writeAgentYaml('main', { name: 'Holden', description: 'hub' });
    writeAgentYaml('naomi', {
      name: 'Nova',
      description: 'research',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      aliases: ['Naomi'],
    });
  });

  it('detects a collision with an existing canonical id', async () => {
    const { findAgentIdentityCollision } = await import('./agent-config.js');
    expect(findAgentIdentityCollision('naomi')).toEqual({ agentId: 'naomi', kind: 'id', value: 'naomi' });
    expect(findAgentIdentityCollision('MAIN')).toEqual({ agentId: 'main', kind: 'id', value: 'main' });
  });

  it('detects a collision with an existing display name (case-insensitive)', async () => {
    const { findAgentIdentityCollision } = await import('./agent-config.js');
    expect(findAgentIdentityCollision('holden')).toEqual({ agentId: 'main', kind: 'name', value: 'Holden' });
    expect(findAgentIdentityCollision('nova')).toEqual({ agentId: 'naomi', kind: 'name', value: 'Nova' });
  });

  it('detects a collision with an existing alias', async () => {
    const { findAgentIdentityCollision } = await import('./agent-config.js');
    expect(findAgentIdentityCollision('naomi ')).toEqual({ agentId: 'naomi', kind: 'id', value: 'naomi' });
    expect(findAgentIdentityCollision('Naomi', { ignoreAgentId: 'naomi' })).toBeNull();
    // With naomi ignored, its alias no longer collides; a fresh value is free.
    expect(findAgentIdentityCollision('brandnew')).toBeNull();
  });

  it('returns null for a free value and ignores the named agent', async () => {
    const { findAgentIdentityCollision } = await import('./agent-config.js');
    expect(findAgentIdentityCollision('freshname')).toBeNull();
    // Renaming naomi and keeping its own name/alias is not a self-collision.
    expect(findAgentIdentityCollision('Nova', { ignoreAgentId: 'naomi' })).toBeNull();
    expect(findAgentIdentityCollision('')).toBeNull();
  });
});

describe('ensureAgentsMdSymlink', () => {
  function makeAgentDir(withClaudeMd: boolean): string {
    const dir = path.join(projectRoot, 'agents', 'sym');
    fs.mkdirSync(dir, { recursive: true });
    if (withClaudeMd) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'INSTRUCTIONS', 'utf-8');
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates AGENTS.md resolving to CLAUDE.md content', async () => {
    const dir = makeAgentDir(true);
    const { ensureAgentsMdSymlink } = await import('./agent-config.js');
    expect(ensureAgentsMdSymlink(dir)).toBe(true);
    const agentsPath = path.join(dir, 'AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);
    // Reading through the link/copy yields the canonical instructions either way.
    expect(fs.readFileSync(agentsPath, 'utf-8')).toBe('INSTRUCTIONS');
  });

  it('returns false when CLAUDE.md is absent', async () => {
    const dir = makeAgentDir(false);
    const { ensureAgentsMdSymlink } = await import('./agent-config.js');
    expect(ensureAgentsMdSymlink(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('is a no-op when AGENTS.md already exists', async () => {
    const dir = makeAgentDir(true);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PREEXISTING', 'utf-8');
    const { ensureAgentsMdSymlink } = await import('./agent-config.js');
    expect(ensureAgentsMdSymlink(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe('PREEXISTING');
  });

  it('falls back to a real copy when symlink creation fails (e.g. stock Windows EPERM)', async () => {
    const dir = makeAgentDir(true);
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const { ensureAgentsMdSymlink } = await import('./agent-config.js');
    expect(ensureAgentsMdSymlink(dir)).toBe(true);
    const agentsPath = path.join(dir, 'AGENTS.md');
    // A real file (not a symlink) containing the instructions.
    expect(fs.lstatSync(agentsPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(agentsPath, 'utf-8')).toBe('INSTRUCTIONS');
  });
});
