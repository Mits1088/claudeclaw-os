import { useState, useEffect, useRef } from 'preact/hooks';
import { Plus, Power, RotateCcw, Trash2, Copy, Check, Lightbulb, RefreshCw, Settings2 } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { AgentStatusBadge } from '@/components/Pill';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { ProviderConfigEditor, type ProviderConfig, type ProviderOption } from '@/components/ProviderConfigEditor';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AgentSettings, type AgentSettingsSection } from '@/components/AgentSettings';
import { AgentSuggestionBadge, AgentSuggestionModal, useAgentSuggestions, type AgentSuggestion } from '@/components/AgentSuggestions';
import { useFetch } from '@/lib/useFetch';
import { useDebouncedValue } from '@/lib/useDebounce';
import { apiPost, apiPatch, apiDelete } from '@/lib/api';
import { formatCost } from '@/lib/format';
import { showCosts } from '@/lib/theme';
import { pushToast } from '@/lib/toasts';
import { modelLabel } from '@/lib/modelLabels';

interface RuntimeOption { id: string; label: string; }

interface Agent {
  id: string;
  name: string;
  description: string;
  model: string;
  provider: ProviderConfig;
  running: boolean;
  todayTurns: number;
  todayCost: number;
  runtimeMode?: string;
  thinkingMode?: string;
  runtimeOptions?: {
    modeLabel?: string;
    thinkingLabel?: string;
    modeOptions: Array<{ id: string; label: string }>;
    thinkingOptions: Array<{ id: string; label: string }>;
  } | null;
}

interface Template { id: string; name: string; description: string; }

