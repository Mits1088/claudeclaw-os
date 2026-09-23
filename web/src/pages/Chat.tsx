import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Send, Square, Sparkles, ArrowDown, CheckCircle2, AlertCircle, Loader2, ListChecks, Wrench } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { StatusDot } from '@/components/Pill';
import { useFetch } from '@/lib/useFetch';
import { apiGet, apiPost, chatId } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { formatCost, formatNumber } from '@/lib/format';
import { modelLabel } from '@/lib/modelLabels';
import { showCosts } from '@/lib/theme';
import { subscribeChatStream, chatStreamConnected, resetUnread } from '@/lib/chat-stream';
import { useAgentQuery } from '@/lib/agentQuery';

interface Turn { role: 'user' | 'assistant'; content: string; source?: string; created_at?: number; photoUrl?: string; photoCaption?: string; }
interface Agent { id: string; name: string; running: boolean; }
interface ProgressItem {
  id: string;
  description: string;
  progressKind?: string;
  status?: string;
  kind?: string;
  toolCallId?: string;
  locations?: Array<{ path: string; line?: number | null }>;
  planEntries?: Array<{ content: string; status: string; priority?: string }>;
  timestamp: number;
}

interface AgentTokens { todayCost: number; todayTurns: number; allTimeCost: number; }
interface Health { contextPct: number; turns: number; model: string; }

const QUICK_ACTIONS = [
  { label: 'Status update', prompt: "Quick status update: what are you working on right now?" },
  { label: "What's next", prompt: 'What should I focus on next based on context?' },
  { label: 'Plan today', prompt: 'What does my day look like today? What are the priorities?' },
  { label: 'Recent wins', prompt: 'What did I accomplish in the last 24 hours?' },
];

