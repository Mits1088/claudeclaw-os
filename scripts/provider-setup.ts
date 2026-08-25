#!/usr/bin/env tsx
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';

import {
  checkProviderAvailability,
  setMainProviderConfig,
  providerToYaml,
  type ProviderConfig,
} from '../src/provider.js';
import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENAI_MODEL } from '../src/config.js';
import { listAgentIds, resolveAgentDir } from '../src/agent-config.js';
import yaml from 'js-yaml';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, defaultVal?: string): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` (${defaultVal})` : '';
    rl.question(`${question}${hint} › `, (ans) => resolve(ans.trim() || defaultVal || ''));
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const ans = (await ask(`${question} [${defaultYes ? 'Y/n' : 'y/N'}]`)).toLowerCase();
  if (!ans) return defaultYes;
  return ans === 'y' || ans === 'yes';
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function getOpenCodeCredentialCount(): number | null {
  const result = spawnSync('opencode', ['providers', 'list'], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) return null;
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const match = output.match(/(\d+)\s+credentials?/i);
  if (match) return parseInt(match[1], 10);
  return output.toLowerCase().includes('credentials') ? 0 : null;
}

function getOpenCodeModels(): string[] {
  const result = spawnSync('opencode', ['models'], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) return [];
  return stripAnsi(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(line));
}

async function selectOpenCodeModel(): Promise<string | null> {
  const models = getOpenCodeModels();
  if (models.length === 0) {
    console.warn('Could not load OpenCode models. You can still enter a model id manually.');
    const manual = await ask('OpenCode default model (provider/model, or Enter to keep current)');
    return manual || null;
  }

  console.log('Available OpenCode models:');
  console.log();
  models.forEach((model, idx) => {
    console.log(`  ${String(idx + 1).padStart(2, ' ')}. ${model}`);
  });
  console.log();
  console.log('Press Enter to keep OpenCode\'s current default model.');
  const answer = await ask('Select model number, or type a model id');
  if (!answer) return null;

  const numeric = parseInt(answer, 10);
  if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= models.length) {
    return models[numeric - 1];
  }
  if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(answer)) return answer;

  console.warn(`Unknown model selection "${answer}". Keeping OpenCode's current default model.`);
  return null;
}

function updateOpenCodeDefaultModel(model: string): void {
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  const configPath = path.join(configDir, 'opencode.jsonc');
  fs.mkdirSync(configDir, { recursive: true });
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      raw = JSON.parse(content) as Record<string, unknown>;
    } catch {
      console.warn(`Could not parse ${configPath}; writing a clean config.`);
    }
  }
  raw.model = model;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

function setAgentProviderYaml(agentId: string, provider: ProviderConfig): void {
  const configPath = path.join(resolveAgentDir(agentId), 'agent.yaml');
  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  raw.provider = providerToYaml(provider);
  delete raw.model;
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

async function selectProvider(): Promise<ProviderConfig> {
  console.log('Providers:');
  console.log('  1. Claude (default)');
  console.log('  2. OpenAI (native Codex)');
  console.log('  3. OpenCode');
  console.log('  4. OpenRouter (native, OpenAI-compatible API — no CLI)');
  console.log('  5. Gemini CLI');
  console.log('  6. Codex ACP adapter');
  console.log('  7. Custom ACP command');
  console.log('  8. Z.ai GLM (full Claude Code tool surface; key in .env)');
  console.log();

  const answer = (await ask('Select provider', '1')).toLowerCase();
  if (answer === '2' || answer === 'openai') {
    const model = await ask(`OpenAI model id (e.g. ${DEFAULT_OPENAI_MODEL})`, DEFAULT_OPENAI_MODEL);
    return { type: 'openai', model };
  }
  if (answer === '3' || answer === 'opencode' || answer === 'o') return { type: 'opencode' };
  if (answer === '4' || answer === 'openrouter' || answer === 'or') {
    const model = await ask(`OpenRouter model id (e.g. ${DEFAULT_OPENROUTER_MODEL})`, DEFAULT_OPENROUTER_MODEL);
    return { type: 'openrouter', model };
  }
  if (answer === '5' || answer === 'gemini' || answer === 'g') return { type: 'gemini' };
  if (answer === '6' || answer === 'codex' || answer === 'acp-codex') return { type: 'acp-codex' };
  if (answer === '8' || answer === 'zai' || answer === 'z.ai' || answer === 'glm' || answer === 'anthropic-compatible' || answer === 'compat') {
    // No model prompt: the model is set in .env alongside the credential,
    // because it has to match what that endpoint actually serves. An optional
    // endpoint override is validated at call time against the allowlist, so a
    // typo here fails the turn loudly instead of silently reaching elsewhere.
    const baseUrl = (await ask('Endpoint (blank = z.ai built-in default; other Anthropic-compatible hosts are advanced config)', '')).trim();
    return baseUrl ? { type: 'anthropic-compatible', baseUrl } : { type: 'anthropic-compatible' };
  }
  if (answer === '7' || answer === 'acp' || answer === 'custom') {
    const command = await ask('ACP command');
    if (!command) throw new Error('Custom ACP provider requires a command.');
    const args = splitArgs(await ask('ACP arguments', '--acp'));
    return { type: 'acp', command, args };
  }
  if (answer !== '1' && answer !== 'claude' && answer !== 'c') {
    console.warn(`Unknown provider "${answer}". Using Claude.`);
  }
  return { type: 'claude', model: await ask('Claude model', 'claude-opus-4-6') };
}

function splitArgs(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ''));
}

