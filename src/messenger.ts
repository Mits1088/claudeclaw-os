// Imported first so the process-level uncaughtException guard is installed
// before anything transitively pulls in @anthropic-ai/claude-agent-sdk.
import './crash-guard.js';

import fs from 'fs';
import path from 'path';

import { loadAgentConfig, resolveAgentDir, resolveAgentClaudeMd, resolveInstructionMd, refreshWarRoomRoster, type AgentLifecycleMode, type AgentRuntimeMode } from './agent-config.js';
import { checkPendingMigrations, backfillMainAgent } from './migrations.js';
import { ALLOWED_CHAT_ID, activeBotToken, STORE_DIR, PROJECT_ROOT, CLAUDECLAW_CONFIG, GOOGLE_API_KEY, setAgentOverrides, SECURITY_PIN_HASH, IDLE_LOCK_MINUTES, EMERGENCY_KILL_PHRASE, WARROOM_ENABLED, WARROOM_PORT } from './config.js';
import { startDashboard } from './dashboard.js';
import { initDatabase, cleanupOldMissionTasks, insertAuditLog } from './db.js';
import { initSecurity, setAuditCallback } from './security.js';
import { registerDispatchTools } from './dispatch-tools.js';
import { logger } from './logger.js';
import { cleanupOldUploads } from './media.js';
import { runConsolidation } from './memory-consolidate.js';
import { runDecaySweep } from './memory.js';
import { runWarroomAvatarMigration } from './avatars.js';
import { initOAuthHealthCheck } from './oauth-health.js';
import { initOrchestrator } from './orchestrator.js';
import { initScheduler } from './scheduler.js';
import { getMainProviderConfig, ensureMainAgentConfig } from './provider.js';
import { setTelegramConnected } from './state.js';
import { getVenvPython, IS_WINDOWS, killProcess, tmpDir } from './platform.js';
import { reconcileHeadlessWorkers, shutdownHeadlessWorkers, startWorkerLease, type WorkerLeaseHandle } from './worker-supervisor.js';

/**
 * A messenger transport (Telegram, Signal, …). `bootMessenger()` owns the whole
 * shared boot sequence — agent identity, PID lock, DB, security, orchestrator,
 * memory decay, dashboard, War Room, scheduler, OAuth health, shutdown — and
 * defers only the genuinely transport-specific surface to this interface.
 *
 * This realises upstream #98 (Mark's `bootMessenger(messengerFactory)` idea):
 * `src/index.ts` supplies a Telegram factory, `src/signal-entry.ts` a Signal
 * factory, and neither re-implements the boot path, so the fork-drift class of
 * bugs (PID-safe releaseLock, provider config, CLAUDE.md resolution,
 * cross-platform War Room) cannot recur.
 */
export interface Messenger {
  /** Human label for logs, e.g. 'telegram' | 'signal'. */
  readonly kind: string;
  /** Destination for unsolicited status messages (scheduler, War Room, OAuth). Null → scheduler disabled. */
  readonly primaryRecipient: string | null;
  /** A Telegram-Bot-Api-shaped object the dashboard's /api/chat/send route needs (or a shim). */
  readonly dashboardApi: unknown;
  /** Push a status/notification message to the primary recipient. */
  sendToPrimary(text: string): Promise<void>;
  /** Go online. `interactive` is false for automation-only agents (no inbound receive loop). */
  start(interactive: boolean): Promise<void>;
  /** Graceful stop. */
  stop(): Promise<void>;
}

/**
 * Two-phase transport factory:
 *
 * - `preflight()` runs BEFORE the PID lock + DB init — cheap config validation
 *   (bot token / linked phone number). May `process.exit(1)` on a
 *   misconfiguration, exactly where the old per-entry `main()` did.
 * - `create()` runs AFTER `initDatabase()` — because building the messenger
 *   (e.g. Telegram's `createBot()` → `getMemoryMigrationNotice()`) reads the
 *   database, so it must not run before the DB is open. Actual network
 *   connection still happens later, in `Messenger.start()`.
 */
