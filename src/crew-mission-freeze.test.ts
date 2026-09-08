import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  claimNextMissionTask,
  completeMissionTask,
  createMissionTask,
  createMissionWorkflow,
  getMissionOutcome,
  getMissionTask,
  reconcileMissionControl,
} from './db.js';
import {
  actionCreateMission,
  actionCreateMissionWorkflow,
  actionResumeMissionWorkflow,
  actionTransitionMissionWorkflow,
} from './cli-actions.js';
import { parseCrewMissionsEnabled } from './config.js';
import {
  CREW_MISSIONS_DISABLED_MESSAGE,
  setCrewMissionsEnabledForTests,
} from './crew-mission-policy.js';
import { buildDashboardApp } from './dashboard.js';

describe('Crew Mission recovery freeze', () => {
  beforeEach(() => {
    _initTestDatabase();
    setCrewMissionsEnabledForTests(false);
  });

  afterEach(() => setCrewMissionsEnabledForTests(undefined));

  it('is disabled unless explicitly enabled', () => {
    expect(parseCrewMissionsEnabled(undefined)).toBe(false);
    expect(parseCrewMissionsEnabled('false')).toBe(false);
    expect(parseCrewMissionsEnabled('TRUE')).toBe(true);
  });

  it('blocks workflow entry and advancement actions while keeping one-shot Missions available', () => {
    expect(() => actionCreateMissionWorkflow({
      objective: 'blocked', prompt: 'blocked', agent: 'main', createdBy: 'main',
    })).toThrow(CREW_MISSIONS_DISABLED_MESSAGE);
    expect(() => actionResumeMissionWorkflow({ id: 'wf', answer: 'answer', createdBy: 'main' }))
      .toThrow(CREW_MISSIONS_DISABLED_MESSAGE);
    expect(() => actionTransitionMissionWorkflow({
      coordinatorTaskId: 'coord', disposition: 'complete', idempotencyKey: 'key', createdBy: 'main',
    })).toThrow(CREW_MISSIONS_DISABLED_MESSAGE);
    expect(() => createMissionWorkflow({
      id: 'direct-bypass', rootTaskId: 'direct-root', title: 'Blocked', objective: 'Blocked',
      initialPrompt: 'blocked', ownerAgent: 'main', workerAgent: 'main', priority: 5,
      maxDepth: 1, maxTasks: 1, maxFanout: 1, deadlineAt: null,
    })).toThrow(CREW_MISSIONS_DISABLED_MESSAGE);

    const ordinary = actionCreateMission({ prompt: 'still available', agent: 'main', createdBy: 'main' });
    expect(claimNextMissionTask('main')?.id).toBe(ordinary.id);
  });

  it('does not claim queued workflow work while frozen', () => {
    setCrewMissionsEnabledForTests(true);
    createMissionWorkflow({
      id: 'wf-frozen', rootTaskId: 'workflow-root', title: 'Frozen', objective: 'Stay parked',
      initialPrompt: 'do not run', ownerAgent: 'main', workerAgent: 'main', priority: 10,
      maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null,
    });
    setCrewMissionsEnabledForTests(false);
    createMissionTask('ordinary', 'Ordinary', 'run me', 'main', 'main', 1);

    expect(claimNextMissionTask('main')?.id).toBe('ordinary');
    expect(getMissionTask('workflow-root')?.status).toBe('queued');
  });

  it('records a running workflow outcome without creating a coordinator wake-up', () => {
    setCrewMissionsEnabledForTests(true);
    createMissionWorkflow({
      id: 'wf-running', rootTaskId: 'running-root', title: 'Running', objective: 'Finish safely',
      initialPrompt: 'finish', ownerAgent: 'main', workerAgent: 'main', priority: 5,
      maxDepth: 1, maxTasks: 2, maxFanout: 1, deadlineAt: null,
    });
    expect(claimNextMissionTask('main')?.id).toBe('running-root');

    setCrewMissionsEnabledForTests(false);
    expect(completeMissionTask('running-root', 'recorded', 'completed')).toMatchObject({
      changed: true, coordinatorTaskId: null,
    });
    expect(getMissionOutcome('outcome:running-root')).toMatchObject({ orchestration_state: 'pending' });
    expect(getMissionTask('coord:outcome:running-root')).toBeNull();
    expect(reconcileMissionControl()).toEqual({
      expiredWorkflows: 0, recoveredOutcomes: 0, releasedJoins: 0,
      blockedJoins: 0, queuedCoordinators: 0, blockedOutcomes: 0,
    });
    expect(getMissionTask('coord:outcome:running-root')).toBeNull();
  });

  it('reports disabled state and rejects workflow creation through the dashboard API', async () => {
    const app = buildDashboardApp(undefined);
    const listed = await app.request('/api/mission/workflows?token=test-contract-token');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      enabled: false,
      workflows: [],
      governor: { activeReservations: 0, usedTurns: 0 },
    });

    const created = await app.request('/api/mission/workflows?token=test-contract-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'blocked', prompt: 'blocked', assigned_agent: 'main', owner_agent: 'main',
      }),
    });
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({ error: CREW_MISSIONS_DISABLED_MESSAGE });
  });
});
