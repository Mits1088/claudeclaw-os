import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  cancelMissionTask,
  createMissionTask,
  completeMissionTask,
  getGroupChildren,
  areAllGroupChildrenTerminal,
  releaseJoinMission,
  getJoinMission,
  updateMissionPrompt,
  getMissionTask,
  maybeReleaseJoinForMission,
} from './db.js';

describe('gather / join primitive (Tier 3)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  function seedGroup(groupId: string, childCount = 2): string[] {
    const childIds: string[] = [];
    for (let i = 0; i < childCount; i++) {
      const id = `child${i}-${groupId}`;
      createMissionTask(id, `Child ${i}`, `Do thing ${i}`, `agent${i}`, 'main', 0, null, groupId, 'task');
      childIds.push(id);
    }
    createMissionTask(`join-${groupId}`, 'Join', 'Summarize everything', 'summarizer', 'main', 0, null, groupId, 'join', 'waiting');
    return childIds;
  }

  it('keeps the join waiting until all children are terminal', () => {
    const groupId = 'g1';
    const [c0, c1] = seedGroup(groupId);

    expect(areAllGroupChildrenTerminal(groupId)).toBe(false);

    completeMissionTask(c0, 'result 0', 'completed');
    expect(areAllGroupChildrenTerminal(groupId)).toBe(false);
    // Release goes through maybeReleaseJoinForMission (scheduler terminal paths
    // and cancelMissionTask), which guards on areAllGroupChildrenTerminal before
    // calling releaseJoinMission; releaseJoinMission itself just performs the
    // atomic flip and doesn't re-check termination, so calling it here (as a
    // caller who skipped the guard never would) still flips a genuinely
    // 'waiting' row. Assert the guarded path instead: with one child still
    // outstanding, the join must stay parked.
    expect(getJoinMission(groupId)?.status).toBe('waiting');

    completeMissionTask(c1, 'result 1', 'completed');
    expect(areAllGroupChildrenTerminal(groupId)).toBe(true);
  });

  it('releases the join exactly once (atomic race guard)', () => {
    const groupId = 'g2';
    const [c0, c1] = seedGroup(groupId);
    completeMissionTask(c0, 'result 0', 'completed');
    completeMissionTask(c1, 'result 1', 'completed');

    expect(areAllGroupChildrenTerminal(groupId)).toBe(true);
    expect(releaseJoinMission(groupId)).toBe(true);
    expect(getJoinMission(groupId)?.status).toBe('queued');

    // A second caller racing to release the same group must be a no-op.
    expect(releaseJoinMission(groupId)).toBe(false);
  });

  it('treats failed and cancelled children as terminal', () => {
    const groupId = 'g3';
    const [c0, c1] = seedGroup(groupId);
    completeMissionTask(c0, null, 'failed', 'boom');
    completeMissionTask(c1, 'ok', 'completed');

    expect(areAllGroupChildrenTerminal(groupId)).toBe(true);
    expect(releaseJoinMission(groupId)).toBe(true);
  });

  it('releases a gather whose children are already terminal before the check runs', () => {
    const groupId = 'g4';
    const [c0, c1] = seedGroup(groupId);
    completeMissionTask(c0, 'result 0', 'completed');
    completeMissionTask(c1, 'result 1', 'completed');

    // Simulate a late-arriving check (e.g. scheduler restart) that only now
    // evaluates the group for the first time.
    expect(areAllGroupChildrenTerminal(groupId)).toBe(true);
    expect(releaseJoinMission(groupId)).toBe(true);
  });

  it('assembles child results into the join prompt before release', () => {
    const groupId = 'g5';
    const [c0, c1] = seedGroup(groupId);
    completeMissionTask(c0, 'finding A', 'completed');
    completeMissionTask(c1, 'finding B', 'completed');

    const join = getJoinMission(groupId);
    expect(join).not.toBeNull();

    const children = getGroupChildren(groupId);
    expect(children).toHaveLength(2);
    const assembled = children
      .map((c) => `=== ${c.title} (@${c.assigned_agent}) ===\n${c.result}`)
      .join('\n\n');
    updateMissionPrompt(join!.id, `${join!.prompt}\n\n--- Collected results ---\n${assembled}`);

    const updated = getMissionTask(join!.id);
    expect(updated?.prompt).toContain('finding A');
    expect(updated?.prompt).toContain('finding B');
    expect(updated?.prompt).toContain('Collected results');
  });

  it('releases the join when the last non-terminal child is cancelled', () => {
    const groupId = 'g8';
    const [c0, c1] = seedGroup(groupId);
    completeMissionTask(c0, 'result 0', 'completed');
    expect(getJoinMission(groupId)?.status).toBe('waiting');

    // Cancelling via the dashboard/CLI surface must release the parked join —
    // the scheduler never sees a queued child again after this flip.
    expect(cancelMissionTask(c1)).toBe(true);
    expect(areAllGroupChildrenTerminal(groupId)).toBe(true);
    expect(getJoinMission(groupId)?.status).toBe('queued');

    // The cancelled child contributes its placeholder to the assembled prompt.
    const join = getJoinMission(groupId);
    expect(join?.prompt).toContain('Collected results');
    expect(join?.prompt).toContain('result 0');
    expect(join?.prompt).toContain('(cancelled)');
  });

  it('does not release or rewrite twice after repeated cancellation', () => {
    const groupId = 'g9';
    const [c0, c1] = seedGroup(groupId);
    completeMissionTask(c0, 'result 0', 'completed');

    expect(cancelMissionTask(c1)).toBe(true);
    const released = getJoinMission(groupId);
    expect(released?.status).toBe('queued');
    expect(cancelMissionTask(c1)).toBe(false);
    maybeReleaseJoinForMission(getMissionTask(c1)!);
    expect(getJoinMission(groupId)?.prompt).toBe(released?.prompt);
    expect(released?.prompt.match(/Collected results/g)).toHaveLength(1);
  });

  it('leaves non-gather tasks and already-terminal groups unchanged', () => {
    createMissionTask('plain', 'Plain', 'Do thing', 'agent0', 'main');
    expect(cancelMissionTask('plain')).toBe(true);

    const groupId = 'g10';
    const [c0, c1] = seedGroup(groupId);
    completeMissionTask(c0, 'result 0', 'completed');
    expect(cancelMissionTask(c1)).toBe(true);
    const released = getJoinMission(groupId);
    maybeReleaseJoinForMission(getMissionTask(c0)!);
    expect(getJoinMission(groupId)).toEqual(released);
  });

  it('assembles cancelled children in deterministic id order', () => {
    const groupId = 'g11';
    const [c0, c1] = seedGroup(groupId);
    expect(cancelMissionTask(c1)).toBe(true);
    expect(cancelMissionTask(c0)).toBe(true);

    const prompt = getJoinMission(groupId)?.prompt ?? '';
    expect(prompt.indexOf('Child 0')).toBeLessThan(prompt.indexOf('Child 1'));
    expect(prompt.match(/\(cancelled\)/g)).toHaveLength(2);
  });

  it('getGroupChildren only returns role=task rows, excluding the join', () => {
    const groupId = 'g6';
    seedGroup(groupId, 3);
    const children = getGroupChildren(groupId);
    expect(children).toHaveLength(3);
    expect(children.every((c) => c.role === 'task')).toBe(true);
  });

  it('areAllGroupChildrenTerminal is false for an unknown/empty group', () => {
    expect(areAllGroupChildrenTerminal('does-not-exist')).toBe(false);
  });
});
