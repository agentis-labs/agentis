import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus, BusMessage } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { analyzeRunFailure, diagnosisToCardBody } from './runFailureAnalysis.js';

export interface OrchestratorEventBridgeDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
}

export class OrchestratorEventBridge {
  #unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: OrchestratorEventBridgeDeps) {}

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.deps.bus.subscribe((message) => this.#handle(message));
    this.deps.logger.info('orchestrator.bridge.started');
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #handle(message: BusMessage): void {
    const event = message.envelope.event;
    if (
      event !== REALTIME_EVENTS.RUN_FAILED &&
      event !== REALTIME_EVENTS.WATCHDOG_TIMEOUT &&
      event !== REALTIME_EVENTS.BUDGET_EVENT_CREATED &&
      event !== REALTIME_EVENTS.APPROVAL_REQUESTED
    ) return;

    const workspaceId = workspaceFromRoom(message.room) ?? workspaceFromPayload(message.envelope.payload);
    if (!workspaceId) return;
    const agent = findOrchestratorAgent(this.deps.db, workspaceId);
    
    // We intentionally stop pushing ProactiveCards to the chat stream 
    // to keep chat for messages only.
    // const payload = buildProactivePayload(event, message.envelope.payload, agent?.id ?? null, { db: this.deps.db, workspaceId });
    // this.deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.AGENT_PROACTIVE_PUSH, payload);
    // if (agent) {
    //   this.deps.bus.publish(REALTIME_ROOMS.conversation(agent.id), REALTIME_EVENTS.AGENT_PROACTIVE_PUSH, payload);
    // }
  }
}

function workspaceFromRoom(room: string): string | null {
  return room.startsWith('workspace:') ? room.slice('workspace:'.length) : null;
}

function workspaceFromPayload(payload: unknown): string | null {
  return payload && typeof payload === 'object' && 'workspaceId' in payload
    ? String((payload as { workspaceId?: unknown }).workspaceId ?? '') || null
    : null;
}

function findOrchestratorAgent(db: AgentisSqliteDb, workspaceId: string) {
  return db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.workspaceId, workspaceId), eq(schema.agents.role, 'orchestrator')))
    .get() ?? null;
}

function buildProactivePayload(
  event: string,
  rawPayload: unknown,
  agentId: string | null,
  deps?: { db: AgentisSqliteDb; workspaceId: string },
) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload as Record<string, unknown> : {};
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
  if (event === REALTIME_EVENTS.RUN_FAILED) {
    // Auto-diagnose by DEFAULT: explain what failed and how to fix it up front,
    // grounded in the real error — instead of a "Diagnose" button the operator
    // has to click. (Settings → a per-workspace `autoDiagnoseFailures` toggle can
    // turn this back into a button; default on.)
    let body = runId ? `I noticed run ${runId.slice(0, 8)} failed.` : 'A workflow run failed.';
    let diagnosed = false;
    if (deps && runId) {
      try {
        const d = analyzeRunFailure(deps.db, deps.workspaceId, runId);
        if (d) { body = diagnosisToCardBody(d); diagnosed = true; }
      } catch { /* fall back to the generic body */ }
    }
    return {
      id: `proactive_${randomUUID()}`,
      agentId,
      runId,
      workflowId,
      kind: 'run_failed',
      card: {
        title: 'Run failed',
        body,
        tone: 'danger',
        actions: [
          ...(workflowId ? [{ label: 'Open workflow', action: `/workflows/${workflowId}`, params: { workflowId } }] : []),
          ...(runId && !diagnosed ? [{ label: 'Diagnose', action: 'agentis.run.diagnose', params: { runId }, variant: 'primary' as const }] : []),
        ],
      },
    };
  }
  if (event === REALTIME_EVENTS.APPROVAL_REQUESTED) {
    return {
      id: `proactive_${randomUUID()}`,
      agentId,
      kind: 'approval_requested',
      card: {
        title: 'Approval needed',
        body: String(payload.title ?? payload.summary ?? 'An agent is waiting for your decision.'),
        tone: 'warn',
        actions: [{ label: 'Review approvals', action: '/approvals', variant: 'primary' as const }],
      },
    };
  }
  if (event === REALTIME_EVENTS.WATCHDOG_TIMEOUT) {
    return {
      id: `proactive_${randomUUID()}`,
      agentId,
      runId,
      workflowId,
      kind: 'watchdog_timeout',
      card: {
        title: 'Run looks stuck',
        body: runId ? `The watchdog timed out on run ${runId.slice(0, 8)}.` : 'The watchdog reported a timeout.',
        tone: 'warn',
        actions: runId ? [{ label: 'Diagnose', action: 'agentis.run.diagnose', params: { runId }, variant: 'primary' as const }] : [],
      },
    };
  }
  return {
    id: `proactive_${randomUUID()}`,
    agentId,
    kind: 'budget_event',
    card: {
      title: 'Budget signal',
      body: String(payload.summary ?? payload.message ?? 'A budget event needs attention.'),
      tone: 'warn',
      actions: [{ label: 'Open dashboard', action: '/dashboard', variant: 'secondary' as const }],
    },
  };
}
