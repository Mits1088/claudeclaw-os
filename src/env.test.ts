import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { readEnvFile, envFileCandidates, REPO_ROOT_ENV } from './env.js';

const TMP_DIR = '/tmp/claudeclaw-env-test';
const TMP_ENV = path.join(TMP_DIR, '.env');

function writeEnv(content: string): void {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(TMP_ENV, content, 'utf-8');
}

function cleanup(): void {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('readEnvFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  function mockCwd(): void {
    vi.spyOn(process, 'cwd').mockReturnValue(TMP_DIR);
  }

  it('parses KEY=value correctly', () => {
    writeEnv('FOO=bar\nBAZ=qux\n');
    mockCwd();
    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles double-quoted values', () => {
    writeEnv('GREETING="hello world"\n');
    mockCwd();
    const result = readEnvFile(['GREETING']);
    expect(result).toEqual({ GREETING: 'hello world' });
  });

  it('handles single-quoted values', () => {
    writeEnv("NAME='John Doe'\n");
    mockCwd();
    const result = readEnvFile(['NAME']);
    expect(result).toEqual({ NAME: 'John Doe' });
  });

  it('ignores comment lines', () => {
    writeEnv('# This is a comment\nKEY=value\n# Another comment\n');
    mockCwd();
    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('ignores blank lines', () => {
    writeEnv('\n\nKEY=value\n\n\n');
    mockCwd();
    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('returns empty object if .env does not exist', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/nonexistent-dir-xyz');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({});
  });

  it('derives the canonical fallback from the module location', () => {
    const expected = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '.env',
    );
    expect(REPO_ROOT_ENV).toBe(expected);
    expect(envFileCandidates('/tmp/non-repo-agent')).toEqual([
      path.resolve('/tmp/non-repo-agent', '.env'),
      expected,
    ]);
  });

  it('falls back to the repo-root .env when invoked from a non-repo cwd', () => {
    const agentCwd = path.resolve('/tmp/non-repo-agent');
    const agentEnv = path.join(agentCwd, '.env');
    vi.spyOn(process, 'cwd').mockReturnValue(agentCwd);
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, encoding) => {
      const resolved = path.resolve(String(file));
      if (resolved === agentEnv) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (resolved === REPO_ROOT_ENV && encoding === 'utf-8') {
        return 'DB_ENCRYPTION_KEY=repo-root-secret\nCLAUDECLAW_CONFIG="C:\\Users\\O\'Brien\\.claudeclaw"\n';
      }
      throw Object.assign(new Error(`unexpected read: ${resolved}`), { code: 'ENOENT' });
    });

    expect(readEnvFile(['DB_ENCRYPTION_KEY', 'CLAUDECLAW_CONFIG'])).toEqual({
      DB_ENCRYPTION_KEY: 'repo-root-secret',
      CLAUDECLAW_CONFIG: "C:\\Users\\O'Brien\\.claudeclaw",
    });
  });

  it('keeps a cwd-local .env authoritative when one exists', () => {
    writeEnv('DB_ENCRYPTION_KEY=local-override\n');
    mockCwd();
    expect(readEnvFile(['DB_ENCRYPTION_KEY'])).toEqual({
      DB_ENCRYPTION_KEY: 'local-override',
    });
  });

  it('only returns requested keys', () => {
    writeEnv('A=1\nB=2\nC=3\n');
    mockCwd();
    const result = readEnvFile(['A', 'C']);
    expect(result).toEqual({ A: '1', C: '3' });
    expect(result).not.toHaveProperty('B');
  });

  it('strips surrounding whitespace from keys and values', () => {
    writeEnv('  MY_KEY  =  my_value  \n');
    mockCwd();
    const result = readEnvFile(['MY_KEY']);
    expect(result).toEqual({ MY_KEY: 'my_value' });
  });

  it('handles values containing = sign', () => {
    writeEnv('URL=https://example.com?a=1&b=2\n');
    mockCwd();
    const result = readEnvFile(['URL']);
    expect(result).toEqual({ URL: 'https://example.com?a=1&b=2' });
  });

  it('skips lines without = sign', () => {
    writeEnv('NOEQUALS\nKEY=value\n');
    mockCwd();
    const result = readEnvFile(['KEY', 'NOEQUALS']);
    expect(result).toEqual({ KEY: 'value' });
  });

  // Quote-safe Windows paths: single-quoting a value must strip exactly one quote
  // layer and leave backslashes literal, so the same .env line works for the Node
  // parser, for shell grep|cut readers, and for a raw `source .env`.
  it('preserves backslashes in a single-quoted Windows path (strips quotes only)', () => {
    writeEnv("CLAUDECLAW_CONFIG='C:\\Users\\mikek\\.claudeclaw-os'\n");
    mockCwd();
    const result = readEnvFile(['CLAUDECLAW_CONFIG']);
    expect(result).toEqual({ CLAUDECLAW_CONFIG: 'C:\\Users\\mikek\\.claudeclaw-os' });
  });

  it('preserves backslashes in a double-quoted Windows path (strips quotes only)', () => {
    writeEnv('CLAUDECLAW_CONFIG="C:\\Users\\mikek\\.claudeclaw-os"\n');
    mockCwd();
    const result = readEnvFile(['CLAUDECLAW_CONFIG']);
    expect(result).toEqual({ CLAUDECLAW_CONFIG: 'C:\\Users\\mikek\\.claudeclaw-os' });
  });

  it('handles an unquoted Windows path (backslashes intact)', () => {
    writeEnv('CLAUDECLAW_CONFIG=C:\\Users\\mikek\\.claudeclaw-os\n');
    mockCwd();
    const result = readEnvFile(['CLAUDECLAW_CONFIG']);
    expect(result).toEqual({ CLAUDECLAW_CONFIG: 'C:\\Users\\mikek\\.claudeclaw-os' });
  });

  // A path containing an apostrophe (e.g. a Windows user folder like O'Brien) cannot be
  // single-quoted — the literal ' would be invalid shell syntax — so setup.ts writes it
  // double-quoted instead. The Node parser must still strip exactly one quote layer and
  // preserve the interior apostrophe and backslashes.
  it('preserves an apostrophe in a double-quoted Windows path', () => {
    writeEnv('CLAUDECLAW_CONFIG="C:\\Users\\O\'Brien\\.claudeclaw-os"\n');
    mockCwd();
    const result = readEnvFile(['CLAUDECLAW_CONFIG']);
    expect(result).toEqual({ CLAUDECLAW_CONFIG: "C:\\Users\\O'Brien\\.claudeclaw-os" });
  });
});

