import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const schedulerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'scheduler.ts'), 'utf8');
const agentSource = fs.readFileSync(path.join(process.cwd(), 'src', 'agent.ts'), 'utf8');

describe('Crew Mission execution budget wiring', () => {
  it('uses a workflow-specific runtime watchdog and turn ceiling', () => {
    expect(schedulerSource).toContain('workflowGovernor.maxRuntimeSeconds * 1000');
    expect(schedulerSource).toContain('workflowGovernor?.maxTurnsPerTask');
    expect(agentSource).toContain('maxTurnsOverride ?? AGENT_MAX_TURNS');
  });
});
