import { expect, it, vi } from 'vitest';
import { summarizeCommand } from './agent-engine/command-summary.js';
import { serializeOutboundArguments } from './outbound-payload.js';

vi.mock('./outbound-policy.js', () => ({
  outboundOptionsForSeam: () => ({ enabled: true, protectedValues: ['alpha\nbeta "quoted" \\ secret'] }),
}));

it('scans command text before whitespace normalization or preview truncation', () => {
  const preview = summarizeCommand('echo alpha\nbeta "quoted" \\ secret', 20);
  expect(preview).toBe('echo [REDACTED]');
});

it('scans arbitrary tool argument leaves and keys before JSON escaping', () => {
  const secret = 'alpha\nbeta "quoted" \\ secret';
  const bytes = serializeOutboundArguments({ command: secret, nested: [secret], [secret]: 'value' }, 'test');
  expect(JSON.parse(bytes)).toEqual({ command: '[REDACTED]', nested: ['[REDACTED]'], '[REDACTED]': 'value' });
  expect(bytes).not.toContain('alpha');
});
