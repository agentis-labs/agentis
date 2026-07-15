/** Database adapter for the pure App conformance doctor. */

import { and, eq, inArray, or } from 'drizzle-orm';
import { AgentisError, surfaceActionSchema, type SurfaceAction, type WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AppDoctorSnapshot } from './appDoctor.js';

export function collectAppDoctorSnapshot(db: AgentisSqliteDb, workspaceId: string, appId: string): AppDoctorSnapshot {
  const app = db.select({ id: schema.apps.id, name: schema.apps.name, status: schema.apps.status })
    .from(schema.apps).where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId))).get();
  if (!app) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);

  const workflowRows = db.select({
    id: schema.workflows.id,
    title: schema.workflows.title,
    graph: schema.workflows.graph,
    settings: schema.workflows.settings,
    contentHash: schema.workflows.contentHash,
  }).from(schema.workflows)
    .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId))).all();
  const workflowIds = workflowRows.map((workflow) => workflow.id);

  const triggerRows = workflowIds.length === 0 ? [] : db.select({
    id: schema.triggers.id,
    workflowId: schema.triggers.workflowId,
    triggerType: schema.triggers.triggerType,
    status: schema.triggers.status,
  }).from(schema.triggers)
    .where(and(eq(schema.triggers.workspaceId, workspaceId), inArray(schema.triggers.workflowId, workflowIds))).all();
  const triggersByWorkflow = new Map<string, typeof triggerRows>();
  for (const trigger of triggerRows) {
    const bucket = triggersByWorkflow.get(trigger.workflowId) ?? [];
    bucket.push(trigger); triggersByWorkflow.set(trigger.workflowId, bucket);
  }

  const subscriptionRows = workflowIds.length === 0 ? [] : db.select().from(schema.workflowEventSubscriptions)
    .where(and(
      eq(schema.workflowEventSubscriptions.workspaceId, workspaceId),
      or(
        inArray(schema.workflowEventSubscriptions.sourceWorkflowId, workflowIds),
        inArray(schema.workflowEventSubscriptions.targetWorkflowId, workflowIds),
      ),
    )).all();

  const collectionRows = db.select({
    id: schema.appCollections.id,
    name: schema.appCollections.name,
    schemaJson: schema.appCollections.schemaJson,
  }).from(schema.appCollections)
    .where(and(eq(schema.appCollections.workspaceId, workspaceId), eq(schema.appCollections.appId, appId))).all();
  const scriptCollectionIds = collectionRows.filter((collection) => collection.name === 'conversation_script').map((collection) => collection.id);
  const scriptRecords = scriptCollectionIds.length === 0 ? [] : db.select({
    id: schema.appRecords.id,
    collectionId: schema.appRecords.collectionId,
    dataJson: schema.appRecords.dataJson,
  }).from(schema.appRecords)
    .where(and(eq(schema.appRecords.workspaceId, workspaceId), inArray(schema.appRecords.collectionId, scriptCollectionIds))).all();

  const surfaces = db.select({
    id: schema.appSurfaces.id,
    name: schema.appSurfaces.name,
    viewJson: schema.appSurfaces.viewJson,
    actionsJson: schema.appSurfaces.actionsJson,
  }).from(schema.appSurfaces)
    .where(and(eq(schema.appSurfaces.workspaceId, workspaceId), eq(schema.appSurfaces.appId, appId))).all();

  const connections = db.select({
    id: schema.channelConnections.id,
    name: schema.channelConnections.name,
    kind: schema.channelConnections.kind,
    appId: schema.channelConnections.appId,
    status: schema.channelConnections.status,
  }).from(schema.channelConnections).where(eq(schema.channelConnections.workspaceId, workspaceId)).all();

  return {
    app,
    workflows: workflowRows.map((workflow) => ({
      ...workflow,
      graph: workflow.graph as WorkflowGraph,
      triggers: (triggersByWorkflow.get(workflow.id) ?? []).map(({ id, triggerType, status }) => ({ id, triggerType, status })),
    })),
    subscriptions: subscriptionRows.map((subscription) => ({
      id: subscription.id,
      sourceWorkflowId: subscription.sourceWorkflowId,
      targetWorkflowId: subscription.targetWorkflowId,
      eventType: subscription.eventType,
      sourceNodeId: subscription.sourceNodeId,
      enabled: subscription.enabled,
    })),
    connections,
    collections: collectionRows.map((collection) => ({
      name: collection.name,
      schema: collection.schemaJson as AppDoctorSnapshot['collections'][number]['schema'],
      records: scriptRecords.filter((item) => item.collectionId === collection.id).map((item) => ({
        id: item.id,
        data: item.dataJson as Record<string, unknown>,
      })),
    })),
    surfaces: surfaces.map((surface) => ({
      id: surface.id,
      name: surface.name,
      view: surface.viewJson,
      actions: parseActions(surface.actionsJson),
    })),
  };
}

function parseActions(value: unknown): SurfaceAction[] {
  const parsed = surfaceActionSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