async function main(): Promise<void> {
  const agents = ['main', ...listAgentIds().filter((id) => id !== 'main')];
  console.log(`Agents: ${agents.join(', ')}`);
  const target = await ask('Configure which agent? Use "all" for every agent', 'main');

  const provider = await selectProvider();

  const availability = checkProviderAvailability(provider);
  if (!availability.ok) {
    const lines = [availability.error ?? 'Provider CLI not found.'];
    if (availability.installCommand) lines.push(`Install: ${availability.installCommand}`);
    if (availability.setupHint) lines.push(availability.setupHint);
    if (availability.docsUrl) lines.push(`Docs: ${availability.docsUrl}`);
    throw new Error(`${lines.join('\n  ')}\n\nRe-run npm run provider:setup after fixing.`);
  }

  if (provider.type === 'opencode') {
    const credentialCount = getOpenCodeCredentialCount();
    if (credentialCount && credentialCount > 0) {
      console.log(`OpenCode auth found (${credentialCount} credential${credentialCount === 1 ? '' : 's'}).`);
      console.log('OpenCode lists model provider credentials here, not an "OpenCode" account.');
    } else if (await confirm('Run OpenCode auth login now?', false)) {
      spawnSync('opencode', ['auth', 'login'], { stdio: 'inherit' });
    }
    if (await confirm('Choose an OpenCode model now?', false)) {
      const model = await selectOpenCodeModel();
      if (model) {
        updateOpenCodeDefaultModel(model);
        console.log(`OpenCode default model set to ${model}`);
      } else {
        console.log('Keeping OpenCode current default model.');
      }
    } else {
      console.log('Keeping OpenCode current default model.');
    }
  } else if (provider.type === 'openrouter') {
    console.log('OpenRouter requires only OPENROUTER_API_KEY in .env (get a key at https://openrouter.ai/keys).');
    console.log('No CLI install, no separate auth flow. Restart the bot after editing .env.');
  } else if (provider.type === 'gemini') {
    console.log('Gemini CLI found. Auth and model selection stay in Gemini CLI.');
  } else if (provider.type === 'acp-codex') {
    console.log('Codex CLI found. ClaudeClaw uses the bundled codex-acp adapter to connect.');
  } else if (provider.type === 'openai') {
    console.log('OpenAI (native Codex) — a stable, ungated provider. No feature flag needed.');
    console.log('Transport: CODEX_TRANSPORT=app-server, or sdk for the temporary rollback path.');
    console.log('Auth: `codex login` (ChatGPT subscription) or OPENAI_API_KEY in .env.');
  } else if (provider.type === 'anthropic-compatible') {
    console.log('Z.ai GLM — set ANTHROPIC_COMPAT_API_KEY in .env; the model defaults to glm-5.3[1m].');
    console.log('Other Anthropic-compatible endpoints are advanced configuration: ANTHROPIC_COMPAT_ALLOW_CUSTOM_ENDPOINTS=true plus ANTHROPIC_COMPAT_ALLOWED_HOSTS.');
  }

  const targets = target === 'all' ? agents : [target];
  for (const id of targets) {
    if (id === 'main') setMainProviderConfig(provider);
    else setAgentProviderYaml(id, provider);
    console.log(`Updated ${id}: ${provider.type}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
