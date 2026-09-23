import { batch, signal } from '@preact/signals';

export type MissionInboxMode = 'show' | 'hide' | 'auto';
export type MissionPane = 'active' | 'history';

interface MissionBoardPreferences {
  inboxMode: MissionInboxMode;
  splitPercent: number;
  activeCollapsed: Record<string, boolean>;
  historyCollapsed: Record<string, boolean>;
}

const STORAGE_KEY = 'claudeclaw.missionBoard.v1';
const DEFAULT_SPLIT_PERCENT = 60;
export const MIN_SPLIT_PERCENT = 20;
export const MAX_SPLIT_PERCENT = 80;

function defaultPreferences(): MissionBoardPreferences {
  return {
    inboxMode: 'show',
    splitPercent: DEFAULT_SPLIT_PERCENT,
    activeCollapsed: {},
    historyCollapsed: {},
  };
}

export function clampMissionSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_PERCENT;
  return Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, Math.round(value)));
}

export function shouldShowMissionInbox(mode: MissionInboxMode, count: number): boolean {
  if (mode === 'hide') return false;
  if (mode === 'auto') return count > 0;
  return true;
}

function isInboxMode(value: unknown): value is MissionInboxMode {
  return value === 'show' || value === 'hide' || value === 'auto';
}

function parseCollapsedMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const parsed: Record<string, boolean> = {};
  for (const [agentId, collapsed] of Object.entries(value)) {
    if (typeof collapsed === 'boolean' && agentId.length > 0) parsed[agentId] = collapsed;
  }
  return parsed;
}

/** Parse persisted browser state without trusting its shape or values. */
export function parseMissionBoardPreferences(value: unknown): MissionBoardPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultPreferences();
  }
  const candidate = value as Partial<MissionBoardPreferences>;
  return {
    inboxMode: isInboxMode(candidate.inboxMode) ? candidate.inboxMode : 'show',
    splitPercent: clampMissionSplitPercent(
      typeof candidate.splitPercent === 'number' ? candidate.splitPercent : DEFAULT_SPLIT_PERCENT,
    ),
    activeCollapsed: parseCollapsedMap(candidate.activeCollapsed),
    historyCollapsed: parseCollapsedMap(candidate.historyCollapsed),
  };
}

/** Parse the exact localStorage representation, including corrupt JSON. */
export function parseStoredMissionBoardPreferences(stored: string | null): MissionBoardPreferences {
  if (!stored) return defaultPreferences();
  try {
    return parseMissionBoardPreferences(JSON.parse(stored));
  } catch {
    return defaultPreferences();
  }
}

function loadPreferences(): MissionBoardPreferences {
  if (typeof localStorage === 'undefined') return defaultPreferences();
  try {
    return parseStoredMissionBoardPreferences(localStorage.getItem(STORAGE_KEY));
  } catch {
    return defaultPreferences();
  }
}

const initial = loadPreferences();

export const missionInboxMode = signal<MissionInboxMode>(initial.inboxMode);
export const missionSplitPercent = signal<number>(initial.splitPercent);
export const missionActiveCollapsed = signal<Record<string, boolean>>(initial.activeCollapsed);
export const missionHistoryCollapsed = signal<Record<string, boolean>>(initial.historyCollapsed);

function persistPreferences() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      inboxMode: missionInboxMode.value,
      splitPercent: missionSplitPercent.value,
      activeCollapsed: missionActiveCollapsed.value,
      historyCollapsed: missionHistoryCollapsed.value,
    } satisfies MissionBoardPreferences));
  } catch {
    // Browser storage can be unavailable in private or restricted contexts.
  }
}

export function setMissionInboxMode(mode: MissionInboxMode) {
  missionInboxMode.value = mode;
  persistPreferences();
}

export function setMissionSplitPercent(percent: number) {
  missionSplitPercent.value = clampMissionSplitPercent(percent);
  persistPreferences();
}

export function setMissionPaneCollapsed(agentId: string, pane: MissionPane, collapsed: boolean) {
  if (!agentId) return;
  const target = pane === 'active' ? missionActiveCollapsed : missionHistoryCollapsed;
  target.value = { ...target.value, [agentId]: collapsed };
  persistPreferences();
}

/** Open both panes at 60/40 for every existing agent, keeping Inbox visibility. */
export function resetMissionPanels(agentIds: readonly string[]) {
  const expanded = Object.fromEntries(agentIds.filter(Boolean).map((id) => [id, false]));
  batch(() => {
    missionSplitPercent.value = DEFAULT_SPLIT_PERCENT;
    // An explicit false overrides automatic collapsing for empty panes.
    missionActiveCollapsed.value = { ...expanded };
    missionHistoryCollapsed.value = { ...expanded };
  });
  persistPreferences();
}
