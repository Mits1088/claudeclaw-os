import { readEnvFile } from './env.js';
import { resolveProtectedValues } from './outbound-sanitizer.js';

export const DEFAULT_PROTECTED_ENV_VARS = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'DB_ENCRYPTION_KEY',
  'TELEGRAM_BOT_TOKEN', 'SLACK_USER_TOKEN', 'GROQ_API_KEY',
  'ELEVENLABS_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY',
];

/** No config/logger imports: safe even while the logger is bootstrapping. */
export function configuredProtectedValues(
  names: string[], env: Record<string, string | undefined> = process.env,
): string[] {
  const file = readEnvFile(names);
  return resolveProtectedValues(names, Object.fromEntries(names.map(name => [name, env[name] || file[name]])));
}

export function logProtectedValues(): string[] {
  const configured = process.env.PROTECTED_ENV_VARS || readEnvFile(['PROTECTED_ENV_VARS']).PROTECTED_ENV_VARS;
  const names = configured ? configured.split(',').map(name => name.trim()).filter(Boolean) : DEFAULT_PROTECTED_ENV_VARS;
  return configuredProtectedValues(names);
}
