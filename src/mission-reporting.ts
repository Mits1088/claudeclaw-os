import { randomUUID } from 'node:crypto';
import { claimMissionWorkflowReport, settleMissionWorkflowReport } from './db.js';
import { logger } from './logger.js';
import { listAgentIds, loadAgentConfig, resolvePrimaryAgentId } from './agent-config.js';

/** One disposition report per tick keeps a delivery outage from monopolizing the queue. */
export async function deliverMissionWorkflowReport(owner: string, send: (text: string) => Promise<void>): Promise<void> {
  const token = randomUUID();
  const owners = [owner];
  if (owner === (resolvePrimaryAgentId() ?? 'main')) {
    for (const id of listAgentIds()) {
      try { if (id !== owner && loadAgentConfig(id).runtimeMode === 'headless') owners.push(id); } catch { /* unavailable configuration is not a delivery target */ }
    }
  }
  let report = null;
  for (const recipient of owners) {
    report = claimMissionWorkflowReport(recipient, token);
    if (report) break;
  }
  if (!report) return;
  try {
    await send(report.body);
    settleMissionWorkflowReport(report.id, token);
  } catch (error) {
    settleMissionWorkflowReport(report.id, token, error instanceof Error ? error.message : String(error));
    logger.warn({ reportId: report.id, error }, 'Mission report delivery pending; outcome is preserved');
  }
}