export interface MessengerFactory {
  preflight(agentId: string): void;
  create(agentId: string): Messenger;
}

/**
 * Stop a messenger during process shutdown without turning a transport/network
 * failure into an uncaught rejection. Telegram's Bot.stop(), for example,
 * confirms its polling offset with one final getUpdates request and can reject
 * when the network is already unavailable. Shutdown must still complete cleanly.
 */
export async function stopMessengerForShutdown(messenger: Pick<Messenger, 'kind' | 'stop'>): Promise<void> {
  try {
    await messenger.stop();
  } catch (err) {
    logger.warn({ err, messenger: messenger.kind }, 'Messenger stop failed during shutdown; exiting anyway');
  }
}

/** Convenience: Telegram's ALLOWED_CHAT_ID, exposed so factories don't re-read config. */
export const TELEGRAM_PRIMARY_RECIPIENT = ALLOWED_CHAT_ID;

function showBanner(): void {
  const bannerPath = path.join(PROJECT_ROOT, 'banner.txt');
  try {
    console.log('\n' + fs.readFileSync(bannerPath, 'utf-8'));
  } catch {
    console.log('\n  ClaudeClaw\n');
  }
}

/**
 * Load the agent's identity + overrides (CLAUDE.md, provider, model, MCP) from
 * argv/config. Mirrors the old top-level block in index.ts/signal-entry.ts but
 * in one place, so the main-agent CLAUDE.md resolution + provider config can't
 * drift between transports. Returns { agentId, interactive }.
 */
