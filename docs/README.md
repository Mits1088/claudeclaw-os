# Documentation

ClaudeClaw documentation is organized by purpose. Architecture decisions are
historical records; references, guides, policies, and runbooks describe the
current system and should evolve with it.

## Releases

- [v1.10.0: shared knowledge, live direction, dependable delegation](releases/v1.10.0.md)
  covers shipped features, optional setup, upgrade steps, and known limits.

## Architecture decisions

RFCs are reserved for decisions with meaningful alternatives, cross-cutting
impact, security or schema consequences, or sequencing that future contributors
need to understand.

An RFC tracks two independent states:

- **Decision:** `Draft`, `Proposed`, `Accepted`, `Rejected`, or `Superseded`.
- **Implementation:** `Not started`, `In progress`, `Partial`, `Complete`, or
  `Retired`.

Accepted RFCs remain accepted after implementation. Do not rewrite their
original rationale to match later code. Record what actually shipped in an
`Outcome` section, and link a superseding RFC when a decision is replaced.

| RFC | Decision | Implementation | Shipped / tracking |
| --- | --- | --- | --- |
| [Agent Provider Engine](rfcs/sdk-engine.md) | Accepted | Partial | v1.2.0, PR #58 |
| [`/respin` checkpoint restore](rfcs/respin-session.md) | Draft | Not started | Design only |
| [Token / Cost Observability](rfcs/token-cost-observability.md) | Accepted | Partial | Foundation in v1.5.0, PR #143 |
| [Agent Awareness & Deterministic Comms](rfcs/agent-awareness-and-comms.md) | Accepted | Complete | v1.5.0, PRs #142 and #144 |
| [Agent Identity Reconciliation](rfcs/agent-identity-reconciliation.md) | Accepted | Complete | v1.6.0, PR #154 |
| [In-Process Dispatch API](rfcs/in-process-dispatch.md) | Accepted | Complete | v1.8.0, PR #174 |
| [Native OpenAI Provider via Codex App Server](rfcs/codex-app-server-provider.md) | Accepted | Complete | Initial scope in v1.8.0, PR #174 |
| [Untrusted Content Provenance](rfcs/untrusted-content-provenance.md) | Draft | Not started | Issue #185 |
| [Z.ai GLM Provider (Anthropic-compatible endpoint)](rfcs/anthropic-compatible-provider.md) | Proposed | Complete | Awaiting review |

## Concepts and guides

- [Agent identity and addressing](agent-identity-and-addressing.md) explains
  canonical ids, display names, aliases, and CLI routing.
- [Signal Messenger Adapter](signal.md) covers Signal setup, routing, voice,
  troubleshooting, and rollback.

## Reference

- [Agent CLI Reference](agent-cli-reference.md) is generated from the CLI
  descriptor registry. Do not edit its generated block by hand.

## Operations and maintenance

- [Incident Runbook](incident-runbook.md) provides symptom-to-action recovery
  procedures and kill switches.
- [Dependency Maintenance](dependency-maintenance.md) defines dependency,
  advisory, override, and release-validation policy.

## Security and policy

- [War-room Tool & MCP Policy](warroom-mcp-policy.md) documents the enforced
  tool capability model, opt-ins, budgets, and audit behavior.
