// Phase 0 policy tests for the shared native-Codex capability profiles.
//
// These lock the SAFETY intent, not an implementation detail: a caller that
// granted no tools must resolve to a profile with no shell, no web search, no
// MCP, a read-only sandbox, and no network — and no combination of other flags
// (including a stale `allowDangerouslySkipPermissions`) may promote it.
//
// Both native OpenAI transports consume this resolver, so a regression here is a
// regression on both.

import { describe, expect, it } from 'vitest';

import {
  codexToolAllowed,
  resolveCodexCapabilityProfile,
  type CodexPolicyInput,
} from './codex-capability-policy.js';

const DISPATCH = 'claudeclaw-dispatch';
const dispatchEntry = { command: 'node', args: ['dist/dispatch-mcp-server.js'] };

/** Resolve with the operator write gate explicitly OFF (the default posture). */
function resolve(input: CodexPolicyInput = {}) {
  return resolveCodexCapabilityProfile(input, { dangerWriteEnabled: false });
}

describe('profile selection precedence', () => {
  it('deny-all selects tool-less', () => {
    expect(resolve({ disallowedTools: ['*'] }).mode).toBe('tool-less');
  });

  it('an explicitly empty allow-list selects tool-less', () => {
    expect(resolve({ allowedTools: [] }).mode).toBe('tool-less');
  });

  it('deny-all wins over a conflicting allow-list', () => {
    const profile = resolve({ allowedTools: ['Bash', 'Write'], disallowedTools: ['*'] });
    expect(profile.mode).toBe('tool-less');
    expect(profile.sandboxMode).toBe('read-only');
  });

  it('deny-all wins over allowDangerouslySkipPermissions', () => {
    // The real memory-ingest / war-room warmup call shape: deny-all AND
    // skip-permissions on the same turn. A locked-down turn must never be
    // promoted to full trust by that flag.
    const profile = resolve({
      allowedTools: [],
      disallowedTools: ['*'],
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    });
    expect(profile.mode).toBe('tool-less');
    expect(profile.sandboxMode).toBe('read-only');
    expect(profile.networkAccess).toBe(false);
  });

  it('a read-only allow-list selects read-only-research', () => {
    const profile = resolve({ allowedTools: ['Read', 'Grep', 'Glob'] });
    expect(profile.mode).toBe('read-only-research');
    expect(profile.sandboxMode).toBe('read-only');
    // Shell stays available: Codex uses it for repository reads and searches.
    // The sandbox, not the tool list, is what prevents writes.
    expect(profile.shellEnabled).toBe(true);
    expect(profile.networkAccess).toBe(false);
  });

  it('an allow-list containing a write/exec tool selects workspace-agent', () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      const profile = resolve({ allowedTools: ['Read', tool] });
      expect(profile.mode, tool).toBe('workspace-agent');
      expect(profile.sandboxMode, tool).toBe('workspace-write');
    }
  });

  it('an unrestricted turn selects workspace-agent with network off', () => {
    const profile = resolve({});
    expect(profile.mode).toBe('workspace-agent');
    expect(profile.sandboxMode).toBe('workspace-write');
    expect(profile.networkAccess).toBe(false);
  });
});

describe('full-trust requires an explicit decision', () => {
  it('explicit allowDangerouslySkipPermissions selects full-trust', () => {
    const profile = resolve({ allowDangerouslySkipPermissions: true });
    expect(profile.mode).toBe('full-trust');
    expect(profile.sandboxMode).toBe('danger-full-access');
    expect(profile.networkAccess).toBe(true);
  });

  it('the CODEX_DANGER_WRITE operator gate promotes an eligible write turn', () => {
    const profile = resolveCodexCapabilityProfile({}, { dangerWriteEnabled: true });
    expect(profile.mode).toBe('full-trust');
    expect(profile.sandboxMode).toBe('danger-full-access');
  });

  it('the operator gate does NOT promote a tool-less or read-only turn', () => {
    // The gate exists because the current native Windows host applies read-only
    // instead of workspace-write; it is not a licence to widen a restricted caller.
    expect(resolveCodexCapabilityProfile({ disallowedTools: ['*'] }, { dangerWriteEnabled: true }).mode)
      .toBe('tool-less');
    expect(resolveCodexCapabilityProfile({ allowedTools: ['Read'] }, { dangerWriteEnabled: true }).mode)
      .toBe('read-only-research');
  });

  it('is never inferred from an incomplete policy', () => {
    // permissionMode is not part of the policy input at all: Codex has no
    // interactive approval channel, so it must not influence the sandbox.
    const profile = resolve({ allowedTools: ['Bash'] } as CodexPolicyInput);
    expect(profile.mode).not.toBe('full-trust');
  });
});

describe('tool-less turns have no capabilities at all', () => {
  const profile = resolve({ allowedTools: [], disallowedTools: ['*'], maxTurns: 1 });

  it('disables the shell', () => expect(profile.shellEnabled).toBe(false));
  it('disables web search', () => expect(profile.webSearchEnabled).toBe(false));
  it('requests read-only with network disabled', () => {
    expect(profile.sandboxMode).toBe('read-only');
    expect(profile.networkAccess).toBe(false);
  });
  it('carries no MCP servers', () => expect(profile.mcpServers).toEqual({}));
  it('budgets zero tool items', () => expect(profile.turnBudget.maxToolItems).toBe(0));
  it('carries a bounded deadline for the caller that asked to be bounded', () => {
    expect(profile.turnBudget.deadlineMs).toBeGreaterThan(0);
  });

  it('strips an authorized MCP set, including dispatch', () => {
    // Defence in depth: even if an authorized set somehow reaches a tool-less
    // turn, the profile narrows it to nothing.
    const stripped = resolve({
      disallowedTools: ['*'],
      mcpServers: { [DISPATCH]: dispatchEntry, files: { command: 'mcp-files' } },
    });
    expect(stripped.mcpServers).toEqual({});
  });
});

