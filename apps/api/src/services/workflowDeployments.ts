import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, desc, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type WorkflowGraph } from '@agentis/core';
import { schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { buildInitialRunState } from '../engine/initialRunState.js';
import { validateWorkflowGraph } from '../engine/validateGraph.js';
import type { EventBus } from '../event-bus.js';

export type DeploymentMode = 'sync' | 'async';

export interface DeploymentRunResult {
  deploymentId: string;
  runId: string;
  workflowId: string;
  status: string;
  response: unknown;
  statusUrl: string;
  completed: boolean;
}

export interface DeploymentRecord {
  id: string;
  workspaceId: string;
  workflowId: string;
  ambientId: string | null;
  userId: string;
  version: number;
  name: string;
  graphSnapshot: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  apiKeyHash: string;
  mode: string;
  publicAccess: boolean;
  chatEnabled: boolean;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function hashDeploymentToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newDeploymentToken(): string {
  return `agt_${randomBytes(24).toString('base64url')}`;
}

function tokenMatches(expectedHash: string, provided: string): boolean {
  const actual = Buffer.from(hashDeploymentToken(provided), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sanitizeDeployment(row: DeploymentRecord) {
  const { apiKeyHash: _apiKeyHash, ...rest } = row;
  return rest;
}

function finalResponseFromRunState(runState: unknown): unknown {
  const state = runState as {
    response?: unknown;
    completedNodeIds?: string[];
    nodeStates?: Record<string, { outputData?: unknown }>;
  };
  if (state.response !== undefined) return state.response;
  const finalNodeId = state.completedNodeIds?.at(-1);
  return finalNodeId ? state.nodeStates?.[finalNodeId]?.outputData ?? {} : {};
}

export class WorkflowDeploymentService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly engine: WorkflowEngine,
    private readonly bus: EventBus,
  ) {}

  list(workspaceId: string) {
    return this.db
      .select()
      .from(schema.workflowDeployments)
      .where(eq(schema.workflowDeployments.workspaceId, workspaceId))
      .orderBy(desc(schema.workflowDeployments.createdAt))
      .all()
      .map((row) => sanitizeDeployment(row as DeploymentRecord));
  }

  get(workspaceId: string, id: string) {
    const row = this.db
      .select()
      .from(schema.workflowDeployments)
      .where(and(eq(schema.workflowDeployments.id, id), eq(schema.workflowDeployments.workspaceId, workspaceId)))
      .get() as DeploymentRecord | undefined;
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', 'Deployment not found');
    return sanitizeDeployment(row);
  }

  create(args: {
    workspaceId: string;
    userId: string;
    workflowId: string;
    name?: string;
    mode?: DeploymentMode;
    publicAccess?: boolean;
    chatEnabled?: boolean;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }) {
    const wf = this.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, args.workflowId), eq(schema.workflows.workspaceId, args.workspaceId)))
      .get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', 'Workflow not found');
    const graph = wf.graph as WorkflowGraph;
    if (graph.nodes.length === 0) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Cannot deploy an empty workflow');
    }
    validateWorkflowGraph(graph);

    const latest = this.db
      .select({ version: schema.workflowDeployments.version })
      .from(schema.workflowDeployments)
      .where(and(eq(schema.workflowDeployments.workflowId, args.workflowId), eq(schema.workflowDeployments.workspaceId, args.workspaceId)))
      .orderBy(desc(schema.workflowDeployments.version))
      .limit(1)
      .get();

    const id = randomUUID();
    const apiKey = newDeploymentToken();
    const version = (latest?.version ?? 0) + 1;
    this.db.insert(schema.workflowDeployments).values({
      id,
      workspaceId: args.workspaceId,
      workflowId: args.workflowId,
      ambientId: wf.ambientId,
      userId: args.userId,
      version,
      name: args.name ?? `${wf.title} v${version}`,
      graphSnapshot: graph,
      inputSchema: args.inputSchema ?? {},
      outputSchema: args.outputSchema ?? {},
      apiKeyHash: hashDeploymentToken(apiKey),
      mode: args.mode ?? 'sync',
      publicAccess: args.publicAccess ?? false,
      chatEnabled: args.chatEnabled ?? false,
    }).run();

    const deployment = this.db
      .select()
      .from(schema.workflowDeployments)
      .where(eq(schema.workflowDeployments.id, id))
      .get() as DeploymentRecord;
    return { deployment: sanitizeDeployment(deployment), apiKey };
  }

  loadPublic(id: string): DeploymentRecord {
    const row = this.db
      .select()
      .from(schema.workflowDeployments)
      .where(eq(schema.workflowDeployments.id, id))
      .get() as DeploymentRecord | undefined;
    if (!row || row.revokedAt) throw new AgentisError('RESOURCE_NOT_FOUND', 'Deployment not found');
    return row;
  }

  assertToken(deployment: DeploymentRecord, providedToken?: string | null): void {
    if (deployment.publicAccess) return;
    if (!providedToken || !tokenMatches(deployment.apiKeyHash, providedToken)) {
      throw new AgentisError('AUTH_FORBIDDEN', 'Deployment API key is required');
    }
  }

  publicConfig(id: string) {
    const deployment = this.loadPublic(id);
    if (!deployment.chatEnabled) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'Chat deployment not found');
    }
    return {
      deployment: {
        id: deployment.id,
        name: deployment.name,
        workflowId: deployment.workflowId,
        version: deployment.version,
        chatEnabled: deployment.chatEnabled,
        publicAccess: deployment.publicAccess,
      },
    };
  }

  async execute(args: {
    deploymentId: string;
    inputs: Record<string, unknown>;
    token?: string | null;
    skipAuth?: boolean;
    syncTimeoutMs?: number;
    source?: 'api' | 'chat' | 'mcp';
  }): Promise<DeploymentRunResult> {
    const deployment = this.loadPublic(args.deploymentId);
    if (!args.skipAuth) this.assertToken(deployment, args.token);
    if (args.source === 'chat' && !deployment.chatEnabled) {
      throw new AgentisError('AUTH_FORBIDDEN', 'Chat is not enabled for this deployment');
    }

    const graph = deployment.graphSnapshot as WorkflowGraph;
    validateWorkflowGraph(graph);
    const runId = randomUUID();
    const state = buildInitialRunState({
      runId,
      workflowId: deployment.workflowId,
      graph,
      inputs: args.inputs,
    });

    this.db.insert(schema.workflowRuns).values({
      id: runId,
      workspaceId: deployment.workspaceId,
      ambientId: deployment.ambientId,
      workflowId: deployment.workflowId,
      userId: deployment.userId,
      status: 'CREATED',
      runState: {
        ...state,
        deployment: { id: deployment.id, version: deployment.version, source: args.source ?? 'api' },
      },
      triggerId: null,
    }).run();

    this.bus.publish(REALTIME_ROOMS.workspace(deployment.workspaceId), REALTIME_EVENTS.RUN_CREATED, {
      runId,
      workflowId: deployment.workflowId,
      ambientId: deployment.ambientId,
      deploymentId: deployment.id,
    });

    await this.engine.startRun({
      workspaceId: deployment.workspaceId,
      ambientId: deployment.ambientId,
      workflowId: deployment.workflowId,
      userId: deployment.userId,
      triggerId: null,
      inputs: args.inputs,
      initialState: state,
      graph,
    });

    const syncTimeoutMs = Math.max(0, Math.min(args.syncTimeoutMs ?? 1500, 10_000));
    const deadline = Date.now() + syncTimeoutMs;
    let run = this.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    while (run && syncTimeoutMs > 0 && Date.now() < deadline && !['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING'].includes(run.status)) {
      await delay(25);
      run = this.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).get();
    }

    const status = run?.status ?? 'CREATED';
    const completed = ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING'].includes(status);
    return {
      deploymentId: deployment.id,
      runId,
      workflowId: deployment.workflowId,
      status,
      response: completed && run ? finalResponseFromRunState(run.runState) : null,
      statusUrl: `/v1/runs/${runId}`,
      completed,
    };
  }
}
