#!/usr/bin/env tsx
/** Disposable, account-free validation of Codex's elevated native-Windows boundary. */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { CodexAppServerClient } from '../src/agent-engine/codex-app-server-client.js';
import {
  applyCodexWindowsSandbox,
  detectCodexWindowsSandbox,
  operatorCodexHome,
} from '../src/agent-engine/codex-home.js';
import {
  parseEffectiveThreadPolicy,
  parseWindowsSandboxReadiness,
} from '../src/agent-engine/codex-app-server-protocol.js';
import {
  verifyEffectivePolicy,
  type RequestedThreadPolicy,
} from '../src/agent-engine/codex-app-server-policy-verify.js';

interface ExecResult { exitCode: number; stdout: string; stderr: string }

const MODEL = process.env.OPENAI_MODEL?.trim() || 'gpt-5.5';
const ROOT_PREFIX = 'claudeclaw-codex-windows-probe-';
const ps = (value: string): string => `'${value.replace(/'/g, "''")}'`;

function childEnv(codexHome: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.CODEX_HOME = codexHome;
  delete env.CODEX_DANGER_WRITE;
  return env;
}

function parseExec(result: unknown, label: string): ExecResult {
  if (!result || typeof result !== 'object') throw new Error(`${label}: response is not an object`);
  const raw = result as Record<string, unknown>;
  if (typeof raw.exitCode !== 'number' || typeof raw.stdout !== 'string' || typeof raw.stderr !== 'string') {
    throw new Error(`${label}: malformed command/exec response`);
  }
  return { exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr };
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  requireCondition(process.platform === 'win32', 'This probe is only valid on native Windows.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.mkdirSync(codexHome);

  const plan = detectCodexWindowsSandbox(codexHome, 'win32', path.join(os.homedir(), '.codex'));
  requireCondition(plan.ready, 'Operator Codex home has no complete elevated Windows sandbox setup. Run codex elevated first.');
  applyCodexWindowsSandbox(plan);

  const client = new CodexAppServerClient({
    env: childEnv(codexHome),
    expectedCodexHome: codexHome,
    clientVersion: 'native-windows-containment-probe',
    onNotification: () => {},
    onServerRequest: async () => ({ error: { code: -32601, message: 'Probe does not accept server requests.' } }),
  });
  const policy = {
    type: 'workspaceWrite',
    writableRoots: [workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  } as const;
  const exec = async (label: string, command: string[], extra: Record<string, unknown> = {}): Promise<ExecResult> =>
    parseExec(await client.request('command/exec', {
      command,
      cwd: workspace,
      timeoutMs: 20_000,
      sandboxPolicy: policy,
      ...extra,
    }, 30_000), label);

  const evidence: Record<string, unknown> = {
    platform: `${process.platform}/${process.arch}`,
    codexVersion: '0.149.1',
    root: '<disposable-os-temp>',
  };

  try {
    console.error('probe: app-server handshake');
    await client.start();
    const readiness = parseWindowsSandboxReadiness(await client.request('windowsSandbox/readiness'));
    requireCondition(readiness.status === 'ready', `Windows sandbox readiness is ${readiness.status}.`);
    evidence.readiness = readiness.status;

    const effective = parseEffectiveThreadPolicy(await client.request('thread/start', {
      model: MODEL,
      modelProvider: 'openai',
      cwd: workspace,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      config: {
        model_provider: 'openai',
        project_doc_max_bytes: 0,
        allow_login_shell: false,
        sandbox_workspace_write: {
          network_access: false,
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true,
        },
      },
    }));
    const requested: RequestedThreadPolicy = {
      model: MODEL,
      cwd: workspace,
      sandboxMode: 'workspace-write',
      networkAccess: false,
      resumedThread: false,
    };
    const verdict = verifyEffectivePolicy(requested, effective);
    requireCondition(verdict.blocking.length === 0, `Effective policy mismatch: ${verdict.blocking.join('; ')}`);
    evidence.effectivePolicy = {
      approvalPolicy: effective.approvalPolicy,
      sandbox: effective.sandbox.type,
      networkAccess: effective.sandbox.type === 'workspaceWrite' ? effective.sandbox.networkAccess : null,
      instructionSources: effective.instructionSources.length,
      activePermissionProfile: effective.activePermissionProfile,
    };

    console.error('probe: contained workspace write');
    const insideFile = path.join(workspace, 'inside.txt');
    const inside = await exec('inside write', ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Set-Content -LiteralPath ${ps(insideFile)} -Value inside`]);
    requireCondition(inside.exitCode === 0 && fs.readFileSync(insideFile, 'utf8').trim() === 'inside', 'Contained workspace write did not succeed.');
    evidence.insideWrite = 'passed';

    console.error('probe: outside write denial');
    const outsideFile = path.join(outside, 'outside.txt');
    const outsideWrite = await exec('outside write', ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Set-Content -LiteralPath ${ps(outsideFile)} -Value escaped`]);
    requireCondition(outsideWrite.exitCode !== 0 && !fs.existsSync(outsideFile), 'Write escaped the workspace boundary.');
    evidence.outsideWriteBlocked = 'passed';

    console.error('probe: outbound network denial');
    const network = await exec('network', ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 https://example.com | Out-Null']);
    requireCondition(network.exitCode !== 0, 'Outbound network access unexpectedly succeeded.');
    evidence.outboundNetworkBlocked = 'passed';

    console.error('probe: junction escape denial');
    const junction = path.join(workspace, 'outside-junction');
    fs.symlinkSync(outside, junction, 'junction');
    const junctionFile = path.join(junction, 'junction-escape.txt');
    const junctionWrite = await exec('junction write', ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `Set-Content -LiteralPath ${ps(junctionFile)} -Value escaped`]);
    requireCondition(junctionWrite.exitCode !== 0 && !fs.existsSync(path.join(outside, 'junction-escape.txt')), 'Junction traversal escaped the workspace boundary.');
    evidence.junctionEscapeBlocked = 'passed';

    console.error('probe: process-tree cancellation isolation');
    const cancellationTarget = exec(
      'cancellation capability target',
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 10'],
      { processId: 'probe-capability-check', timeoutMs: 3_000 },
    ).catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 500));
    let cancellationFailure = '';
    try {
      await client.request('command/exec/terminate', { processId: 'probe-capability-check' });
    } catch (error) {
      cancellationFailure = error instanceof Error ? error.message : String(error);
    }
    await cancellationTarget;
    requireCondition(
      /not supported for windows sandbox processes/i.test(cancellationFailure),
      `Expected the pinned Windows cancellation limitation, received: ${cancellationFailure || '<success>'}`,
    );
    evidence.processTreeCancellation = {
      status: 'blocked',
      reason: 'Codex 0.149.1 rejects command/exec/terminate for Windows sandbox processes.',
    };
    evidence.unrelatedProcessIsolation = 'not run because sandboxed cancellation is unavailable';

    console.log(JSON.stringify(evidence, null, 2));
    throw new Error('Native-Windows containment gate failed: sandboxed process-tree cancellation is unavailable in Codex 0.149.1.');
  } finally {
    await client.shutdown().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const resolved = path.resolve(root);
    requireCondition(path.basename(resolved).startsWith(ROOT_PREFIX), `Refusing to remove unexpected probe root: ${resolved}`);
    const junction = path.join(workspace, 'outside-junction');
    try {
      if (fs.existsSync(junction)) fs.unlinkSync(junction);
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    } catch (error) {
      console.error(`probe cleanup deferred for ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
