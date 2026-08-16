import { eq } from 'drizzle-orm';
import type { WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { normalizeExtensionManifest } from '../extensionRuntime.js';
import { WorkflowRevisionService } from './workflowRevisionService.js';

/**
 * Repair stale cross-desktop extension UUIDs after a separately exported
 * extension is installed. A repair is deliberately conservative: the missing
 * reference is changed only when the node's declared operation is provided by
 * exactly one extension in the target workspace.
 */
export function repairMissingExtensionReferences(
  db: AgentisSqliteDb,
  workspaceId: string,
  installedExtensionId: string,
): { workflows: number; nodes: number } {
  const extensions = db.select().from(schema.extensions)
    .where(eq(schema.extensions.workspaceId, workspaceId)).all();
  const installed = extensions.find((row) => row.id === installedExtensionId);
  if (!installed) return { workflows: 0, nodes: 0 };

  const installedOperations = new Set(normalizeExtensionManifest(installed.manifest, installed).operations.map((op) => op.name));
  const providersByOperation = new Map<string, string[]>();
  for (const extension of extensions) {
    for (const operation of normalizeExtensionManifest(extension.manifest, extension).operations) {
      const providers = providersByOperation.get(operation.name) ?? [];
      providers.push(extension.id);
      providersByOperation.set(operation.name, providers);
    }
  }
  const existingIds = new Set(extensions.map((extension) => extension.id));
  const revisions = new WorkflowRevisionService(db);
  let repairedWorkflows = 0;
  let repairedNodes = 0;

  for (const workflow of db.select().from(schema.workflows)
    .where(eq(schema.workflows.workspaceId, workspaceId)).all()) {
    const candidate = revisions.candidate(workspaceId, workflow.id);
    const active = revisions.active(workspaceId, workflow.id);
    const base = candidate?.revision ?? active.revision;
    const graph = structuredClone((candidate?.graph ?? active.graph) as WorkflowGraph);
    let changed = 0;
    graph.nodes = graph.nodes.map((node) => {
      if (node.config.kind !== 'extension_task') return node;
      const config = node.config as typeof node.config & { extensionId?: string; operationName?: string };
      if (!config.extensionId || existingIds.has(config.extensionId) || !config.operationName) return node;
      if (!installedOperations.has(config.operationName)) return node;
      const providers = providersByOperation.get(config.operationName) ?? [];
      if (providers.length !== 1 || providers[0] !== installedExtensionId) return node;
      changed += 1;
      return { ...node, config: { ...config, extensionId: installedExtensionId, extensionSlug: installed.slug } } as typeof node;
    });
    if (changed === 0) continue;

    revisions.createCandidate({
      workspaceId,
      workflowId: workflow.id,
      graph,
      baseRevisionId: base.id,
      source: 'self_heal',
      actor: { type: 'system' },
      reason: `Rebound ${changed} missing extension reference(s) to ${installed.slug}`,
    });
    repairedWorkflows += 1;
    repairedNodes += changed;
  }
  return { workflows: repairedWorkflows, nodes: repairedNodes };
}
