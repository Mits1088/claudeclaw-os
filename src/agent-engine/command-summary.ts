/**
 * Turn a raw shell command into a readable one-line progress label.
 *
 * Codex commonly wraps the useful payload in a platform shell launcher. The
 * launcher is transport plumbing, so omit it and spend the width on the command
 * the user can recognize.
 */
const SHELL_WRAPPERS: RegExp[] = [
  /^(?:"[^"]*[\\/](?:pwsh|powershell)(?:\.exe)?"|(?:pwsh|powershell)(?:\.exe)?)(?:\s+-[A-Za-z]+)*\s+-(?:c|Command|EncodedCommand)\s+/i,
  /^(?:"?\/usr\/bin\/bash"?|bash)(?:\s+-[a-z]+)*\s+-l?c\s+/,
  /^(?:"?\/bin\/sh"?|sh)\s+-c\s+/,
  /^(?:"?[^"]*[\\/]cmd(?:\.exe)?"?|cmd(?:\.exe)?)\s+\/[a-z]\s+/i,
];

function truncate(text: string, max: number): string {
  const oneLine = outboundText(text, 'provider.preview').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function summarizeCommand(command: string, max = 80): string {
  let rest = outboundText(command, 'provider.command').replace(/\s+/g, ' ').trim();
  for (const wrapper of SHELL_WRAPPERS) {
    if (wrapper.test(rest)) {
      rest = rest.replace(wrapper, '');
      break;
    }
  }

  const first = rest[0];
  if ((first === '"' || first === "'") && rest.endsWith(first)) {
    rest = rest.slice(1, -1).trim();
  }

  // Redirections are plumbing, never the point of the line.
  rest = rest.replace(/\s*2>&1\s*$/, '').trim();
  return truncate(rest || command, max);
}
import { outboundText } from '../outbound-payload.js';
