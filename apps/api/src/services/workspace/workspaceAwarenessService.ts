/**
 * WorkspaceAwarenessService — the orchestrator's durable, channel-independent
 * situational model (OMNICHANNEL-ORCHESTRATOR-10X §4.1).
 *
 * A web operator looks at a viewport; a channel user has none. For the channel
 * user the orchestrator must lead with *workspace-level* awareness — what this
 * workspace is for, who its agents are, what's in motion, what it can wire, and
 * which channels it answers on. This service assembles that picture from
 * existing tables (no new schema), caches it briefly per workspace, and formats
 * it into the WORKSPACE SITUATION prompt block.
 *
 * It is deliberately cheap: a handful of indexed reads, short TTL, and graceful
 * fallback to an empty model so a channel turn never blocks on it.
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';

export interface SituationalAgent {
  id: string;
  name: string;
  role: string | null;
  adapterType: string;
  status: string;
  capabilityTags: string[];
  whatTheyDo: string;
}

export interface SituationalIntent {
  id: string;
  title: string;
  summary: string;
}

export interface WorkspaceSituationalModel {
  workspaceName: string;
  /** Standing automations the workspace runs — a proxy for "what it's for". */
  intents: SituationalIntent[];
  agents: SituationalAgent[];
  activeRuns: Array<{ id: string; workflowId: string; status: string }>;
  pendingApprovals: Array<{ id: string; title: string; summary: string | null }>;
  liveChannels: Array<{ kind: string; status: string }>;
}

interface CacheEntry {
  model: WorkspaceSituationalModel;
  expiresAt: number;
}

const TTL_MS = 15_000;
const MAX_AGENTS = 20;
const MAX_INTENTS = 8;

export class WorkspaceAwarenessService {
  readonly #cache = new Map<string, CacheEntry>();

  constructor(
    private readonly deps: { db: AgentisSqliteDb; logger?: Logger },
  ) {}

  /** Invalidate the cached model (call when agents/runs/approvals change). */
  invalidate(workspaceId: string): void {
    this.#cache.delete(workspaceId);
  }

  /** Assemble (or return cached) the situational model for a workspace. */
  build(workspaceId: string): WorkspaceSituationalModel {
    const cached = this.#cache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) return cached.model;
    const model = this.#assemble(workspaceId);
    this.#cache.set(workspaceId, { model, expiresAt: Date.now() + TTL_MS });
    return model;
  }

  /** The formatted WORKSPACE SITUATION block for the system prompt. */
  buildContextBlock(workspaceId: string): string {
    try {
      return formatSituationalModel(this.build(workspaceId));
    } catch (err) {
      this.deps.logger?.warn?.('awareness.build_failed', { workspaceId, err: (err as Error).message });
      return '';
    }
  }

  #assemble(workspaceId: string): WorkspaceSituationalModel {
    const db = this.deps.db;
    const workspace = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();

    // PERF: project only rendered columns and push filter/order/limit into SQL.
    // Previously each (cache-missed) assembly did `.all()` over workflow_runs and
    // workflows — loading every run's runState/graphSnapshot and every workflow's
    // graph JSON blob — which grew without bound and made channel turns slower
    // the longer a workspace lived.
    const agents = db
      .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, adapterType: schema.agents.adapterType, status: schema.agents.status, capabilityTags: schema.agents.capabilityTags, description: schema.agents.description, instructions: schema.agents.instructions })
      .from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).limit(MAX_AGENTS).all()
      .map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role ?? null,
        adapterType: a.adapterType,
        status: a.status,
        capabilityTags: Array.isArray(a.capabilityTags) ? (a.capabilityTags as string[]) : [],
        whatTheyDo: oneLine(a.description ?? a.instructions ?? ''),
      }));

    const activeRuns = db
      .select({ id: schema.workflowRuns.id, workflowId: schema.workflowRuns.workflowId, status: schema.workflowRuns.status })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workspaceId, workspaceId), eq(schema.workflowRuns.status, 'RUNNING')))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(10).all()
      .map((r) => ({ id: r.id, workflowId: r.workflowId ?? `ephemeral:${r.id}`, status: r.status }));

    const pendingApprovals = db
      .select({ id: schema.approvalRequests.id, title: schema.approvalRequests.title, summary: schema.approvalRequests.summary })
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.workspaceId, workspaceId), eq(schema.approvalRequests.status, 'pending')))
      .orderBy(desc(schema.approvalRequests.createdAt))
      .limit(10).all()
      .map((a) => ({ id: a.id, title: a.title, summary: a.summary ?? null }));

    const intents = db
      .select({ id: schema.workflows.id, title: schema.workflows.title, description: schema.workflows.description })
      .from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId))
      .orderBy(desc(schema.workflows.updatedAt))
      .limit(MAX_INTENTS).all()
      .map((w) => ({ id: w.id, title: w.title, summary: oneLine(w.description ?? '') }));

    const liveChannels = db
      .select({ kind: schema.channelConnections.kind, status: schema.channelConnections.status })
      .from(schema.channelConnections).where(eq(schema.channelConnections.workspaceId, workspaceId)).all()
      .map((c) => ({ kind: c.kind, status: c.status }));

    return {
      workspaceName: workspace?.name ?? workspaceId,
      intents,
      agents,
      activeRuns,
      pendingApprovals,
      liveChannels,
    };
  }
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

/** Render the model as the WORKSPACE SITUATION prompt block. */
export function formatSituationalModel(model: WorkspaceSituationalModel): string {
  const lines: string[] = ['WORKSPACE SITUATION', `Workspace: ${model.workspaceName}`];

  if (model.intents.length > 0) {
    lines.push('', 'Standing automations (what this workspace runs):');
    for (const intent of model.intents) {
      lines.push(`- ${intent.title}${intent.summary ? ` — ${intent.summary}` : ''}`);
    }
  }

  if (model.agents.length > 0) {
    lines.push('', 'Agent roster (who can do what):');
    for (const a of model.agents) {
      const tags = a.capabilityTags.length > 0 ? ` [${a.capabilityTags.slice(0, 5).join(', ')}]` : '';
      const role = a.role ? ` ${a.role}` : '';
      lines.push(`- ${a.name}${role} (${a.status})${tags}${a.whatTheyDo ? ` — ${a.whatTheyDo}` : ''}`);
    }
  } else {
    lines.push('', 'Agent roster: none configured yet.');
  }

  if (model.activeRuns.length > 0) {
    lines.push('', 'In motion now:');
    for (const r of model.activeRuns) lines.push(`- run ${r.id} (workflow ${r.workflowId}) ${r.status}`);
  }

  if (model.pendingApprovals.length > 0) {
    lines.push('', 'Awaiting your approval:');
    for (const a of model.pendingApprovals) lines.push(`- ${a.title}${a.summary ? ` — ${a.summary}` : ''} (id ${a.id})`);
  }

  if (model.liveChannels.length > 0) {
    const summary = model.liveChannels.map((c) => `${c.kind}:${c.status}`).join(', ');
    lines.push('', `Channel presence: ${summary}`);
  }

  return lines.join('\n');
}
