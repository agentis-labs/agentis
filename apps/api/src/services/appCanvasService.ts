/**
 * AppCanvasService — persistence + validation for AppGraph instances.
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §13, §14.
 *
 * Responsibilities:
 *   1. Read/write the per-instance graph inside `app_instances.package_contents`.
 *   2. Compose the reference scope (workflows, agents, datasets, integrations,
 *      output labels) for a given app from existing stores.
 *   3. Validate a graph against its scope (structural + reference + product).
 *   4. Provide "from-package" helper that re-derives the instance graph from
 *      the manifest's `appGraphTemplate`.
 *
 * The service is intentionally synchronous and dependency-light: it talks to
 * the SQLite db directly (same pattern as other wedge stores) and consumes
 * stable types from `@agentis/core`.
 */

import { and, eq, or } from 'drizzle-orm';
import {
  AgentisError,
  emptyAppGraph,
  type AppGraph,
  type AppGraphNode,
  type AppGraphValidationIssue,
  type AppGraphValidationResult,
  type AppGraphReferenceScope,
  type AppCoreConfig,
  type EntryWorkflowConfig,
  type WorkflowModuleConfig,
  type AgentGroupConfig,
  type KnowledgeSourceConfig,
  type IntegrationSurfaceConfig,
  type OutputSurfaceConfig,
  APP_GRAPH_NODE_TYPES,
  APP_GRAPH_EDGE_TYPES,
} from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export interface AppCanvasRecord {
  id: string;
  slug: string;
  name: string;
  status: string;
  description?: string;
  graph: AppGraph;
  references: AppGraphReferenceScope;
  validation: AppGraphValidationResult;
}

