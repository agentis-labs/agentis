/** First-class persisted event rules for agent-authored orchestration. */

import { AgentisError } from '@agentis/core';
import { z } from 'zod';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import {
  deleteOrchestrationRule,
  listOrchestrationRules,
  orchestrationEventTypeSchema,
  upsertOrchestrationRule,
} from '../workflow/orchestrationRuleService.js';

export function registerOrchestrationRuleTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([{
    definition: {
      id: 'agentis.workflow.rule',
      family: 'app',
      description:
        'Create, inspect, update, or delete an EXECUTABLE workflow event rule. Use run.accomplished when the target may start only after the source definition-of-done passes; run.completed means execution stopped cleanly but is not business proof. Rules are persisted in the scheduler and survive restarts. This is not UI prose and not card order.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'upsert', 'delete'], description: 'Default: list.' },
          id: { type: 'string', description: 'Existing rule id for update/delete.' },
          appId: { type: 'string', description: 'Optional App scope for list and ownership validation.' },
          sourceWorkflowId: { type: 'string' },
          targetWorkflowId: { type: 'string' },
          eventType: { type: 'string', enum: orchestrationEventTypeSchema.options },
          sourceNodeId: { type: 'string' },
          filterExpression: { type: 'string' },
          inputMapping: { type: 'object', description: 'Target input key -> source event path.' },
          coalescePolicy: { type: 'string', enum: ['always_enqueue', 'coalesce_pending', 'latest_only'] },
          catchupPolicy: { type: 'string' },
          enabled: { type: 'boolean' },
        },
      },
      mutating: true,
      autoExecute: true,
      mcpExposed: true,
    },
    handler: (raw, ctx) => {
      const action = typeof raw.action === 'string' ? raw.action : 'list';
      if (action === 'list') {
        const rows = listOrchestrationRules(deps.db, ctx.workspaceId, typeof raw.appId === 'string' ? raw.appId : undefined);
        return { rules: rows, count: rows.length };
      }

      if (action === 'delete') {
        const id = z.string().uuid().parse(raw.id);
        deleteOrchestrationRule(deps.db, ctx.workspaceId, id);
        return { deleted: true, id };
      }

      if (action !== 'upsert') throw new AgentisError('VALIDATION_FAILED', `unknown workflow.rule action: ${action}`);
      const id = typeof raw.id === 'string' && raw.id ? z.string().uuid().parse(raw.id) : null;
      const saved = upsertOrchestrationRule(deps.db, ctx.workspaceId, raw, {
        ...(id ? { id } : {}),
        ...(typeof raw.appId === 'string' && raw.appId ? { appId: raw.appId } : {}),
      });
      return {
        rule: saved,
        persisted: true,
        semantic: saved.eventType === 'run.accomplished'
          ? 'business_success'
          : saved.eventType === 'run.completed'
            ? 'execution_completion_only'
            : saved.eventType,
        ...(saved.eventType === 'run.completed'
          ? { warning: 'run.completed does not prove the source objective. Use run.accomplished for success-gated progression.' }
          : {}),
      };
    },
  }]);
}