export function Agents() {
  const { data, loading, error, refresh } = useFetch<{ agents: Agent[]; claudeModels?: RuntimeOption[]; openaiModels?: RuntimeOption[] }>('/api/agents', 30_000);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settings, setSettings] = useState<Agent | null>(null);
  const [settingsSection, setSettingsSection] = useState<AgentSettingsSection>('overview');
  const [openedSuggestion, setOpenedSuggestion] = useState<AgentSuggestion | null>(null);
  const [suggestionPrefill, setSuggestionPrefill] = useState<AgentSuggestion | null>(null);
  const [refreshingSuggestions, setRefreshingSuggestions] = useState(false);
  const suggestionsFetch = useAgentSuggestions();
  const suggestions = suggestionsFetch.data?.suggestions ?? [];
  const agents = data?.agents ?? [];

  async function refreshSuggestions() {
    setRefreshingSuggestions(true);
    try {
      const res = await apiPost<{ inserted: number; skipped: number; reason?: string }>('/api/agents/suggestions/refresh');
      suggestionsFetch.refresh();
      if (res.reason) {
        pushToast({ tone: 'warn', title: 'Not enough activity yet', description: res.reason, durationMs: 6000 });
      } else if (res.inserted === 0) {
        pushToast({ tone: 'success', title: 'No new suggestions', description: 'Your agents look well-scoped.' });
      } else {
        pushToast({
          tone: 'success',
          title: `${res.inserted} suggestion${res.inserted === 1 ? '' : 's'}`,
          description: 'Look for the lightbulb icon on each agent card.',
        });
      }
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Refresh failed', description: err?.message || String(err), durationMs: 7000 });
    } finally { setRefreshingSuggestions(false); }
  }

  function actOnSuggestion(s: AgentSuggestion) {
    setOpenedSuggestion(null);
    setSuggestionPrefill(s);
    setWizardOpen(true);
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Agents"
        actions={
          <>
            <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums mr-2">
              {agents.filter((a) => a.running).length} online · {agents.length} total
            </span>
            {suggestions.length > 0 ? (
              // Cached on mount via useAgentSuggestions — clicking is
              // INSTANT, not a scan. Opens the first suggestion's modal
              // directly. The refresh icon next to it is the only path
              // that triggers Haiku.
              <div class="inline-flex">
                <button
                  type="button"
                  onClick={() => setOpenedSuggestion(suggestions[0])}
                  title={`View ${suggestions.length} active suggestion${suggestions.length === 1 ? '' : 's'}`}
                  class="control-button inline-flex items-center gap-1 px-2.5 py-1.5 rounded-l text-[12px] border border-r-0 transition-colors control-accent"
                >
                  <Lightbulb size={13} />
                  {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'}
                </button>
                <button
                  type="button"
                  onClick={refreshSuggestions}
                  disabled={refreshingSuggestions}
                  title="Re-scan hive_mind for new suggestions (~30–90s)"
                  class="control-button inline-flex items-center justify-center px-2 py-1.5 rounded-r text-[12px] border control-accent disabled:opacity-40 transition-colors"
                >
                  <RefreshCw size={12} class={refreshingSuggestions ? 'animate-spin' : ''} />
                </button>
              </div>
            ) : (
              // No active suggestions — only path is the explicit scan.
              <button
                type="button"
                onClick={refreshSuggestions}
                disabled={refreshingSuggestions}
                title="Scan hive_mind for agents that should be split (~30–90s)"
                class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] border border-[var(--color-border)] transition-colors disabled:opacity-40"
              >
                <Lightbulb size={13} />
                {refreshingSuggestions ? 'Scanning…' : 'Scan for suggestions'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              class="control-button inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium control-accent transition-colors"
            >
              <Plus size={14} /> New Agent
            </button>
          </>
        }
      />

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}
      {!loading && !error && agents.length === 0 && (
        <PageState empty emptyTitle="No agents configured" emptyDescription="Click New Agent to create your first one." />
      )}

      {agents.length > 0 && (
        <div class="flex-1 overflow-y-auto p-3 sm:p-6 min-w-0">
          <div
            class="grid gap-3 items-stretch min-w-0"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}
          >
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                catalog={(a.provider?.type === 'openai' ? data?.openaiModels : a.provider?.type === 'claude' ? data?.claudeModels : []) ?? []}
                onChange={refresh}
                onOpen={(section = 'overview') => { setSettingsSection(section); setSettings(a); }}
                suggestions={suggestions}
                onOpenSuggestion={(s) => setOpenedSuggestion(s)}
              />
            ))}
          </div>
        </div>
      )}

      <CreateAgentWizard
        open={wizardOpen}
        onClose={() => { setWizardOpen(false); setSuggestionPrefill(null); }}
        onCreated={refresh}
        prefill={suggestionPrefill ? {
          id: suggestionPrefill.suggested_id,
          name: suggestionPrefill.suggested_name,
          description: suggestionPrefill.suggested_description,
        } : undefined}
      />
      {settings && <AgentSettings key={settings.id} agent={agents.find((a) => a.id === settings.id) ?? settings}
        initialSection={settingsSection} onClose={() => setSettings(null)} onChange={refresh} />}
      <AgentSuggestionModal
        suggestion={openedSuggestion}
        onClose={() => setOpenedSuggestion(null)}
        onActed={actOnSuggestion}
        onChange={suggestionsFetch.refresh}
      />
    </div>
  );
}