export class AppCanvasService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // Read / write
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Load the canvas response for an app: graph, references, validation.
   *
   * If the app has no persisted graph yet, returns an empty graph plus a
   * scope-derived list of references so the editor can bootstrap.
   */
  load(workspaceId: string, appId: string): AppCanvasRecord {
    const pkg = this.loadPackage(workspaceId, appId);
    const contents = packageContents(pkg);
    const graph = (contents.appGraphTemplate as AppGraph | null | undefined) ?? emptyAppGraph();
    const references = this.collectReferences(workspaceId, appId, pkg);
    const validation = validateAppGraph(graph, references);
    return {
      id: pkg?.id ?? appId,
      slug: pkg?.slug ?? appId,
      name: pkg?.name ?? appId,
      status: pkg?.status ?? 'active',
      description: stringValue(contents.description) ?? stringValue(contents.summary),
      graph,
      references,
      validation,
    };
  }

  /**
   * Persist a graph for an app. Returns the saved record (with re-derived
   * references + validation). Throws if the package row is missing — callers
   * cannot create graphs for non-installed apps.
   */
  save(workspaceId: string, appId: string, graph: AppGraph): AppCanvasRecord {
    const pkg = this.loadPackage(workspaceId, appId);
    if (!pkg) {
      throw new AgentisError(
        'RESOURCE_NOT_FOUND',
        `app '${appId}' not installed — cannot save canvas`,
      );
    }
    const sanitized = sanitizeGraph(graph);
    const contents = { ...packageContents(pkg), appGraphTemplate: sanitized };
    this.db
      .update(schema.appInstances)
      .set({ packageContents: contents, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.appInstances.id, pkg.id),
          eq(schema.appInstances.workspaceId, workspaceId),
        ),
      )
      .run();
    this.logger.info('app_canvas.saved', {
      appId,
      nodeCount: sanitized.nodes.length,
      edgeCount: sanitized.edges.length,
    });
    return this.load(workspaceId, appId);
  }

  /**
   * Re-copy `manifest.appGraphTemplate` into `appGraph`. Used when the
   * operator wants to discard local edits and restore the package shape
   * (App Canvas §14.1 POST /canvas/from-package).
   */
  resetFromPackage(workspaceId: string, appId: string): AppCanvasRecord {
    const pkg = this.loadPackage(workspaceId, appId);
    if (!pkg) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `app '${appId}' not installed`);
    }
    const contents = packageContents(pkg);
    const template = contents.appGraphTemplate as AppGraph | undefined;
    const next = template ? sanitizeGraph(template) : emptyAppGraph();
    const nextContents = { ...contents, appGraphTemplate: next };
    this.db
      .update(schema.appInstances)
      .set({ packageContents: nextContents, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.appInstances.id, pkg.id),
          eq(schema.appInstances.workspaceId, workspaceId),
        ),
      )
      .run();
    return this.load(workspaceId, appId);
  }

  /**
   * Run validation for a graph candidate against the live scope without
   * persisting. Powers the "POST /canvas/validate" endpoint so the UI can
   * pre-flight an edit before committing.
   */
  validateCandidate(
    workspaceId: string,
    appId: string,
    graph: AppGraph,
  ): { references: AppGraphReferenceScope; validation: AppGraphValidationResult } {
    const pkg = this.loadPackage(workspaceId, appId);
    const references = this.collectReferences(workspaceId, appId, pkg);
    return { references, validation: validateAppGraph(graph, references) };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Reference scope
  // ──────────────────────────────────────────────────────────────────────

  private collectReferences(
    workspaceId: string,
    appId: string,
    pkg: typeof schema.appInstances.$inferSelect | null,
  ): AppGraphReferenceScope {
    // Workflows: via `package_id` if the package row exists; otherwise empty.
    const workflowRows = pkg
      ? this.db
          .select({ id: schema.workflows.id, title: schema.workflows.title, settings: schema.workflows.settings })
          .from(schema.workflows)
          .where(eq(schema.workflows.workspaceId, workspaceId))
          .all()
      : [];
    const workflows = workflowRows.map((w) => ({ id: w.id, title: w.title }));
    const collections = new Map<string, Array<{ id: string; title: string }>>();
    for (const workflow of workflowRows) {
      const settings = workflow.settings && typeof workflow.settings === 'object' && !Array.isArray(workflow.settings)
        ? workflow.settings as Record<string, unknown>
        : {};
      const name = typeof settings.collection === 'string' ? settings.collection.trim() : '';
      if (!name) continue;
      if (!collections.has(name)) collections.set(name, []);
      collections.get(name)!.push({ id: workflow.id, title: workflow.title });
    }

    const agents = pkg
      ? this.db
          .select({
            id: schema.agents.id,
            name: schema.agents.name,
            tags: schema.agents.capabilityTags,
          })
          .from(schema.agents)
          .where(eq(schema.agents.workspaceId, workspaceId))
          .all()
          .map((a) => ({
            id: a.id,
            name: a.name,
            role: extractRole(a.tags),
          }))
      : [];

    const contents = packageContents(pkg);
    const datasetSpecs = (contents.datasetSpecs as Array<{ key: string; label: string }>) ?? [];
    const integrationsSpec =
      (contents.integrations as Array<{ service: string; name?: string }>) ?? [];
    const outputLabels =
      (contents.outputLabels as Array<{ label: string; path: string }>) ?? [];

    return {
      workflows,
      collections: Array.from(collections.entries())
        .map(([name, collectionWorkflows]) => ({ name, workflows: collectionWorkflows }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      agents,
      datasets: datasetSpecs.map((s) => ({ key: s.key, label: s.label })),
      integrations: integrationsSpec.map((i) => ({ service: i.service, name: i.name })),
      outputLabels,
    };
  }

  private loadPackage(workspaceId: string, appId: string) {
    return (
      this.db
        .select()
        .from(schema.appInstances)
        .where(
          and(
            eq(schema.appInstances.workspaceId, workspaceId),
            or(eq(schema.appInstances.id, appId), eq(schema.appInstances.slug, appId))!,
          ),
        )
        .get() ?? null
    );
  }
}

function packageContents(pkg: typeof schema.appInstances.$inferSelect | null): Record<string, unknown> {
  return ((pkg?.packageContents ?? {}) as Record<string, unknown>) ?? {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// ────────────────────────────────────────────────────────────
// Validation (pure functions — no IO)
// ────────────────────────────────────────────────────────────

const NODE_TYPE_SET = new Set<string>(APP_GRAPH_NODE_TYPES);
const EDGE_TYPE_SET = new Set<string>(APP_GRAPH_EDGE_TYPES);

/**
 * Validate a graph in three layers:
 *   - Structural: node IDs unique, edges resolve, max one app_core, etc.
 *   - Reference:  bound workflowId/datasetKey/integration must exist.
 *   - Product:    quality warnings — no knowledge source, too many modules.
 *
 * Errors block save; warnings surface in the inspector.
 */
export function validateAppGraph(
  graph: AppGraph,
  scope: AppGraphReferenceScope,
): AppGraphValidationResult {
  const errors: AppGraphValidationIssue[] = [];
  const warnings: AppGraphValidationIssue[] = [];

  // ── Structural ──
  const seen = new Set<string>();
  let coreCount = 0;
  let entryWorkflowCount = 0;
  let workflowModuleCount = 0;
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') {
      errors.push({
        code: 'INVALID_NODE_ID',
        message: 'Node has no id.',
        severity: 'error',
        nodeId: node.id,
      });
      continue;
    }
    if (seen.has(node.id)) {
      errors.push({
        code: 'DUPLICATE_NODE_ID',
        message: `Duplicate node id '${node.id}'.`,
        severity: 'error',
        nodeId: node.id,
      });
    }
    seen.add(node.id);
    if (!NODE_TYPE_SET.has(node.type)) {
      errors.push({
        code: 'UNKNOWN_NODE_TYPE',
        message: `Unknown node type '${node.type}'.`,
        severity: 'error',
        nodeId: node.id,
      });
    }
    if (node.type === 'app_core') coreCount += 1;
    if (node.type === 'entry_workflow') entryWorkflowCount += 1;
    if (node.type === 'workflow_module') workflowModuleCount += 1;
  }

  if (coreCount > 1) {
    errors.push({
      code: 'MULTIPLE_APP_CORE',
      message: `${coreCount} App core nodes — keep just one to anchor this app.`,
      severity: 'error',
    });
  }
  if (graph.nodes.length > 0 && coreCount === 0) {
    warnings.push({
      code: 'MISSING_APP_CORE',
      message: 'Add an App core node — every app needs one to anchor it.',
      severity: 'warning',
    });
  }
  if (graph.nodes.length > 0 && entryWorkflowCount === 0 && workflowModuleCount === 0) {
    warnings.push({
      code: 'NO_WORKFLOW_NODE',
      message: 'Add at least one workflow — apps usually need something to run.',
      severity: 'warning',
    });
  }

  // Edge references + types.
  for (const edge of graph.edges) {
    if (!seen.has(edge.source)) {
      errors.push({
        code: 'EDGE_DANGLING_SOURCE',
        message: `A connection points to a node that no longer exists.`,
        severity: 'error',
        edgeId: edge.id,
      });
    }
    if (!seen.has(edge.target)) {
      errors.push({
        code: 'EDGE_DANGLING_TARGET',
        message: `A connection points to a node that no longer exists.`,
        severity: 'error',
        edgeId: edge.id,
      });
    }
    if (!EDGE_TYPE_SET.has(edge.type)) {
      errors.push({
        code: 'UNKNOWN_EDGE_TYPE',
        message: `Edge ${edge.id} has unknown type '${edge.type}'.`,
        severity: 'error',
        edgeId: edge.id,
      });
    }
  }

  // ── Reference ──
  const workflowIds = new Set(scope.workflows.map((w) => w.id));
  const agentIds = new Set(scope.agents.map((a) => a.id));
  const datasetKeys = new Set(scope.datasets.map((d) => d.key));
  const integrationKeys = new Set(scope.integrations.map((i) => i.service));
  const outputKeys = new Set((scope.outputLabels ?? []).map((o) => o.path));

  for (const node of graph.nodes) {
    const cfg = node.config as
      | AppCoreConfig
      | EntryWorkflowConfig
      | WorkflowModuleConfig
      | AgentGroupConfig
      | KnowledgeSourceConfig
      | IntegrationSurfaceConfig
      | OutputSurfaceConfig;
    if (
      cfg &&
      typeof cfg === 'object' &&
      'kind' in cfg &&
      (cfg.kind === 'entry_workflow' || cfg.kind === 'workflow_module')
    ) {
      if (cfg.workflowId && !workflowIds.has(cfg.workflowId)) {
        errors.push({
          code: 'UNRESOLVED_WORKFLOW',
          message: `“${node.title}” points to a workflow that no longer exists. Pick a different workflow.`,
          severity: 'error',
          nodeId: node.id,
        });
      }
      if (!cfg.workflowId) {
        warnings.push({
          code: 'UNBOUND_WORKFLOW',
          message: `Connect a workflow to “${node.title}” so it has something to run.`,
          severity: 'warning',
          nodeId: node.id,
        });
      }
    }
    if (cfg && 'kind' in cfg && cfg.kind === 'agent_group') {
      for (const id of cfg.agentIds ?? []) {
        if (!agentIds.has(id)) {
          warnings.push({
            code: 'UNRESOLVED_AGENT',
            message: `Agent team “${node.title}” includes an agent that no longer exists. Update or remove it.`,
            severity: 'warning',
            nodeId: node.id,
          });
        }
      }
    }
    if (cfg && 'kind' in cfg && cfg.kind === 'knowledge_source') {
      if (cfg.datasetKey && !datasetKeys.has(cfg.datasetKey)) {
        errors.push({
          code: 'UNRESOLVED_DATASET',
          message: `Data source “${node.title}” points to a dataset that no longer exists.`,
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
    if (cfg && 'kind' in cfg && cfg.kind === 'integration_surface') {
      if (cfg.service && integrationKeys.size > 0 && !integrationKeys.has(cfg.service)) {
        warnings.push({
          code: 'UNDECLARED_INTEGRATION',
          message: `Integration “${node.title}” uses “${cfg.service}” — add it to this app's integrations to make it work.`,
          severity: 'warning',
          nodeId: node.id,
        });
      }
    }
    if (cfg && 'kind' in cfg && cfg.kind === 'output_surface') {
      if (cfg.outputKey && outputKeys.size > 0 && !outputKeys.has(cfg.outputKey)) {
        warnings.push({
          code: 'UNDECLARED_OUTPUT',
          message: `Output “${node.title}” refers to a result that this app doesn't actually produce.`,
          severity: 'warning',
          nodeId: node.id,
        });
      }
    }
  }

  // ── Product (warnings only — see §13.3) ──
  const counts = countNodesByType(graph.nodes);
  if (counts.knowledge_source === 0 && graph.nodes.length > 0) {
    warnings.push({
      code: 'NO_KNOWLEDGE_SOURCE',
      message: 'Add a Data source so this app has something to work with.',
      severity: 'warning',
    });
  }
  if (counts.output_surface === 0 && graph.nodes.length > 0) {
    warnings.push({
      code: 'NO_OUTPUT_SURFACE',
      message: 'Add an Output node so users can see what this app produces.',
      severity: 'warning',
    });
  }
  if (workflowModuleCount > 7) {
    warnings.push({
      code: 'TOO_MANY_TOP_LEVEL_MODULES',
      message: `${workflowModuleCount} workflows at the top level — keep it under 7 to stay readable. Group related ones into a single workflow.`,
      severity: 'warning',
    });
  }

  return { errors, warnings };
}

function countNodesByType(nodes: AppGraphNode[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of APP_GRAPH_NODE_TYPES) out[t] = 0;
  for (const n of nodes) out[n.type] = (out[n.type] ?? 0) + 1;
  return out;
}

/** Coerce a possibly-untrusted graph into the canonical shape. */
function sanitizeGraph(g: AppGraph): AppGraph {
  return {
    version: 1,
    nodes: (g.nodes ?? []).map((n) => ({
      id: String(n.id),
      type: n.type,
      title: String(n.title ?? ''),
      position: {
        x: Number.isFinite(n.position?.x) ? n.position.x : 0,
        y: Number.isFinite(n.position?.y) ? n.position.y : 0,
      },
      config: (n.config ?? { kind: n.type }) as AppGraphNode['config'],
      ...(n.zone ? { zone: n.zone } : {}),
    })),
    edges: (g.edges ?? []).map((e) => ({
      id: String(e.id),
      source: String(e.source),
      target: String(e.target),
      type: e.type,
      ...(e.label ? { label: e.label } : {}),
    })),
    viewport: {
      x: Number.isFinite(g.viewport?.x) ? g.viewport.x : 0,
      y: Number.isFinite(g.viewport?.y) ? g.viewport.y : 0,
      zoom: Number.isFinite(g.viewport?.zoom) && g.viewport.zoom > 0 ? g.viewport.zoom : 1,
    },
  };
}

/** Pluck a role hint from an agent's capability tags (e.g. `role:sdr`). */
function extractRole(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  for (const t of tags as string[]) {
    if (typeof t === 'string' && t.startsWith('role:')) return t.slice(5);
  }
  return null;
}
