// Every path that starts a ClaudeClaw agent process must target
// dist/main-entry.js, the only module that reads MESSENGER_TYPE
// (src/main-entry.ts). src/index.ts hard-wires the Telegram factory and never
// reads MESSENGER_TYPE, so a service definition pointing at dist/index.js pins
// its agent to Telegram whatever the operator configured: with a Telegram token
// present the process boots the wrong transport and logs nothing unusual;
// without one it exits 1 and the supervisor relaunches it on a loop.
//
// This covers specialists as well as main. ClaudeClaw runs one process per
// agent and each process opens its own transport, so a specialist template left
// on dist/index.js makes the per-channel architecture in docs/mattermost.md
// unreachable even when the main service is correct.
//
// A launch site counts whether it is written as a literal path in a template or
// assembled with path.join(), so both spellings are swept. Checking only the
// literal one is what let scripts/setup.ts and src/platform.ts keep the
// Telegram-only entrypoint through the first round of this change.
//
// These are content assertions over shipped files, so they run on every
// platform. Sources are normalized to LF before matching so a CRLF checkout
// compares the same way (same idiom as src/db.concurrent-boot.test.ts).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DISPATCHER = 'dist/main-entry.js';
const TELEGRAM_ONLY = 'dist/index.js';
// A launch site is spelled either as a literal path in a template or assembled
// segment by segment with path.join(). Both spellings have to be swept: the
// second one is invisible to a search for the first.
const JOINED_TELEGRAM_ONLY = "'dist', 'index.js'";

function read(...segments: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * Drop comment-only lines so prose explaining why the Telegram-only entrypoint
 * is wrong does not read as an occurrence of it. Only whole lines are dropped:
 * a launch site is never written on one, so nothing executable can hide behind
 * this, unlike stripping from the first // on a line (which would also cut the
 * DOCTYPE URL out of the plist template in scripts/setup.ts).
 */
function readCode(...segments: string[]): string {
  return read(...segments)
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*|#)/.test(line))
    .join('\n');
}

// Discovered rather than listed: a template added later is covered without
// touching this file. signal-cli.plist is excluded on purpose — it runs
// signal-cli, not ClaudeClaw.
const launchdTemplates = fs
  .readdirSync(path.join(REPO_ROOT, 'launchd'))
  .filter((name) => name.startsWith('com.claudeclaw.') && name.endsWith('.plist'))
  .sort();

describe('service entry points route through the MESSENGER_TYPE dispatcher', () => {
  it('ships the main template and the four specialist templates', () => {
    expect(launchdTemplates).toContain('com.claudeclaw.main.plist');
    expect(launchdTemplates.length).toBeGreaterThanOrEqual(5);
  });

  it.each(launchdTemplates)('launchd/%s runs the dispatcher', (name) => {
    const plist = read('launchd', name);
    expect(plist).toContain(`<string>${DISPATCHER}</string>`);
    expect(plist).not.toContain(`<string>${TELEGRAM_ONLY}</string>`);
  });

  it('the sample plist at the repository root runs the dispatcher', () => {
    const plist = read('claudeclaw.plist');
    expect(plist).toContain(`PATH_TO_CLAUDECLAW/${DISPATCHER}`);
    expect(plist).not.toContain(TELEGRAM_ONLY);
  });

  it('the VPS systemd unit runs the dispatcher', () => {
    const installer = read('deploy', 'install-vps.sh');
    expect(installer).toContain(`ExecStart=/usr/bin/node ${DISPATCHER}`);
    expect(installer).not.toContain(TELEGRAM_ONLY);
  });

  it('the generated per-agent services run the dispatcher on both platforms', () => {
    const generator = read('scripts', 'agent-service.sh');
    expect(generator).toContain(`<string>\${PROJECT_DIR}/${DISPATCHER}</string>`);
    expect(generator).toContain(`ExecStart=\${NODE_PATH} \${PROJECT_DIR}/${DISPATCHER} --agent \${AGENT_ID}`);
    expect(generator).not.toContain(TELEGRAM_ONLY);
  });

  it('the agent-creation script starts a new agent through the dispatcher', () => {
    expect(read('scripts', 'agent-create.sh')).not.toContain(TELEGRAM_ONLY);
  });

  it('the npm start scripts run the dispatcher', () => {
    // package.json "main" is the module entry for importers, not a launch site,
    // and deliberately stays on dist/index.js.
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe(`node ${DISPATCHER}`);
    expect(pkg.scripts['agent:start']).toBe(`node ${DISPATCHER} --agent`);
  });

  it('the plist generated for user-created agents runs the dispatcher', () => {
    // generateLaunchdPlist() and activateDetached() are module-private, so the
    // contract is pinned on the normalized source.
    const source = read('src', 'agent-create.ts');
    expect(source).toContain(`<string>${DISPATCHER}</string>`);
    expect(source).toContain("path.join(PROJECT_ROOT, 'dist', 'main-entry.js')");
  });

  it('the documented Signal service runs the dispatcher', () => {
    expect(read('docs', 'signal.md')).not.toContain(`<string>$PWD/${TELEGRAM_ONLY}</string>`);
  });

  it('the interactive installer registers every service on the dispatcher', () => {
    // scripts/setup.ts is what the README and docs/signal.md tell operators to
    // run. It assembles its paths with path.join(), so its launchd plist,
    // systemd unit, PM2 command, schtasks wrapper and build check all named the
    // Telegram-only entrypoint without ever containing the string
    // 'dist/index.js'. One constant keeps the four definitions from drifting.
    const source = read('scripts', 'setup.ts');
    expect(source).toContain("const DISPATCHER_ENTRY = path.join(PROJECT_ROOT, 'dist', 'main-entry.js');");
  });

  // Every file that builds a command line for an agent process. src/platform.ts
  // is deliberately absent: it reads command lines instead of writing them, and
  // has to keep recognizing the legacy entrypoint (see below).
  const launchSiteSources = [
    ['scripts', 'setup.ts'],
    ['scripts', 'agent-service.sh'],
    ['scripts', 'agent-create.sh'],
    ['deploy', 'install-vps.sh'],
    ['src', 'agent-create.ts'],
  ];

  it.each(launchSiteSources)('%s/%s names no Telegram-only entrypoint', (...segments) => {
    const source = readCode(...segments);
    expect(source).not.toContain(TELEGRAM_ONLY);
    expect(source).not.toContain(JOINED_TELEGRAM_ONLY);
  });

  it('the process enumerator recognizes both entrypoints', () => {
    // The one place that still names dist/index.js on purpose. Services
    // installed before this change keep launching it until the operator re-runs
    // setup, and listAgentProcesses() has to keep returning those processes or
    // the supervisor orphans them. Pinned without mocks against real processes
    // in src/platform.agent-processes.test.ts.
    const source = read('src', 'platform.ts');
    expect(source).toContain("path.join(projectRoot, 'dist', 'main-entry.js')");
    expect(source).toContain("path.join(projectRoot, 'dist', 'index.js')");
  });
});
