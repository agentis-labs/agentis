/**
 * SessionMirror — bridges OpenClaw Gateway session events into the
 * Agentis conversation surface so operators see whatever the agent is
 * doing in its own UI.
 *
 * Wires into AdapterManager.onEvent and reacts to:
 *   - agent.session_message  → ConversationStore.appendMirrored
 *   - agent.approval_requested → ApprovalInbox.create(source='openclaw_exec')
 *   - agent.status           → DB update + realtime event
 *   - agent.heartbeat        → DB update only (high-frequency, no event)
 *
 * The mirror is workspace-aware: it looks up the agent row to find the
 * workspace and operator binding before writing.
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type NormalizedAgentEvent,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { ConversationStore } from './conversationStore.js';
import type { ApprovalInboxService } from './approvalInbox.js';

export interface SessionMirrorDeps {
  db: AgentisSqliteDb;
  bus: EventBus;
  logger: Logger;
  conversations: ConversationStore;
  approvals: ApprovalInboxService;
}

export class SessionMirror {
  constructor(private readonly deps: SessionMirrorDeps) {}

  /** Subscribe to AdapterManager events. */
  bind(register: (h: (event: NormalizedAgentEvent, agentId: string) => void) => () => void): () => void {
    return register((event, agentId) => {
      this.handle(event, agentId).catch((err) =>
        this.deps.logger.error('session_mirror.handler', { err: (err as Error).message, agentId }),
      );
    });
  }

  async handle(event: NormalizedAgentEvent, agentId: string): Promise<void> {
    const agent = this.deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    if (!agent) return;

    switch (event.eventType) {
      case 'agent.session_message': {
        const conversation = this.deps.conversations.getOrCreateByAgent({
          workspaceId: agent.workspaceId,
          ambientId: agent.ambientId,
          userId: agent.userId,
          agentId: agent.id,
          mirroredSessionId: event.sessionId,
        });
        this.deps.conversations.appendMirrored({
          workspaceId: agent.workspaceId,
          conversationId: conversation.id,
          sessionMessageId: event.sessionMessageId,
          body: event.body,
          authorType: event.authorType === 'operator' ? 'system' : event.authorType,
        });
        return;
      }
      case 'agent.approval_requested': {
        await this.deps.approvals.create({
          workspaceId: agent.workspaceId,
          ambientId: agent.ambientId,
          userId: agent.userId,
          runId: event.runId ?? null,
          taskId: event.taskId ?? null,
          gatewayId: agent.gatewayId ?? null,
          source: 'openclaw_exec',
          title: event.title,
          summary: event.summary,
          confidence: null,
        });
        return;
      }
      case 'agent.status': {
        this.deps.db
          .update(schema.agents)
          .set({ status: event.status, updatedAt: new Date().toISOString() })
          .where(eq(schema.agents.id, agentId))
          .run();
        this.deps.bus.publish(
          REALTIME_ROOMS.workspace(agent.workspaceId),
          REALTIME_EVENTS.AGENT_STATUS_CHANGED,
          { agentId, status: event.status },
        );
        return;
      }
      case 'agent.heartbeat': {
        this.deps.db
          .update(schema.agents)
          .set({ lastHeartbeatAt: event.timestamp })
          .where(eq(schema.agents.id, agentId))
          .run();
        return;
      }
      default:
        return;
    }
  }
}
