import { EngineFactory } from './agent-engine/index.js';
import type { ProviderConfig } from './provider.js';
import { readEnvFile } from './env.js';
import { getScrubbedSdkEnv } from './security.js';

export interface IsolatedExtractionOptions {
  provider: ProviderConfig;
  model?: string;
  timeoutMs?: number;
}

/**
 * Run a fresh, single-turn extraction with no settings, tools, MCP, or dispatch.
 * Callers must treat the prompt as untrusted: this boundary prevents transcript
 * text from acquiring runtime capabilities even if the model follows it.
 */
export async function runIsolatedExtraction(
  prompt: string,
  options: IsolatedExtractionOptions,
): Promise<string> {
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 15_000);
  let text = '';

  try {
    const engine = EngineFactory.forProvider(options.provider);
    for await (const event of engine.invoke({
      prompt,
      provider: options.provider,
      cwd: process.cwd(),
      ...(options.model ? { model: options.model } : {}),
      allowedTools: [],
      disallowedTools: ['*'],
      settingSources: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: getScrubbedSdkEnv(secrets),
      abortController: abort,
    })) {
      if (event.type === 'result' && typeof event.text === 'string') text = event.text;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
