import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { isFailedTurn, runAgent, UsageInfo } from './agent.js';
import { loadAgentConfig, listAgentIds, resolveAgentClaudeMd, resolveAgentId } from './agent-config.js';
import { PROJECT_ROOT } from './config.js';
import { logToHiveMind, createInterAgentTask, completeInterAgentTask } from './db.js';
import { logger } from './logger.js';
import { buildMemoryContext } from './memory.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DelegationResult {
  agentId: string;
  text: string | null;
  usage: UsageInfo | null;
  taskId: string;
  durationMs: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

// ── Registry ─────────────────────────────────────────────────────────

/** Cache of available agents loaded at startup. */
let agentRegistry: AgentInfo[] = [];

/** Default timeout for a delegated task (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initialize the orchestrator by scanning `agents/` for valid configs.
 * Safe to call even if no agents are configured — the registry will be empty.
 */
export function initOrchestrator(): void {
  rebuildRegistry();
  logger.info(
    { agents: agentRegistry.map((a) => a.id) },
    'Orchestrator initialized',
  );
}

function rebuildRegistry(): void {
  const ids = listAgentIds();
  const next: AgentInfo[] = [];
  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      next.push({ id, name: config.name, description: config.description });
    } catch (err) {
      // Agent config is broken (e.g. missing token) — skip it but warn
      logger.warn({ agentId: id, err }, 'Skipping agent — config load failed');
    }
  }
  agentRegistry = next;
}

/**
 * Refresh the cached registry from disk. Call after createAgent/deleteAgent
 * so @delegate: syntax sees newly-created agents without a process restart.
 */
export function refreshAgentRegistry(): void {
  rebuildRegistry();
  logger.info({ agents: agentRegistry.map((a) => a.id) }, 'Orchestrator registry refreshed');
}

/** Return all agents that were successfully loaded. */
export function getAvailableAgents(): AgentInfo[] {
  return [...agentRegistry];
}

// ── Delegation ───────────────────────────────────────────────────────

/**
 * Parse a user message for delegation syntax.
 *
 * Supported forms:
 *   @agentId: prompt text
 *   @agentId prompt text   (only if agentId is a known agent)
 *   /delegate agentId prompt text
 *
 * Returns `{ agentId, prompt }` or `null` if no delegation detected.
 */
export function parseDelegation(
  message: string,
): { agentId: string; prompt: string } | null {
  // /delegate agentId prompt
  const cmdMatch = message.match(
    /^\/delegate\s+(\S+)\s+([\s\S]+)/i,
  );
  if (cmdMatch) {
    return { agentId: cmdMatch[1], prompt: cmdMatch[2].trim() };
  }

  // @agentId: prompt
  const atMatch = message.match(
    /^@(\S+?):\s*([\s\S]+)/,
  );
  if (atMatch) {
    return { agentId: atMatch[1], prompt: atMatch[2].trim() };
  }

  // @agentId prompt (only for known agents to avoid false positives)
  const atMatchNoColon = message.match(
    /^@(\S+)\s+([\s\S]+)/,
  );
  if (atMatchNoColon) {
    const candidate = atMatchNoColon[1];
    if (agentRegistry.some((a) => a.id === candidate)) {
      return { agentId: candidate, prompt: atMatchNoColon[2].trim() };
    }
  }

  return null;
}

/**
 * Delegate a task to another agent. Runs the agent's Claude Code session
 * in-process (same Node.js process) with the target agent's cwd and
 * system prompt.
 *
 * The delegation is logged to both `inter_agent_tasks` and `hive_mind`.
 *
 * @param agentId    Target agent identifier (must exist in agents/)
 * @param prompt     The task to delegate
 * @param chatId     Telegram chat ID (for DB tracking)
 * @param fromAgent  The requesting agent's ID (usually 'main')
 * @param onProgress Optional callback for status updates
 * @param timeoutMs  Maximum execution time (default 5 min)
 */
