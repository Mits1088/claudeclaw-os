import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDashboardHtml } from './dashboard-html.js';

describe('Mission Control future-task availability', () => {
  it('renders the persisted one-time execution gate in assigned and inbox cards', () => {
    const html = getDashboardHtml('test-token', 'test-chat');

    expect(html).toContain('function missionAvailabilityHtml(t)');
    expect(html).toContain('if (!t.available_at) return');
    expect(html).toContain('Runs once ');
    expect(html).toContain('runAt.toISOString()');
    expect(html.match(/missionAvailabilityHtml\(t\)/g)).toHaveLength(3);
  });

  it('renders the persisted one-time execution gate in the current web dashboard', () => {
    const source = readFileSync(join(process.cwd(), 'web/src/pages/MissionControl.tsx'), 'utf8');

    expect(source).toContain('available_at: number | null');
    expect(source).toContain('function missionAvailability(task: MissionTask)');
    expect(source).toContain('Runs once ${localTime} · ${missionCountdown(');
    expect(source).toContain('<span>{availability}</span>');
  });
});
