import { AgentisError } from '@agentis/core';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

const SENSITIVITIES = new Set(['cautious', 'balanced', 'autonomous']);

export function registerPermissionTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.register(
    {
      id: 'agentis.permissions.configure',
      family: 'run',
      description:
        'Adjust how often the current conversation asks for permission. Use when the user asks you to be more cautious, use normal/balanced judgment, or ask less and act more autonomously. This changes the Ask-mode risk threshold only; protected actions and Plan mode remain enforced.',
      inputSchema: {
        type: 'object',
        properties: {
          sensitivity: {
            type: 'string',
            enum: ['cautious', 'balanced', 'autonomous'],
            description: 'cautious asks for medium+ risk; balanced asks for high+ risk; autonomous asks only for critical/protected actions.',
          },
        },
        required: ['sensitivity'],
      },
      mutating: true,
      autoExecute: true,
      approval: { riskLevel: 'low', reversible: true, externalSideEffects: false },
      mcpExposed: true,
    },
    (args, ctx) => {
      if (!ctx.conversationId) {
        throw new AgentisError('VALIDATION_FAILED', 'This preference can only be changed from an active conversation.');
      }
      const sensitivity = typeof args.sensitivity === 'string' ? args.sensitivity : '';
      if (!SENSITIVITIES.has(sensitivity)) {
        throw new AgentisError('VALIDATION_FAILED', 'sensitivity must be cautious, balanced, or autonomous');
      }
      const result = deps.db.update(schema.conversations)
        .set({ approvalSensitivity: sensitivity, updatedAt: new Date().toISOString() })
        .where(and(
          eq(schema.conversations.id, ctx.conversationId),
          eq(schema.conversations.workspaceId, ctx.workspaceId),
        ))
        .run();
      if (result.changes === 0) throw new AgentisError('RESOURCE_NOT_FOUND', 'Conversation not found');
      return {
        sensitivity,
        effectiveOn: 'next_turn',
        message: `Ask sensitivity is now ${sensitivity}.`,
      };
    },
  );
}
