/**
 * workflowDeployments — AGENT-FIRST-ARCHITECTURE.md Plane 7.
 *
 * Two-tier deployment model:
 *   - Workflow deployment: a single workflow exposed via API + MCP
 *   - App deployment: an app's deployment profile (multiple workflows + tools)
 *
 * Deployments are resolved by a unique slug per workspace and produce a
 * stable URL surface (`/v1/deployments/<slug>/run`). The actual route is
 * mounted by `apps/api/src/routes/deployments.ts` (a thin shim over this
 * service); this service owns lifecycle and lookups.
 *
 * V1 scope: in-memory registration + a thin DB hook. The runtime contract
 * for an app deployment is loaded from the package and applied to every run
 * triggered through the deployment.
 */

import { eq, and } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  AgentisError,
  type AppRuntimeContract,
  type WorkflowGraph,
} from '@agentis/core';
import type { Logger } from '../logger.js';

export interface WorkflowDeploymentSpec {
  kind: 'workflow';
  slug: string;
  workflowId: string;
  /** Optional contract override applied to runs. */
  contract?: AppRuntimeContract;
  /** Whether this workflow is reachable through MCP. */
  mcpExposed?: boolean;
}

export interface AppDeploymentSpec {
  kind: 'app';
  slug: string;
  appId: string;
  /** Workflows exposed under this deployment; first is the entrypoint. */
  workflowIds: string[];
  /** Tool ids from AgentisToolRegistry exposed by this deployment. */
  exposedTools?: string[];
  /** Contract enforced for runs through this deployment. */
  contract: AppRuntimeContract;
  mcpExposed?: boolean;
}

export type DeploymentSpec = WorkflowDeploymentSpec | AppDeploymentSpec;

export interface DeploymentLookup {
  workspaceId: string;
  spec: DeploymentSpec;
  graph?: WorkflowGraph;
}

export class WorkflowDeployments {
  /** workspaceId → slug → spec. */
  readonly #byWorkspace = new Map<string, Map<string, DeploymentSpec>>();

  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger: Logger,
  ) {}

  /** Register a deployment in memory. Idempotent. */
  register(workspaceId: string, spec: DeploymentSpec): void {
    let bucket = this.#byWorkspace.get(workspaceId);
    if (!bucket) {
      bucket = new Map();
      this.#byWorkspace.set(workspaceId, bucket);
    }
    bucket.set(spec.slug, spec);
    this.logger.info('deployment.registered', {
      workspaceId,
      slug: spec.slug,
      kind: spec.kind,
    });
  }

  /** Unregister a deployment. */
  unregister(workspaceId: string, slug: string): void {
    this.#byWorkspace.get(workspaceId)?.delete(slug);
  }

  /** Look up a deployment by slug, attaching the workflow graph for convenience. */
  lookup(workspaceId: string, slug: string): DeploymentLookup | null {
    const spec = this.#byWorkspace.get(workspaceId)?.get(slug);
    if (!spec) return null;
    const result: DeploymentLookup = { workspaceId, spec };
    const wfId = spec.kind === 'workflow' ? spec.workflowId : spec.workflowIds[0];
    if (wfId) {
      const wf = this.db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, wfId), eq(schema.workflows.workspaceId, workspaceId)))
        .get();
      if (wf) result.graph = wf.graph as WorkflowGraph;
    }
    return result;
  }

  /** List all deployments for a workspace. */
  list(workspaceId: string): DeploymentSpec[] {
    return Array.from(this.#byWorkspace.get(workspaceId)?.values() ?? []);
  }

  /** Resolve a workflow id by deployment slug; convenience for routes. */
  resolveWorkflowId(workspaceId: string, slug: string): string {
    const lookup = this.lookup(workspaceId, slug);
    if (!lookup) throw new AgentisError('RESOURCE_NOT_FOUND', `deployment '${slug}' not found`);
    if (lookup.spec.kind === 'workflow') return lookup.spec.workflowId;
    const first = lookup.spec.workflowIds[0];
    if (!first) {
      throw new AgentisError('RESOURCE_CONFLICT', `app deployment '${slug}' has no workflows`);
    }
    return first;
  }

  /** Get the contract attached to a deployment, if any. */
  contractFor(workspaceId: string, slug: string): AppRuntimeContract | null {
    const lookup = this.lookup(workspaceId, slug);
    if (!lookup) return null;
    if (lookup.spec.kind === 'workflow') return lookup.spec.contract ?? null;
    return lookup.spec.contract;
  }
}
