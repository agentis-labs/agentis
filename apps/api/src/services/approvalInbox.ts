/**
 * Approval inbox.
 *
 * Sources (V1-SPEC §11.10): checkpoint nodes, OpenClaw exec proposals,
 * package install requests, credential access prompts. The dashboard subscribes
 * to `approval.requested` / `approval.resolved` and shows an inbox row per
 * pending item.
 *
 * Resolution callback hook: when a checkpoint approval is approved, we call
 * back into the engine via the supplied `onCheckpointResolved` so the run
 * resumes deterministically.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

type ApprovalRow = typeof schema.approvalRequests.$inferSelect;

export type PresentedApproval = ApprovalRow & {
  payload: Record<string, unknown>;
  workflowId: string | null;
  workflowName: string | null;
  agentName: string | null;
  nodeTitle: string | null;
  nodeType: string | null;
};

export interface ApprovalCreateArgs {
  workspaceId: string;
  ambientId: string | null;
  userId: string;
  runId: string | null;
  taskId: string | null;
  targetId?: string | null;
  gatewayId: string | null;
  source: 'checkpoint' | 'phase_gate' | 'self_heal' | 'openclaw_exec' | 'package_install' | 'credential_access' | 'budget_limit' | 'outbound';
  title: string;
  summary: string;
  confidence: number | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Invoked when a run-resuming approval (`checkpoint` or `phase_gate`) is resolved.
 * `targetId` carries the gated entity id — the checkpoint node id, or the phase id.
 */
export type CheckpointResumeHandler = (args: {
  runId: string;
  approvalId: string;
  source: string;
  targetId: string | null;
  decision: 'approve' | 'reject' | 'revise';
  /** Submitted form values for a `human_input` node (becomes the node output). */
  data?: Record<string, unknown>;
  /**
   * Operator's free-text instruction for a `revise` decision — delivered to the
   * waiting agent (orchestrator/manager) so it can adjust course WITHOUT the run
   * being torn down. Ignored for approve/reject.
   */
  feedback?: string;
}) => Promise<void>;

/**
 * Invoked when an `outbound` approval (an App's held outbound message — G7) is
 * resolved. On approve the held message is delivered; on reject it is dropped.
 * The payload carries the App/conversation/channel context needed to deliver.
 */
export type OutboundApprovalHandler = (args: {
  approvalId: string;
  decision: 'approve' | 'reject';
  payload: Record<string, unknown>;
}) => Promise<void>;

