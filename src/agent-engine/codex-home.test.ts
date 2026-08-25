// The isolated CODEX_HOME and its credential lifecycle.
//
// Synthetic credentials in temp directories only — nothing here reads or writes a real
// ~/.codex. The token strings are deliberately distinctive so the last suite can prove no
// log line or error message ever carries one.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../logger.js';
import {
  CodexAuthPreparationError,
  CodexWindowsSandboxPreparationError,
  applyCodexAuth,
  applyCodexWindowsSandbox,
  detectCodexAuth,
  detectCodexWindowsSandbox,
  ensureIsolatedCodexHome,
  operatorCodexHome,
} from './codex-home.js';

/** A token shaped like the real thing, so a leak into a message is unmistakable. */
const TOKEN = 'sk-synthetic-DO-NOT-LEAK-4a91c0f7';
const authJson = (token = TOKEN): string => JSON.stringify({ tokens: { access_token: token } });

let root: string;
let configDir: string;
let projectRoot: string;
let cwd: string;
let operatorHome: string;
const savedCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-codex-home-'));
  configDir = path.join(root, 'config');
  projectRoot = path.join(root, 'project');
  cwd = path.join(root, 'workspace');
  operatorHome = path.join(root, 'operator-codex');
  for (const dir of [configDir, projectRoot, cwd, operatorHome]) fs.mkdirSync(dir, { recursive: true });
  // The operator's home is resolved from CODEX_HOME, exactly as the Codex CLI and the
  // provider preflight resolve it. Pointed at a temp directory so no real login is touched.
  process.env.CODEX_HOME = operatorHome;
});

afterEach(() => {
  // Before the cleanup below, not after: several tests spy on fs to force a failure, and a
  // mocked rmSync would make the teardown throw instead of removing the temp tree.
  vi.restoreAllMocks();
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(root, { recursive: true, force: true });
});

/** The isolated home, plus the path its mirrored credential would live at. */
function isolated(): { home: string; dest: string } {
  const home = ensureIsolatedCodexHome(configDir, projectRoot, cwd);
  return { home, dest: path.join(home, 'auth.json') };
}

