/**
 * Durable realtime observability spine.
 *
 * This service is the bridge between low-level bus envelopes and the operator
 * command-center model. It persists a compact, human-oriented event row, keeps
 * raw payloads redacted, and republishes one normalized `observability.event`
 * envelope that every realtime surface can consume.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, max as drizzleMax } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { BusMessage, EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import type { ColdArchiveStore } from './storage/coldArchiveStore.js';

type ObservabilityKind =
  | 'run'
  | 'node'
  | 'agent'
  | 'tool'
  | 'handoff'
  | 'approval'
  | 'brain'
  | 'artifact'
  | 'listener'
  | 'budget'
  | 'workflow'
  | 'system';

type ObservabilityStatus = 'started' | 'progress' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'info';
type ObservabilityScopeType = 'workspace' | 'run' | 'agent' | 'workflow' | 'brain';

export interface ObservabilityEvent {
  id: string;
  workspaceId: string;
  sequenceNumber: number;
  scopeType: string;
  scopeId: string | null;
  kind: ObservabilityKind;
  status: ObservabilityStatus;
  title: string;
  summary: string;
  detail: string | null;
  actorType: string | null;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  runId: string | null;
  workflowId: string | null;
  agentId: string | null;
  nodeId: string | null;
  approvalId: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  progress: { completed?: number; total?: number; label?: string } | null;
  evidence: Array<Record<string, unknown>>;
  rawPayloadRedacted: Record<string, unknown>;
  sourceEvent: string;
  createdAt: string;
}

interface RecordInput {
  workspaceId: string;
  scopeType?: ObservabilityScopeType;
  scopeId?: string | null;
  kind: ObservabilityKind;
  status: ObservabilityStatus;
  title: string;
  summary?: string | null;
  detail?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  runId?: string | null;
  workflowId?: string | null;
  agentId?: string | null;
  nodeId?: string | null;
  approvalId?: string | null;
  correlationId?: string | null;
  parentEventId?: string | null;
  progress?: { completed?: number; total?: number; label?: string } | null;
  evidence?: Array<Record<string, unknown>>;
  rawPayload?: Record<string, unknown>;
  sourceEvent: string;
  createdAt?: string;
}

export class ObservabilityService {
  readonly #seqCache = new Map<string, number>();
  #unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
    private readonly logger?: Logger,
    private readonly archive?: ColdArchiveStore,
  ) {}

  startLegacyBridge(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.bus.subscribe((message) => {
      const input = this.#fromBusMessage(message);
      if (!input) return;
      try {
        this.record(input);
      } catch (err) {
        this.logger?.warn('observability.record_failed', {
          event: message.envelope.event,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  record(input: RecordInput): ObservabilityEvent {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const sequenceNumber = this.#nextSequence(input.workspaceId);
    const id = randomUUID();
    const scope = this.#scopeFor(input);
    // Telemetry must never fail because the thing it describes isn't persisted
    // yet. A `workflow.build.phase` event fires WHILE a workflow is being built —
    // its workflowId has no row until the build commits — and the FK on
    // workflow_id/run_id/agent_id would otherwise abort the insert and drop the
    // event. Null out any reference whose target doesn't exist; the event still
    // records (linkage is best-effort), instead of being lost to a FK error.
    const runId = this.#fkOrNull(schema.workflowRuns, input.runId);
    const workflowId = this.#fkOrNull(schema.workflows, input.workflowId);
    const agentId = this.#fkOrNull(schema.agents, input.agentId);
    const row = {
      id,
      workspaceId: input.workspaceId,
      sequenceNumber,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      kind: input.kind,
      status: input.status,
      title: clip(input.title, 160) || 'Workspace event',
      summary: clip(input.summary ?? '', 280),
      detail: input.detail ? clip(input.detail, 2_000) : null,
      actorType: input.actorType ?? null,
      actorId: input.actorId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      runId,
      workflowId,
      agentId,
      nodeId: input.nodeId ?? null,
      approvalId: input.approvalId ?? null,
      correlationId: input.correlationId ?? null,
      parentEventId: input.parentEventId ?? null,
      progress: input.progress ?? null,
      evidence: input.evidence ?? [],
      rawPayloadRedacted: redact(input.rawPayload ?? {}),
      sourceEvent: input.sourceEvent,
      createdAt,
    } satisfies ObservabilityEvent;

    this.db.insert(schema.observabilityEvents).values(row).run();
    this.bus.publish(REALTIME_ROOMS.workspace(input.workspaceId), REALTIME_EVENTS.OBSERVABILITY_EVENT, row, input.correlationId ?? undefined);
    if (row.runId) this.bus.publish(REALTIME_ROOMS.run(row.runId), REALTIME_EVENTS.OBSERVABILITY_EVENT, row, input.correlationId ?? undefined);
    if (row.agentId) this.bus.publish(REALTIME_ROOMS.agent(row.agentId), REALTIME_EVENTS.OBSERVABILITY_EVENT, row, input.correlationId ?? undefined);
    if (row.workflowId) this.bus.publish(REALTIME_ROOMS.workflow(row.workflowId), REALTIME_EVENTS.OBSERVABILITY_EVENT, row, input.correlationId ?? undefined);
    return row;
  }

  list(args: {
    workspaceId: string;
    scopeType?: string;
    scopeId?: string | null;
    afterSequence?: number;
    limit?: number;
  }): ObservabilityEvent[] {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const after = args.afterSequence ?? 0;
    const conditions = [
      eq(schema.observabilityEvents.workspaceId, args.workspaceId),
      gt(schema.observabilityEvents.sequenceNumber, after),
    ];
    switch (args.scopeType) {
      case 'run':
        if (args.scopeId) conditions.push(eq(schema.observabilityEvents.runId, args.scopeId));
        break;
      case 'agent':
        if (args.scopeId) conditions.push(eq(schema.observabilityEvents.agentId, args.scopeId));
        break;
      case 'workflow':
        if (args.scopeId) conditions.push(eq(schema.observabilityEvents.workflowId, args.scopeId));
        break;
      case 'brain':
        conditions.push(eq(schema.observabilityEvents.kind, 'brain'));
        break;
      default:
        break;
    }
    const hot = this.db
      .select()
      .from(schema.observabilityEvents)
      .where(and(...conditions))
      .orderBy(asc(schema.observabilityEvents.sequenceNumber))
      .limit(limit)
      .all()
      .map(toEvent);
    const archived = (this.archive?.listObservabilityEvents(args.workspaceId) ?? [])
      .filter((row) => Number(row.sequenceNumber ?? 0) > after)
      .map((row) => toEvent(row as typeof schema.observabilityEvents.$inferSelect))
      .filter((event) => this.matchesScope(event, args));
    const merged = new Map<string, ObservabilityEvent>();
    for (const event of [...archived, ...hot]) merged.set(event.id, event);
    return [...merged.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber).slice(0, limit);
  }

  matchesScope(event: ObservabilityEvent, args: { workspaceId: string; scopeType?: string; scopeId?: string | null }): boolean {
    if (event.workspaceId !== args.workspaceId) return false;
    switch (args.scopeType) {
      case 'run': return Boolean(args.scopeId) && event.runId === args.scopeId;
      case 'agent': return Boolean(args.scopeId) && event.agentId === args.scopeId;
      case 'workflow': return Boolean(args.scopeId) && event.workflowId === args.scopeId;
      case 'brain': return event.kind === 'brain';
      case 'workspace':
      default: return true;
    }
  }

  /**
   * Return `id` only if a row with that id exists in `table`, else null — so a
   * telemetry row never trips a FK constraint by pointing at an entity that
   * hasn't been persisted yet (e.g. a workflow mid-build). Best-effort: any query
   * error also degrades to null rather than throwing.
   */
  #fkOrNull(table: { id: AnySQLiteColumn }, id: string | null | undefined): string | null {
    if (!id) return null;
    try {
      const row = this.db.select({ id: table.id }).from(table as never).where(eq(table.id, id)).limit(1).get();
      return row ? id : null;
    } catch {
      return null;
    }
  }

  #nextSequence(workspaceId: string): number {
    const cached = this.#seqCache.get(workspaceId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.#seqCache.set(workspaceId, next);
      return next;
    }
    const row = this.db
      .select({ m: drizzleMax(schema.observabilityEvents.sequenceNumber) })
      .from(schema.observabilityEvents)
      .where(eq(schema.observabilityEvents.workspaceId, workspaceId))
      .get();
    const next = (row?.m ?? 0) + 1;
    this.#seqCache.set(workspaceId, next);
    return next;
  }

  #scopeFor(input: RecordInput): { scopeType: ObservabilityScopeType; scopeId: string | null } {
    if (input.scopeType) return { scopeType: input.scopeType, scopeId: input.scopeId ?? input.workspaceId };
    if (input.runId) return { scopeType: 'run', scopeId: input.runId };
    if (input.agentId) return { scopeType: 'agent', scopeId: input.agentId };
    if (input.workflowId) return { scopeType: 'workflow', scopeId: input.workflowId };
    if (input.kind === 'brain') return { scopeType: 'brain', scopeId: input.workspaceId };
    return { scopeType: 'workspace', scopeId: input.workspaceId };
  }

  #fromBusMessage(message: BusMessage): RecordInput | null {
    const event = message.envelope.event;
    if (event === REALTIME_EVENTS.OBSERVABILITY_EVENT || event === REALTIME_EVENTS.AGENT_HEARTBEAT) return null;
    if (event === REALTIME_EVENTS.LEDGER_EVENT) return null;

    const payload = asRecord(message.envelope.payload);
    const workspaceId = this.#workspaceIdFor(message, payload);
    if (!workspaceId) return null;

    const runId = stringField(payload, 'runId') ?? (event.startsWith('run.') ? stringField(payload, 'id') : undefined);
    const workflowId = stringField(payload, 'workflowId');
    const agentId = stringField(payload, 'agentId');
    const nodeId = stringField(payload, 'nodeId') ?? stringField(payload, 'taskId');
    const approvalId = stringField(payload, 'approvalId') ?? (event === REALTIME_EVENTS.APPROVAL_REQUESTED ? stringField(payload, 'id') : undefined);
    const at = stringField(payload, 'at') ?? stringField(payload, 'timestamp') ?? message.envelope.emittedAt;
    const common = {
      workspaceId,
      runId,
      workflowId,
      agentId,
      nodeId,
      approvalId,
      correlationId: message.envelope.correlationId ?? null,
      rawPayload: payload,
      sourceEvent: event,
      createdAt: at,
    };

    if (event === REALTIME_EVENTS.RUN_CREATED || event === REALTIME_EVENTS.RUN_RUNNING || event === REALTIME_EVENTS.RUN_QUEUED) {
      return {
        ...common,
        kind: 'run',
        status: event === REALTIME_EVENTS.RUN_QUEUED ? 'waiting' : 'started',
        title: stringField(payload, 'workflowName', 'title') ?? 'Run started',
        summary: stringField(payload, 'currentStep', 'status', 'reason') ?? 'Execution is underway.',
        progress: progressFrom(payload),
      };
    }
    if (event === REALTIME_EVENTS.RUN_COMPLETED) {
      const accomplished = payload.accomplished;
      return {
        ...common,
        kind: 'run',
        status: accomplished === false ? 'blocked' : 'completed',
        title: stringField(payload, 'workflowName', 'title') ?? (accomplished === false ? 'Run finished — outcome not accomplished' : 'Run completed'),
        summary: stringField(payload, 'summary', 'result')
          ?? (accomplished === true
            ? 'Execution completed and the business outcome was verified.'
            : accomplished === false
              ? `Execution completed mechanically, but the business verdict is ${stringField(payload, 'verdict') ?? 'deficient'}.`
              : 'Execution completed without a business-outcome verdict.'),
      };
    }
    if (event === REALTIME_EVENTS.RUN_FAILED) {
      return {
        ...common,
        kind: 'run',
        status: 'failed',
        title: stringField(payload, 'workflowName', 'title') ?? 'Run failed',
        summary: stringField(payload, 'error', 'reason', 'failedNode') ?? 'The run needs operator attention.',
      };
    }

    if (event === REALTIME_EVENTS.NODE_STARTED || event === REALTIME_EVENTS.NODE_COMPLETED || event === REALTIME_EVENTS.NODE_FAILED || event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT || event === REALTIME_EVENTS.NODE_RETRY_SCHEDULED) {
      const status: ObservabilityStatus =
        event === REALTIME_EVENTS.NODE_COMPLETED ? 'completed'
          : event === REALTIME_EVENTS.NODE_FAILED ? 'failed'
            : event === REALTIME_EVENTS.NODE_WAITING_FOR_INPUT ? 'waiting'
              : event === REALTIME_EVENTS.NODE_RETRY_SCHEDULED ? 'blocked'
                : 'started';
      return {
        ...common,
        kind: 'node',
        status,
        title: stringField(payload, 'nodeTitle', 'title') ?? titleFromEvent(event),
        summary: stringField(payload, 'outputPreview', 'summary', 'error', 'reason', 'detail') ?? summaryFromStatus(status),
      };
    }

    if (event === REALTIME_EVENTS.AGENT_WORK_STEP) {
      const phase = stringField(payload, 'phase');
      const summary = stringField(payload, 'description', 'detail', 'message', 'step') ?? 'Working';
      return {
        ...common,
        kind: 'agent',
        status: phase === 'fail' ? 'failed' : phase === 'complete' ? 'completed' : 'progress',
        title: stringField(payload, 'agentName', 'actorName') ?? 'Agent working',
        summary,
        progress: progressFrom(nonEmptyRecord(payload.progress) ?? payload),
      };
    }

    if (event === REALTIME_EVENTS.AGENT_TERMINAL_TOOL_CALL) {
      const tool = stringField(payload, 'tool', 'toolName', 'name', 'command') ?? 'tool';
      return {
        ...common,
        kind: 'tool',
        status: payload.result !== undefined ? 'completed' : 'progress',
        title: `Tool: ${tool}`,
        summary: payload.result !== undefined ? 'Tool returned evidence.' : 'Tool is running.',
        evidence: [{ label: 'tool', value: tool }],
      };
    }

    if (event === REALTIME_EVENTS.AGENT_TERMINAL_MESSAGE) {
      const messageText = stringField(payload, 'message', 'text', 'line', 'token');
      if (!messageText) return null;
      return {
        ...common,
        kind: 'agent',
        status: 'progress',
        title: stringField(payload, 'agentName', 'actorName') ?? 'Agent update',
        summary: messageText,
      };
    }

    if (event === REALTIME_EVENTS.AGENT_STATUS_CHANGED) {
      return {
        ...common,
        kind: 'agent',
        status: 'info',
        title: stringField(payload, 'agentName', 'name') ?? 'Agent status changed',
        summary: stringField(payload, 'status', 'nextStatus') ?? 'Status updated.',
      };
    }

    if (event === REALTIME_EVENTS.APPROVAL_REQUESTED || event === REALTIME_EVENTS.APPROVAL_RESOLVED) {
      const requested = event === REALTIME_EVENTS.APPROVAL_REQUESTED;
      return {
        ...common,
        kind: 'approval',
        status: requested ? 'waiting' : 'completed',
        title: stringField(payload, 'title', 'agentName') ?? (requested ? 'Approval requested' : 'Approval resolved'),
        summary: stringField(payload, 'summary', 'decision', 'status') ?? (requested ? 'Operator input is required.' : 'The request was handled.'),
      };
    }

    if (event.startsWith('brain.')) {
      return {
        ...common,
        scopeType: 'brain',
        scopeId: workspaceId,
        kind: 'brain',
        status: event.includes('degraded') || event.includes('dispute') || event.includes('contradiction') ? 'blocked' : 'progress',
        title: titleFromEvent(event),
        summary: stringField(payload, 'summary', 'title', 'reason') ?? 'Workspace intelligence changed.',
      };
    }

    if (event.startsWith('listener.')) {
      return {
        ...common,
        kind: 'listener',
        status: event.includes('error') || event.includes('disconnected') ? 'failed' : 'progress',
        title: titleFromEvent(event),
        summary: stringField(payload, 'summary', 'message', 'error') ?? 'Listener activity changed.',
      };
    }

    if (event.startsWith('budget.')) {
      return {
        ...common,
        kind: 'budget',
        status: 'blocked',
        title: titleFromEvent(event),
        summary: stringField(payload, 'summary', 'message') ?? 'Budget threshold reached.',
      };
    }

    if (event.startsWith('artifact.')) {
      return {
        ...common,
        kind: 'artifact',
        status: event.endsWith('deleted') ? 'completed' : 'info',
        title: titleFromEvent(event),
        summary: stringField(nonEmptyRecord(payload.artifact) ?? payload, 'title', 'name') ?? 'Artifact changed.',
      };
    }

    if (event.startsWith('workflow.build') || event.startsWith('canvas.')) {
      return {
        ...common,
        kind: 'workflow',
        status: event.endsWith('complete') ? 'completed' : 'progress',
        title: titleFromEvent(event),
        summary: stringField(payload, 'detail', 'message', 'summary') ?? 'Workflow build activity.',
      };
    }

    return null;
  }

  #workspaceIdFor(message: BusMessage, payload: Record<string, unknown>): string | null {
    const direct = stringField(payload, 'workspaceId');
    if (direct) return direct;
    if (message.room.startsWith('workspace:')) return message.room.slice('workspace:'.length);
    const runId = stringField(payload, 'runId') ?? (message.room.startsWith('run:') ? message.room.slice('run:'.length) : null);
    if (runId) {
      const row = this.db
        .select({ workspaceId: schema.workflowRuns.workspaceId })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, runId))
        .get();
      if (row?.workspaceId) return row.workspaceId;
    }
    const agentId = stringField(payload, 'agentId') ?? (message.room.startsWith('agent:') ? message.room.slice('agent:'.length) : null);
    if (agentId) {
      const row = this.db
        .select({ workspaceId: schema.agents.workspaceId })
        .from(schema.agents)
        .where(eq(schema.agents.id, agentId))
        .get();
      if (row?.workspaceId) return row.workspaceId;
    }
    const workflowId = stringField(payload, 'workflowId') ?? (message.room.startsWith('workflow:') ? message.room.slice('workflow:'.length) : null);
    if (workflowId) {
      const row = this.db
        .select({ workspaceId: schema.workflows.workspaceId })
        .from(schema.workflows)
        .where(eq(schema.workflows.id, workflowId))
        .get();
      if (row?.workspaceId) return row.workspaceId;
    }
    return null;
  }
}