export class ApprovalInboxService {
  #onCheckpointResolved: CheckpointResumeHandler | null = null;
  #onOutboundResolved: OutboundApprovalHandler | null = null;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
  ) {}

  bindCheckpointHandler(handler: CheckpointResumeHandler): void {
    this.#onCheckpointResolved = handler;
  }

  /** Bind the deliver-on-approve hook for App outbound approvals (G7). */
  bindOutboundHandler(handler: OutboundApprovalHandler): void {
    this.#onOutboundResolved = handler;
  }

  async create(args: ApprovalCreateArgs) {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .insert(schema.approvalRequests)
      .values({
        id,
        workspaceId: args.workspaceId,
        ambientId: args.ambientId,
        userId: args.userId,
        runId: args.runId,
        taskId: args.taskId,
        targetId: args.targetId ?? null,
        gatewayId: args.gatewayId,
        source: args.source,
        title: args.title,
        summary: args.summary,
        confidence: args.confidence,
        payload: args.payload ?? {},
        status: 'pending',
        createdAt,
      })
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.APPROVAL_REQUESTED, {
      id,
      ...args,
      status: 'pending',
      createdAt,
    });
    return { id, ...args, status: 'pending' as const, createdAt };
  }

  list(workspaceId: string, status: 'pending' | 'all' = 'pending'): PresentedApproval[] {
    const rows = this.db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.workspaceId, workspaceId))
      .all();
    
    const filteredRows = status === 'all' ? rows : rows.filter((r) => r.status === 'pending');
    
    if (filteredRows.length > 0) {
      const runIds = [...new Set(filteredRows.map(r => r.runId).filter(Boolean))] as string[];
      if (runIds.length > 0) {
        const runs = this.db
          .select({ id: schema.workflowRuns.id, status: schema.workflowRuns.status })
          .from(schema.workflowRuns)
          .where(inArray(schema.workflowRuns.id, runIds))
          .all();
        
        const activeStatuses = new Set(['CREATED', 'PLANNING', 'RUNNING', 'WAITING', 'PAUSED']);
        const knownRunIds = new Set(runs.map(r => r.id));
        const activeRunIds = new Set(runs.filter(r => activeStatuses.has(r.status)).map(r => r.id));
        
        return filteredRows
          .filter(r => !r.runId || !knownRunIds.has(r.runId) || activeRunIds.has(r.runId))
          .map((row) => this.#present(row));
      }
    }
    
    return filteredRows.map((row) => this.#present(row));
  }

  get(workspaceId: string, approvalId: string): PresentedApproval | null {
    const row = this.db
      .select()
      .from(schema.approvalRequests)
      .where(and(eq(schema.approvalRequests.id, approvalId), eq(schema.approvalRequests.workspaceId, workspaceId)))
      .get();
    return row ? this.#present(row) : null;
  }

  async resolve(args: {
    workspaceId: string;
    approvalId: string;
    decision: 'approve' | 'reject' | 'revise';
    reason?: string;
    /** Submitted form values for a `human_input` node. */
    data?: Record<string, unknown>;
    /** Operator instruction for a `revise` decision (see CheckpointResumeHandler). */
    feedback?: string;
  }) {
    const row = this.db
      .select()
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.id, args.approvalId),
          eq(schema.approvalRequests.workspaceId, args.workspaceId),
        ),
      )
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Approval not found');
    if (row.status !== 'pending') {
      throw new AgentisError('RESOURCE_CONFLICT', `Approval already ${row.status}`);
    }
    // `revise` is a non-destructive third decision: the operator sends a new
    // instruction back to the waiting agent instead of approving or cancelling
    // (which would tear down the run). The original request is retired as
    // `revised`; the agent decides what to do next and may re-request approval.
    const next = args.decision === 'approve' ? 'approved' : args.decision === 'revise' ? 'revised' : 'rejected';
    // The instruction rides in `feedback` for revise, or `reason` for approve/reject.
    const resolutionReason = args.decision === 'revise' ? (args.feedback ?? args.reason ?? null) : (args.reason ?? null);
    const resolvedAt = new Date().toISOString();
    this.db
      .update(schema.approvalRequests)
      .set({
        status: next,
        resolutionReason,
        resolvedAt,
      })
      .where(eq(schema.approvalRequests.id, row.id))
      .run();
    this.bus.publish(REALTIME_ROOMS.workspace(row.workspaceId), REALTIME_EVENTS.APPROVAL_RESOLVED, {
      id: row.id,
      status: next,
      resolvedAt,
    });
    if (row.runId && isRunResumingApproval(row.source) && this.#onCheckpointResolved) {
      await this.#onCheckpointResolved({
        runId: row.runId,
        approvalId: row.id,
        source: row.source,
        targetId: row.targetId ?? row.taskId ?? null,
        decision: args.decision,
        ...(args.data ? { data: args.data } : {}),
        ...(args.decision === 'revise' && resolutionReason ? { feedback: resolutionReason } : {}),
      });
    } else if (row.source === 'outbound' && this.#onOutboundResolved && args.decision !== 'revise') {
      // App outbound approval (G7): deliver the held message on approve, drop on reject.
      // `revise` has no meaning for a held one-shot outbound message, so it is a no-op here.
      await this.#onOutboundResolved({
        approvalId: row.id,
        decision: args.decision,
        payload: (row.payload ?? {}) as Record<string, unknown>,
      });
    }
    return { ...row, status: next, resolvedAt, resolutionReason };
  }

  #present(row: ApprovalRow): PresentedApproval {
    const context = this.#approvalContext(row);
    return {
      ...row,
      payload: redactForApprovalReview(asRecord(row.payload)) as Record<string, unknown>,
      workflowId: context.workflowId,
      workflowName: context.workflowName,
      agentName: context.agentName,
      nodeTitle: context.nodeTitle,
      nodeType: context.nodeType,
    };
  }

  #approvalContext(row: ApprovalRow): {
    workflowId: string | null;
    workflowName: string | null;
    agentName: string | null;
    nodeTitle: string | null;
    nodeType: string | null;
  } {
    let workflowId: string | null = null;
    let workflowName: string | null = null;
    let graph: unknown = null;
    let taskNodeId: string | null = null;
    let taskExecutorRef: string | null = null;
    let taskExecutorType: string | null = null;

    if (row.runId) {
      const run = this.db
        .select({
          workflowId: schema.workflowRuns.workflowId,
          graphSnapshot: schema.workflowRuns.graphSnapshot,
        })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, row.runId))
        .get();
      workflowId = run?.workflowId ?? null;
      graph = run?.graphSnapshot ?? null;
    }

    if (row.taskId) {
      const task = this.db
        .select({
          workflowId: schema.tasks.workflowId,
          nodeId: schema.tasks.nodeId,
          executorType: schema.tasks.executorType,
          executorRef: schema.tasks.executorRef,
          title: schema.tasks.title,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, row.taskId))
        .get();
      workflowId = workflowId ?? task?.workflowId ?? null;
      taskNodeId = task?.nodeId ?? null;
      taskExecutorRef = task?.executorRef ?? null;
      taskExecutorType = task?.executorType ?? null;
    }

    if (workflowId) {
      const workflow = this.db
        .select({ title: schema.workflows.title, graph: schema.workflows.graph, ownerAgentId: schema.workflows.ownerAgentId })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, workflowId))
        .get();
      workflowName = workflow?.title ?? null;
      graph = graph ?? workflow?.graph ?? null;
      if (!taskExecutorRef && workflow?.ownerAgentId) {
        taskExecutorType = 'agent';
        taskExecutorRef = workflow.ownerAgentId;
      }
    }

    const nodeId = row.targetId ?? taskNodeId;
    const node = nodeId ? findWorkflowGraphNode(graph, nodeId) : null;
    const agentId = taskExecutorType === 'agent'
      ? taskExecutorRef
      : node ? agentRefFromNode(node) : null;
    const agent = agentId
      ? this.db
        .select({ name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get()
      : null;

    return {
      workflowId,
      workflowName,
      agentName: agent?.name ?? null,
      nodeTitle: node ? String((node as Record<string, unknown>).title ?? nodeId) : null,
      nodeType: node ? String((node as Record<string, unknown>).type ?? ((node as Record<string, unknown>).config as { kind?: unknown } | undefined)?.kind ?? '') || null : null,
    };
  }
}

function isRunResumingApproval(source: string): boolean {
  return source === 'checkpoint' || source === 'phase_gate' || source === 'self_heal';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function findWorkflowGraphNode(graph: unknown, nodeId: string): Record<string, unknown> | null {
  const nodes = graph && typeof graph === 'object' ? (graph as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) return null;
  return (nodes.find((node) => (
    node && typeof node === 'object' && String((node as { id?: unknown }).id ?? '') === nodeId
  )) as Record<string, unknown> | undefined) ?? null;
}

function agentRefFromNode(node: Record<string, unknown>): string | null {
  const config = node.config && typeof node.config === 'object' ? node.config as Record<string, unknown> : {};
  const candidate = config.agentId ?? config.agent_id ?? config.assigneeAgentId ?? config.executorRef;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

const SECRET_KEY = /(password|secret|token|api[-_ ]?key|service[-_ ]?role|credential|authorization|bearer|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret)/i;

function redactForApprovalReview(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactForApprovalReview(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[Redacted]' : redactForApprovalReview(nested, depth + 1);
  }
  return out;
}