function writeOperatorLogin(token = TOKEN, mtimeMs?: number): string {
  const file = path.join(operatorHome, 'auth.json');
  fs.writeFileSync(file, authJson(token));
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function writeOperatorWindowsSandbox(marker = '{"version":5}', users = 'dpapi-protected-users'): void {
  const markerPath = path.join(operatorHome, '.sandbox', 'setup_marker.json');
  const usersPath = path.join(operatorHome, '.sandbox-secrets', 'sandbox_users.json');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.mkdirSync(path.dirname(usersPath), { recursive: true });
  fs.writeFileSync(markerPath, marker);
  fs.writeFileSync(usersPath, users);
}

/** Everything the logger was handed this test, flattened to one searchable string. */
function loggedText(): string {
  const mocks = [logger.info, logger.warn, logger.error, logger.debug] as unknown as Array<{ mock: { calls: unknown[][] } }>;
  return JSON.stringify(mocks.map((m) => m.mock.calls));
}

describe('the isolated codex home', () => {
  it('creates it under the config dir and returns the canonical path', () => {
    const { home } = isolated();
    expect(fs.statSync(home).isDirectory()).toBe(true);
    expect(path.basename(home)).toBe('codex-home');
    // Canonical, because the App Server policy verifier compares paths and cannot resolve
    // them itself.
    expect(home).toBe(fs.realpathSync(home));
  });

  it('is idempotent', () => {
    expect(isolated().home).toBe(isolated().home);
  });

  it('refuses a home that resolves INSIDE a writable root', () => {
    // A workspace-write turn could otherwise plant a config.toml in the "isolated" home and
    // defeat the boundary on a later turn, so this fails closed rather than launching.
    expect(() => ensureIsolatedCodexHome(path.join(cwd, 'nested'), projectRoot, cwd))
      .toThrow(/resolves inside a writable root/);
    expect(() => ensureIsolatedCodexHome(path.join(projectRoot, 'nested'), projectRoot, cwd))
      .toThrow(/resolves inside a writable root/);
  });

  it('reports an isolation failure as a plain error, not a credential one', () => {
    // Each adapter wraps a generic failure in "check that directory is writable", which is
    // the right advice here and the wrong advice for an unreadable credential file.
    let caught: unknown;
    try { ensureIsolatedCodexHome(path.join(cwd, 'nested'), projectRoot, cwd); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CodexAuthPreparationError);
  });
});

describe('elevated Windows sandbox state', () => {
  it('is a no-op away from native Windows', () => {
    const { home } = isolated();
    const plan = detectCodexWindowsSandbox(home, 'linux', operatorHome);

    expect(plan).toMatchObject({ mode: 'not-applicable', ready: true, identity: 'not-applicable' });
    applyCodexWindowsSandbox(plan);
    expect(fs.existsSync(path.join(home, 'config.toml'))).toBe(false);
  });

  it('reports an unconfigured boundary without inventing setup state', () => {
    const { home } = isolated();
    const plan = detectCodexWindowsSandbox(home, 'win32', operatorHome);

    expect(plan).toMatchObject({ mode: 'elevated', ready: false, identity: 'elevated:unconfigured' });
    applyCodexWindowsSandbox(plan);
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain('sandbox = "elevated"');
    expect(fs.existsSync(path.join(home, '.sandbox', 'setup_marker.json'))).toBe(false);
  });

  it('mirrors only the approved setup marker and protected sandbox-user state', () => {
    writeOperatorWindowsSandbox();
    const { home } = isolated();
    const plan = detectCodexWindowsSandbox(home, 'win32', operatorHome);

    expect(plan.ready).toBe(true);
    expect(plan.identity).toMatch(/^elevated:[a-f0-9]{64}$/);
    expect(plan.identity).not.toContain('dpapi-protected-users');
    applyCodexWindowsSandbox(plan);

    expect(fs.readFileSync(path.join(home, '.sandbox', 'setup_marker.json'), 'utf8')).toBe('{"version":5}');
    expect(fs.readFileSync(path.join(home, '.sandbox-secrets', 'sandbox_users.json'), 'utf8')).toBe('dpapi-protected-users');
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(
      '[windows]\nsandbox = "elevated"\nsandbox_private_desktop = true\n',
    );
    expect(fs.readdirSync(home).sort()).toEqual(['.sandbox', '.sandbox-secrets', 'config.toml']);
  });

  it('fails closed when the source changes between detection and launch preparation', () => {
    writeOperatorWindowsSandbox();
    const { home } = isolated();
    const plan = detectCodexWindowsSandbox(home, 'win32', operatorHome);
    fs.writeFileSync(path.join(operatorHome, '.sandbox', 'setup_marker.json'), '{"version":6}');

    expect(() => applyCodexWindowsSandbox(plan)).toThrow(CodexWindowsSandboxPreparationError);
    expect(fs.existsSync(path.join(home, '.sandbox', 'setup_marker.json'))).toBe(false);
  });

  it('does not copy setup artifacts onto themselves', () => {
    writeOperatorWindowsSandbox();
    fs.writeFileSync(path.join(operatorHome, 'config.toml'), '# operator-owned\n');
    const plan = detectCodexWindowsSandbox(operatorHome, 'win32', operatorHome);

    applyCodexWindowsSandbox(plan);
    expect(fs.readFileSync(path.join(operatorHome, '.sandbox-secrets', 'sandbox_users.json'), 'utf8'))
      .toBe('dpapi-protected-users');
    expect(fs.readFileSync(path.join(operatorHome, 'config.toml'), 'utf8')).toBe('# operator-owned\n');
  });

  it('does not mistake an implicitly inherited isolated CODEX_HOME for sandbox setup source', () => {
    const { home } = isolated();
    process.env.CODEX_HOME = home;
    const conventionalHome = path.join(root, '.codex');
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    const marker = path.join(conventionalHome, '.sandbox', 'setup_marker.json');
    const users = path.join(conventionalHome, '.sandbox-secrets', 'sandbox_users.json');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.mkdirSync(path.dirname(users), { recursive: true });
    fs.writeFileSync(marker, '{"version":5}');
    fs.writeFileSync(users, 'protected');

    expect(detectCodexWindowsSandbox(home, 'win32').sourceHome).toBe(conventionalHome);
  });
});

describe('subscription mode mirrors the operator login', () => {
  it('copies a file-backed login into the isolated home', () => {
    writeOperatorLogin();
    const { home, dest } = isolated();

    const plan = detectCodexAuth(home, false);
    expect(plan.mode).toBe('file');
    expect(plan.action).toBe('copy');
    expect(plan.identity).toMatch(/^file:[0-9a-f]{64}$/);
    // Read-only so far: the App Server path needs the identity BEFORE it may touch the home.
    expect(fs.existsSync(dest)).toBe(false);

    applyCodexAuth(plan);
    expect(fs.readFileSync(dest, 'utf8')).toBe(authJson());
  });

  it('leaves a NEWER mirrored copy alone, so refreshed tokens survive', () => {
    // Codex writes refreshed tokens back into its own CODEX_HOME. Overwriting them with an
    // older source file would throw away a live session for no reason.
    writeOperatorLogin(TOKEN, Date.now() - 60_000);
    const { home, dest } = isolated();
    fs.writeFileSync(dest, authJson('refreshed-by-the-child'));

    const plan = detectCodexAuth(home, false);
    expect(plan.action).toBe('none');
    applyCodexAuth(plan);
    expect(fs.readFileSync(dest, 'utf8')).toBe(authJson('refreshed-by-the-child'));
  });

  it('re-mirrors once a fresh login rewrites the source', () => {
    writeOperatorLogin('first-login', Date.now() - 60_000);
    const { home, dest } = isolated();
    applyCodexAuth(detectCodexAuth(home, false));
    expect(fs.readFileSync(dest, 'utf8')).toBe(authJson('first-login'));

    // `codex login` again: newer source, different contents.
    writeOperatorLogin('second-login', Date.now() + 60_000);
    const plan = detectCodexAuth(home, false);
    expect(plan.action).toBe('copy');
    applyCodexAuth(plan);
    expect(fs.readFileSync(dest, 'utf8')).toBe(authJson('second-login'));
  });

  it('identifies the login by the SOURCE, so a token refresh is not a rotation', () => {
    // The identity feeds the launch fingerprint. Digesting our own copy would make every
    // routine refresh look like a credential rotation and drain every turn in flight.
    writeOperatorLogin(TOKEN, Date.now() - 60_000);
    const { home, dest } = isolated();
    const before = detectCodexAuth(home, false).identity;

    fs.writeFileSync(dest, authJson('a-refreshed-access-token'));
    expect(detectCodexAuth(home, false).identity).toBe(before);
  });

  it('installs the credential atomically and owner-only, leaving no temp file', () => {
    writeOperatorLogin();
    const { home, dest } = isolated();
    applyCodexAuth(detectCodexAuth(home, false));

    expect(fs.readdirSync(home).filter((f) => f.includes('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') {
      // Advisory on Windows, where the inherited ACL governs instead.
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses when the login changes between detection and application', () => {
    // The plan's digest is already in the published launch fingerprint. Writing a different
    // credential would leave the manager claiming an auth state its home does not hold.
    writeOperatorLogin('detected-login');
    const { home, dest } = isolated();
    const plan = detectCodexAuth(home, false);

    writeOperatorLogin('a-completely-different-login');
    expect(() => applyCodexAuth(plan)).toThrow(CodexAuthPreparationError);
    expect(() => applyCodexAuth(plan)).toThrow(/login changed while ClaudeClaw was preparing/);
    // Nothing was written: the next invocation detects the new login and rotates to it.
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('does not copy a file onto itself when CODEX_HOME already IS the isolated home', () => {
    // Truncating the operator's own login would be the worst possible outcome here.
    const { home, dest } = isolated();
    process.env.CODEX_HOME = home;
    fs.writeFileSync(dest, authJson());

    const plan = detectCodexAuth(home, false);
    expect(plan.action).toBe('none');
    expect(plan.mode).toBe('file');
    applyCodexAuth(plan);
    expect(fs.readFileSync(dest, 'utf8')).toBe(authJson());
  });
});

describe('API-key mode keeps subscription credentials out of the home', () => {
  it('removes a credential mirrored in by an earlier subscription turn', () => {
    // The App Server path never did this at all: an API-key turn could keep reading the
    // subscription credential a previous turn had copied in.
    const { home, dest } = isolated();
    fs.writeFileSync(dest, authJson());

    const plan = detectCodexAuth(home, true);
    expect(plan.mode).toBe('api-key');
    expect(plan.action).toBe('remove');
    expect(plan.identity).toBe('api-key:');
    expect(fs.existsSync(dest)).toBe(true); // still read-only

    applyCodexAuth(plan);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('does nothing when there is no credential to remove', () => {
    const { home } = isolated();
    const plan = detectCodexAuth(home, true);
    expect(plan.action).toBe('none');
    expect(() => applyCodexAuth(plan)).not.toThrow();
  });

  it('ignores the operator login entirely', () => {
    writeOperatorLogin();
    const { home, dest } = isolated();
    applyCodexAuth(detectCodexAuth(home, true));
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('a keyring-backed login is not a missing login', () => {
  // Pinned 0.144.6 reads the OS keyring FIRST under its Auto storage mode ("failed to load
  // CLI auth from keyring, falling back to file storage") and keys entries by the service
  // name `Codex Auth` rather than by CODEX_HOME. So an isolated home authenticates fine
  // with nothing copied, and treating an absent auth.json as an error would refuse turns
  // that are perfectly able to run.

  it('does not fail when there is no auth.json to mirror', () => {
    const { home, dest } = isolated();
    const plan = detectCodexAuth(home, false);
    expect(plan.mode).toBe('delegated');
    expect(plan.action).toBe('none');
    expect(plan.identity).toBe('delegated:');
    expect(() => applyCodexAuth(plan)).not.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('removes a credential the operator has since deleted', () => {
    // Logged out of file storage, or switched to the keyring. Either way the mirrored copy
    // would authenticate as something they may have revoked.
    const { home, dest } = isolated();
    fs.writeFileSync(dest, authJson());

    const plan = detectCodexAuth(home, false);
    expect(plan.mode).toBe('delegated');
    expect(plan.action).toBe('remove');
    applyCodexAuth(plan);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('is a DIFFERENT launch identity from both file and api-key auth', () => {
    // So a logout, a login and a switch to API-key billing each rotate the process once.
    const { home } = isolated();
    const delegated = detectCodexAuth(home, false).identity;
    const apiKey = detectCodexAuth(home, true).identity;
    writeOperatorLogin();
    const file = detectCodexAuth(home, false).identity;

    expect(new Set([delegated, apiKey, file]).size).toBe(3);
  });
});

describe('preparation fails CLOSED', () => {
  // This replaces a warn-and-continue. A failed removal in API-key mode leaves the turn able
  // to read the credential the mode exists to keep away from it, and a failed copy only
  // postpones the failure to somewhere much less clear.

  it('throws when a stale credential cannot be removed', () => {
    const { home, dest } = isolated();
    fs.writeFileSync(dest, authJson());
    const plan = detectCodexAuth(home, true);

    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(() => applyCodexAuth(plan)).toThrow(CodexAuthPreparationError);
    expect(() => applyCodexAuth(plan)).toThrow(/will not start a Codex turn that could still read it/);
  });

  it('throws when the credential cannot be installed', () => {
    writeOperatorLogin();
    const { home, dest } = isolated();
    const plan = detectCodexAuth(home, false);

    // The home disappears between detection and application.
    fs.rmSync(home, { recursive: true, force: true });
    expect(() => applyCodexAuth(plan)).toThrow(CodexAuthPreparationError);
    expect(() => applyCodexAuth(plan)).toThrow(/Could not install the Codex credential/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('cleans up its temp file when the rename fails', () => {
    // A partial credential file is worse than none: the child would read it, fail to parse
    // it, and report an auth problem that looks nothing like a truncated write.
    writeOperatorLogin();
    const { home } = isolated();
    const plan = detectCodexAuth(home, false);

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    expect(() => applyCodexAuth(plan)).toThrow(/Could not install the Codex credential/);
    vi.restoreAllMocks();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('throws when the operator credential exists but cannot be read', () => {
    // Unreadable is not the same as absent. Treating it as a logout would silently run the
    // turn under different credentials than the operator has.
    writeOperatorLogin();
    const { home } = isolated();
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(() => detectCodexAuth(home, false)).toThrow(CodexAuthPreparationError);
    expect(() => detectCodexAuth(home, false)).toThrow(/Could not read the Codex credential/);
  });

  /**
   * Fail a `statSync` for ONE path with a given errno, delegating every other path to the
   * real implementation. Targeted rather than blanket, because detection stats several files
   * and the point is which one is unreadable.
   */
  function failStatFor(target: string, code: string) {
    const real = fs.statSync.bind(fs);
    return vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(file)) === path.resolve(target)) {
        throw Object.assign(new Error(`${code}: cannot stat`), { code });
      }
      return (real as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.statSync);
  }

  it('refuses when the OPERATOR credential cannot be stat\'d', () => {
    // EACCES is not a logout. Reading it as "absent" would quietly downgrade a subscription
    // login to `delegated` and run the turn under whatever the keyring happens to hold — or
    // under nothing — instead of saying the credential could not be inspected.
    writeOperatorLogin();
    const { home } = isolated();
    failStatFor(path.join(operatorHome, 'auth.json'), 'EACCES');

    expect(() => detectCodexAuth(home, false)).toThrow(CodexAuthPreparationError);
    expect(() => detectCodexAuth(home, false)).toThrow(/Could not determine whether a Codex credential exists/);
  });

  it('refuses when the operator credential is unreadable even with nothing mirrored yet', () => {
    // The same fail-closed answer whether or not a previous turn left a copy behind: the
    // detection result decides the launch fingerprint, so an unknown state must not resolve
    // to a confident 'delegated:'.
    writeOperatorLogin();
    const { home, dest } = isolated();
    expect(fs.existsSync(dest)).toBe(false);
    failStatFor(path.join(operatorHome, 'auth.json'), 'EPERM');

    expect(() => detectCodexAuth(home, false)).toThrow(/Could not determine whether a Codex credential exists/);
  });

  it('refuses stale-auth REMOVAL in API-key mode when the mirrored file cannot be stat\'d', () => {
    // The worst case of the swallow-everything version, and the reason it had to change: an
    // unreadable mirrored credential became `action: 'none'`, the removal silently turned
    // into a no-op, and the turn ran with the subscription credential this mode exists to
    // keep away from it.
    const { home, dest } = isolated();
    fs.writeFileSync(dest, authJson());
    failStatFor(dest, 'EACCES');

    expect(() => detectCodexAuth(home, true)).toThrow(CodexAuthPreparationError);
    expect(() => detectCodexAuth(home, true)).toThrow(/will not start a Codex turn without knowing which credentials/);
  });

  it('still reads a genuine absence as absence', () => {
    // The distinction only means something if ENOENT keeps working: a fresh install has no
    // credential anywhere and must not be refused.
    const { home } = isolated();
    failStatFor(path.join(operatorHome, 'auth.json'), 'ENOENT');
    expect(detectCodexAuth(home, false).mode).toBe('delegated');

    // ENOTDIR is the same fact reached differently — a parent path component is a file, so
    // nothing can exist below it.
    vi.restoreAllMocks();
    failStatFor(path.join(operatorHome, 'auth.json'), 'ENOTDIR');
    expect(detectCodexAuth(home, false).mode).toBe('delegated');
  });

  it('throws when the source vanishes between detection and the copy', () => {
    writeOperatorLogin();
    const { home } = isolated();
    const plan = detectCodexAuth(home, false);

    fs.rmSync(plan.source!, { force: true });
    expect(() => applyCodexAuth(plan)).toThrow(/Could not read the Codex login at/);
  });
});

describe('no credential material escapes', () => {
  it('keeps the token out of every log line and every error message', () => {
    writeOperatorLogin();
    const { home, dest } = isolated();

    // Every path that touches a credential, in one test: mirror it, then remove it.
    const mirror = detectCodexAuth(home, false);
    expect(mirror.identity).not.toContain(TOKEN);
    applyCodexAuth(mirror);
    applyCodexAuth(detectCodexAuth(home, true));

    // And the failure paths, whose messages are the likeliest place for contents to leak.
    fs.writeFileSync(dest, authJson());
    const messages: string[] = [];
    // Only this spy is restored, not every mock: a blanket restore would also wipe the
    // logger's recorded calls, which are what the assertions below inspect.
    const rmSync = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error(`refused while holding ${TOKEN}`);
    });
    try { applyCodexAuth(detectCodexAuth(home, true)); } catch (err) {
      messages.push(err instanceof Error ? err.message : String(err));
    }
    rmSync.mockRestore();

    expect(messages).toHaveLength(1);
    // The underlying error's own message quoted the token. Ours reports the errno — or, with
    // no errno, the error's class name — and never the message, precisely so a failure from
    // outside Node's fs layer cannot carry a credential into a log or a chat reply.
    expect(messages[0]).not.toContain(TOKEN);
    expect(messages[0]).toContain('(Error)');
    expect(loggedText()).not.toContain(TOKEN);
    // What IS logged is a byte count and a mode name — enough to diagnose, never the value.
    expect(loggedText()).toContain('codex_auth_mirrored');
  });

  it('does not put the operator home\'s contents in the identity', () => {
    writeOperatorLogin();
    const { home } = isolated();
    const identity = detectCodexAuth(home, false).identity;
    expect(identity).not.toContain(TOKEN);
    expect(identity).not.toContain('access_token');
    // A digest of the credential, so a rotation is detectable and the value is not.
    expect(identity).toBe(`file:${require('crypto').createHash('sha256').update(authJson()).digest('hex')}`);
  });
});

describe('the operator home is resolved the same way the CLI resolves it', () => {
  it('honours CODEX_HOME', () => {
    expect(operatorCodexHome()).toBe(operatorHome);
  });

  it('falls back to ~/.codex when CODEX_HOME is unset or blank', () => {
    delete process.env.CODEX_HOME;
    expect(operatorCodexHome()).toBe(path.join(os.homedir(), '.codex'));
    process.env.CODEX_HOME = '   ';
    expect(operatorCodexHome()).toBe(path.join(os.homedir(), '.codex'));
  });
});
