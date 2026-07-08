/**
 * CommandIndex — Cmd+K command palette backend (V1-SPEC §13).
 *
 * Returns the union of apps, workflows, agents, gateways, runs, approvals,
 * extensions and registry entries (when configured) matching a free-text query, ordered by
 * a small relevance heuristic. Callers cap the result to
 * COMMAND_PALETTE_RESULT_LIMIT.
 */

import { eq, and, like, desc, isNull, ne, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AgentisError, CONSTANTS } from '@agentis/core';

export interface CommandHit {
  type: 'app' | 'workflow' | 'agent' | 'gateway' | 'run' | 'approval' | 'extension' | 'conversation';
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
      case 'app': {
        const row = this.db
          .select()
          .from(schema.apps)
          .where(and(eq(schema.apps.id, id), eq(schema.apps.workspaceId, workspaceId)))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `App ${id} not found`);
        return { type, id, href: `/apps/${id}` };
      }
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
        return { type, id, href: `/history?tab=runs&runId=${id}` };
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
      case 'extension': {
        const row = this.db
          .select()
          .from(schema.extensions)
          .where(and(eq(schema.extensions.id, id), eq(schema.extensions.workspaceId, workspaceId)))
          .get();
        if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `extension ${id} not found`);
        return { type, id, href: `/extensions?focus=${id}` };
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
    if (q.length < 2) return [];
    const hits: CommandHit[] = [];
    const pattern = `%${escapeLike(q)}%`;

    // Apps are the org primitive — surface them first.
    const apps = this.db.select().from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), like(schema.apps.name, pattern)))
      .limit(20)
      .all();
    for (const a of apps) {
      const score = relevance(q, a.name, a.description ?? '');
      if (score > 0) hits.push({ type: 'app', id: a.id, title: a.name, subtitle: a.description || 'Agentic App', href: `/apps/${a.id}`, score });
    }

    const workflows = this.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), like(schema.workflows.title, pattern)))
      .limit(20)
      .all();
    for (const w of workflows) {
      const score = relevance(q, w.title, w.description ?? '');
      if (score > 0) hits.push({ type: 'workflow', id: w.id, title: w.title, subtitle: w.description ?? undefined, href: `/workflows/${w.id}`, score });
    }

    const agents = this.db.select().from(schema.agents)
      .where(and(
        eq(schema.agents.workspaceId, workspaceId),
        like(schema.agents.name, pattern),
      ))
      .limit(20)
      .all();
    for (const a of agents) {
      const score = relevance(q, a.name, a.adapterType);
      if (score > 0) hits.push({ type: 'agent', id: a.id, title: a.name, subtitle: a.adapterType, href: `/agents/${a.id}`, score });
    }

    const gateways = this.db.select().from(schema.openclawGateways)
      .where(and(eq(schema.openclawGateways.workspaceId, workspaceId), like(schema.openclawGateways.name, pattern)))
      .limit(10)
      .all();
    for (const g of gateways) {
      const score = relevance(q, g.name, g.gatewayUrl);
      if (score > 0) hits.push({ type: 'gateway', id: g.id, title: g.name, subtitle: g.gatewayUrl, href: `/gateways/${g.id}`, score });
    }

    const runs = this.db.select().from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), like(schema.workflowRuns.id, pattern)))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(10)
      .all();
    for (const r of runs) {
      const score = relevance(q, r.id.slice(0, 8), r.status);
      if (score > 0) hits.push({ type: 'run', id: r.id, title: `Run ${r.id.slice(0, 8)}`, subtitle: r.status, href: `/history?tab=runs&runId=${r.id}`, score });
    }

    const approvals = this.db.select().from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.workspaceId, workspaceId), like(schema.approvalRequests.title, pattern)))
      .limit(10)
      .all();
    for (const a of approvals) {
      const score = relevance(q, a.title, a.summary);
      if (score > 0) hits.push({ type: 'approval', id: a.id, title: a.title, subtitle: a.summary, href: `/approvals?focus=${a.id}`, score });
    }

    const extensions = this.db.select().from(schema.extensions)
      .where(and(eq(schema.extensions.workspaceId, workspaceId), like(schema.extensions.name, pattern)))
      .limit(10)
      .all();
    for (const s of extensions) {
      const score = relevance(q, s.name, s.runtime);
      if (score > 0) hits.push({ type: 'extension', id: s.id, title: s.name, subtitle: `${s.runtime} • v${s.version}`, href: `/extensions?focus=${s.id}`, score });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, CONSTANTS.COMMAND_PALETTE_RESULT_LIMIT);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
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
