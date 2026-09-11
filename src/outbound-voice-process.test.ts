import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

it.each(['success', 'error', 'abort'])('captures actual voice subprocess stdout on %s without a provider', mode => {
  expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-output-fixture-'));
  const loader = path.join(dir, 'fixture.mjs');
  const secret = 'alpha\nbeta "quoted" \\ credential';
  // Only the provider and memory boundaries are replaced. The actual bridge,
  // database initialization, catch path and stdout serialization execute.
  fs.writeFileSync(loader, `
    import { registerHooks } from 'node:module';
    const sources = {
      'fixture:engine': ${JSON.stringify(`export function executionCertaintyOf(error) { return error?.execution; }
      export const EngineFactory = { forProvider() { return { async *invoke() {
        process.stderr.write('FIXTURE_ENGINE_USED\\n');
        const text = process.env.FIXTURE_SECRET;
        if (process.env.FIXTURE_MODE === 'error') throw new Error(text);
        if (process.env.FIXTURE_MODE === 'abort') { yield {type:'aborted',text,usage:null}; return; }
        yield {type:'text_delta',delta:text,accumulatedText:text};
        yield {type:'result',text,usage:null};
      } }; } };`)},
      'fixture:memory': 'export async function buildMemoryContext() { return { contextText: "" }; }',
      'fixture:registry': 'export function providerRunnable() { return true; }'
    };
    registerHooks({
      resolve(specifier, context, next) {
        if (context.parentURL?.includes('/src/')) {
          if (specifier === './agent-engine/index.js') return {url:'fixture:engine',shortCircuit:true};
          if (specifier === './memory.js') return {url:'fixture:memory',shortCircuit:true};
          if (specifier === './provider-registry.js') return {url:'fixture:registry',shortCircuit:true};
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (sources[url]) return {format:'module',source:sources[url],shortCircuit:true};
        return next(url, context);
      }
    });
  `);
  const child = spawnSync(process.execPath, ['--import', tsx, '--import', pathToFileURL(loader).href,
    path.join(root, 'src/agent-voice-bridge.ts'), '--message', 'Synthetic test'], {
    cwd: dir, encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      HOME: dir, USERPROFILE: dir, TEMP: dir, TMP: dir, CODEX_HOME: path.join(dir, 'codex'),
      NODE_ENV: 'test', LOG_LEVEL: 'silent', CLAUDECLAW_CONFIG: path.join(dir, 'config'),
      CLAUDECLAW_STORE_DIR: path.join(dir, 'store'), DB_ENCRYPTION_KEY: 'a'.repeat(64),
      EXFILTRATION_GUARD_ENABLED: 'true', PROTECTED_ENV_VARS: 'FIXTURE_SECRET',
      FIXTURE_SECRET: secret, FIXTURE_MODE: mode },
  });
  expect(child.stderr, child.stdout).toContain('FIXTURE_ENGINE_USED');
  expect(child.stdout).not.toContain('alpha');
  expect(child.stderr).not.toContain('alpha');
  const payload = JSON.parse(child.stdout.trim());
  expect(payload[mode === 'error' ? 'error' : 'response']).toBe(mode === 'abort' ? null : '[REDACTED]');
  expect(child.status).toBe(mode === 'error' ? 1 : 0);
});