export function Chat() {
  const agents = useFetch<{ agents: Agent[] }>('/api/agents', 60_000);
  const [activeAgent, setActiveAgent] = useAgentQuery();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamConnected = chatStreamConnected.value;
  // Track whether the message list is scrolled near the bottom. Drives
  // the floating "scroll to latest" button and tells the auto-scroll
  // effect whether it's safe to jump on a new turn (we don't yank the
  // viewport while the user is reading older messages).
  const [atBottom, setAtBottom] = useState(true);

  function scrollToBottom(smooth = true) {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  // Live session info for the bar.
  const health = useFetch<Health>(`/api/health?chatId=${encodeURIComponent(chatId)}`, 30_000);
  const agentTokens = useFetch<AgentTokens>(
    activeAgent === 'all' ? null : `/api/agents/${encodeURIComponent(activeAgent)}/tokens`,
    30_000,
  );

  // Load conversation history for the active agent. Extracted so the SSE
  // reconnect handler below can re-fetch it too.
  const loadHistory = useCallback(() => {
    setLoading(true);
    const path = activeAgent === 'all'
      ? `/api/chat/history?chatId=${encodeURIComponent(chatId)}&limit=50`
      : `/api/agents/${encodeURIComponent(activeAgent)}/conversation?chatId=${encodeURIComponent(chatId)}&limit=50`;
    return apiGet<{ turns: Turn[] }>(path)
      // The history endpoint returns turns newest-first (ORDER BY id DESC).
      // The panel renders oldest-first (newest at the bottom) and live SSE
      // events append to the end, so reverse to match. Without this a history
      // reload (revisiting the page, or the SSE-reconnect backfill above)
      // renders the conversation upside down.
      .then((d) => setTurns((d.turns || []).slice().reverse()))
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  }, [activeAgent]);

  // Load history on mount and whenever the active agent changes.
  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Backfill on SSE reconnect. chat-stream.ts auto-reconnects after a drop
  // (laptop sleep, network blip, backgrounded tab) and toggles
  // chatStreamConnected, but messages exchanged during the gap were never
  // streamed and would otherwise be a silent hole in the panel. On a
  // reconnect — not the initial connect — re-fetch history. A ref holds the
  // latest loader so this effect fires only on connectivity changes, never on
  // agent changes (already handled by the mount effect), avoiding a double load.
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;
  const hasConnectedOnce = useRef(false);
  useEffect(() => {
    if (!streamConnected) return;
    if (hasConnectedOnce.current) {
      loadHistoryRef.current();
    } else {
      hasConnectedOnce.current = true;
    }
  }, [streamConnected]);

  // Auto-scroll only when the user is already near the bottom. New
  // messages arriving while they're reading history shouldn't yank
  // them away.
  useEffect(() => {
    if (atBottom && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [turns, processing, atBottom]);

  // Watch the message list scroll position so the "scroll to latest"
  // button shows up the moment the user scrolls away from the bottom.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    function onScroll() {
      const dist = el!.scrollHeight - el!.scrollTop - el!.clientHeight;
      setAtBottom(dist < 60);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [activeAgent]);

  // Subscribe to the global chat SSE (started in main.tsx). The page just
  // reads the events; the stream itself stays open for the whole app
  // lifecycle so the sidebar unread badge keeps tracking.
  useEffect(() => {
    resetUnread();
    const unsub = subscribeChatStream((eventName, data) => {
      if (eventName === 'user_message') {
        setTurns((prev) => [...prev, { role: 'user', content: data.content, source: data.source }]);
      } else if (eventName === 'assistant_message') {
        setTurns((prev) => [...prev, { role: 'assistant', content: data.content, source: data.source }]);
        setProcessing(false); setProgressLabel(null); setProgressItems([]);
        health.refresh();
        if (activeAgent !== 'all') agentTokens.refresh();
      } else if (eventName === 'assistant_photo') {
        // Inline photo bubble. The bot already stripped the marker from
        // the text-side assistant_message; this event carries the URL.
        setTurns((prev) => [...prev, {
          role: 'assistant',
          content: '',
          source: data.source,
          photoUrl: data.url,
          photoCaption: data.caption,
        }]);
      } else if (eventName === 'processing') {
        if (data.processing !== undefined) setProcessing(!!data.processing);
        if (!data.processing) {
          setProgressLabel(null);
          setProgressItems([]);
        }
      } else if (eventName === 'progress') {
        if (data.description) {
          setProgressLabel(data.description);
          setProgressItems((prev) => mergeProgressItem(prev, {
            id: progressItemId(data),
            description: data.description,
            progressKind: data.progressKind,
            status: data.status,
            kind: data.kind,
            toolCallId: data.toolCallId,
            locations: data.locations,
            planEntries: data.planEntries,
            timestamp: data.timestamp || Date.now(),
          }));
        }
      } else if (eventName === 'error') {
        setTurns((prev) => [...prev, { role: 'assistant', content: data.content || 'Error' }]);
        setProcessing(false); setProgressLabel(null); setProgressItems([]);
      }
    });
    return unsub;
  }, [activeAgent]);

  async function send(textOverride?: string) {
    const message = (textOverride ?? draft).trim();
    if (!message) return;
    setSending(true); setError(null); setProgressItems([]); setProgressLabel(null);
    try {
      const res = await apiPost<{ ok?: boolean; error?: string }>('/api/chat/send', { message });
      if (!res.ok && res.error) {
        setError(res.error === 'busy' ? 'A turn is already in flight. Wait for it to finish.' : res.error);
      } else if (!textOverride) {
        setDraft('');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally { setSending(false); }
  }

  async function abort() {
    try { await apiPost('/api/chat/abort'); } catch {}
  }

  function quick(prompt: string) {
    void send(prompt);
    inputRef.current?.focus();
  }

  const agentList = agents.data?.agents ?? [];
  const todayCost = activeAgent === 'all'
    ? agentList.reduce((sum, a: any) => sum + (a.todayCost || 0), 0)
    : agentTokens.data?.todayCost ?? 0;
  const todayTurns = activeAgent === 'all'
    ? agentList.reduce((sum, a: any) => sum + (a.todayTurns || 0), 0)
    : agentTokens.data?.todayTurns ?? 0;

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Chat"
        actions={
          <span class="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <StatusDot tone={streamConnected ? 'done' : 'cancelled'} />
            {streamConnected ? 'Stream live' : 'Reconnecting…'}
          </span>
        }
      />

      <ChatToolbar
        agents={agentList}
        activeAgent={activeAgent}
        onAgentChange={setActiveAgent}
        contextPct={health.data?.contextPct}
        turnsToday={todayTurns}
        costToday={todayCost}
        model={activeAgent === 'all' ? health.data?.model : undefined}
      />

      <div class="relative flex-1 min-h-0">
        <div ref={messagesRef} class="absolute inset-0 overflow-y-auto px-6 py-4 space-y-2">
          {error && <div class="text-[var(--color-status-failed)] text-[11.5px]">{error}</div>}
          {loading && <PageState loading />}
          {!loading && turns.length === 0 && (
            <PageState empty emptyTitle="No messages yet" emptyDescription="Type below to talk to your agent. Replies stream in via SSE." />
          )}
          {turns.map((t, i) => <Bubble key={i} turn={t} />)}
          {processing && <ProcessingBubble label={progressLabel} items={progressItems} />}
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            class="control-button absolute bottom-3 right-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11.5px] font-medium control-accent shadow-lg transition-colors"
            aria-label="Scroll to latest message"
          >
            <ArrowDown size={13} />
            Latest
          </button>
        )}
      </div>

      <div class="border-t border-[var(--color-border)] px-4 pt-2 pb-3">
        <div class="max-w-4xl mx-auto">
          <div class="flex items-center gap-1 mb-2 flex-wrap">
            {QUICK_ACTIONS.map((qa) => (
              <button
                key={qa.label}
                type="button"
                onClick={() => quick(qa.prompt)}
                disabled={processing || sending}
                class="px-2 py-0.5 rounded text-[10.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] border border-[var(--color-border)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {qa.label}
              </button>
            ))}
          </div>
          <div class="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={draft}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim()) void send();
                }
              }}
              placeholder="Type a message. Shift+Enter for newline."
              rows={1}
              class="flex-1 bg-[var(--color-elevated)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)] resize-none max-h-32"
            />
            {processing ? (
              <button
                type="button"
                onClick={abort}
                class="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-[12px] font-medium bg-[var(--color-status-failed)] text-white hover:opacity-90 transition-opacity"
              >
                <Square size={12} fill="currentColor" /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || sending}
                class="control-button inline-flex items-center gap-1 px-3 py-2 rounded-lg text-[12px] font-medium control-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Send size={12} /> {sending ? 'Sending…' : 'Send'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatToolbar({
  agents, activeAgent, onAgentChange, contextPct, turnsToday, costToday, model,
}: {
  agents: Agent[];
  activeAgent: string;
  onAgentChange: (agentId: string) => void;
  contextPct?: number;
  turnsToday: number;
  costToday: number;
  model?: string;
}) {
  const selected = agents.find((agent) => agent.id === activeAgent);
  const onlineAgents = agents.filter((agent) => agent.running);
  const offlineAgents = agents.filter((agent) => !agent.running);
  const onlineCount = onlineAgents.length;
  const inputClass = 'toolbar-control rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';

  return (
    <div class="page-toolbar shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      <label class="flex items-center gap-2 min-w-0">
        <span class="text-[13px] text-[var(--color-text-muted)]">Agent</span>
        <select
          value={activeAgent}
          onChange={(event) => onAgentChange(event.currentTarget.value)}
          aria-label="Select chat agent"
          class={`${inputClass} w-[min(260px,60vw)] min-w-[150px] px-2.5`}
        >
          <option value="all">All agents</option>
          {onlineAgents.length > 0 && (
            <optgroup label="Online">
              {onlineAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name || agent.id}</option>)}
            </optgroup>
          )}
          {offlineAgents.length > 0 && (
            <optgroup label="Offline">
              {offlineAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name || agent.id}</option>)}
            </optgroup>
          )}
          {activeAgent !== 'all' && !selected && <option value={activeAgent}>{activeAgent}</option>}
        </select>
      </label>

      <span class="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)] whitespace-nowrap">
        <StatusDot tone={activeAgent === 'all' ? (onlineCount > 0 ? 'done' : 'cancelled') : selected?.running ? 'done' : 'cancelled'} />
        {activeAgent === 'all'
          ? `${onlineCount} of ${agents.length} online`
          : selected?.running ? 'Online' : 'Offline'}
      </span>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-[var(--color-text-faint)] tabular-nums sm:ml-auto">
        {typeof contextPct === 'number' && (
          <span><span class="uppercase tracking-wider">Ctx</span> <span class="text-[var(--color-text-muted)]">{contextPct}%</span></span>
        )}
        <span><span class="uppercase tracking-wider">Turns today</span> <span class="text-[var(--color-text-muted)]">{formatNumber(turnsToday)}</span></span>
        {showCosts.value && (
          <span><span class="uppercase tracking-wider">Cost today</span> <span class="text-[var(--color-text-muted)]">{formatCost(costToday)}</span></span>
        )}
        {model && (
          <span class="inline-flex min-w-0 max-w-[180px] items-center gap-1">
            <span class="shrink-0 uppercase tracking-wider">Model</span>
            <span class="min-w-0 truncate text-[var(--color-text-muted)] normal-case" title={model}>{modelLabel(model)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  const isUser = turn.role === 'user';
  const isPhoto = !!turn.photoUrl;
  const html = (isUser || isPhoto) ? null : renderMarkdown(turn.content);
  return (
    <div class={'flex ' + (isUser ? 'justify-end' : 'justify-start')}>
      <div
        class={[
          'max-w-[75%] rounded-lg text-[12.5px] leading-relaxed overflow-hidden',
          'select-text',
          isPhoto ? 'p-1' : 'px-3 py-2',
          isUser
            ? 'bg-[var(--color-accent)] text-white rounded-br-sm whitespace-pre-wrap'
            : 'bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text)] rounded-bl-sm chat-md',
        ].join(' ')}
      >
        {isPhoto ? (
          <>
            <img
              src={turn.photoUrl}
              alt={turn.photoCaption || 'attached image'}
              class="block rounded max-h-[320px] w-auto object-contain"
              loading="lazy"
            />
            {turn.photoCaption && (
              <div class="px-2 py-1 text-[11px] text-[var(--color-text-muted)]">{turn.photoCaption}</div>
            )}
          </>
        ) : isUser ? (
          turn.content
        ) : (
          <div dangerouslySetInnerHTML={{ __html: html || '' }} />
        )}
        {turn.source === 'dashboard' && !isPhoto && (
          <div class="text-[9.5px] opacity-60 mt-1 uppercase tracking-wider">via dashboard</div>
        )}
      </div>
    </div>
  );
}

function progressItemId(data: any): string {
  if (data.toolCallId) return `tool:${data.toolCallId}`;
  if (data.progressKind === 'plan') return 'plan';
  return `progress:${data.timestamp || Date.now()}:${data.description || ''}`;
}

function mergeProgressItem(prev: ProgressItem[], next: ProgressItem): ProgressItem[] {
  const idx = prev.findIndex((item) => item.id === next.id);
  const merged = idx === -1
    ? [...prev, next]
    : prev.map((item, itemIdx) => itemIdx === idx ? { ...item, ...next } : item);
  return merged.slice(-8);
}

function ProcessingBubble({ label, items }: { label: string | null; items: ProgressItem[] }) {
  const visible = items.slice(-6).reverse();
  return (
    <div class="flex justify-start">
      <div class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg rounded-bl-sm px-3 py-2 text-[12px] text-[var(--color-text-muted)] min-w-[260px] max-w-[560px]">
        <div class="inline-flex items-center gap-2">
          <Sparkles size={12} class="animate-pulse text-[var(--color-accent)]" />
          <span>{label || 'Thinking…'}</span>
        </div>
        {visible.length > 0 && (
          <div class="mt-2 space-y-1.5 border-t border-[var(--color-border)] pt-2">
            {visible.map((item) => <ProgressRow key={item.id} item={item} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressRow({ item }: { item: ProgressItem }) {
  const Icon = progressIcon(item);
  const location = item.locations?.[0];
  return (
    <div class="grid grid-cols-[14px_1fr_auto] gap-2 items-start">
      <Icon size={13} class={progressIconClass(item)} />
      <div class="min-w-0">
        <div class="text-[11.5px] text-[var(--color-text)] truncate">{item.description}</div>
        {location && (
          <div class="text-[10.5px] text-[var(--color-text-faint)] font-mono truncate">
            {location.path}{location.line ? `:${location.line}` : ''}
          </div>
        )}
        {item.progressKind === 'plan' && item.planEntries && item.planEntries.length > 1 && (
          <div class="mt-1 space-y-0.5">
            {item.planEntries.slice(0, 4).map((entry, idx) => (
              <div key={idx} class="text-[10.5px] text-[var(--color-text-faint)] truncate">
                {entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '›' : '·'} {entry.content}
              </div>
            ))}
          </div>
        )}
      </div>
      {item.status && (
        <span class="text-[9.5px] uppercase text-[var(--color-text-faint)] tabular-nums">
          {item.status.replace('_', ' ')}
        </span>
      )}
    </div>
  );
}

function progressIcon(item: ProgressItem) {
  if (item.status === 'completed') return CheckCircle2;
  if (item.status === 'failed') return AlertCircle;
  if (item.progressKind === 'plan') return ListChecks;
  if (item.progressKind === 'tool_active') return Wrench;
  return Loader2;
}

function progressIconClass(item: ProgressItem): string {
  if (item.status === 'completed') return 'mt-0.5 text-[var(--color-status-done)]';
  if (item.status === 'failed') return 'mt-0.5 text-[var(--color-status-failed)]';
  if (item.status === 'in_progress' || item.progressKind === 'tool_active') return 'mt-0.5 text-[var(--color-accent)] animate-pulse';
  return 'mt-0.5 text-[var(--color-text-faint)]';
}
