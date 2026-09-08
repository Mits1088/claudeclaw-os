import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Mission Control crew mission IDs', () => {
  const source = readFileSync(join(process.cwd(), 'web/src/pages/MissionControl.tsx'), 'utf8');

  it('renders six-character workflow IDs while retaining full IDs as hover text', () => {
    expect(source).toContain('title={workflow.id}>{workflow.id.slice(0, 6)}</span>');
    expect(source).toContain('title={task.workflow_id}><Pill tone="accent">crew mission {task.workflow_id.slice(0, 6)}');
  });

  it('retains full workflow IDs in confirmation and API operations', () => {
    expect(source).toContain('Cancel crew mission ${workflow.id}?');
    expect(source).toContain('/api/mission/workflows/${workflow.id}/cancel');
    expect(source).toContain('/api/mission/workflows/${workflow.id}/resume');
  });

  it('removes workflow creation and resume controls while operator-disabled', () => {
    expect(source).toContain('crewMissionsEnabled ? <label');
    expect(source).toContain('enabled && workflow.status === \'waiting_human\'');
    expect(source).toContain('Crew Missions are disabled by operator policy');
  });

  it('shows durable governor usage and parked workflow work', () => {
    expect(source).toContain('5h budget {governor.usedTurns}/{governor.hardAllowanceTurns} turns');
    expect(source).toContain('governor.parkedWorkflowTasks');
    expect(source).toContain('governor.activeReservations');
    expect(source).toContain("governor.budgetState.replace('_', ' ')");
    expect(source).toContain('governor.totals.inputTokens');
  });
});
