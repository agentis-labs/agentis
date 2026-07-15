import { randomUUID } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import { and, eq } from 'drizzle-orm';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { z } from 'zod';

export const orchestrationEventTypeSchema = z.enum([
  'run.completed',
  'run.accomplished',
  'run.failed',
  'node.completed',
  'node.failed',
]);

export const orchestrationRuleInputSchema = z.object({
  sourceWorkflowId: z.string().uuid(),
  targetWorkflowId: z.string().uuid(),
  eventType: orchestrationEventTypeSchema,
  sourceNodeId: z.string().min(1).nullable().optional(),
  filterExpression: z.string().max(2000).nullable().optional(),
  inputMapping: z.record(z.string(), z.string()).default({}),
  coalescePolicy: z.enum(['always_enqueue', 'coalesce_pending', 'latest_only']).default('always_enqueue'),
  catchupPolicy: z.string().default('enqueue_missed_with_cap:5'),
  enabled: z.boolean().default(true),
});

export type OrchestrationRuleInput = z.infer<typeof orchestrationRuleInputSchema>;

export function listOrchestrationRules(db: AgentisSqliteDb, workspaceId: string, appId?: string) {
  const rows = db.select().from(schema.workflowEventSubscriptions)
    .where(eq(schema.workflowEventSubscriptions.workspaceId, workspaceId)).all();
  if (!appId) return rows.map(toOrchestrationRuleResult);
  const ids = workflowIdsForApp(db, workspaceId, appId);
  return (ids.length === 0 ? [] : rows.filter((row) => ids.includes(row.sourceWorkflowId) || ids.includes(row.targetWorkflowId)))
    .map(toOrchestrationRuleResult);
}

export function upsertOrchestrationRule(
  db: AgentisSqliteDb,
  workspaceId: string,
  input: unknown,
  options: { id?: string; appId?: string } = {},
) {
  const id = options.id ? z.string().uuid().parse(options.id) : null;
  const existing = id ? findOrchestrationRule(db, workspaceId, id) : null;
  const merged = orchestrationRuleInputSchema.parse({
    ...(existing ? {
      sourceWorkflowId: existing.sourceWorkflowId,
      targetWorkflowId: existing.targetWorkflowId,
      eventType: existing.eventType,
      sourceNodeId: existing.sourceNodeId,
      filterExpression: existing.filterExpression,
      inputMapping: existing.inputMapping,
      coalescePolicy: existing.coalescePolicy,
      catchupPolicy: existing.catchupPolicy,
      enabled: existing.enabled,
    } : {}),
    ...(input && typeof input === 'object' ? input : {}),
  });
  const source = requireWorkflow(db, workspaceId, merged.sourceWorkflowId);
  const target = requireWorkflow(db, workspaceId, merged.targetWorkflowId);
  if (options.appId && (source.appId !== options.appId || target.appId !== options.appId)) {
    throw new AgentisError('VALIDATION_FAILED', 'both workflows must belong to the supplied App; adopt them before authoring the rule');
  }
  if (merged.sourceWorkflowId === merged.targetWorkflowId && merged.coalescePolicy === 'always_enqueue') {
    throw new AgentisError('VALIDATION_FAILED', 'a self-triggering rule must use coalesce_pending or latest_only to avoid an unbounded enqueue loop');
  }

  const now = new Date().toISOString();
  const values = {
    workspaceId,
    sourceWorkflowId: merged.sourceWorkflowId,
    targetWorkflowId: merged.targetWorkflowId,
    eventType: merged.eventType,
    sourceNodeId: merged.sourceNodeId ?? null,
    filterExpression: merged.filterExpression ?? null,
    inputMapping: merged.inputMapping,
    coalescePolicy: merged.coalescePolicy,
    catchupPolicy: merged.catchupPolicy,
    enabled: merged.enabled,
    updatedAt: now,
  };
  const ruleId = id ?? randomUUID();
  if (existing) db.update(schema.workflowEventSubscriptions).set(values).where(eq(schema.workflowEventSubscriptions.id, ruleId)).run();
  else db.insert(schema.workflowEventSubscriptions).values({ id: ruleId, ...values, createdAt: now }).run();
  return toOrchestrationRuleResult(findOrchestrationRule(db, workspaceId, ruleId));
}

export function deleteOrchestrationRule(db: AgentisSqliteDb, workspaceId: string, id: string): void {
  const existing = findOrchestrationRule(db, workspaceId, z.string().uuid().parse(id));
  db.delete(schema.workflowEventSubscriptions).where(eq(schema.workflowEventSubscriptions.id, existing.id)).run();
}

export function findOrchestrationRule(db: AgentisSqliteDb, workspaceId: string, id: string) {
  const row = db.select().from(schema.workflowEventSubscriptions)
    .where(and(eq(schema.workflowEventSubscriptions.workspaceId, workspaceId), eq(schema.workflowEventSubscriptions.id, id))).get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow event rule not found: ${id}`);
  return row;
}

function requireWorkflow(db: AgentisSqliteDb, workspaceId: string, workflowId: string) {
  const row = db.select({ id: schema.workflows.id, appId: schema.workflows.appId }).from(schema.workflows)
    .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId))).get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${workflowId}`);
  return row;
}

function workflowIdsForApp(db: AgentisSqliteDb, workspaceId: string, appId: string): string[] {
  return db.select({ id: schema.workflows.id }).from(schema.workflows)
    .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId))).all().map((row) => row.id);
}

export function toOrchestrationRuleResult(row: typeof schema.workflowEventSubscriptions.$inferSelect) {
  return {
    id: row.id,
    sourceWorkflowId: row.sourceWorkflowId,
    targetWorkflowId: row.targetWorkflowId,
    eventType: row.eventType,
    sourceNodeId: row.sourceNodeId,
    filterExpression: row.filterExpression,
    inputMapping: row.inputMapping,
    coalescePolicy: row.coalescePolicy,
    catchupPolicy: row.catchupPolicy,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