function AgentCard({ agent, catalog, onChange, onOpen, suggestions, onOpenSuggestion }: {
  agent: Agent;
  catalog: RuntimeOption[];
  onChange: () => void;
  onOpen: (section?: AgentSettingsSection) => void;
  suggestions: AgentSuggestion[];
  onOpenSuggestion: (s: AgentSuggestion) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function run(action: 'restart' | 'stop' | 'start' | 'delete') {
    if (action === 'delete' && !confirm(`Delete agent "${agent.id}"? This unloads the service, removes its config, deletes its bot token from .env, and removes log files.`)) return;
    setBusy(action);
    try {
      if (action === 'restart') await apiPost(`/api/agents/${agent.id}/restart`);
      if (action === 'stop') await apiPost(`/api/agents/${agent.id}/deactivate`);
      if (action === 'start') await apiPost(`/api/agents/${agent.id}/activate`);
      if (action === 'delete') await apiDelete(`/api/agents/${agent.id}/full`);
      setTimeout(onChange, action === 'delete' ? 200 : 1500);
    } catch (err: any) {
      alert(action + ' failed: ' + (err?.message || err));
    } finally {
      setBusy(null);
    }
  }

  const isMain = agent.id === 'main';

  return (
    <article
      role="group"
      aria-label={`${agent.name || agent.id} agent`}
      class="agent-card bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl overflow-hidden hover:border-[var(--color-border-strong)] transition-colors h-full min-w-0 flex flex-col"
    >
      <div class="agent-info-banner px-5 py-4 min-w-0 bg-[var(--color-agent-banner)]">
        <div class="flex items-center gap-3.5">
          <AgentAvatar agentId={agent.id} name={agent.name} size={52} />
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <h2 title={agent.name || agent.id} class="text-[16px] font-semibold tracking-tight text-[var(--color-text)] truncate">{agent.name || agent.id}</h2>
              {isMain && <span class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium bg-[var(--color-accent-soft)] text-[var(--color-accent)]">Main</span>}
              <AgentSuggestionBadge agentId={agent.id} suggestions={suggestions} onOpen={onOpenSuggestion} />
            </div>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
              <AgentStatusBadge running={agent.running} />
              <span aria-hidden="true" class="h-3 border-l border-[var(--color-border-strong)]" />
              <span aria-label="Agent activity summary" class="inline-flex items-center gap-1 text-[var(--color-text-faint)]">Turns today <span class="font-medium tabular-nums text-[var(--color-text-muted)]">{agent.todayTurns ?? 0}</span></span>
              {showCosts.value && <span class="text-[var(--color-text-faint)] tabular-nums">· {formatCost(agent.todayCost ?? 0)}</span>}
            </div>
          </div>
          <button type="button" onClick={() => onOpen()} title="Agent settings" aria-label={`Open settings for ${agent.name || agent.id}`}
            class="shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">
            <Settings2 size={17} />
          </button>
        </div>
      </div>
      <div class="px-5 py-3 flex-1 min-w-0 border-b border-[var(--color-border-strong)]">
        <p title={agent.description} class="text-[12px] text-[var(--color-text-muted)] leading-[1.65] line-clamp-2 min-h-[3.3em]">{agent.description || 'No description yet.'}</p>
      </div>
      <div class="px-5 py-4 min-w-0">
        <AgentCardControls agent={agent} catalog={catalog} onChange={onChange} onConfigureProvider={() => onOpen('provider')} />
      </div>
      <div class="flex items-center gap-2 border-t border-[var(--color-border)] px-5 py-3 bg-[var(--color-bg)]/30 min-h-[58px]">
        {isMain ? (
          <span class="text-[11px] text-[var(--color-text-faint)]">Start and stop from the host</span>
        ) : (
          <>
            <button type="button" onClick={() => run(agent.running ? 'stop' : 'start')} disabled={busy !== null}
              class={`control-button h-8 flex-1 inline-flex items-center justify-center gap-1.5 px-3 rounded-md text-[11px] border transition-colors disabled:opacity-40 ${agent.running ? 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)]' : 'control-accent'}`}>
              <Power size={13} />{busy === 'stop' ? 'Stopping…' : busy === 'start' ? 'Starting…' : agent.running ? 'Stop' : 'Start'}
            </button>
            <button type="button" onClick={() => run('restart')} disabled={busy !== null}
              class="h-8 flex-1 inline-flex items-center justify-center gap-1.5 px-3 rounded-md text-[11px] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] transition-colors disabled:opacity-40">
              <RotateCcw size={13} class={busy === 'restart' ? 'animate-spin' : ''} />{busy === 'restart' ? 'Restarting…' : 'Restart'}
            </button>
            <button type="button" onClick={() => run('delete')} disabled={busy !== null} title="Delete agent" aria-label={`Delete ${agent.name || agent.id}`}
              class="ml-1 h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md text-[var(--color-text-faint)] hover:text-[var(--color-status-failed)] hover:bg-[var(--color-control-hover)] transition-colors disabled:opacity-40">
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function AgentCardControls({ agent, catalog, onChange, onConfigureProvider }: {
  agent: Agent;
  catalog: RuntimeOption[];
  onChange: () => void;
  onConfigureProvider: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const options = agent.runtimeOptions;
  const fields = [
    { field: 'runtimeMode', label: options?.modeLabel || 'Effort', choices: options?.modeOptions, value: agent.runtimeMode ?? agent.provider?.runtimeMode ?? '' },
    { field: 'thinkingMode', label: options?.thinkingLabel || 'Thinking', choices: options?.thinkingOptions, value: agent.thinkingMode ?? agent.provider?.thinkingMode ?? '' },
  ].filter((field) => field.choices?.length);

  async function save(field: 'model' | 'runtimeMode' | 'thinkingMode', value: string) {
    if (value === '__custom__') { onConfigureProvider(); return; }
    const current = field === 'model' ? agent.model : fields.find((item) => item.field === field)?.value;
    if (saving.current || value === current) return;
    saving.current = true;
    setBusy(true);
    try {
      const result = await apiPatch<{ restartRequired?: boolean; cleared?: Array<{ label: string; value: string }> }>(
        `/api/agents/${agent.id}/${field === 'model' ? 'model' : 'runtime'}`, { [field]: value },
      );
      const notices = result.cleared?.map((item) => `${item.label} reset (${item.value} not supported)`) ?? [];
      if (result.restartRequired) notices.push(`Restart ${agent.name || agent.id} to apply.`);
      pushToast({ tone: 'success', title: field === 'model' ? 'Model saved' : 'Runtime setting saved', description: notices.join('; ') || 'Applies to the next message.' });
    } catch (err: any) {
      pushToast({ tone: 'error', title: 'Change failed', description: err?.message || String(err) });
    } finally {
      onChange();
      saving.current = false;
      setBusy(false);
    }
  }

  const controlClass = 'min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] text-[var(--color-text)] hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] transition-colors disabled:opacity-40';
  const selectable = (agent.provider?.type === 'claude' || agent.provider?.type === 'openai') && catalog.length > 0;

  const labelClass = 'block mb-1.5 text-[9px] uppercase tracking-wider text-[var(--color-text-faint)] truncate';

  return <div class="grid min-w-0 gap-2" style={{ gridTemplateColumns: fields.length === 2 ? 'minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr)' : `repeat(${fields.length + 1}, minmax(0, 1fr))` }} aria-busy={busy}>
    <div class="min-w-0">
      <button type="button" disabled={busy} onClick={onConfigureProvider}
        aria-label={`Configure provider for ${agent.name || agent.id}`} title="Change provider"
        class="block w-full min-w-0 rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-40">
        <span class={labelClass}>Model: {providerLabel(agent.provider)}</span>
      </button>
      {selectable ? <select aria-label="Model" title={`Model: ${modelLabel(agent.model)}`} value={agent.model} disabled={busy}
        onChange={(event) => save('model', event.currentTarget.value)} class={`${controlClass} w-full h-8 px-2 text-[11px] font-medium truncate`}>
        {!catalog.some((option) => option.id === agent.model) && <option value={agent.model}>{modelLabel(agent.model) || 'Provider default'}</option>}
        {catalog.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        <option value="__custom__">Custom…</option>
      </select> : <button type="button" disabled={busy} onClick={onConfigureProvider} aria-label={`Configure model for ${agent.name || agent.id}`}
        title={agent.model || 'Configure model'} class={`${controlClass} w-full h-8 px-2 text-left text-[11px] font-medium truncate`}>
        {modelLabel(agent.model) || 'Provider default'}
      </button>}
    </div>
    {fields.length > 0 && <div class="contents" aria-label="Agent runtime levels">
      {fields.map((field) => <label key={field.field} class="block min-w-0">
        <span class={labelClass}>{field.label === 'Reasoning effort' ? 'Effort' : field.label}</span>
        <select value={field.value} disabled={busy} aria-label={field.label}
          title={`${field.label}: ${field.choices?.find((choice) => choice.id === field.value)?.label ?? (field.value || 'Default')}`}
          onChange={(event) => save(field.field as 'runtimeMode' | 'thinkingMode', event.currentTarget.value)}
          class={`${controlClass} w-full h-8 px-2 text-[11px] font-medium truncate`}>
          {!field.choices?.some((choice) => choice.id === field.value) && <option value={field.value}>{field.value || 'Default'}</option>}
          {field.choices?.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </label>)}
    </div>}
  </div>;
}

function providerLabel(provider?: ProviderConfig): string {
  if (!provider) return 'Provider';
  if (provider.type === 'claude') return 'Claude';
  if (provider.type === 'opencode') return 'OpenCode';
  if (provider.type === 'gemini') return 'Gemini';
  if (provider.type === 'acp-codex') return 'Codex';
  if (provider.type === 'openai') return 'OpenAI';
  if (provider.type === 'openrouter') return 'OpenRouter';
  if (provider.type === 'anthropic-compatible') return 'Z.ai (GLM)';
  return 'ACP';
}

// ── Wizard ───────────────────────────────────────────────────────────

interface CreateAgentWizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Optional pre-fill from a suggestion ("spin off X" flow). When set,
   *  the wizard opens to step 1 with id/name/description already filled. */
  prefill?: { id: string; name: string; description: string };
}

function CreateAgentWizard({ open, onClose, onCreated, prefill }: CreateAgentWizardProps) {
  const [step, setStep] = useState(1);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const providerStatus = useFetch<{ provider?: ProviderConfig; model?: string; providers?: ProviderOption[] }>('/api/provider/status', 30_000);
  const [provider, setProvider] = useState<ProviderConfig>({ type: 'claude', model: 'claude-sonnet-4-6' });
  const [template, setTemplate] = useState('');
  const [botToken, setBotToken] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [createdSummary, setCreatedSummary] = useState<{ envKey: string; agentDir: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedId = useDebouncedValue(id, 350);
  const debouncedToken = useDebouncedValue(botToken, 600);

  // Apply suggestion-driven prefill when the wizard opens with one.
  // We watch on open transition to avoid clobbering user edits if they
  // tweak the prefilled fields before clicking Next.
  useEffect(() => {
    if (open && prefill) {
      setId(prefill.id);
      setName(prefill.name);
      setNameTouched(true); // suppress the auto-generate-name effect
      setDescription(prefill.description);
    }
  }, [open, prefill?.id]);

  // Reset on close.
  function close() {
    setStep(1); setId(''); setName(''); setNameTouched(false); setDescription('');
    setProvider(providerStatus.data?.provider ?? { type: 'claude', model: 'claude-sonnet-4-6' }); setTemplate(''); setBotToken('');
    setCreatedId(null); setCreatedSummary(null); setError(null);
    onClose();
  }

  // Live ID validation.
  const idCheck = useFetch<{ ok: boolean; error?: string }>(
    debouncedId ? `/api/agents/validate-id?id=${encodeURIComponent(debouncedId)}` : null
  );

  // Live token validation.
  const [tokenStatus, setTokenStatus] = useState<{ ok?: boolean; error?: string; username?: string } | null>(null);
  useEffect(() => {
    if (!debouncedToken || !debouncedToken.includes(':')) { setTokenStatus(null); return; }
    let cancelled = false;
    apiPost<{ ok: boolean; error?: string; botInfo?: { username?: string } }>('/api/agents/validate-token', { token: debouncedToken })
      .then((r) => { if (!cancelled) setTokenStatus({ ok: r.ok, error: r.error, username: r.botInfo?.username }); })
      .catch((e) => { if (!cancelled) setTokenStatus({ ok: false, error: e?.message || String(e) }); });
    return () => { cancelled = true; };
  }, [debouncedToken]);

  // Templates list.
  const templates = useFetch<{ templates: Template[] }>('/api/agents/templates');

  useEffect(() => {
    if (!open || !providerStatus.data?.provider) return;
    setProvider(providerStatus.data.provider);
  }, [open, providerStatus.data?.provider?.type, providerStatus.data?.provider?.model]);

  // Sync auto name from id when user hasn't edited name.
  if (!nameTouched && id && !name) {
    const auto = id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (name !== auto) setTimeout(() => setName(auto), 0);
  }

  const idValid = !!debouncedId && idCheck.data?.ok === true;
  const tokenValid = tokenStatus?.ok === true;
  const suggestedBotName = `ClaudeClaw ${name || 'Agent'}`;
  const suggestedBotUsername = `claudeclaw_${id || 'agent'}_bot`;

  async function create() {
    setCreating(true); setError(null);
    try {
      const res = await apiPost<any>('/api/agents/create', {
        id, name, description, provider, template, botToken,
      });
      setCreatedId(res.agentId);
      setCreatedSummary({ envKey: res.envKey, agentDir: res.agentDir });
      setStep(3);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally { setCreating(false); }
  }

  async function activate() {
    if (!createdId) return;
    setActivating(true); setError(null);
    try {
      const res = await apiPost<any>(`/api/agents/${createdId}/activate`);
      if (!res.ok) throw new Error(res.error || 'Activation failed');
      onCreated();
      setTimeout(close, 800);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally { setActivating(false); }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="New Agent"
      width={520}
      footer={
        <>
          {step === 1 && (
            <>
              <button type="button" onClick={close} class="px-3 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Cancel</button>
              <button
                type="button"
                onClick={() => { if (idValid && name && description) setStep(2); }}
                disabled={!idValid || !name || !description}
                class="control-button ml-auto px-3 py-1.5 rounded text-[12px] font-medium control-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next: Bot token →
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button type="button" onClick={() => setStep(1)} class="px-3 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">← Back</button>
              <button
                type="button"
                onClick={create}
                disabled={!tokenValid || creating}
                class="control-button ml-auto px-3 py-1.5 rounded text-[12px] font-medium control-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating…' : 'Create Agent'}
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <button type="button" onClick={close} class="control-button px-3 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">Close</button>
              <button
                type="button"
                onClick={activate}
                disabled={activating}
                class="control-button ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded text-[12px] font-medium control-accent transition-colors disabled:opacity-40"
              >
                <Power size={12} /> {activating ? 'Activating…' : 'Activate (start service)'}
              </button>
            </>
          )}
        </>
      }
    >
      <div class="flex items-center gap-2 mb-4 text-[10px] uppercase tracking-wider">
        {[1, 2, 3].map((n) => (
          <div key={n} class="flex items-center gap-2">
            <div
              class="w-5 h-5 rounded-full flex items-center justify-center font-semibold"
              style={{
                backgroundColor: step >= n ? 'var(--color-accent-soft)' : 'var(--color-elevated)',
                color: step >= n ? 'var(--color-accent)' : 'var(--color-text-faint)',
                fontSize: '10px',
              }}
            >
              {step > n ? '✓' : n}
            </div>
            <span class={step === n ? 'text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'}>
              {n === 1 ? 'Basics' : n === 2 ? 'Bot token' : 'Activate'}
            </span>
            {n < 3 && <span class="text-[var(--color-border)]">·</span>}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div class="space-y-3">
          <Field label="Agent ID" hint="Lowercase letters, numbers, dash/underscore. 30 chars max.">
            <input
              type="text"
              value={id}
              onInput={(e) => setId((e.target as HTMLInputElement).value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
              placeholder="research"
              autoFocus
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
            {debouncedId && idCheck.data && !idCheck.data.ok && (
              <div class="text-[var(--color-status-failed)] text-[11px] mt-1">{idCheck.data.error}</div>
            )}
            {debouncedId && idCheck.data?.ok && (
              <div class="text-[var(--color-status-done)] text-[11px] mt-1">✓ Available</div>
            )}
          </Field>

          <Field label="Display name">
            <input
              type="text"
              value={name}
              onInput={(e) => { setNameTouched(true); setName((e.target as HTMLInputElement).value); }}
              placeholder="Research"
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </Field>

          <Field label="Description" hint="What this agent is responsible for. Used by Gemini auto-assign.">
            <textarea
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={3}
              placeholder="Deep web research, competitive intel, trend research"
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] resize-none"
            />
          </Field>

          <div class="grid grid-cols-2 gap-3">
            <Field label="Template">
              <select
                value={template}
                onChange={(e) => setTemplate((e.target as HTMLSelectElement).value)}
                class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">Blank</option>
                {templates.data?.templates?.filter((t) => t.id !== '_template').map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
          </div>

          <div class="border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-card)]">
            <ProviderConfigEditor
              value={provider}
              fallbackModel={providerStatus.data?.model}
              providers={providerStatus.data?.providers}
              onChange={setProvider}
            />
          </div>
        </div>
      )}

      {step === 2 && (
        <div class="space-y-3">
          <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3 text-[12px] leading-relaxed">
            <div class="font-semibold text-[var(--color-text)] mb-2">Create the bot in Telegram</div>
            <ol class="list-decimal list-inside space-y-1 text-[var(--color-text-muted)]">
              <li>Open <span class="font-mono text-[var(--color-accent)]">@BotFather</span> in Telegram</li>
              <li>Send <span class="font-mono text-[var(--color-accent)]">/newbot</span></li>
              <li>
                Name it: <CopyButton text={suggestedBotName} />
              </li>
              <li>
                Username: <CopyButton text={suggestedBotUsername} />
              </li>
              <li>Copy the token BotFather returns</li>
              <li>
                Set a profile photo: send <span class="font-mono text-[var(--color-accent)]">/setuserpic</span> to BotFather, pick this bot, then upload an image. Skipping this is fine; the dashboard will fall back to initials.
              </li>
            </ol>
          </div>

          <Field label="Paste bot token">
            <input
              type="text"
              value={botToken}
              onInput={(e) => setBotToken((e.target as HTMLInputElement).value.trim())}
              placeholder="123456789:ABC..."
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
            {tokenStatus?.error && (
              <div class="text-[var(--color-status-failed)] text-[11px] mt-1">{tokenStatus.error}</div>
            )}
            {tokenStatus?.ok && tokenStatus.username && (
              <div class="text-[var(--color-status-done)] text-[11px] mt-1">✓ Verified: @{tokenStatus.username}</div>
            )}
          </Field>

          {error && <div class="text-[var(--color-status-failed)] text-[11px]">{error}</div>}
        </div>
      )}

      {step === 3 && createdId && (
        <div class="space-y-3 text-[12.5px]">
          <div class="text-[var(--color-status-done)] text-[14px] font-medium">✓ Agent created</div>
          <div class="bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3 space-y-1.5 font-mono text-[11px]">
            <div><span class="text-[var(--color-text-faint)]">id:</span> {createdId}</div>
            <div><span class="text-[var(--color-text-faint)]">env:</span> {createdSummary?.envKey}</div>
            <div><span class="text-[var(--color-text-faint)]">dir:</span> {createdSummary?.agentDir}</div>
          </div>
          <div class="text-[var(--color-text-muted)]">
            Click activate to install the launchd service and start the agent process. Once activated,
            send it a message in Telegram and you're live.
          </div>
          {error && <div class="text-[var(--color-status-failed)] text-[11px]">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: any }) {
  return (
    <div>
      <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] mb-1">{label}</label>
      {children}
      {hint && <div class="text-[10.5px] text-[var(--color-text-faint)] mt-1">{hint}</div>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      }}
      class="inline-flex items-center gap-1 font-mono text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
    >
      <span>{text}</span>
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}