export async function delegateToAgent(
  agentId: string,
  prompt: string,
  chatId: string,
  fromAgent: string,
  onProgress?: (msg: string) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DelegationResult> {
  // Resolve a display-name/alias to the canonical id up front so the registry
  // lookup, DB row, and hive-mind log all key off the id (not a name that would
  // dead-letter). Fall back to the raw input so the existing not-found error
  // still fires for a genuinely unknown agent.
  const canonicalId = resolveAgentId(agentId) ?? agentId;

  let agent = agentRegistry.find((a) => a.id === canonicalId);
  if (!agent) {
    // Cache miss: an agent created via the dashboard wizard after this
    // process started won't be in the cache yet. Refresh once and retry.
    rebuildRegistry();
    agent = agentRegistry.find((a) => a.id === canonicalId);
  }
  if (!agent) {
    const available = agentRegistry.map((a) => a.id).join(', ') || '(none)';
    throw new Error(
      `Agent "${agentId}" not found. Available: ${available}`,
    );
  }

  const taskId = crypto.randomUUID();
  const start = Date.now();

  // Record the task
  createInterAgentTask(taskId, fromAgent, canonicalId, chatId, prompt);
  logToHiveMind(
    fromAgent,
    chatId,
    'delegate',
    `Delegated to ${canonicalId}: ${prompt.slice(0, 100)}`,
  );

  onProgress?.(`Delegating to ${agent.name}...`);

  try {
    // Load agent config to get its system prompt and MCP allowlist
    const agentConfig = loadAgentConfig(canonicalId);
    const claudeMdPath = resolveAgentClaudeMd(canonicalId);
    let systemPrompt = '';
    if (claudeMdPath) {
      try {
        systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
      } catch {
        // No CLAUDE.md for this agent — that's fine
      }
    }

    // Build memory context for the delegated agent
    const { contextText: memCtx } = await buildMemoryContext(chatId, prompt, canonicalId);

    // Build the delegated prompt with agent role context + memory
    const contextParts: string[] = [];
    if (systemPrompt) {
      contextParts.push(`[Agent role — follow these instructions]\n${systemPrompt}\n[End agent role]`);
    }
    if (memCtx) {
      contextParts.push(memCtx);
    }
    contextParts.push(prompt);
    const fullPrompt = contextParts.join('\n\n');

    // Create an AbortController with timeout
    const abortCtrl = new AbortController();
    const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

    try {
      const result = await runAgent(
        fullPrompt,
        undefined, // fresh session for each delegation
        () => {}, // no typing indicator needed for sub-delegation
        undefined, // no progress callback for inner agent
        // Honour the target agent's `model:` field from agent.yaml.
        // NOT `agentDefaultModel` (from config.ts): delegateToAgent
        // runs in-process inside the orchestrator (main), so the
        // module-level export resolves to the CALLER's model
        // (undefined for main), not the target's. We pull from
        // agentConfig which was loaded for the target specialist
        // a few lines above.
        agentConfig.model,
        abortCtrl,
        undefined, // no streaming for delegation
        agentConfig.mcpServers,
        // Honour the target agent's `provider:` field from agent.yaml —
        // same reasoning as `agentConfig.model` above. delegateToAgent runs
        // in-process inside the orchestrator (main), so getSelectedProviderConfig()
        // would resolve to the CALLER's/main's provider, silently running the
        // target's model id on the wrong engine once a second provider ships.
        // Pull the provider from the target's own config instead.
        agentConfig.provider,
      );

      clearTimeout(timer);

      // A timed-out or errored run must not be recorded as 'completed' — the
      // catch below already routes failures correctly (completeInterAgentTask
      // 'failed', hive_mind delegate_error, re-throw → user notification).
      if (result.aborted) {
        throw new Error(`Delegation timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      if (isFailedTurn(result)) {
        const reason = result.stopReason ?? 'unknown error';
        // Codex adapters preserve actionable provider diagnostics in text.
        // Keep the bounded detail just as scheduler and mission failures do.
        const detail = result.text ? `: ${result.text.slice(0, 400)}` : '';
        throw new Error(`Agent run failed (${reason})${detail}`.slice(0, 500));
      }

      const durationMs = Date.now() - start;
      completeInterAgentTask(taskId, 'completed', result.text);
      logToHiveMind(
        canonicalId,
        chatId,
        'delegate_result',
        `Completed delegation from ${fromAgent}: ${(result.text ?? '').slice(0, 120)}`,
      );

      onProgress?.(
        `${agent.name} completed (${Math.round(durationMs / 1000)}s)`,
      );

      return {
        agentId: canonicalId,
        text: result.text,
        usage: result.usage,
        taskId,
        durationMs,
      };
    } catch (innerErr) {
      clearTimeout(timer);
      throw innerErr;
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    completeInterAgentTask(taskId, 'failed', errMsg);
    logToHiveMind(
      canonicalId,
      chatId,
      'delegate_error',
      `Delegation from ${fromAgent} failed: ${errMsg.slice(0, 120)}`,
    );
    throw err;
  }
}
