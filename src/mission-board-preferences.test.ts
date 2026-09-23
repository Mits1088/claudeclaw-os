import { describe, expect, it } from 'vitest';

const modulePath = '../web/src/lib/missionBoardPreferences.ts';
const preferences = await import(/* @vite-ignore */ modulePath) as {
  clampMissionSplitPercent: (value: number) => number;
  parseMissionBoardPreferences: (value: unknown) => {
    inboxMode: string;
    splitPercent: number;
    activeCollapsed: Record<string, boolean>;
    historyCollapsed: Record<string, boolean>;
  };
  parseStoredMissionBoardPreferences: (stored: string | null) => {
    inboxMode: string;
    splitPercent: number;
    activeCollapsed: Record<string, boolean>;
    historyCollapsed: Record<string, boolean>;
  };
  shouldShowMissionInbox: (mode: 'show' | 'hide' | 'auto', count: number) => boolean;
  resetMissionPanels: (agentIds: readonly string[]) => void;
  missionInboxMode: { value: 'show' | 'hide' | 'auto' };
  missionSplitPercent: { value: number };
  missionActiveCollapsed: { value: Record<string, boolean> };
  missionHistoryCollapsed: { value: Record<string, boolean> };
};

describe('Mission Control browser preferences', () => {
  it('keeps the shared pane split in its usable range', () => {
    expect(preferences.clampMissionSplitPercent(3)).toBe(20);
    expect(preferences.clampMissionSplitPercent(63.6)).toBe(64);
    expect(preferences.clampMissionSplitPercent(99)).toBe(80);
    expect(preferences.clampMissionSplitPercent(Number.NaN)).toBe(60);
  });

  it('falls back safely for corrupt storage and ignores unknown or invalid fields', () => {
    expect(preferences.parseStoredMissionBoardPreferences('{not json')).toEqual({
      inboxMode: 'show',
      splitPercent: 60,
      activeCollapsed: {},
      historyCollapsed: {},
    });

    expect(preferences.parseMissionBoardPreferences({
      inboxMode: 'sometimes',
      splitPercent: 95,
      activeCollapsed: { alpha: true, beta: 'yes' },
      historyCollapsed: ['alpha'],
      unknownFutureField: { enabled: true },
    })).toEqual({
      inboxMode: 'show',
      splitPercent: 80,
      activeCollapsed: { alpha: true },
      historyCollapsed: {},
    });
  });

  it('shows an automatic Inbox when work arrives and honors explicit visibility choices', () => {
    expect(preferences.shouldShowMissionInbox('auto', 0)).toBe(false);
    expect(preferences.shouldShowMissionInbox('auto', 1)).toBe(true);
    expect(preferences.shouldShowMissionInbox('show', 0)).toBe(true);
    expect(preferences.shouldShowMissionInbox('hide', 4)).toBe(false);
  });

  it('resets both populated and empty agent panes to an explicit 60/40 split without changing Inbox visibility', () => {
    const saved = {
      inbox: preferences.missionInboxMode.value,
      split: preferences.missionSplitPercent.value,
      active: preferences.missionActiveCollapsed.value,
      history: preferences.missionHistoryCollapsed.value,
    };
    try {
      preferences.missionInboxMode.value = 'hide';
      preferences.missionSplitPercent.value = 80;
      preferences.missionActiveCollapsed.value = { busy: true };
      preferences.missionHistoryCollapsed.value = { busy: true, empty: true };

      preferences.resetMissionPanels(['busy', 'empty']);

      expect(preferences.missionSplitPercent.value).toBe(60);
      // Missing keys trigger automatic collapse when a pane has no tasks.
      expect(preferences.missionActiveCollapsed.value).toEqual({ busy: false, empty: false });
      expect(preferences.missionHistoryCollapsed.value).toEqual({ busy: false, empty: false });
      expect(preferences.missionInboxMode.value).toBe('hide');
    } finally {
      preferences.missionInboxMode.value = saved.inbox;
      preferences.missionSplitPercent.value = saved.split;
      preferences.missionActiveCollapsed.value = saved.active;
      preferences.missionHistoryCollapsed.value = saved.history;
    }
  });
});
