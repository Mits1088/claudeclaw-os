import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Activity, FileText, Info, SlidersHorizontal } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { AgentActivity, AgentOverview, type AgentSummary } from '@/components/AgentDetail';
import { ProviderConfigEditor, type ProviderConfig, type ProviderOption } from '@/components/ProviderConfigEditor';
import { AgentStatusBadge } from '@/components/Pill';
import { AgentFilesEditor } from '@/pages/AgentFiles';
import { useFetch } from '@/lib/useFetch';
import { apiPatch, apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';

export type AgentSettingsSection = 'overview' | 'provider' | 'files' | 'activity';
type EditState = { dirty: boolean; busy: boolean };
type SettingsAgent = AgentSummary & { provider: ProviderConfig };
const sections = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'provider', label: 'Provider', icon: SlidersHorizontal },
  { id: 'files', label: 'Persona & config', icon: FileText },
  { id: 'activity', label: 'Activity', icon: Activity },
] as const;

/** One settings window contains the agent's profile, configuration and activity. */
export function AgentSettings({ agent, initialSection, onClose, onChange }: {
  agent: SettingsAgent;
  initialSection: AgentSettingsSection;
  onClose: () => void;
  onChange: () => void;
}) {
  const [section, setSection] = useState(initialSection);
  const [editState, setEditState] = useState<EditState>({ dirty: false, busy: false });
  const [pending, setPending] = useState<AgentSettingsSection | 'close' | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const onEditorState = useCallback((next: EditState) => {
    setEditState(next);
    if (!next.dirty) setPending(null);
  }, []);
  const onOverviewBusy = useCallback((busy: boolean) => setEditState({ dirty: false, busy }), []);

  useEffect(() => {
    if (pending) keepEditingRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (!editState.dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editState.dirty]);

  function navigate(next: AgentSettingsSection | 'close') {
    setPending(null);
    setEditState({ dirty: false, busy: false });
    if (next === 'close') onClose();
    else setSection(next);
  }

  function requestNavigation(next: AgentSettingsSection | 'close') {
    if (editState.busy || next === section) return;
    if (pending && next === 'close') { setPending(null); return; }
    if (editState.dirty) setPending(next);
    else navigate(next);
  }

  return (
    <Modal open onClose={() => requestNavigation('close')} closeDisabled={editState.busy}
      title={`${agent.name || agent.id} · Agent settings`} width={960}
      height="min(760px, calc(var(--app-height) - 2rem))"
      bodyClassName="flex-1 min-h-0 flex flex-col overflow-hidden"
      footer={pending ? (
        <div role="alert" class="flex w-full flex-wrap items-center gap-3">
          <div class="flex-1 min-w-[180px]">
            <p class="text-[12px] font-medium text-[var(--color-text)]">Discard unsaved changes?</p>
            <p class="text-[11px] text-[var(--color-text-muted)]">Your edits in this section have not been saved.</p>
          </div>
          <button type="button" ref={keepEditingRef} onClick={() => setPending(null)} class="toolbar-control control-button px-3 rounded-md text-[var(--color-text)] hover:bg-[var(--color-control-hover)]">Keep editing</button>
          <button type="button" onClick={() => navigate(pending)} class="toolbar-control control-button px-3 rounded-md bg-[var(--color-status-failed)] text-white">Discard changes</button>
        </div>
      ) : (
        <>
          <span role="status" class="text-[11px] text-[var(--color-text-muted)]">{editState.busy ? 'Saving changes…' : editState.dirty ? 'Unsaved changes' : section === 'activity' ? 'Recent activity preview. Use Open to continue on the full page.' : 'Changes are saved within each section.'}</span>
          <button type="button" onClick={() => requestNavigation('close')} disabled={editState.busy} class="toolbar-control control-button ml-auto px-3 rounded-md text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40">Close</button>
        </>
      )}
    >
      <div class="px-5 pt-4 pb-3 shrink-0">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
          <AgentStatusBadge running={agent.running} />
          {agent.id === 'main' && <span class="text-[var(--color-accent)]">Main agent</span>}
        </div>
        {agent.description && <p title={agent.description} class="text-[12px] text-[var(--color-text-muted)] leading-relaxed mt-2 line-clamp-2">{agent.description}</p>}
      </div>
      <nav aria-label="Agent settings sections" class="page-toolbar grid grid-cols-2 sm:flex sm:flex-wrap gap-1 px-4 pb-3 border-b border-[var(--color-border)] shrink-0">
        {sections.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" aria-current={section === id ? 'page' : undefined}
            disabled={editState.busy || !!pending} onClick={() => requestNavigation(id)}
            class={`toolbar-control control-button inline-flex items-center gap-1.5 rounded-md px-3 transition-colors disabled:opacity-50 ${section === id ? 'control-accent font-medium' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]'}`}>
            <Icon size={14} />{label}
            {section === id && editState.dirty && <span aria-label="Unsaved changes" class="h-1.5 w-1.5 rounded-full bg-current" />}
          </button>
        ))}
      </nav>
      <section aria-label={`${sections.find((item) => item.id === section)?.label} settings`}
        class={`flex-1 min-h-0 min-w-0 ${section === 'files' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto p-5'}`}>
        {section === 'overview' && <AgentOverview agent={agent} onBusyChange={onOverviewBusy} />}
        {section === 'provider' && <AgentProviderSettings agent={agent} onChange={onChange} onStateChange={onEditorState} />}
        {section === 'files' && <AgentFilesEditor agentId={agent.id} embedded onStateChange={onEditorState} onSaved={onChange} />}
        {section === 'activity' && <AgentActivity key={agent.id} agentId={agent.id} agentName={agent.name || agent.id} />}
      </section>
    </Modal>
  );
}

