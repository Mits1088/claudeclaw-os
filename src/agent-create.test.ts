import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

let tmpRoot: string;
let projectRoot: string;
let claudeclawConfig: string;
let storeDir: string;
let homeDir: string;

// Mock config BEFORE importing agent-create so PROJECT_ROOT/CLAUDECLAW_CONFIG
// point at tmp dirs.
vi.mock('./config.js', () => ({
  get CLAUDECLAW_CONFIG() { return claudeclawConfig; },
  get PROJECT_ROOT() { return projectRoot; },
  get STORE_DIR() { return storeDir; },
  get WARROOM_TMP_DIR() { return path.join(storeDir, 'tmp'); },
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
}));

// Cut the heavy import chain (orchestrator -> agent -> SDK); createAgent only
// calls refreshAgentRegistry as a post-write side effect we don't exercise here.
vi.mock('./orchestrator.js', () => ({ refreshAgentRegistry: () => {} }));

// env reader used by loadAgentConfig for the seeded existing agents.
vi.mock('./env.js', () => ({ readEnvFile: () => ({ TEST_BOT_TOKEN: 'dummy' }) }));

// createAgent writes the launchd plist under os.homedir(). Forcing IS_MACOS on
// makes that write path run on every platform, so CI (ubuntu) exercises the
// isolation test below instead of skipping the only branch that touches the
// home directory. homedir itself is redirected in beforeEach.
vi.mock('./platform.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./platform.js')>()),
  IS_MACOS: true,
}));

function writeAgentYaml(agentId: string, content: Record<string, unknown>) {
  const dir = path.join(projectRoot, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), yaml.dump(content), 'utf-8');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-agent-create-'));
  projectRoot = path.join(tmpRoot, 'project');
  claudeclawConfig = path.join(tmpRoot, 'config');
  storeDir = path.join(tmpRoot, 'store');
  fs.mkdirSync(path.join(projectRoot, 'agents'), { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  // Keep the per-agent plist inside the temp root. Without this, every run of
  // this file left com.claudeclaw.worker.plist and
  // com.claudeclaw.temporary-worker.plist in the developer's real
  // ~/Library/LaunchAgents, pointing at a temp dir that no longer exists.
  homeDir = path.join(tmpRoot, 'home');
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  process.env.TEST_BOT_TOKEN = 'dummy';
  // Existing roster: canonical id != display name, plus an alias.
  writeAgentYaml('naomi', {
    name: 'Nova',
    description: 'research',
    telegram_bot_token_env: 'TEST_BOT_TOKEN',
    aliases: ['Naomi', 'Researcher'],
  });
});

