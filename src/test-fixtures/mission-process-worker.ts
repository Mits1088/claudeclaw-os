// Synthetic process for mission lifecycle tests. No scheduler, provider or messenger.
import fs from 'node:fs';
import * as db from '../db.js';

db.initDatabase();
const methods = {
  create: db.createMissionTask,
  claim: db.claimNextMissionTask,
  complete: db.completeMissionTask,
  get: db.getMissionTask,
  tasks: db.getMissionTasks,
  handback: db.createMissionHandback,
  continue: db.createMissionContinuation,
  cancelChain: db.cancelMissionChain,
  chain: db.getMissionChain,
  cancel: db.cancelMissionTask,
  epoch: db.beginWorkerSupervisorEpoch,
  desired: db.ensureWorkerDesiredState,
  lease: db.acquireWorkerLease,
  reset: db.resetStuckMissionTasks,
  join: db.getJoinMission,
  releaseJoin: db.releaseJoinMission,
  releaseEligible: db.maybeReleaseJoinForMission,
};
process.on('message', (message: { id: number; method: string; args: unknown[] }) => {
  if (message.method === 'stop') process.exit(0);
  if (message.method === 'crash') {
    // An observable synthetic side effect, followed by exit before completion.
    fs.appendFileSync(String(message.args[0]), 'executed\n');
    process.exit(17);
  }
  try {
    if (!Object.hasOwn(methods, message.method)) throw new Error('Unknown fixture method');
    const fn = methods[message.method as keyof typeof methods] as (...args: any[]) => unknown;
    process.send?.({ id: message.id, result: fn(...message.args) });
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) });
  }
});
process.send?.({ ready: true });