function mockEnvFiles(files: Map<string, string>): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, encoding) => {
    const resolved = path.resolve(String(file));
    const content = files.get(resolved);
    if (content !== undefined && encoding === 'utf-8') return content;
    throw Object.assign(new Error(`missing: ${resolved}`), { code: 'ENOENT' });
  });
}

describe('cwd .env store mismatch warning', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('warns once and names both env files and resolved store paths', async () => {
    // test-env-setup.ts forces a temp store; the warning path needs it unset.
    vi.stubEnv('CLAUDECLAW_STORE_DIR', undefined);
    const { readEnvFile, REPO_ROOT_ENV } = await import('./env.js');
    const cwd = path.resolve(path.dirname(REPO_ROOT_ENV), '..', 'sibling-checkout');
    const cwdEnv = path.join(cwd, '.env');
    const cwdStore = path.join(cwd, 'isolated-store');
    const rootStore = path.join(path.dirname(REPO_ROOT_ENV), 'store');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    mockEnvFiles(new Map([
      [cwdEnv, 'CLAUDECLAW_STORE_DIR=./isolated-store\nAPI_KEY=cwd\n'],
      [REPO_ROOT_ENV, `CLAUDECLAW_STORE_DIR=${rootStore}\nAPI_KEY=root\n`],
    ]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(readEnvFile(['API_KEY'])).toEqual({ API_KEY: 'cwd' });
    expect(readEnvFile(['API_KEY'])).toEqual({ API_KEY: 'cwd' });

    expect(error).toHaveBeenCalledOnce();
    const warning = String(error.mock.calls[0][0]);
    expect(warning).toContain(cwdEnv);
    expect(warning).toContain(REPO_ROOT_ENV);
    expect(warning).toContain(cwdStore);
    expect(warning).toContain(rootStore);
  });

  it('stays silent for equivalent resolved store paths', async () => {
    const { readEnvFile, REPO_ROOT_ENV } = await import('./env.js');
    const cwd = path.resolve(path.dirname(REPO_ROOT_ENV), '..', 'sibling-checkout');
    const cwdEnv = path.join(cwd, '.env');
    const rootStore = path.join(path.dirname(REPO_ROOT_ENV), 'store');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    mockEnvFiles(new Map([
      [cwdEnv, `CLAUDECLAW_STORE_DIR=${path.relative(cwd, rootStore)}\n`],
      [REPO_ROOT_ENV, `CLAUDECLAW_STORE_DIR=${rootStore}\n`],
    ]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    readEnvFile(['CLAUDECLAW_STORE_DIR']);

    expect(error).not.toHaveBeenCalled();
  });

  it('stays silent when a home-relative store resolves to the same path', async () => {
    const { readEnvFile, REPO_ROOT_ENV } = await import('./env.js');
    const cwd = path.resolve(path.dirname(REPO_ROOT_ENV), '..', 'sibling-checkout');
    const cwdEnv = path.join(cwd, '.env');
    const homeStore = path.join(os.homedir(), 'claudeclaw-test-store');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    mockEnvFiles(new Map([
      [cwdEnv, 'CLAUDECLAW_STORE_DIR=~/claudeclaw-test-store\n'],
      [REPO_ROOT_ENV, `CLAUDECLAW_STORE_DIR=${homeStore}\n`],
    ]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    readEnvFile(['CLAUDECLAW_STORE_DIR']);

    expect(error).not.toHaveBeenCalled();
  });

  it('stays silent when both env files use the default store', async () => {
    const { readEnvFile, REPO_ROOT_ENV } = await import('./env.js');
    const cwd = path.resolve(path.dirname(REPO_ROOT_ENV), '..', 'sibling-checkout');
    const cwdEnv = path.join(cwd, '.env');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    mockEnvFiles(new Map([
      [cwdEnv, 'API_KEY=cwd\n'],
      [REPO_ROOT_ENV, 'API_KEY=root\n'],
    ]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    readEnvFile(['API_KEY']);

    expect(error).not.toHaveBeenCalled();
  });

  it('stays silent when process.env overrides both env files', async () => {
    const { readEnvFile, REPO_ROOT_ENV } = await import('./env.js');
    const cwd = path.resolve(path.dirname(REPO_ROOT_ENV), '..', 'sibling-checkout');
    const cwdEnv = path.join(cwd, '.env');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.stubEnv('CLAUDECLAW_STORE_DIR', path.join(cwd, 'explicit-store'));
    mockEnvFiles(new Map([
      [cwdEnv, 'CLAUDECLAW_STORE_DIR=./isolated-store\n'],
      [REPO_ROOT_ENV, 'CLAUDECLAW_STORE_DIR=./store\n'],
    ]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    readEnvFile(['CLAUDECLAW_STORE_DIR']);

    expect(error).not.toHaveBeenCalled();
  });

  it('stays silent when cwd and repo root produce a single candidate', async () => {
    const { readEnvFile, REPO_ROOT_ENV } = await import('./env.js');
    vi.spyOn(process, 'cwd').mockReturnValue(path.dirname(REPO_ROOT_ENV));
    mockEnvFiles(new Map([[REPO_ROOT_ENV, 'CLAUDECLAW_STORE_DIR=./store\n']]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    readEnvFile(['CLAUDECLAW_STORE_DIR']);

    expect(error).not.toHaveBeenCalled();
  });

  it('stays silent when the repo-root .env is missing', async () => {
    const { readEnvFile, REPO_ROOT_ENV } = await import('./env.js');
    const cwd = path.resolve(path.dirname(REPO_ROOT_ENV), '..', 'sibling-checkout');
    const cwdEnv = path.join(cwd, '.env');
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    mockEnvFiles(new Map([[cwdEnv, 'CLAUDECLAW_STORE_DIR=./isolated-store\n']]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    readEnvFile(['CLAUDECLAW_STORE_DIR']);

    expect(error).not.toHaveBeenCalled();
  });
});
