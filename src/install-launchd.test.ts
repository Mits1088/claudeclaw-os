import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(__dirname, '..', 'scripts', 'install-launchd.sh');

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
 * A throwaway installation: fake HOME with its own ~/Library/LaunchAgents, a
 * fixture project holding a copy of the real installer, and PATH stubs.
 *
 * The installer derives PROJECT_DIR from its own location, so copying the
 * script into a fixture project runs the real code against surroundings the
 * test owns — no reliance on the developer's .env, agents/ or launchd/.
 */
function makeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-launchd-'));
  tempDirs.push(root);

  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const stubs = path.join(root, 'stubs');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const launchctlLog = path.join(root, 'launchctl.log');

  fs.mkdirSync(launchAgents, { recursive: true });
  fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(project, 'launchd'), { recursive: true });
  fs.mkdirSync(stubs, { recursive: true });
  fs.writeFileSync(launchctlLog, '', 'utf-8');

  const script = path.join(project, 'scripts', 'install-launchd.sh');
  fs.copyFileSync(INSTALLER, script);

  // One repo-managed plist so the install phase has something to install.
  // Without it the unmatched glob makes `sed` fail under `set -e` before the
  // cleanup assertions can be read.
  fs.writeFileSync(
    path.join(project, 'launchd', 'com.claudeclaw.main.plist'),
    '<plist><dict><key>WorkingDirectory</key><string>__PROJECT_DIR__</string></dict></plist>\n',
    'utf-8',
  );

  // launchctl records its calls, so a kept agent can be shown to have been
  // left loaded rather than merely left on disk. npm and sleep keep the run
  // hermetic and fast; nothing here touches the real launchd.
  writeStub(stubs, 'launchctl', `printf '%s\\n' "$*" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`);
  writeStub(stubs, 'npm', 'exit 0\n');
  writeStub(stubs, 'sleep', 'exit 0\n');

  const api = {
    home,
    project,
    /** Seed ~/Library/LaunchAgents with a plist for `label`. */
    plist(label: string) {
      fs.writeFileSync(path.join(launchAgents, `${label}.plist`), '<plist/>\n', 'utf-8');
      return api;
    },
    /** Give agent `id` a directory under `dir` (created if needed). */
    agentDir(dir: string, id: string) {
      fs.mkdirSync(path.join(dir, 'agents', id), { recursive: true });
      return api;
    },
    /** Write a literal CLAUDECLAW_CONFIG line into the fixture project's .env. */
    env(value: string) {
      fs.writeFileSync(path.join(project, '.env'), `CLAUDECLAW_CONFIG=${value}\n`, 'utf-8');
      return api;
    },
    /** A path inside the fixture, e.g. dir('active-config'). */
    dir(...parts: string[]) {
      return path.join(root, ...parts);
    },
    run(processConfig?: string) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        PATH: `${stubs}:${process.env.PATH}`,
      };
      // src/test-env-setup.ts pins CLAUDECLAW_CONFIG for every test module, so
      // it is always inherited here. Drop it explicitly: the cases below are
      // about which source the installer honors, and an ambient value would
      // silently answer that question for it.
      delete env.CLAUDECLAW_CONFIG;
      if (processConfig !== undefined) env.CLAUDECLAW_CONFIG = processConfig;

      try {
        return execFileSync('bash', [script], { env, cwd: project, encoding: 'utf-8' });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        throw new Error(`installer failed\nstdout:\n${e.stdout}\nstderr:\n${e.stderr}`);
      }
    },
    kept(label: string) {
      return fs.existsSync(path.join(launchAgents, `${label}.plist`));
    },
    unloaded(label: string) {
      return fs.readFileSync(launchctlLog, 'utf-8')
        .split('\n')
        .some((line) => line.startsWith('unload ') && line.includes(`${label}.plist`));
    },
  };
  return api;
}

describe.skipIf(process.platform === 'win32')('install-launchd.sh stale-agent cleanup', () => {
  it('keeps an agent whose directory lives under CLAUDECLAW_CONFIG', () => {
    const i = makeInstall();
    const config = i.dir('config');
    i.agentDir(config, 'zlatan').plist('com.claudeclaw.zlatan');

    const out = i.run(config);

    expect(out).toContain('Keeping user-created agent: com.claudeclaw.zlatan');
    expect(i.kept('com.claudeclaw.zlatan')).toBe(true);
    expect(i.unloaded('com.claudeclaw.zlatan')).toBe(false);
  });

  it('keeps an agent whose directory lives in the repo', () => {
    const i = makeInstall();
    i.agentDir(i.project, 'health').plist('com.claudeclaw.health');

    i.run();

    expect(i.kept('com.claudeclaw.health')).toBe(true);
    expect(i.unloaded('com.claudeclaw.health')).toBe(false);
  });

  it('keeps both the com.claudeclaw.<id> and com.claudeclaw.agent-<id> labels', () => {
    const i = makeInstall();
    i.agentDir(i.project, 'health')
      .plist('com.claudeclaw.health')
      .plist('com.claudeclaw.agent-health');

    i.run();

    expect(i.kept('com.claudeclaw.health')).toBe(true);
    expect(i.kept('com.claudeclaw.agent-health')).toBe(true);
  });

  it('keeps an agent under the default ~/.claudeclaw when nothing overrides it', () => {
    const i = makeInstall();
    i.agentDir(path.join(i.home, '.claudeclaw'), 'zlatan').plist('com.claudeclaw.zlatan');

    i.run();

    expect(i.kept('com.claudeclaw.zlatan')).toBe(true);
  });

  it('removes a plist with no agent directory anywhere', () => {
    const i = makeInstall();
    i.plist('com.claudeclaw.ghost');

    const out = i.run(i.dir('config'));

    expect(out).toContain('Removing stale agent: com.claudeclaw.ghost');
    expect(i.kept('com.claudeclaw.ghost')).toBe(false);
    expect(i.unloaded('com.claudeclaw.ghost')).toBe(true);
  });

  it('honors a process-level CLAUDECLAW_CONFIG over a conflicting .env', () => {
    // The destructive case: .env points at a config dir the user has moved on
    // from, the installer runs against the live one. Reading .env here unloads
    // and deletes an agent that is running.
    const i = makeInstall();
    const active = i.dir('active-config');
    const stale = i.dir('stale-config');
    fs.mkdirSync(stale, { recursive: true });
    i.agentDir(active, 'zlatan').env(stale).plist('com.claudeclaw.zlatan');

    i.run(active);

    expect(i.kept('com.claudeclaw.zlatan')).toBe(true);
    expect(i.unloaded('com.claudeclaw.zlatan')).toBe(false);
  });

  it('falls back to .env when no process-level CLAUDECLAW_CONFIG is set', () => {
    // Quoted and ~-relative, the two transforms .env values go through.
    const i = makeInstall();
    i.agentDir(path.join(i.home, 'custom-config'), 'zlatan')
      .env('"~/custom-config"')
      .plist('com.claudeclaw.zlatan');

    i.run();

    expect(i.kept('com.claudeclaw.zlatan')).toBe(true);
  });
});
