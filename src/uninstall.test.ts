import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UNINSTALLER = path.resolve(__dirname, '..', 'scripts', 'uninstall.sh');

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeStub(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}`, 'utf-8');
  fs.chmodSync(file, 0o755);
}

/**
 * A throwaway installation to uninstall: fake HOME, a fixture project holding a
 * copy of the real script, and PATH stubs.
 *
 * `rm` is stubbed and only records its arguments. That is what makes these
 * cases safe to run: the script deletes by absolute path, including a literal
 * /tmp/claudeclaw*.log glob, so a real rm would reach outside the fixture. It
 * also makes the assertions exact — the question here is which directory the
 * script aimed at, which the log answers directly.
 */
function makeUninstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'));
  tempDirs.push(root);

  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const stubs = path.join(root, 'stubs');
  const rmLog = path.join(root, 'rm.log');

  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(stubs, { recursive: true });
  fs.writeFileSync(rmLog, '', 'utf-8');

  const script = path.join(project, 'scripts', 'uninstall.sh');
  fs.copyFileSync(UNINSTALLER, script);

  writeStub(stubs, 'rm', `printf '%s\\n' "$*" >> ${JSON.stringify(rmLog)}\nexit 0\n`);
  writeStub(stubs, 'launchctl', 'exit 0\n');

  const api = {
    home,
    project,
    /** A path inside the fixture, e.g. dir('active-config'). */
    dir(...parts: string[]) {
      return path.join(root, ...parts);
    },
    /** Create a config directory so the script's `[ -d ]` guard sees it. */
    configDir(...parts: string[]) {
      const dir = path.join(root, ...parts);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** Write a literal CLAUDECLAW_CONFIG line into the fixture project's .env. */
    env(value: string) {
      fs.writeFileSync(path.join(project, '.env'), `CLAUDECLAW_CONFIG=${value}\n`, 'utf-8');
      return api;
    },
    run(processConfig?: string) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        PATH: `${stubs}:${process.env.PATH}`,
      };
      // src/test-env-setup.ts pins CLAUDECLAW_CONFIG for every test module, so
      // it is always inherited here. Drop it explicitly: these cases are about
      // which source the script honors, and an ambient value would silently
      // answer that question for it.
      delete env.CLAUDECLAW_CONFIG;
      if (processConfig !== undefined) env.CLAUDECLAW_CONFIG = processConfig;

      try {
        const out = execFileSync('bash', [script], { env, cwd: project, encoding: 'utf-8' });
        // The script colors the path it reports, so the escapes sit between the
        // label and the value. Strip them and the assertions can read as text.
        return out.replace(/\u001b\[[0-9;]*m/g, '');
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        throw new Error(`uninstaller failed\nstdout:\n${e.stdout}\nstderr:\n${e.stderr}`);
      }
    },
    /** Whether the script asked to recursively remove `target`. */
    removed(target: string) {
      return fs.readFileSync(rmLog, 'utf-8')
        .split('\n')
        .some((line) => line.startsWith('-rf ') && line.slice(4).trim() === target);
    },
  };
  return api;
}

describe.skipIf(process.platform === 'win32')('uninstall.sh config directory resolution', () => {
  it('honors a process-level CLAUDECLAW_CONFIG over a conflicting .env', () => {
    // The destructive case: .env names a config directory the user has moved on
    // from, the uninstall runs against the live one. Reading .env here rm -rf's
    // the wrong directory and leaves the one the user asked to remove.
    const u = makeUninstall();
    const active = u.configDir('active-config');
    const stale = u.configDir('stale-config');
    u.env(stale);

    const out = u.run(active);

    expect(out).toContain(`Removing config: ${active}`);
    expect(u.removed(active)).toBe(true);
    expect(u.removed(stale)).toBe(false);
  });

  it('falls back to .env when no process-level CLAUDECLAW_CONFIG is set', () => {
    // Quoted and ~-relative, the two transforms .env values go through.
    const u = makeUninstall();
    const custom = path.join(u.home, 'custom-config');
    fs.mkdirSync(custom, { recursive: true });
    u.env('"~/custom-config"');

    u.run();

    expect(u.removed(custom)).toBe(true);
  });

  it('falls back to ~/.claudeclaw when neither source sets a path', () => {
    const u = makeUninstall();
    const fallback = path.join(u.home, '.claudeclaw');
    fs.mkdirSync(fallback, { recursive: true });

    u.run();

    expect(u.removed(fallback)).toBe(true);
  });

  it('ignores an empty CLAUDECLAW_CONFIG in the process environment', () => {
    // `${CLAUDECLAW_CONFIG:-}` and getClaudeclawConfig's `||` agree: an empty
    // value is not a path, so .env still gets its turn.
    const u = makeUninstall();
    const fromEnvFile = u.configDir('env-file-config');
    u.env(fromEnvFile);

    u.run('');

    expect(u.removed(fromEnvFile)).toBe(true);
  });
});