afterEach(() => {
  delete process.env.TEST_BOT_TOKEN;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createdDirExists(id: string): boolean {
  return fs.existsSync(path.join(projectRoot, 'agents', id))
    || fs.existsSync(path.join(claudeclawConfig, 'agents', id));
}

describe('createAgent uniqueness guard', () => {
  const baseOpts = { name: 'Fresh', description: 'd', botToken: '123:abc' };

  it('rejects a new id that collides with an existing agent, writing nothing', async () => {
    const { createAgent } = await import('./agent-create.js');
    await expect(createAgent({ ...baseOpts, id: 'naomi' })).rejects.toThrow(/already exists|collides/i);
    expect(createdDirExists('naomi')).toBe(true); // pre-existing agent dir untouched
  });

  it('rejects a new display name that collides with an existing name', async () => {
    const { createAgent } = await import('./agent-create.js');
    await expect(createAgent({ ...baseOpts, id: 'freshid', name: 'nova' }))
      .rejects.toThrow(/collides with the name "Nova" of agent "naomi"/);
    expect(createdDirExists('freshid')).toBe(false); // nothing written
  });

  it('rejects a new display name that collides with an existing alias', async () => {
    const { createAgent } = await import('./agent-create.js');
    await expect(createAgent({ ...baseOpts, id: 'freshid', name: 'Researcher' }))
      .rejects.toThrow(/collides with the alias "Researcher" of agent "naomi"/);
    expect(createdDirExists('freshid')).toBe(false);
  });
});

describe('createAgent headless runtime', () => {
  it('creates a worker without validating or storing a Telegram token', async () => {
    const { createAgent } = await import('./agent-create.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await createAgent({
      id: 'worker',
      name: 'Worker',
      description: 'mission worker',
      runtimeMode: 'headless',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.envKey).toBeNull();
    expect(result.botInfo).toBeNull();
    const raw = yaml.load(fs.readFileSync(path.join(result.agentDir, 'agent.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(raw.runtime).toEqual({ mode: 'headless' });
    expect(raw.lifecycle).toEqual({ mode: 'persistent' });
    expect(raw.telegram_bot_token_env).toBeUndefined();
  });

  it('persists task-scoped lifecycle for an explicitly temporary worker', async () => {
    const { createAgent } = await import('./agent-create.js');
    const result = await createAgent({
      id: 'temporary-worker',
      name: 'Temporary Worker',
      description: 'one bounded task tree',
      runtimeMode: 'headless',
      lifecycleMode: 'task-scoped',
    });

    const raw = yaml.load(fs.readFileSync(path.join(result.agentDir, 'agent.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(raw.lifecycle).toEqual({ mode: 'task-scoped' });
  });

  it('rejects task-scoped lifecycle for a messenger agent', async () => {
    const { createAgent } = await import('./agent-create.js');
    await expect(createAgent({
      id: 'bad-scope',
      name: 'Bad Scope',
      description: 'invalid lifecycle combination',
      runtimeMode: 'messenger',
      lifecycleMode: 'task-scoped',
    })).rejects.toThrow(/requires runtime mode 'headless'/);
  });
});

describe('createAgent service config', () => {
  it('writes the launchd plist under os.homedir() and nothing outside the temp root', async () => {
    const { createAgent } = await import('./agent-create.js');
    const writes = vi.spyOn(fs, 'writeFileSync');
    const result = await createAgent({
      id: 'boxed',
      name: 'Boxed',
      description: 'service config isolation',
      runtimeMode: 'headless',
    });

    expect(result.plistPath).toBe(path.join(homeDir, 'Library', 'LaunchAgents', 'com.claudeclaw.boxed.plist'));
    expect(fs.existsSync(String(result.plistPath))).toBe(true);
    // Every write must stay under the OS temp dir: the suite's own temp root
    // plus the War Room roster, which agent-config binds to the first temp
    // root of the process at import time.
    const tmpBase = os.tmpdir();
    const escaped = writes.mock.calls.map(call => String(call[0])).filter(target => !target.startsWith(tmpBase));
    expect(escaped).toEqual([]);
  });
});

describe('resolveStableNodePath', () => {
  it('prefers the stable Homebrew wrapper over the versioned Cellar binary', async () => {
    const { resolveStableNodePath } = await import('./agent-create.js');
    const cellar = '/opt/homebrew/Cellar/node@24/24.19.0/bin/node';
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      if (p === process.execPath || p === '/opt/homebrew/bin/node') return cellar;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as typeof fs.realpathSync);

    expect(resolveStableNodePath()).toBe('/opt/homebrew/bin/node');
  });

  it('keeps execPath when no stable wrapper points at the same binary', async () => {
    const { resolveStableNodePath } = await import('./agent-create.js');
    const nvm = '/Users/someone/.nvm/versions/node/v24.19.0/bin/node';
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      if (p === process.execPath) return nvm;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as typeof fs.realpathSync);

    expect(resolveStableNodePath()).toBe(process.execPath);
  });

  it('never returns a path that resolves to a different binary', async () => {
    const { resolveStableNodePath } = await import('./agent-create.js');
    expect(fs.realpathSync(resolveStableNodePath()))
      .toBe(fs.realpathSync(process.execPath));
  });
});
