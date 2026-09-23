import { apiPost, ApiError } from '@/lib/api';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useFetch } from '@/lib/useFetch';

export interface ProviderConfig {
  type: 'openrouter' | 'claude' | 'opencode' | 'gemini' | 'acp-codex' | 'openai' | 'acp' | 'anthropic-compatible';
  model?: string;
  baseUrl?: string;
  runtimeMode?: string;
  thinkingMode?: string;
  command?: string;
  args?: string[];
}

interface ProviderModelOption { id: string; label: string; free?: boolean; }
interface ProviderModelsResponse {
  provider: string;
  models: ProviderModelOption[];
  defaultModel: string;
  selectable: boolean;
  allowCustom?: boolean;
  note?: string;
}
interface ProviderRuntimeOption { id: string; label: string; current?: boolean; }
interface ProviderRuntimeOptionsResponse {
  provider: string;
  modeLabel?: string;
  thinkingLabel?: string;
  modeOptions: ProviderRuntimeOption[];
  thinkingOptions: ProviderRuntimeOption[];
  source: 'provider' | 'fallback' | 'static';
  error?: string;
}

type ProviderEditorVariant = 'compact' | 'settings';

const PROVIDER_DETAILS: Record<ProviderConfig['type'], { summary: string; runtime: string }> = {
  claude: {
    summary: 'Claude models for tool-supported agent tasks.',
    runtime: 'Bundled SDK',
  },
  openai: {
    summary: 'OpenAI models with model-specific reasoning controls.',
    runtime: 'Native SDK',
  },
  'anthropic-compatible': {
    summary: 'GLM models with agent tools. Uses one shared Z.ai API key.',
    runtime: 'API endpoint',
  },
  'acp-codex': {
    summary: 'Run Codex through the local ACP command-line bridge.',
    runtime: 'ACP bridge',
  },
  gemini: {
    summary: 'Run Gemini through its local ACP command-line bridge.',
    runtime: 'ACP bridge',
  },
  opencode: {
    summary: 'Run OpenCode through its local ACP command-line bridge.',
    runtime: 'ACP bridge',
  },
  openrouter: {
    summary: 'A hosted model catalog for chat. No tools, and each message starts a fresh session.',
    runtime: 'Hosted routing',
  },
  acp: {
    summary: 'Connect any local ACP-compatible command and pass your own arguments.',
    runtime: 'Local command',
  },
};

export type ProviderTier = 'stable' | 'experimental';
export interface ProviderOption {
  type: ProviderConfig['type'];
  label: string;
  tier: ProviderTier;
}

// The set of selectable providers comes from /api/provider/status (registry-
// driven, grouped by tier). Claude is always present as the safe fallback.
const CLAUDE_ONLY: ProviderOption[] = [{ type: 'claude', label: 'Claude', tier: 'stable' }];

function normalizeProviderType(
  nextType: ProviderConfig['type'],
  providers: ProviderOption[],
): ProviderConfig['type'] {
  return providers.some((p) => p.type === nextType) ? nextType : 'claude';
}