describe('host-owned Codex Apps are disabled for every untrusted-input profile', () => {
  // `mcpServers: {}` only covers ClaudeClaw-provided servers. Codex 0.144.6
  // materializes the host-owned `codex_apps` server from the ACCOUNT regardless,
  // exposing the operator's connector and skill inventory — so this is a separate
  // mandatory gate, verified on a live turn to be `features.apps = false`.
  it('is disabled for tool-less', () => {
    expect(resolve({ disallowedTools: ['*'] }).hostAppsEnabled).toBe(false);
    expect(resolve({ allowedTools: [] }).hostAppsEnabled).toBe(false);
  });

  it('is disabled for read-only-research (untrusted research and voice turns)', () => {
    expect(resolve({ allowedTools: ['Read', 'Grep', 'Glob'] }).hostAppsEnabled).toBe(false);
  });

  it('may remain enabled for the trusted workspace-agent and full-trust profiles', () => {
    expect(resolve({}).hostAppsEnabled).toBe(true);
    expect(resolve({ allowDangerouslySkipPermissions: true }).hostAppsEnabled).toBe(true);
    expect(resolveCodexCapabilityProfile({}, { dangerWriteEnabled: true }).hostAppsEnabled).toBe(true);
  });

  it('tracks the profile, not the caller MCP set — an empty set is not the gate', () => {
    // The trap this closes: "no caller MCP" reads as "no MCP", which was false.
    const research = resolve({ allowedTools: ['Read'], mcpServers: {} });
    expect(research.mcpServers).toEqual({});
    expect(research.hostAppsEnabled).toBe(false);
    const trusted = resolve({ mcpServers: {} });
    expect(trusted.mcpServers).toEqual({});
    expect(trusted.hostAppsEnabled).toBe(true);
  });
});

describe('the profile may narrow the authorized MCP set but never widen it', () => {
  it('passes an authorized set through unchanged for a tool-capable turn', () => {
    const authorized = { [DISPATCH]: dispatchEntry, files: { command: 'mcp-files' } };
    expect(resolve({ mcpServers: authorized }).mcpServers).toEqual(authorized);
    expect(resolve({ allowedTools: ['Read'], mcpServers: authorized }).mcpServers).toEqual(authorized);
  });

  it('adds nothing when the caller authorized nothing', () => {
    // The whole point of Phase 0: no layer below the authorization boundary may
    // introduce a server. An absent set stays absent.
    for (const input of [{}, { allowedTools: ['Read'] }, { allowDangerouslySkipPermissions: true }]) {
      expect(resolve(input).mcpServers).toEqual({});
    }
  });

  it('does not alias the caller object', () => {
    const authorized: Record<string, { command: string }> = { files: { command: 'mcp-files' } };
    const profile = resolve({ mcpServers: authorized });
    profile.mcpServers.injected = { command: 'evil' };
    expect(authorized).not.toHaveProperty('injected');
  });
});

describe('web search follows the tool policy', () => {
  it('is disabled by a deny-all, an explicit WebSearch deny, or an omitting allow-list', () => {
    expect(resolve({ disallowedTools: ['*'] }).webSearchEnabled).toBe(false);
    expect(resolve({ disallowedTools: ['WebSearch'] }).webSearchEnabled).toBe(false);
    expect(resolve({ allowedTools: ['Read', 'Grep'] }).webSearchEnabled).toBe(false);
  });

  it('is enabled for an unrestricted turn and for an allow-list that names it', () => {
    expect(resolve({}).webSearchEnabled).toBe(true);
    expect(resolve({ allowedTools: ['Read', 'WebSearch'] }).webSearchEnabled).toBe(true);
  });

  it('keeps sandbox network confinement independent of live web search', () => {
    // Codex's managed web-search capability and model-spawned shell network
    // access are separate controls; enabling one must not relax the other.
    const profile = resolve({ allowedTools: ['Bash', 'WebSearch'] });
    expect(profile.webSearchEnabled).toBe(true);
    expect(profile.networkAccess).toBe(false);
  });
});

describe('codexToolAllowed — deny always wins', () => {
  it('honours deny-all, explicit deny, and allow-list membership', () => {
    expect(codexToolAllowed({ disallowedTools: ['*'] }, 'WebSearch')).toBe(false);
    expect(codexToolAllowed({ disallowedTools: ['WebSearch'] }, 'WebSearch')).toBe(false);
    expect(codexToolAllowed({ allowedTools: ['Read'] }, 'WebSearch')).toBe(false);
    expect(codexToolAllowed({ allowedTools: ['WebSearch'] }, 'WebSearch')).toBe(true);
    expect(codexToolAllowed({}, 'WebSearch')).toBe(true);
    // A deny wins even when the same tool is also allowed.
    expect(codexToolAllowed({ allowedTools: ['WebSearch'], disallowedTools: ['WebSearch'] }, 'WebSearch')).toBe(false);
  });
});

describe('Claude tool names are not claimed to be a Codex boundary', () => {
  it('omitting Bash from an allow-list does not disable the Codex shell — it selects a read-only sandbox instead', () => {
    // The honest translation: we cannot turn off Codex's shell by leaving a
    // Claude tool name out of a list, so the profile constrains the SANDBOX and
    // says so. Only the tool-less profile actually requests shell-off.
    const profile = resolve({ allowedTools: ['Read', 'Grep', 'Glob'] });
    expect(profile.shellEnabled).toBe(true);
    expect(profile.sandboxMode).toBe('read-only');
  });
});
