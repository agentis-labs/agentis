/**
 * CommandIndex — Cmd+K command palette backend (V1-SPEC §13).
 *
 * Returns the union of workflows, agents, gateways, runs, approvals, skills
 * and registry entries (when configured) matching a free-text query, ordered by
 * a small relevance heuristic. Callers cap the result to
 * COMMAND_PALETTE_RESULT_LIMIT.
 */

import { eq, and } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, CONSTANTS } from '@agentis/core';

export interface CommandHit {
  type: 'workflow' | 'agent' | 'gateway' | 'run' | 'approval' | 'skill' | 'conversation';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  score: number;
}

export type CommandTargetType = CommandHit['type'];

export interface CommandExecuteRequest {
  type: CommandTargetType;
  id: string;
}

export interface CommandExecuteResult {
  type: CommandTargetType;
  id: string;
  href: string;
}

export class CommandIndex {
  constructor(private readonly db: AgentisSqliteDb) {}

  /**
   * Resolve a command-palette selection to a navigation target. Verifies the
   * entity belongs to `workspaceId` (V1-SPEC §11 "POST /command/execute"),
   * then returns the same `href` that `search()` would have emitted. Throws
   * RESOURCE_NOT_FOUND when the entity is missing or out of scope.
   */
  execute(workspaceId: string, req: CommandExecuteRequest): CommandExecuteResult {
    const { type, id } = req;
    switch (type) {
      case 'workflow': {
        const row = this.db
          .select()
          .from(schema.workflows)
          .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, workspaceId)))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `Workflow ${id} not found`);
        return { type, id, href: `/workflows/${id}` };
      }
      case 'agent': {
        const row = this.db
          .select()
          .from(schema.agents)
          .where(and(eq(schema.agents.id, id), eq(schema.agents.workspaceId, workspaceId)))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `Agent ${id} not found`);
        return { type, id, href: `/agents/${id}` };
      }
      case 'gateway': {
        const row = this.db
          .select()
          .from(schema.openclawGateways)
          .where(and(
            eq(schema.openclawGateways.id, id),
            eq(schema.openclawGateways.workspaceId, workspaceId),
          ))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `Gateway ${id} not found`);
        return { type, id, href: `/gateways/${id}` };
      }
      case 'run': {
        const row = this.db
          .select()
          .from(schema.workflowRuns)
          .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowRuns.workspaceId, workspaceId)))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `Run ${id} not found`);
        return { type, id, href: `/runs/${id}` };
      }
      case 'approval': {
        const row = this.db
          .select()
          .from(schema.approvalRequests)
          .where(and(
            eq(schema.approvalRequests.id, id),
            eq(schema.approvalRequests.workspaceId, workspaceId),
          ))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `Approval ${id} not found`);
        return { type, id, href: `/approvals?focus=${id}` };
      }
      case 'skill': {
        const row = this.db
          .select()
          .from(schema.skills)
          .where(and(eq(schema.skills.id, id), eq(schema.skills.workspaceId, workspaceId)))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `Skill ${id} not found`);
        return { type, id, href: `/skills?focus=${id}` };
      }
      case 'conversation': {
        return { type, id, href: `/activity?conversation=${id}` };
      }
      default:
        throw new AgentisError('VALIDATION_FAILED', `Unsupported command target type: ${String(type)}`);
    }
  }

  search(workspaceId: string, query: string): CommandHit[] {
    const q = query.trim().toLowerCase();
    const hits: CommandHit[] = [];

    const workflows = this.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all();
    for (const w of workflows) {
      const score = relevance(q, w.title, w.summary ?? '');
      if (score > 0) hits.push({ type: 'workflow', id: w.id, title: w.title, subtitle: w.summary ?? undefined, href: `/workflows/${w.id}`, score });
    }

    const agents = this.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all();
    for (const a of agents) {
      const score = relevance(q, a.name, a.adapterType);
      if (score > 0) hits.push({ type: 'agent', id: a.id, title: a.name, subtitle: a.adapterType, href: `/agents/${a.id}`, score });
    }

    const gateways = this.db.select().from(schema.openclawGateways).where(eq(schema.openclawGateways.workspaceId, workspaceId)).all();
    for (const g of gateways) {
      const score = relevance(q, g.name, g.gatewayUrl);
      if (score > 0) hits.push({ type: 'gateway', id: g.id, title: g.name, subtitle: g.gatewayUrl, href: `/gateways/${g.id}`, score });
    }

    const runs = this.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workspaceId, workspaceId)).all();
    for (const r of runs) {
      const score = relevance(q, r.id.slice(0, 8), r.status);
      if (score > 0) hits.push({ type: 'run', id: r.id, title: `Run ${r.id.slice(0, 8)}`, subtitle: r.status, href: `/runs/${r.id}`, score });
    }

    const approvals = this.db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.workspaceId, workspaceId)).all();
    for (const a of approvals) {
      const score = relevance(q, a.title, a.summary);
      if (score > 0) hits.push({ type: 'approval', id: a.id, title: a.title, subtitle: a.summary, href: `/approvals?focus=${a.id}`, score });
    }

    const skills = this.db.select().from(schema.skills).where(eq(schema.skills.workspaceId, workspaceId)).all();
    for (const s of skills) {
      const score = relevance(q, s.name, s.runtime);
      if (score > 0) hits.push({ type: 'skill', id: s.id, title: s.name, subtitle: `${s.runtime} • v${s.version}`, href: `/skills?focus=${s.id}`, score });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, CONSTANTS.COMMAND_PALETTE_RESULT_LIMIT);
  }
}

function relevance(query: string, ...fields: string[]): number {
  if (query.length === 0) return 1; // empty query — list everything (caller limits)
  let max = 0;
  for (const f of fields) {
    const t = (f ?? '').toLowerCase();
    if (t === query) max = Math.max(max, 100);
    else if (t.startsWith(query)) max = Math.max(max, 60);
    else if (t.includes(query)) max = Math.max(max, 30);
  }
  return max;
}
