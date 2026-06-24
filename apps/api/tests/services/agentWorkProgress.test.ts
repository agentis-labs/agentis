import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REALTIME_EVENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { createTestContext } from '../_helpers/createTestContext.js';
import { ObservabilityService } from '../../src/services/observability.js';
import { publishAgentWorkStep } from '../../src/services/agentWorkProgress.js';

describe('agent work progress', () => {
  it('persists non-workflow work steps with agent scope and correlation', async () => {
      const ctx = await createTestContext();
    try {
      const observability = new ObservabilityService(ctx.db, ctx.bus, ctx.logger);
      observability.startLegacyBridge();
      const agentId = randomUUID();
      ctx.db.insert(schema.agents).values({
        id: agentId,
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        userId: ctx.user.id,
        name: 'Codex',
        adapterType: 'codex',
      }).run();

      publishAgentWorkStep(ctx.bus, {
        workspaceId: ctx.workspace.id,
        ambientId: ctx.ambient.id,
        agentId,
        conversationId: 'conversation-1',
        clientTurnId: 'turn-1',
        phase: 'progress',
        description: 'Inspecting the workspace',
      });

      const events = observability.list({ workspaceId: ctx.workspace.id, scopeType: 'agent', scopeId: agentId });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'agent',
        status: 'progress',
        summary: 'Inspecting the workspace',
        agentId,
        correlationId: 'turn-1',
        sourceEvent: REALTIME_EVENTS.AGENT_WORK_STEP,
      });
    } finally {
      ctx.close();
    }
  });
});
