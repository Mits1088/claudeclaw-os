import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { ChevronDown, ChevronRight } from 'lucide-preact';
import {
  MIN_SPLIT_PERCENT,
  MAX_SPLIT_PERCENT,
  missionActiveCollapsed,
  missionHistoryCollapsed,
  missionSplitPercent,
  setMissionPaneCollapsed,
  setMissionSplitPercent,
  type MissionPane,
} from '@/lib/missionBoardPreferences';

interface MissionColumnPanelsProps {
  agentId: string;
  agentName: string;
  activeCount: number;
  historyCount: number;
  activeContent: ComponentChildren;
  historyContent: ComponentChildren;
  historyEnabled?: boolean;
}

const hasOwn = (value: Record<string, boolean>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export function MissionColumnPanels({
  agentId,
  agentName,
  activeCount,
  historyCount,
  activeContent,
  historyContent,
  historyEnabled = true,
}: MissionColumnPanelsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const pointerDragging = useRef(false);
  const capturedPointerId = useRef<number | null>(null);
  const dragOffsetY = useRef(0);
  const lastPointerY = useRef(0);
  const collapsePreviewRef = useRef<MissionPane | null>(null);
  const [collapsePreview, setCollapsePreview] = useState<MissionPane | null>(null);
  const instanceId = useId().replace(/:/g, '');

  const activePreferences = missionActiveCollapsed.value;
  const historyPreferences = missionHistoryCollapsed.value;
  const activeWasSet = hasOwn(activePreferences, agentId);
  const historyWasSet = hasOwn(historyPreferences, agentId);
  const activeCollapsed = historyEnabled && (
    activeWasSet ? activePreferences[agentId] : activeCount === 0
  );
  const historyCollapsed = historyWasSet ? historyPreferences[agentId] : historyCount === 0;
  const splitPercent = missionSplitPercent.value;
  const showDivider = historyEnabled && !activeCollapsed && !historyCollapsed;

  const activeId = `mission-${instanceId}-active`;
  const historyId = `mission-${instanceId}-history`;

  const gridRows = !historyEnabled
    ? 'minmax(0, 1fr)'
    : showDivider
      ? `minmax(44px, ${splitPercent}fr) 5px minmax(44px, ${100 - splitPercent}fr)`
      : activeCollapsed && !historyCollapsed
        ? 'auto minmax(0, 1fr)'
        : !activeCollapsed && historyCollapsed
          ? 'minmax(0, 1fr) auto'
          : 'auto auto';

  useEffect(() => () => {
    const pointerId = capturedPointerId.current;
    const divider = dividerRef.current;
    if (pointerId !== null && divider?.hasPointerCapture(pointerId)) {
      divider.releasePointerCapture(pointerId);
    }
    capturedPointerId.current = null;
    pointerDragging.current = false;
  }, []);

  function updateFromPointer(clientY: number) {
    const rect = rootRef.current?.getBoundingClientRect();
    const dividerHeight = dividerRef.current?.getBoundingClientRect().height ?? 0;
    if (!rect || rect.height <= dividerHeight) return;
    // Measure the space used by the two panes, excluding the divider itself.
    // Preserve where the pointer grabbed the handle to avoid a jump on click.
    const percent = ((clientY - dragOffsetY.current - rect.top - dividerHeight / 2) / (rect.height - dividerHeight)) * 100;
    const collapse = percent < MIN_SPLIT_PERCENT ? 'active' : percent > MAX_SPLIT_PERCENT ? 'history' : null;
    // Keep the divider mounted while pulled beyond the limit. Releasing
    // commits the preview; moving back into range cancels it.
    collapsePreviewRef.current = collapse;
    setCollapsePreview(collapse);
    setMissionSplitPercent(percent);
  }

  function onDividerPointerDown(event: PointerEvent) {
    if (event.button !== 0 || pointerDragging.current) return;
    event.preventDefault();
    const divider = event.currentTarget as HTMLElement;
    const rect = divider.getBoundingClientRect();
    dragOffsetY.current = event.clientY - (rect.top + rect.height / 2);
    lastPointerY.current = event.clientY;
    pointerDragging.current = true;
    capturedPointerId.current = event.pointerId;
    divider.setPointerCapture(event.pointerId);
  }

  function onDividerPointerMove(event: PointerEvent) {
    if (!pointerDragging.current || event.pointerId !== capturedPointerId.current || event.clientY === lastPointerY.current) return;
    lastPointerY.current = event.clientY;
    updateFromPointer(event.clientY);
  }

  function onDividerPointerUp(event: PointerEvent) {
    if (!pointerDragging.current || event.pointerId !== capturedPointerId.current) return;
    if (event.clientY !== lastPointerY.current) updateFromPointer(event.clientY);
    const collapse = collapsePreviewRef.current;
    stopDividerDrag();
    if (collapse) setMissionPaneCollapsed(agentId, collapse, true);
  }

  function stopDividerDrag(event?: PointerEvent) {
    const pointerId = capturedPointerId.current;
    if (event && event.pointerId !== pointerId) return;
    const divider = dividerRef.current;
    capturedPointerId.current = null;
    pointerDragging.current = false;
    collapsePreviewRef.current = null;
    setCollapsePreview(null);
    if (pointerId !== null && divider?.hasPointerCapture(pointerId)) {
      divider.releasePointerCapture(pointerId);
    }
  }

  function onDividerKeyDown(event: KeyboardEvent) {
    const step = event.shiftKey ? 10 : 5;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setMissionSplitPercent(splitPercent - step);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setMissionSplitPercent(splitPercent + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setMissionSplitPercent(MIN_SPLIT_PERCENT);
    } else if (event.key === 'End') {
      event.preventDefault();
      setMissionSplitPercent(MAX_SPLIT_PERCENT);
    }
  }

  return (
    <div
      ref={rootRef}
      class="grid flex-1 min-h-0 content-start overflow-hidden"
      style={{ gridTemplateRows: gridRows }}
    >
      <MissionPaneSection
        id={activeId}
        label="Active Tasks"
        regionLabel={`${agentName} active tasks`}
        count={activeCount}
        collapsed={activeCollapsed}
        collapsePreview={collapsePreview === 'active'}
        emptyLabel="Tasks appear here when assigned to this agent."
        canCollapse={historyEnabled}
        onCollapsed={(collapsed) => setMissionPaneCollapsed(agentId, 'active', collapsed)}
      >
        {activeContent}
      </MissionPaneSection>

      {showDivider && (
        <div
          ref={dividerRef}
          role="separator"
          aria-label="Resize active tasks and recent history for all agent columns"
          aria-orientation="horizontal"
          aria-valuemin={MIN_SPLIT_PERCENT}
          aria-valuemax={MAX_SPLIT_PERCENT}
          aria-valuenow={splitPercent}
          aria-valuetext={`${splitPercent}% active tasks, ${100 - splitPercent}% recent history`}
          tabIndex={0}
          title="Drag to resize all columns. Pull past a limit and release to collapse that panel in this column; drag back to cancel. Use the header to reopen. Arrow keys adjust the split."
          onPointerDown={onDividerPointerDown}
          onPointerMove={onDividerPointerMove}
          onPointerUp={onDividerPointerUp}
          onPointerCancel={stopDividerDrag}
          onLostPointerCapture={() => stopDividerDrag()}
          onKeyDown={onDividerKeyDown}
          class="group relative z-[2] flex items-center justify-center cursor-row-resize touch-none outline-none"
        >
          <span class={`absolute inset-x-0 top-1/2 h-px transition-colors duration-150 group-hover:bg-[var(--color-accent)] group-focus:bg-[var(--color-accent)] ${collapsePreview ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border-strong)]'}`} />
          <span aria-hidden="true" class={`relative h-[5px] w-6 rounded-full border transition-colors duration-150 group-hover:border-[var(--color-accent)] group-hover:bg-[var(--color-accent)] group-focus:border-[var(--color-accent)] group-focus:bg-[var(--color-accent)] ${collapsePreview ? 'border-[var(--color-accent)] bg-[var(--color-accent)]' : 'border-[var(--color-border-strong)] bg-[var(--color-text-faint)]'}`} />
          {collapsePreview && <span role="status" class="pointer-events-none absolute bottom-[12px] left-1/2 z-20 w-max max-w-[calc(100%_-_16px)] -translate-x-1/2 whitespace-normal rounded-md border border-[var(--color-control-border)] bg-[var(--color-sidebar)] px-2.5 py-[3px] text-center text-[10px] font-medium leading-[12px] text-[var(--color-text)] shadow-lg shadow-black/25">
            Release to collapse {collapsePreview === 'active' ? 'Active Tasks' : 'Recent History'}
          </span>}
        </div>
      )}

      {historyEnabled && (
        <MissionPaneSection
          id={historyId}
          label="Recent History"
          regionLabel={`${agentName} recent history`}
          count={historyCount}
          collapsed={historyCollapsed}
          collapsePreview={collapsePreview === 'history'}
          emptyLabel="This agent has no recent task history."
          canCollapse
          onCollapsed={(collapsed) => setMissionPaneCollapsed(agentId, 'history', collapsed)}
        >
          {historyContent}
        </MissionPaneSection>
      )}
    </div>
  );
}

interface MissionPaneSectionProps {
  id: string;
  label: string;
  regionLabel: string;
  count: number;
  collapsed: boolean;
  collapsePreview?: boolean;
  emptyLabel: string;
  canCollapse: boolean;
  onCollapsed: (collapsed: boolean) => void;
  children: ComponentChildren;
}

function MissionPaneSection({
  id,
  label,
  regionLabel,
  count,
  collapsed,
  collapsePreview = false,
  emptyLabel,
  canCollapse,
  onCollapsed,
  children,
}: MissionPaneSectionProps) {
  return (
    <section class="flex min-h-0 flex-col overflow-hidden">
      <div class={`flex h-9 shrink-0 items-center gap-2 border-b px-2.5 transition-colors duration-150 ${collapsePreview ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] bg-[var(--color-sidebar)]'}`}>
        <div class="min-w-0 flex-1 text-[11.5px] font-medium text-[var(--color-text)]">
          <span class="block truncate">{label}{count === 0 ? ' (none)' : ''}</span>
        </div>
        {count > 0 && <span class="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-1.5 py-0.5 text-[10.5px] tabular-nums text-[var(--color-text-muted)]">
          {count}
        </span>}
        {canCollapse && (
          <button
            type="button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${regionLabel}`}
            aria-expanded={!collapsed}
            aria-controls={id}
            onClick={() => onCollapsed(!collapsed)}
            class="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] outline-none transition-colors hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)] focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            title={`${collapsed ? 'Expand' : 'Collapse'} ${label.toLowerCase()}`}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>
      <div
        id={id}
        role="region"
        aria-label={regionLabel}
        tabIndex={collapsed ? -1 : 0}
        hidden={collapsed}
        class="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
      >
        {count === 0 ? (
          <div class="py-5 text-center text-[11px] text-[var(--color-text-faint)]">{emptyLabel}</div>
        ) : children}
      </div>
    </section>
  );
}