export function ProviderConfigEditor({
  value,
  fallbackModel,
  providers,
  onChange,
  onSave,
  onReset,
  onStateChange,
  saveLabel = 'Save provider',
  busy = false,
  variant = 'compact',
}: {
  value?: ProviderConfig;
  fallbackModel?: string;
  /** Selectable providers from /api/provider/status. Undefined = still loading
   *  — the editor must NOT snap the saved type to claude before the list
   *  arrives, or a fast Save persists the wrong provider. */
  providers?: ProviderOption[];
  onChange?: (provider: ProviderConfig) => void;
  onSave?: (provider: ProviderConfig) => void | Promise<void>;
  onReset?: () => void;
  onStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
  saveLabel?: string;
  busy?: boolean;
  /** The settings view uses the available width for a provider guide. Wizards
   * keep the compact, single-column selector. */
  variant?: ProviderEditorVariant;
}) {
  const loaded = providers !== undefined;
  const availableProviders = providers && providers.length > 0 ? providers : CLAUDE_ONLY;
  const initial = value ?? { type: 'claude' as const };
  const [type, setType] = useState<ProviderConfig['type']>(initial.type);
  const [modelSort, setModelSort] = useState('most-popular');
  const [modelSearch, setModelSearch] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const models = useFetch<ProviderModelsResponse>('/api/providers/models?provider=' + encodeURIComponent(type) + (type === 'openrouter' ? '&sort=' + modelSort : ''), 0);
  const keyProvider = type === 'openrouter' ? 'OpenRouter' : 'Z.ai';
  const keyEndpoint = type === 'openrouter' ? '/api/providers/openrouter/setup' : '/api/providers/zai/setup';
  const usesKeySetup = type === 'anthropic-compatible' || type === 'openrouter';
  const zai = useFetch<{ configured: boolean; enabled: boolean; ready: boolean; canEdit: boolean; legacyKey: boolean; message: string }>(usesKeySetup ? keyEndpoint + (type === 'anthropic-compatible' && value?.baseUrl ? '?baseUrl=' + encodeURIComponent(value.baseUrl) : '') : null, 0);
  const [apiKey, setApiKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  async function saveKey(migrate = false) {
    setKeyBusy(true); setKeyMessage('');
    try {
      await apiPost(keyEndpoint, migrate ? { migrate: true } : { apiKey });
      setApiKey(''); setEditingKey(false);
      setKeyMessage(type === 'openrouter' ? 'Key saved. OpenRouter will use it on the next turn.' : 'Key saved. Restart other running agents that use Z.ai to load the change.');
      zai.refresh();
    } catch (err) {
      setKeyMessage(err instanceof ApiError ? (err.body as { error?: string })?.error ?? 'Could not save key.' : 'Could not save key.');
    } finally { setKeyBusy(false); }
  }
  const [model, setModel] = useState(initial.model ?? fallbackModel ?? '');
  const [customModel, setCustomModel] = useState('');
  const [runtimeMode, setRuntimeMode] = useState(initial.runtimeMode ?? '');
  const [thinkingMode, setThinkingMode] = useState(initial.thinkingMode ?? '');
  const [command, setCommand] = useState(initial.command ?? '');
  const [args, setArgs] = useState((initial.args ?? []).join(' '));
  const dirtyRef = useRef(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    onStateChange?.({ dirty: touched || apiKey.length > 0, busy: busy || keyBusy });
  }, [touched, apiKey, busy, keyBusy, onStateChange]);

  const runtimeOptionsPath = type === 'acp' && !command.trim()
    ? null
    : '/api/providers/runtime-options?provider='
      + encodeURIComponent(type)
      + (model && model !== '__custom__' ? '&model=' + encodeURIComponent(model) : '')
      + (type === 'acp' ? '&command=' + encodeURIComponent(command.trim()) + '&args=' + encodeURIComponent(args) : '');
  const runtimeOptions = useFetch<ProviderRuntimeOptionsResponse>(runtimeOptionsPath, 0);

  function markDirty() {
    dirtyRef.current = true;
    setTouched(true);
  }

  function providerPayload(): ProviderConfig {
    const selectedModel = model === '__custom__' ? customModel.trim() : model.trim();
    const provider: ProviderConfig = { type };
    if (type === 'anthropic-compatible' && value?.baseUrl) provider.baseUrl = value.baseUrl;
    if (selectedModel && selectedModel !== 'provider-default') provider.model = selectedModel;
    if (runtimeMode) provider.runtimeMode = runtimeMode;
    if (thinkingMode) provider.thinkingMode = thinkingMode;
    if (type === 'acp') {
      provider.command = command.trim();
      provider.args = splitArgs(args);
    }
    return provider;
  }

  const providerKey = loaded ? availableProviders.map((p) => p.type).join(',') : 'loading';

  useEffect(() => {
    if (dirtyRef.current) return;
    const next = value ?? { type: 'claude' as const };
    // Before the provider list loads, keep the saved type verbatim; normalize
    // only against a real list.
    setType(loaded ? normalizeProviderType(next.type, availableProviders) : next.type);
    setModel(next.model ?? fallbackModel ?? '');
    setRuntimeMode(next.runtimeMode ?? '');
    setThinkingMode(next.thinkingMode ?? '');
    setCommand(next.command ?? '');
    setArgs((next.args ?? []).join(' '));
  }, [providerKey, value?.type, value?.model, value?.runtimeMode, value?.thinkingMode, value?.command, JSON.stringify(value?.args ?? []), fallbackModel]);

  useEffect(() => {
    if (!loaded) return;
    if (normalizeProviderType(type, availableProviders) !== type) {
      setType('claude');
      setModel('');
      setCustomModel('');
    }
  }, [providerKey, type]);

  useEffect(() => {
    if (models.data?.provider !== type) return;
    const defaultModel = models.data?.defaultModel;
    if (!defaultModel) return;
    const available = models.data?.models ?? [];
    setModel((existing) => {
      if (!existing) return defaultModel;
      if (existing === '__custom__') return existing;
      if (available.some((m) => m.id === existing)) return existing;
      if (models.data?.allowCustom) {
        setCustomModel(existing);
        return '__custom__';
      }
      return defaultModel;
    });
  }, [type, models.data?.provider, models.data?.defaultModel, models.data?.allowCustom, JSON.stringify(models.data?.models ?? [])]);

  useEffect(() => {
    if (runtimeOptions.data?.provider !== type) return;
    const modeOptions = runtimeOptions.data?.modeOptions ?? [];
    const thinkingOptions = runtimeOptions.data?.thinkingOptions ?? [];
    setRuntimeMode((existing) => {
      if (!modeOptions.length) return '';
      if (existing && modeOptions.some((option) => option.id === existing)) return existing;
      return modeOptions.find((option) => option.current)?.id ?? modeOptions[0].id;
    });
    setThinkingMode((existing) => {
      if (!thinkingOptions.length) return '';
      if (existing && thinkingOptions.some((option) => option.id === existing)) return existing;
      return thinkingOptions.find((option) => option.current)?.id ?? thinkingOptions[0].id;
    });
  }, [type, runtimeOptions.data?.provider, JSON.stringify(runtimeOptions.data?.modeOptions ?? []), JSON.stringify(runtimeOptions.data?.thinkingOptions ?? [])]);

  useEffect(() => {
    onChange?.(providerPayload());
  }, [type, model, customModel, runtimeMode, thinkingMode, command, args]);

  // Stable providers (Claude, OpenAI) first, then the experimental tier.
  const stableOptions = availableProviders.filter((p) => p.tier === 'stable');
  const experimentalOptions = availableProviders.filter((p) => p.tier === 'experimental');
  const onlyStable = experimentalOptions.length === 0;

  const filteredModels = (models.data?.models ?? []).filter((m) => type !== 'openrouter' || ((!freeOnly || m.free === true) && (m.id + ' ' + m.label).toLowerCase().includes(modelSearch.trim().toLowerCase())));
  const selectedOutsideFilter = model && model !== '__custom__' && !filteredModels.some((m) => m.id === model);

  function chooseProvider(nextType: ProviderConfig['type']) {
    if (nextType === type) return;
    setType(normalizeProviderType(nextType, availableProviders));
    setModel('');
    setCustomModel('');
    setModelSearch('');
    setFreeOnly(false);
    setApiKey('');
    setKeyMessage('');
    setEditingKey(false);
    setRuntimeMode('');
    setThinkingMode('');
    markDirty();
  }

  const selectedProvider = availableProviders.find((provider) => provider.type === type);
  const selectedDetails = PROVIDER_DETAILS[type];
  const settingsView = variant === 'settings';

  return (
    <div class={settingsView ? 'grid gap-5 lg:grid-cols-[minmax(250px,0.82fr)_minmax(0,1.45fr)] lg:items-start' : 'space-y-3'}>
      <section class={settingsView ? 'rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)]/35 p-3.5' : ''}>
        {settingsView && (
          <div class="mb-3">
            <h4 class="text-[12.5px] font-semibold text-[var(--color-text)]">Choose a provider</h4>
            <p class="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">Stable providers are the default tier. Experimental providers may require additional setup.</p>
          </div>
        )}
        {!settingsView ? <EditorField label="Provider">
        <select
          aria-label="Provider"
          value={type}
          disabled={!loaded || keyBusy}
          onChange={(event) => {
            chooseProvider((event.currentTarget as HTMLSelectElement).value as ProviderConfig['type']);
          }}
          class="w-full h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-[12.5px] text-[var(--color-text)] disabled:opacity-60"
        >
          {!loaded
            ? <option value={type}>{type}</option>
            : onlyStable
              ? stableOptions.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)
              : (
                <>
                  <optgroup label="Stable">
                    {stableOptions.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
                  </optgroup>
                  <optgroup label="Experimental (beta)">
                    {experimentalOptions.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
                  </optgroup>
                </>
              )}
        </select>
        {loaded && !availableProviders.some((p) => ['acp', 'acp-codex', 'gemini', 'opencode', 'openrouter'].includes(p.type)) && (
          <div class="text-[12px] text-[var(--color-text-muted)] mt-1">
            Experimental providers (ACP: Gemini, OpenCode, Codex-ACP, custom) are hidden. Set ENABLE_ACP=true in .env to enable them.
          </div>
        )}
        </EditorField> : (
          <>
            <div class="lg:hidden">
              <EditorField label="Provider">
                <select aria-label="Provider" value={type} disabled={!loaded || keyBusy}
                  onChange={(event) => chooseProvider((event.currentTarget as HTMLSelectElement).value as ProviderConfig['type'])}
                  class="w-full h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2.5 text-[12.5px] text-[var(--color-text)] disabled:opacity-60">
                  {!loaded
                    ? <option value={type}>{type}</option>
                    : onlyStable
                      ? stableOptions.map((provider) => <option key={provider.type} value={provider.type}>{provider.label}</option>)
                      : <><optgroup label="Stable">{stableOptions.map((provider) => <option key={provider.type} value={provider.type}>{provider.label}</option>)}</optgroup><optgroup label="Experimental">{experimentalOptions.map((provider) => <option key={provider.type} value={provider.type}>{provider.label}</option>)}</optgroup></>}
                </select>
              </EditorField>
              <div class="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)]/50 px-3 py-2.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[12px] font-medium text-[var(--color-text)]">{selectedProvider?.label ?? type}</span>
                  {selectedProvider && <span class="text-[9px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{selectedProvider.tier}</span>}
                </div>
                <p class="mt-1 text-[10.5px] leading-snug text-[var(--color-text-muted)]">{selectedDetails.summary}</p>
              </div>
            </div>
            <div role="group" aria-label="Provider choices"
              style={{ maxHeight: 'clamp(160px, calc(var(--app-height) - 380px), 420px)' }}
              class="hidden space-y-1.5 lg:block lg:overflow-y-auto lg:pr-1">
              {!loaded && (
                <div class="rounded-md border border-[var(--color-border)] px-3 py-2.5 text-[12px] text-[var(--color-text-muted)]">Loading providers…</div>
              )}
              {loaded && availableProviders.map((provider) => {
                const active = provider.type === type;
                const details = PROVIDER_DETAILS[provider.type];
                return (
                  <button key={provider.type} type="button" data-provider={provider.type} aria-label={`Use ${provider.label}`} aria-pressed={active}
                    disabled={keyBusy} onClick={() => chooseProvider(provider.type)}
                    class={`control-button w-full rounded-md border px-3 py-2.5 text-left transition-colors ${active ? 'control-accent' : 'border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-control-hover)]'}`}>
                    <span class="flex items-center justify-between gap-2">
                      <span class={`text-[12.5px] font-medium ${active ? 'text-[var(--color-control-text)]' : 'text-[var(--color-text)]'}`}>{provider.label}</span>
                      <span class={`rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${provider.tier === 'stable' ? 'bg-[color-mix(in_srgb,var(--color-status-done)_16%,transparent)] text-[var(--color-status-done)]' : 'bg-[color-mix(in_srgb,var(--color-status-running)_16%,transparent)] text-[var(--color-status-running)]'}`}>{provider.tier}</span>
                    </span>
                    <span class="mt-1 block text-[10.5px] leading-snug text-[var(--color-text-muted)]">{details.summary}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {settingsView && loaded && !availableProviders.some((p) => ['acp', 'acp-codex', 'gemini', 'opencode', 'openrouter'].includes(p.type)) && (
          <p class="mt-3 border-t border-[var(--color-border)] pt-3 text-[10.5px] leading-relaxed text-[var(--color-text-muted)]">Additional ACP providers are hidden. Set <span class="font-mono">ENABLE_ACP=true</span> in <span class="font-mono">.env</span> to make them available.</p>
        )}
      </section>

      <div class={settingsView ? 'min-w-0 space-y-4' : 'contents'}>
      <section class={settingsView ? 'space-y-3 rounded-lg border border-[var(--color-border)] p-4' : 'contents'}>
        {settingsView && (
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] pb-3">
            <div>
              <h4 class="text-[13px] font-semibold text-[var(--color-text)]">{selectedProvider?.label ?? type} configuration</h4>
              <p class="mt-0.5 text-[11px] text-[var(--color-text-muted)]">Select the model and provider-specific runtime options.</p>
            </div>
            <span class="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-1 text-[10.5px] text-[var(--color-text-muted)]">{selectedDetails.runtime}</span>
          </div>
        )}

      {usesKeySetup && <p class="text-[12px] leading-relaxed text-[var(--color-text-muted)]">{type === 'openrouter' ? 'Chat only, without tools. Each message starts fresh; saved memory still applies.' : 'Run GLM with this agent’s permitted tools.'} One API key serves all agents using {keyProvider}.</p>}
      {usesKeySetup && (
        <div class="space-y-2 rounded-md border border-[var(--color-border)] p-3 text-[12px]">
          <div class="flex items-center justify-between gap-3">
            <span class="font-medium">API key</span>
            <div class="flex items-center gap-3"><span class="text-[var(--color-text-muted)]">{zai.loading ? 'Checking...' : zai.data?.configured ? 'Key saved' : 'Setup required'}</span>
            {zai.data?.configured && zai.data.canEdit && !editingKey && <button type="button" onClick={() => setEditingKey(true)} class="rounded px-2 py-1 hover:bg-[var(--color-control-hover)]">Replace API key</button>}</div>
          </div>

          {!zai.loading && (!zai.data?.ready || !zai.data?.canEdit) && <p>{zai.data?.message}</p>}
          {zai.error && <p role="alert">Could not load setup. <button type="button" onClick={zai.refresh}>Retry</button></p>}
          {zai.data?.canEdit && (!zai.data.configured || editingKey) && (
            <>
              <a href={type === 'openrouter' ? 'https://openrouter.ai/keys' : 'https://z.ai/manage-apikey/apikey-list'} target="_blank" rel="noopener noreferrer" class="underline">Get a {keyProvider} API key</a>
              <input type="password" disabled={keyBusy} value={apiKey} autoComplete="new-password" aria-label={keyProvider + ' API key'} placeholder={zai.data.configured ? 'Enter a replacement key' : 'Paste your ' + keyProvider + ' API key'} onInput={(event) => setApiKey((event.currentTarget as HTMLInputElement).value)} class="w-full rounded border border-[var(--color-border)] bg-[var(--color-elevated)] p-2" />
              <button type="button" disabled={keyBusy || !apiKey} onClick={() => saveKey()} class="underline disabled:opacity-50">{keyBusy ? 'Saving...' : 'Save key'}</button>
              {zai.data.legacyKey && <button type="button" disabled={keyBusy} onClick={() => saveKey(true)} class="ml-3 underline">Migrate existing key to ZAI_API_KEY</button>}
              <p class="text-[var(--color-text-muted)]">Stored privately in the server’s .env. Saved keys are never displayed.</p>
              {zai.data.configured && <button type="button" onClick={() => { setEditingKey(false); setApiKey(''); }} class="ml-3 underline">Cancel</button>}
            </>
          )}
          {zai.data && !zai.data.ready && <button type="button" onClick={zai.refresh} class="underline">Check setup again</button>}
          {keyMessage && <p role="status">{keyMessage}</p>}
        </div>
      )}
      {type === 'openrouter' && (
        <div class="space-y-2 text-[12px]">
          <input type="search" aria-label="Search models" placeholder="Search models" value={modelSearch} onInput={(event) => setModelSearch(event.currentTarget.value)} class="w-full rounded border border-[var(--color-border)] bg-[var(--color-elevated)] p-2" />
          <div class="flex items-center justify-between gap-3 flex-wrap">
          <label class="flex items-center gap-2">Sort
            <select aria-label="Sort models" value={modelSort} onChange={(event) => setModelSort(event.currentTarget.value)} class="rounded border border-[var(--color-border)] bg-[var(--color-elevated)] p-1">
              <option value="most-popular">Popular</option>
              <option value="newest">Newest</option>
              <option value="pricing-low-to-high">Cheapest first</option>
            </select>
          </label>
          <label class="flex items-center gap-2"><input type="checkbox" checked={freeOnly} onChange={(event) => setFreeOnly(event.currentTarget.checked)} />Free only</label>
          <span class="text-[var(--color-text-muted)]">{filteredModels.length} matches</span>
          </div>
          {selectedOutsideFilter && <p class="text-[var(--color-text-muted)]">Selected model kept below</p>}
        </div>
      )}

      <EditorField label="Model">
        <select
          aria-label="Model"
          value={model}
          onChange={(event) => { setModel((event.currentTarget as HTMLSelectElement).value); markDirty(); }}
          disabled={models.loading}
          class="w-full h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-[12.5px] text-[var(--color-text)] disabled:opacity-60"
        >
          {models.loading && <option value="">Loading models...</option>}
          {!models.loading && !models.data && <option value="">Models unavailable</option>}
          {selectedOutsideFilter && <option value={model}>{model} (selected)</option>}
          {filteredModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          {models.data?.allowCustom && <option value="__custom__">Custom model...</option>}
        </select>
        {models.error && <p role="alert" class="text-[12px]">Could not load models. <button type="button" onClick={models.refresh}>Retry</button></p>}
        {model === '__custom__' && (
          <input
            type="text"
            value={customModel}
            onInput={(event) => { setCustomModel((event.currentTarget as HTMLInputElement).value); markDirty(); }}
            placeholder="model-id"
            aria-label="Custom model"
            class="mt-1.5 w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        )}
        {models.data?.note && !usesKeySetup && <div class="text-[12px] text-[var(--color-text-muted)] mt-1 leading-snug">{models.data.note}</div>}
      </EditorField>

      {(runtimeOptions.data?.modeOptions?.length ?? 0) > 0 && (
        <EditorField label={runtimeOptions.data?.modeLabel ?? 'Agent speed'}>
          <SegmentedControl
            value={runtimeMode}
            options={(runtimeOptions.data?.modeOptions ?? []).map((option) => ({ value: option.id, label: option.label }))}
            onChange={(next) => { setRuntimeMode(next); markDirty(); }}
          />
        </EditorField>
      )}

      {(runtimeOptions.data?.thinkingOptions?.length ?? 0) > 0 && (
        <EditorField label={runtimeOptions.data?.thinkingLabel ?? 'Thinking'}>
          <SegmentedControl
            value={thinkingMode}
            options={(runtimeOptions.data?.thinkingOptions ?? []).map((option) => ({ value: option.id, label: option.label }))}
            onChange={(next) => { setThinkingMode(next); markDirty(); }}
          />
        </EditorField>
      )}

      {runtimeOptions.loading && <div class="text-[11px] text-[var(--color-text-muted)]">Checking provider runtime options...</div>}
      {runtimeOptions.data?.source === 'fallback' && runtimeOptions.data.error && (
        <div class="text-[11px] text-[var(--color-text-muted)] leading-snug">Using fallback options: {runtimeOptions.data.error}</div>
      )}

      {type === 'acp' && (
        <>
          <EditorField label="Command">
            <input
              type="text"
              value={command}
              onInput={(event) => { setCommand((event.currentTarget as HTMLInputElement).value); markDirty(); }}
              placeholder="my-acp-agent"
              aria-label="Command"
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </EditorField>
          <EditorField label="Arguments" hint="Shell-style quoting is supported for simple args.">
            <input
              type="text"
              value={args}
              onInput={(event) => { setArgs((event.currentTarget as HTMLInputElement).value); markDirty(); }}
              placeholder="--acp"
              aria-label="Arguments"
              class="w-full bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-1.5 text-[12.5px] font-mono text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
          </EditorField>
        </>
      )}
      </section>

      {onSave && (
        <div class={`flex flex-wrap items-center justify-end gap-2 ${settingsView ? 'rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)]/35 p-3' : 'pt-3 border-t border-[var(--color-border)]'}`}>
          {apiKey && <p class="w-full text-[12px] text-[var(--color-text-muted)]">Save or clear the API key draft before saving the provider.</p>}
          {onReset && <button type="button" onClick={onReset} disabled={busy || keyBusy || (!touched && !apiKey)} class="px-3 py-1.5 rounded-md text-[12px] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40">Reset</button>}
          <button
            type="button"
            onClick={() => onSave(providerPayload())}
            disabled={busy || keyBusy || !!apiKey || !loaded || models.loading || !!models.error || !models.data || !(model === '__custom__' ? customModel.trim() : model.trim()) || (usesKeySetup && (!zai.data?.ready || zai.loading || !!zai.error))}
            class="control-button px-3 py-1.5 rounded-md text-[12px] font-medium control-accent disabled:opacity-60"
          >
            {busy ? 'Saving...' : saveLabel}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}

function EditorField({ label, hint, children }: { label: string; hint?: string; children: any }) {
  return (
    <div>
      <label class="block text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{label}</label>
      {children}
      {hint && <div class="text-[12px] text-[var(--color-text-muted)] mt-1">{hint}</div>}
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div class="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] p-0.5 flex-wrap">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            class={[
              'control-button px-2.5 py-1 rounded text-[12px] font-medium transition-colors',
              active
                ? 'control-accent'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function splitArgs(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ''));
}