function loadAgentIdentity(): { agentId: string; interactive: boolean; runtimeMode: AgentRuntimeMode; lifecycleMode: AgentLifecycleMode } {
  const agentFlagIndex = process.argv.indexOf('--agent');
  const agentId = agentFlagIndex !== -1 ? process.argv[agentFlagIndex + 1] : 'main';
  // Export AGENT_ID to env so child processes (schedule-cli, etc.) inherit it.
  process.env.CLAUDECLAW_AGENT_ID = agentId;

  let interactive = true;
  let runtimeMode: AgentRuntimeMode = 'messenger';
  let lifecycleMode: AgentLifecycleMode = 'persistent';

  if (agentId !== 'main') {
    const agentConfig = loadAgentConfig(agentId);
    interactive = agentConfig.interactive;
    runtimeMode = agentConfig.runtimeMode;
    lifecycleMode = agentConfig.lifecycleMode;
    const agentDir = resolveAgentDir(agentId);
    const claudeMdPath = resolveAgentClaudeMd(agentId);
    let systemPrompt: string | undefined;
    if (claudeMdPath) {
      try { systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8'); } catch { /* no CLAUDE.md */ }
    }
    setAgentOverrides({
      agentId,
      botToken: agentConfig.botToken,
      cwd: agentDir,
      model: agentConfig.model,
      provider: agentConfig.provider,
      obsidian: agentConfig.obsidian,
      systemPrompt,
      mcpServers: agentConfig.mcpServers,
    });
    logger.info({ agentId, name: agentConfig.name, provider: agentConfig.provider, runtimeMode, lifecycleMode }, 'Running as agent');
  } else {
    // Main bot: load CLAUDE.md from CLAUDECLAW_CONFIG/agents/main/, set CWD to
    // that dir so the SDK loads the personal CLAUDE.md (not the repo template).
    // Falls back to CLAUDECLAW_CONFIG/CLAUDE.md for backward compatibility.
    const agentClaudeMd = resolveAgentClaudeMd('main');
    const claudeMdSource = agentClaudeMd ?? resolveInstructionMd(CLAUDECLAW_CONFIG);
    const mainAgentDir = agentClaudeMd ? path.dirname(agentClaudeMd) : null;

    if (claudeMdSource) {
      let systemPrompt: string | undefined;
      try { systemPrompt = fs.readFileSync(claudeMdSource, 'utf-8'); } catch { /* unreadable */ }
      if (systemPrompt) {
        setAgentOverrides({
          agentId: 'main',
          botToken: activeBotToken,
          cwd: mainAgentDir ?? PROJECT_ROOT,
          provider: getMainProviderConfig(),
          systemPrompt,
        });
        logger.info({ source: claudeMdSource, cwd: mainAgentDir ?? PROJECT_ROOT }, 'Loaded main agent CLAUDE.md');
      }
    } else {
      logger.warn(
        'No CLAUDE.md found. Copy CLAUDE.md.example to %s/agents/main/CLAUDE.md and customize it.',
        CLAUDECLAW_CONFIG,
      );
    }
  }

  return { agentId, interactive, runtimeMode, lifecycleMode };
}

/** Mission-only transport. It deliberately owns no token and performs no I/O. */
export function createHeadlessMessenger(): Messenger {
  return {
    kind: 'headless',
    primaryRecipient: null,
    dashboardApi: null,
    async sendToPrimary(): Promise<void> { /* intentionally silent */ },
    async start(): Promise<void> { logger.info('Headless worker ready'); },
    async stop(): Promise<void> { /* nothing to close */ },
  };
}

/** Start the War Room voice subprocess (main-only), routing errors via sendToPrimary. */
function startWarRoom(notify: (text: string) => Promise<void>): void {
  void (async () => {
    const { spawn, spawnSync } = await import('child_process');
    const venvPython = getVenvPython(path.join(PROJECT_ROOT, 'warroom', '.venv'));
    const serverScript = path.join(PROJECT_ROOT, 'warroom', 'server.py');

    // Write agent roster so the Python voice stack can discover agents.
    refreshWarRoomRoster();

    let uvAvailable = false;
    try { uvAvailable = spawnSync('uv', ['--version'], { stdio: 'pipe', windowsHide: true }).status === 0; } catch { /* */ }
    if (uvAvailable) logger.info('uv detected — will use uv commands in War Room instructions');

    if (fs.existsSync(venvPython) && fs.existsSync(serverScript)) {
      // Pre-flight: verify Python dependencies are actually installed.
      const depCheck = spawnSync(venvPython, ['-c', 'import pipecat'], { stdio: 'pipe', timeout: 10000, windowsHide: true });
      if (depCheck.status !== 0) {
        const msg = uvAvailable
          ? 'War Room Python dependencies not installed. Run:\n\n'
            + `uv pip install --python ${venvPython} -r warroom/requirements.txt\n\n`
            + 'Then restart the bot.'
          : IS_WINDOWS
            ? 'War Room Python dependencies not installed. Run:\n\n'
              + 'In PowerShell:\n'
              + '  .\\warroom\\.venv\\Scripts\\Activate.ps1\n'
              + '  pip install -r warroom\\requirements.txt\n\n'
              + 'Or in Command Prompt:\n'
              + '  warroom\\.venv\\Scripts\\activate.bat\n'
              + '  pip install -r warroom\\requirements.txt\n\n'
              + 'Then restart the bot.'
            : 'War Room Python dependencies not installed. Run:\n\n'
              + 'source warroom/.venv/bin/activate\n'
              + 'pip install -r warroom/requirements.txt\n\n'
              + 'Then restart the bot.';
        logger.error(msg);
        void notify(`War Room could not start.\n\n${msg}`);
        return;
      }

      // Dedicated log file for the warroom subprocess (cross-platform temp dir).
      const warroomLogPath = path.join(tmpDir(), 'warroom-debug.log');
      let warroomLogFd: number | null = null;
      try {
        warroomLogFd = fs.openSync(warroomLogPath, 'a');
      } catch (err) {
        logger.warn({ err, warroomLogPath }, 'Could not open warroom log');
      }

      const MAX_CRASH_RESPAWNS = 3;
      // Time a process must stay alive without crashing before we treat its
      // crash counter as "recovered". The python server prints "ready" before
      // it binds the WS transport, so resetting on first stdout could loop.
      const STABLE_UPTIME_MS = 20_000;
      let respawnAttempts = 0;
      let shuttingDown = false;
      let currentProc: ReturnType<typeof spawn> | null = null;

      const spawnWarroom = (): void => {
        if (shuttingDown) return;
        const proc = spawn(venvPython, [serverScript], {
          cwd: PROJECT_ROOT,
          env: { ...process.env, WARROOM_PORT: String(WARROOM_PORT), GOOGLE_API_KEY },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        currentProc = proc;

        const stableResetHandle = setTimeout(() => { respawnAttempts = 0; }, STABLE_UPTIME_MS);

        proc.stdout.once('data', (data: Buffer) => {
          try {
            const info = JSON.parse(data.toString().trim());
            logger.info({ port: WARROOM_PORT, ws_url: info.ws_url, pid: proc.pid }, 'War Room server started');
          } catch {
            logger.info({ port: WARROOM_PORT, pid: proc.pid }, 'War Room server started');
          }
        });

        if (warroomLogFd !== null) {
          const write = (buf: Buffer) => { try { fs.writeSync(warroomLogFd!, buf); } catch { /* ok */ } };
          proc.stdout.on('data', write);
          proc.stderr.on('data', write);
        }

        proc.on('exit', (code, signal) => {
          clearTimeout(stableResetHandle);
          if (shuttingDown) return;
          const wasIntentional = signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT';
          logger.warn({ code, signal, pid: proc.pid, intentional: wasIntentional }, 'War Room server exited');
          let delayMs: number;
          if (wasIntentional) {
            delayMs = 300;
            respawnAttempts = 0;
          } else {
            respawnAttempts += 1;
            if (respawnAttempts > MAX_CRASH_RESPAWNS) {
              logger.error(`War Room crashed ${MAX_CRASH_RESPAWNS} times. Giving up. Check ${warroomLogPath} for errors.`);
              void notify(`War Room crashed ${MAX_CRASH_RESPAWNS} times and has been disabled.\n\nCheck ${warroomLogPath}, fix the issue, and restart the bot.`);
              return;
            }
            delayMs = Math.min(30000, 500 * 2 ** Math.min(respawnAttempts, 6));
          }
          logger.info({ delayMs, attempt: respawnAttempts }, 'Respawning War Room server');
          setTimeout(spawnWarroom, delayMs);
        });
      };

      spawnWarroom();

      const shutdownWarroom = () => {
        shuttingDown = true;
        try { currentProc?.kill(); } catch { /* ok */ }
        if (warroomLogFd !== null) { try { fs.closeSync(warroomLogFd); } catch { /* ok */ } }
      };
      process.on('exit', shutdownWarroom);
      process.on('SIGTERM', shutdownWarroom);
      process.on('SIGINT', shutdownWarroom);
    } else {
      const missingVenv = !fs.existsSync(venvPython);
      const hint = missingVenv
        ? uvAvailable
          ? 'Python venv not found. Run:\n\nuv venv warroom/.venv\nuv pip install --python warroom/.venv -r warroom/requirements.txt'
          : IS_WINDOWS
            ? 'Python venv not found. Run:\n\n'
              + 'python -m venv warroom\\.venv\n\n'
              + 'In PowerShell:\n'
              + '  .\\warroom\\.venv\\Scripts\\Activate.ps1\n'
              + '  pip install -r warroom\\requirements.txt\n\n'
              + 'Or in Command Prompt:\n'
              + '  warroom\\.venv\\Scripts\\activate.bat\n'
              + '  pip install -r warroom\\requirements.txt'
            : 'Python venv not found. Run:\n\npython3 -m venv warroom/.venv\nsource warroom/.venv/bin/activate\npip install -r warroom/requirements.txt'
        : 'warroom/server.py not found. Make sure the warroom/ directory exists.';
      logger.warn('War Room enabled but cannot start: %s', hint);
      void notify(`War Room is enabled but could not start.\n\n${hint}`);
    }
  })();
}

/**
 * The single shared boot path. A transport supplies its Messenger via
 * `createMessenger`; everything else is identical across Telegram/Signal.
 */
export async function bootMessenger(factory: MessengerFactory): Promise<void> {
  const { agentId, interactive, runtimeMode, lifecycleMode } = loadAgentIdentity();
  let workerLease: WorkerLeaseHandle | undefined;

  const PID_FILE = path.join(STORE_DIR, `${agentId === 'main' ? 'claudeclaw' : `agent-${agentId}`}.pid`);

  const acquireLock = (): void => {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    try {
      if (fs.existsSync(PID_FILE)) {
        const old = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (!isNaN(old) && old !== process.pid) {
          killProcess(old);
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } catch { /* ok */ }
        }
      }
    } catch { /* ignore */ }
    fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  };

  const releaseLock = (): void => {
    // Only remove the pidfile if it still points at us — prevents a dying
    // process from deleting a pidfile a successor already claimed.
    try {
      const cur = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (cur === process.pid) fs.unlinkSync(PID_FILE);
    } catch { /* ignore */ }
  };

  try {
    checkPendingMigrations(PROJECT_ROOT);
    if (agentId === 'main') {
      showBanner();
      // Bootstrap main's external config on boot, independent of the setup
      // wizard. Headless/VPS installs never run the wizard's step 6b, so
      // without this the file wouldn't exist and reads/writes fell through to
      // PROJECT_ROOT — the virgin state behind #146/#148. Idempotent. Lives in
      // the SHARED boot path so Signal (signal-entry) gets it too, not only
      // Telegram (upstream placed it in index.ts's monolithic main()).
      ensureMainAgentConfig();
      // Ported from #154 into the SHARED boot path so Signal gets it too.
      try {
        const { changed } = backfillMainAgent({ configDir: CLAUDECLAW_CONFIG, storeDir: STORE_DIR, projectRoot: PROJECT_ROOT });
        if (changed.length > 0) logger.info({ changed }, 'main-agent backfill applied');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err }, 'main-agent backfill failed (continuing boot)');
      }
    }

    // Transport preflight (token / phone number) BEFORE the lock — fail fast on
    // a misconfiguration, exactly where the old per-entry main() did.
    if (runtimeMode === 'messenger') factory.preflight(agentId);

    acquireLock();

    try {
      initDatabase();
    } catch (err: any) {
      logger.error('Database initialization failed: %s', err?.message || err);
      if (err?.message?.includes('DB_ENCRYPTION_KEY')) {
        logger.error('Fix: add DB_ENCRYPTION_KEY to .env. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      }
      process.exit(1);
    }
    logger.info('Database ready');

    if (agentId === 'main') {
      await reconcileHeadlessWorkers();
    } else if (runtimeMode === 'headless') {
      workerLease = startWorkerLease(agentId);
      logger.info({ agentId, instanceId: workerLease.instanceId }, 'Headless worker lease acquired');
    }

    // Register the in-process dispatch tools (mission/schedule/hive) into the
    // process-global registry so runAgent merges them into eligible turns —
    // including scheduled/mission turns, which fire with a scrubbed env. Done
    // here (once per agent process, all entry points share bootMessenger) rather
    // than in config.ts to avoid the config → descriptors → cli-actions → db →
    // config import cycle that Phase 1 deliberately inverted.
    registerDispatchTools();

    initSecurity({
      pinHash: SECURITY_PIN_HASH || undefined,
      idleLockMinutes: IDLE_LOCK_MINUTES,
      killPhrase: EMERGENCY_KILL_PHRASE || undefined,
    });
    setAuditCallback((entry) => {
      insertAuditLog(entry.agentId, entry.chatId, entry.action, entry.detail, entry.blocked);
    });

    initOrchestrator();

    // Decay + consolidation run ONLY in the main process to prevent
    // multi-process over-decay and duplicate consolidation records.
    if (agentId === 'main') {
      runDecaySweep();
      cleanupOldMissionTasks(7);
      setInterval(() => { runDecaySweep(); cleanupOldMissionTasks(7); }, 24 * 60 * 60 * 1000);

      // One-time bundled→mutable avatar migration.
      runWarroomAvatarMigration();

      if (ALLOWED_CHAT_ID && GOOGLE_API_KEY) {
        setTimeout(() => {
          void runConsolidation(ALLOWED_CHAT_ID).catch((err) => logger.error({ err }, 'Initial consolidation failed'));
        }, 2 * 60 * 1000);
        setInterval(() => {
          void runConsolidation(ALLOWED_CHAT_ID).catch((err) => logger.error({ err }, 'Periodic consolidation failed'));
        }, 30 * 60 * 1000);
        logger.info('Memory consolidation enabled (every 30 min)');
      }
    } else {
      logger.info({ agentId }, 'Skipping decay/consolidation (main process owns these)');
    }

    cleanupOldUploads();

    // Build the messenger now — AFTER initDatabase(), because construction reads
    // the DB (Telegram's createBot() → getMemoryMigrationNotice()).
    const messenger = runtimeMode === 'headless' ? createHeadlessMessenger() : factory.create(agentId);

    // Dashboard + War Room only run in the main process.
    if (agentId === 'main') {
      // Telegram passes bot.api; Signal passes a minimal sendMessage-only shim.
      // startDashboard only touches sendMessage, so the shim is safe here.
      startDashboard(messenger.dashboardApi as Parameters<typeof startDashboard>[0]);
      if (WARROOM_ENABLED) startWarRoom((text) => messenger.sendToPrimary(text));
    }

    if (messenger.kind === 'headless') {
      initScheduler(
        async () => { /* results remain in mission state for handback */ },
        agentId,
        workerLease?.instanceId,
        lifecycleMode,
        () => {
          // The scheduler already changed desired_state to inactive in the
          // transaction that proved the task scope drained. SIGTERM follows
          // the normal graceful shutdown path and releases the lease.
          try { process.kill(process.pid, 'SIGTERM'); } catch { process.exit(0); }
        },
      );
      logger.info({ agentId, lifecycleMode }, 'Headless mission scheduler enabled');
    } else if (messenger.primaryRecipient) {
      initScheduler(async (text) => { await messenger.sendToPrimary(text); }, agentId);

      // Proactive OAuth health monitoring — OPT-IN via OAUTH_HEALTH_ENABLED=true.
      const oauthHealthEnv = (await import('./env.js')).readEnvFile(['OAUTH_HEALTH_ENABLED']);
      if ((oauthHealthEnv.OAUTH_HEALTH_ENABLED || '').trim().toLowerCase() === 'true') {
        initOAuthHealthCheck(async (text) => { await messenger.sendToPrimary(text); });
      } else {
        logger.info('OAuth health check disabled (set OAUTH_HEALTH_ENABLED=true in .env to enable)');
      }
    } else {
      logger.warn('No primary recipient configured — scheduler disabled (no destination for results)');
    }

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info('Shutting down...');
      setTelegramConnected(false);
      if (agentId === 'main') await shutdownHeadlessWorkers();
      workerLease?.stop();
      releaseLock();
      await stopMessengerForShutdown(messenger);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    logger.info({ agentId, messenger: messenger.kind }, 'Starting ClaudeClaw...');
    await messenger.start(interactive);
  } catch (err: unknown) {
    logger.error({ err }, 'Fatal error');
    releaseLock();
    process.exit(1);
  }
}