function AgentProviderSettings({ agent, onChange, onStateChange }: {
  agent: SettingsAgent;
  onChange: () => void;
  onStateChange: (state: EditState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState<ProviderConfig | null>(null);
  const providerStatus = useFetch<{ providers?: ProviderOption[] }>('/api/provider/status', 30_000);

  async function save(provider: ProviderConfig) {
    if (provider.type === 'acp' && !provider.command?.trim()) {
      pushToast({ tone: 'error', title: 'Command required', description: 'Custom ACP needs a command.' });
      return;
    }
    setBusy(true);
    onStateChange({ dirty: true, busy: true });
    try {
      const res = await apiPatch<{ changed?: boolean; sessionReset?: boolean; restartRequired: boolean }>(
        `/api/agents/${encodeURIComponent(agent.id)}/provider`, { provider },
      );
      setSaved(provider);
      setVersion((v) => v + 1);
      onStateChange({ dirty: false, busy: false });
      onChange();
      if (res.changed !== false && res.restartRequired) {
        pushToast({
          tone: 'warn', title: `${agent.name || agent.id} needs a restart`,
          description: 'Provider saved. Restart this agent to apply it.', durationMs: 0,
          action: agent.id === 'main' ? undefined : {
            label: 'Restart now', run: async () => {
              await apiPost(`/api/agents/${encodeURIComponent(agent.id)}/restart`);
              pushToast({ tone: 'success', title: 'Agent restarting', description: 'Should be online again in a few seconds.' });
              setTimeout(onChange, 2500);
            },
          },
        });
      } else {
        pushToast({ tone: 'success', title: 'Provider saved', description: res.changed === false ? 'Already up to date.' : res.sessionReset ? 'The next message starts a new conversation with this provider.' : 'Takes effect on the next message.' });
      }
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Provider save failed', description: err?.body?.error || err?.message || String(err), durationMs: 7000 });
    } finally { setBusy(false); }
  }

  return (
    <div class="w-full max-w-[880px] mx-auto">
      <div class="mb-5">
        <h3 class="text-[14px] font-semibold text-[var(--color-text)]">Provider & model</h3>
        <p class="mt-1 text-[12px] text-[var(--color-text-muted)]">Choose the runtime for this agent, then tune its model and behavior.</p>
      </div>
      {providerStatus.error && <p role="alert" class="mb-3 text-[12px] text-[var(--color-status-failed)]">Could not load providers. <button type="button" onClick={providerStatus.refresh} class="underline">Retry</button></p>}
      <fieldset disabled={busy} class="min-w-0">
        <ProviderConfigEditor key={version} value={saved ?? agent.provider} fallbackModel={saved ? saved.model : agent.model}
          providers={providerStatus.data?.providers} onSave={save} busy={busy}
          variant="settings"
          onReset={() => { setVersion((v) => v + 1); onStateChange({ dirty: false, busy: false }); }}
          onStateChange={onStateChange} />
      </fieldset>
    </div>
  );
}
