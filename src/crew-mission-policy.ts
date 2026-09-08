import {
  CREW_MISSIONS_ENABLED,
  CREW_MISSION_MAX_ACTIVE,
  CREW_MISSION_MAX_RUNNING_COORDINATORS,
  CREW_MISSION_MAX_RUNNING_WORKERS,
  CREW_MISSION_MAX_RUNTIME_SECONDS,
  CREW_MISSION_MAX_TURNS,
  CREW_MISSION_TURN_BUDGET_5H,
  CREW_MISSION_BUDGET_HARD_PERCENT,
  CREW_MISSION_PROVIDER_TURN_BUDGET_5H,
  CREW_MISSION_BUDGET_WARNING_PERCENT,
  CREW_MISSION_MAX_DEPTH,
  CREW_MISSION_MAX_TASKS,
  CREW_MISSION_MAX_FANOUT,
  CREW_MISSION_MAX_COORDINATOR_REVIEWS,
} from './config.js';

export const CREW_MISSIONS_DISABLED_MESSAGE =
  'Crew Missions are disabled by operator policy; ordinary one-shot Missions remain available';

let testOverride: boolean | undefined;
let governorTestOverride: CrewMissionGovernorPolicy | undefined;

export interface CrewMissionGovernorPolicy {
  maxActiveWorkflows: number;
  maxRunningWorkers: number;
  maxRunningCoordinators: number;
  maxTurnsPerTask: number;
  maxRuntimeSeconds: number;
  turnBudget5h: number;
  hardStopPercent: number;
  providerTurnBudget5h: number;
  warningPercent: number;
  maxWorkflowDepth: number;
  maxWorkflowTasks: number;
  maxWorkflowFanout: number;
  maxCoordinatorReviews: number;
}

export function crewMissionsEnabled(): boolean {
  return testOverride ?? CREW_MISSIONS_ENABLED;
}

export function setCrewMissionsEnabledForTests(value: boolean | undefined): void {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    throw new Error('Crew Mission policy overrides are test-only');
  }
  testOverride = value;
}

export function crewMissionGovernorPolicy(): CrewMissionGovernorPolicy {
  return governorTestOverride ?? {
    maxActiveWorkflows: CREW_MISSION_MAX_ACTIVE,
    maxRunningWorkers: CREW_MISSION_MAX_RUNNING_WORKERS,
    maxRunningCoordinators: CREW_MISSION_MAX_RUNNING_COORDINATORS,
    maxTurnsPerTask: CREW_MISSION_MAX_TURNS,
    maxRuntimeSeconds: CREW_MISSION_MAX_RUNTIME_SECONDS,
    turnBudget5h: CREW_MISSION_TURN_BUDGET_5H,
    hardStopPercent: CREW_MISSION_BUDGET_HARD_PERCENT,
    providerTurnBudget5h: CREW_MISSION_PROVIDER_TURN_BUDGET_5H,
    warningPercent: CREW_MISSION_BUDGET_WARNING_PERCENT,
    maxWorkflowDepth: CREW_MISSION_MAX_DEPTH,
    maxWorkflowTasks: CREW_MISSION_MAX_TASKS,
    maxWorkflowFanout: CREW_MISSION_MAX_FANOUT,
    maxCoordinatorReviews: CREW_MISSION_MAX_COORDINATOR_REVIEWS,
  };
}

export function setCrewMissionGovernorPolicyForTests(
  value: CrewMissionGovernorPolicy | undefined,
): void {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    throw new Error('Crew Mission governor overrides are test-only');
  }
  governorTestOverride = value;
}