function toEvent(row: typeof schema.observabilityEvents.$inferSelect): ObservabilityEvent {
  return {
    ...row,
    kind: row.kind as ObservabilityKind,
    status: row.status as ObservabilityStatus,
    progress: row.progress as ObservabilityEvent['progress'],
    evidence: Array.isArray(row.evidence) ? row.evidence as Array<Record<string, unknown>> : [],
    rawPayloadRedacted: asRecord(row.rawPayloadRedacted),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? record : null;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (!key) continue;
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function numberField(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function progressFrom(source: Record<string, unknown>): ObservabilityEvent['progress'] {
  const completed = numberField(source, 'completed', 'done', 'stepIndex');
  const total = numberField(source, 'total', 'totalSteps');
  if (completed == null && total == null) return null;
  return {
    ...(completed != null ? { completed } : {}),
    ...(total != null ? { total } : {}),
  };
}

function titleFromEvent(event: string): string {
  return event
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function summaryFromStatus(status: ObservabilityStatus): string {
  if (status === 'completed') return 'Step completed.';
  if (status === 'failed') return 'Step failed.';
  if (status === 'waiting') return 'Waiting for operator input.';
  if (status === 'blocked') return 'Work is blocked.';
  return 'Step started.';
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/(secret|token|password|api[_-]?key|authorization|credential)/i.test(key)) {
      out[key] = '[redacted]';
    } else if (Array.isArray(raw)) {
      out[key] = raw.slice(0, 20).map((item) => asRecord(item) === item ? redact(item as Record<string, unknown>) : item);
    } else if (raw && typeof raw === 'object') {
      out[key] = redact(raw as Record<string, unknown>);
    } else if (typeof raw === 'string') {
      out[key] = clip(raw, 4_000);
    } else {
      out[key] = raw;
    }
  }
  return out;
}
