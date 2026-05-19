/**
 * Build tools — agent creates and patches workflows.
 *
 * Mutating; gated by the runtime policy engine in production deployments.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { AgentisPackageContents, AppGraph, AppSurface, RealtimeEventName, WorkflowContents, WorkflowGraph, WorkflowGraphPatch, WorkflowNode } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { validateWorkflowGraph } from '../../engine/validateGraph.js';
import { PackagerService } from '../packager.js';

export function registerBuildTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.workflow.create',
        family: 'build',
        description: 'Create a new workflow from a graph payload.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            graph: { type: 'object' },
          },
          required: ['name', 'graph'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const id = randomUUID();
        const now = new Date().toISOString();
        const graph = args.graph as WorkflowGraph;
        deps.db
          .insert(schema.workflows)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            userId: ctx.userId,
            title: String(args.name),
            summary: args.description ? String(args.description) : null,
            graph,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return { workflowId: id, title: String(args.name) };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.patch',
        family: 'build',
        description: 'Patch a workflow graph (replaces the graph atomically).',
        inputSchema: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            runId: { type: 'string' },
            patch: { type: 'object' },
            graph: { type: 'object' },
          },
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        if (args.runId && args.patch) {
          const run = deps.db
            .select()
            .from(schema.workflowRuns)
            .where(eq(schema.workflowRuns.id, String(args.runId)))
            .get();
          if (!run || run.workspaceId !== ctx.workspaceId) throw new Error(`run ${args.runId} not found`);
          const result = await deps.engine.applyGraphPatch({
            runId: run.id,
            patch: args.patch as WorkflowGraphPatch,
          });
          return { runId: run.id, patched: true, ...result };
        }

        if (!args.workflowId || !args.graph) {
          throw new Error('workflow.patch requires either runId+patch or workflowId+graph');
        }
        const wf = deps.db
          .select()
          .from(schema.workflows)
          .where(eq(schema.workflows.id, String(args.workflowId)))
          .get();
        if (!wf || wf.workspaceId !== ctx.workspaceId) {
          throw new Error(`workflow ${args.workflowId} not found`);
        }
        const graph = args.graph as WorkflowGraph;
        deps.db
          .update(schema.workflows)
          .set({ graph, updatedAt: new Date().toISOString() })
          .where(eq(schema.workflows.id, wf.id))
          .run();
        return { workflowId: wf.id, patched: true };
      },
    },
    {
      definition: {
        id: 'agentis.workflow.cancel',
        family: 'run',
        description: 'Cancel a running workflow run.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const run = deps.db
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, String(args.runId)))
          .get();
        if (!run || run.workspaceId !== ctx.workspaceId) throw new Error(`run ${args.runId} not found`);
        await deps.engine.cancelRun(run.id);
        return { runId: run.id, status: 'cancelled' };
      },
    },
    {
      definition: {
        id: 'agentis.build_workflow',
        family: 'build',
        description: 'Generate a workflow from natural language and stream canvas build events.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            title: { type: 'string' },
            workflowId: { type: 'string' },
          },
          required: ['description'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const description = String(args.description ?? '').trim();
        if (!description) throw new Error('build_workflow requires description');
        const title = String(args.title ?? titleFromDescription(description));
        const graph = buildWorkflowDraft(description, deps, ctx.workspaceId);
        validateWorkflowGraph(graph);

        const now = new Date().toISOString();
        const existingWorkflowId = args.workflowId ? String(args.workflowId) : null;
        const workflowId = existingWorkflowId ?? randomUUID();
        const emptyGraph: WorkflowGraph = { ...graph, nodes: [], edges: [] };
        if (existingWorkflowId) {
          const existing = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, existingWorkflowId)).get();
          if (!existing || existing.workspaceId !== ctx.workspaceId) throw new Error(`workflow ${existingWorkflowId} not found`);
          deps.db.update(schema.workflows)
            .set({ title, summary: description, graph: emptyGraph, updatedAt: now })
            .where(eq(schema.workflows.id, existing.id))
            .run();
        } else {
          deps.db.insert(schema.workflows).values({
            id: workflowId,
            workspaceId: ctx.workspaceId,
            ambientId: ctx.ambientId ?? null,
            userId: ctx.userId,
            title,
            summary: description,
            graph: emptyGraph,
            settings: {},
            createdAt: now,
            updatedAt: now,
          }).run();
        }

        const streamRunId = ctx.runId ?? `build_${workflowId}`;
        publishCanvas(deps, ctx, REALTIME_EVENTS.AGENT_WORK_STEP, {
          workflowId,
          runId: streamRunId,
          agentId: ctx.agentId ?? null,
          description: `Building "${title}"`,
          step: 'build_start',
        });

        for (const node of graph.nodes) {
          await sleep(120);
          publishCanvas(deps, ctx, REALTIME_EVENTS.CANVAS_NODE_PLACED, {
            workflowId,
            runId: streamRunId,
            agentId: ctx.agentId ?? null,
            node: {
              id: node.id,
              type: 'default',
              position: node.position,
              data: { label: node.title, kind: node.config.kind },
            },
            nodeLabel: node.title,
            reason: nodeReason(node),
          });
          publishCanvas(deps, ctx, REALTIME_EVENTS.AGENT_WORK_STEP, {
            workflowId,
            runId: streamRunId,
            agentId: ctx.agentId ?? null,
            description: `Added ${node.title}`,
            step: 'node_placed',
          });
        }

        for (const edge of graph.edges) {
          await sleep(60);
          publishCanvas(deps, ctx, REALTIME_EVENTS.CANVAS_EDGE_CONNECTED, {
            workflowId,
            runId: streamRunId,
            agentId: ctx.agentId ?? null,
            edge: { id: edge.id, source: edge.source, target: edge.target },
            from: graph.nodes.find((node) => node.id === edge.source)?.title ?? edge.source,
            to: graph.nodes.find((node) => node.id === edge.target)?.title ?? edge.target,
          });
        }

        deps.db.update(schema.workflows)
          .set({ graph, updatedAt: new Date().toISOString() })
          .where(eq(schema.workflows.id, workflowId))
          .run();
        publishCanvas(deps, ctx, REALTIME_EVENTS.CANVAS_BUILD_COMPLETE, {
          workflowId,
          runId: streamRunId,
          agentId: ctx.agentId ?? null,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
        });
        return {
          workflowId,
          runId: streamRunId,
          title,
          summary: description,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          graph,
          message: `Workflow "${title}" built with ${graph.nodes.length} nodes.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.create',
        family: 'build',
        description: 'Create a deployed Agentis app from an operator goal. Builds an entry workflow when no workflowId is provided.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            workflowId: { type: 'string' },
          },
          required: ['goal'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const goal = String(args.goal ?? '').trim();
        if (!goal) throw new Error('app.create requires goal');
        const appName = String(args.name ?? appNameFromGoal(goal)).trim() || appNameFromGoal(goal);
        const description = String(args.description ?? goal).trim();
        const workflow = loadOrBuildEntryWorkflow(args.workflowId ? String(args.workflowId) : null, goal, appName, deps, ctx.workspaceId);
        const packager = new PackagerService({ db: deps.db, bus: deps.bus });
        const contents: AgentisPackageContents & Record<string, unknown> = {
          kind: 'agentis',
          agents: [],
          skills: [],
          workflows: [{
            slug: 'entry',
            title: workflow.title,
            summary: goal,
            graph: workflow.graph,
            settings: workflow.settings,
          }],
          integrations: [],
          credentialSlots: [],
          datasetSpecs: [],
          knowledgeSeeds: [],
          memorySeeds: [],
          evaluatorRubrics: [],
          evaluatorExampleSeeds: [],
          workflowBaselines: [],
          runtimeEpisodeSeeds: [],
          screenshotUrls: [],
          crossAppDependencies: [],
          entryWorkflowSlug: 'entry',
          category: inferAppCategory(goal),
          description,
          summary: goal,
          iconGlyph: initials(appName),
          iconColor: '#34d399',
          appGraphTemplate: { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        };
        const pkg = packager.create(
          { workspaceId: ctx.workspaceId, ambientId: ctx.ambientId ?? null, userId: ctx.userId },
          { name: appName, version: '1.0.0', description, tags: ['orchestrator-created', 'app'] },
          'agentis',
          contents,
        );
        const used = packager.usePackage(
          { workspaceId: ctx.workspaceId, ambientId: ctx.ambientId ?? null, userId: ctx.userId },
          pkg.id,
        );
        const appRow = deps.db.select().from(schema.appInstances).where(eq(schema.appInstances.id, used.resourceId)).get();
        if (!appRow || appRow.workspaceId !== ctx.workspaceId) throw new Error('created app could not be loaded');
        const nextContents = {
          ...((appRow.packageContents ?? {}) as Record<string, unknown>),
          appGraphTemplate: buildAppGraphTemplate(appName, workflow.title, appRow.entryWorkflowId ?? ''),
        };
        deps.db.update(schema.appInstances)
          .set({ packageContents: nextContents, updatedAt: new Date().toISOString() })
          .where(eq(schema.appInstances.id, appRow.id))
          .run();
        return {
          appId: appRow.id,
          slug: appRow.slug,
          name: appRow.name,
          entryWorkflowId: appRow.entryWorkflowId,
          path: `${used.path}?layer=output&tab=results`,
          canvasPath: `${used.path}?layer=canvas`,
          message: `Created app "${appName}" with an entry workflow.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.compose',
        family: 'build',
        description: 'Complete or update an existing draft Agentis app. Can attach an entry workflow, create/link worker agents, update declared surfaces, and replace the app canvas graph.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            slug: { type: 'string' },
            goal: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            workflowId: { type: 'string' },
            workflowTitle: { type: 'string' },
            surfaces: { type: 'array', items: { type: 'object' } },
            agents: { type: 'array', items: { type: 'object' } },
            appGraph: { type: 'object' },
          },
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const target = String(args.appId ?? args.slug ?? '').trim();
        if (!target) throw new Error('app.compose requires appId or slug');

        const appRow = deps.db
          .select()
          .from(schema.appInstances)
          .where(and(
            eq(schema.appInstances.workspaceId, ctx.workspaceId),
            or(eq(schema.appInstances.id, target), eq(schema.appInstances.slug, target))!,
          ))
          .get();
        if (!appRow) throw new Error(`app ${target} not found`);

        const now = new Date().toISOString();
        const appName = String(args.name ?? appRow.name).trim() || appRow.name;
        const goal = String(args.goal ?? args.description ?? appRow.name).trim();
        const description = String(args.description ?? goal).trim();
        const currentContents = recordFromUnknown(appRow.packageContents) as AgentisPackageContents & Record<string, unknown>;

        const createdAgentIds = createRequestedAgents(args.agents, deps, ctx, appRow.id);
        let entryWorkflowId = appRow.entryWorkflowId ?? null;
        let workflowTitle = 'Entry workflow';
        let workflowSummary = goal;
        let workflowGraph: WorkflowGraph | null = null;
        let workflowSettings: Record<string, unknown> = {};

        if (args.workflowId || goal) {
          const workflow = loadOrBuildEntryWorkflow(args.workflowId ? String(args.workflowId) : null, goal, appName, deps, ctx.workspaceId);
          workflowTitle = String(args.workflowTitle ?? workflow.title);
          workflowSummary = goal || workflow.title;
          workflowGraph = workflow.graph;
          workflowSettings = workflow.settings;

          if (args.workflowId) {
            entryWorkflowId = String(args.workflowId);
          } else {
            entryWorkflowId = randomUUID();
            deps.db.insert(schema.workflows).values({
              id: entryWorkflowId,
              workspaceId: ctx.workspaceId,
              ambientId: ctx.ambientId ?? null,
              userId: ctx.userId,
              title: workflowTitle,
              summary: workflowSummary,
              graph: workflow.graph,
              settings: workflow.settings,
              tags: [appRow.slug],
              appId: appRow.id,
              createdAt: now,
              updatedAt: now,
            }).run();
          }
        }

        const surfaces: AppSurface[] | undefined = Array.isArray(args.surfaces)
          ? args.surfaces.map(normalizeSurface).filter((surface): surface is AppSurface => Boolean(surface))
          : currentContents.surfaces;
        const appGraph = args.appGraph && typeof args.appGraph === 'object'
          ? args.appGraph as AppGraph
          : buildAppGraphTemplate(appName, workflowTitle, entryWorkflowId ?? '');

        const workflows: WorkflowContents[] = Array.isArray(currentContents.workflows) ? [...currentContents.workflows] : [];
        if (entryWorkflowId && workflowGraph) {
          const entryWorkflow: WorkflowContents = {
            slug: 'entry',
            title: workflowTitle,
            summary: workflowSummary,
            graph: workflowGraph,
            settings: workflowSettings,
          };
          const index = workflows.findIndex((workflow) => {
            const record = recordFromUnknown(workflow);
            return record.slug === 'entry' || record.title === workflowTitle;
          });
          if (index >= 0) workflows[index] = entryWorkflow;
          else workflows.unshift(entryWorkflow);
        }

        const nextContents: AgentisPackageContents & Record<string, unknown> = {
          ...currentContents,
          name: appName,
          description,
          summary: goal || description,
          creationMode: 'orchestrated_draft',
          surfaces: surfaces ?? [{ type: 'thread' }],
          workflows,
          entryWorkflowSlug: entryWorkflowId ? 'entry' : currentContents.entryWorkflowSlug,
          appGraphTemplate: appGraph,
          agents: Array.isArray(currentContents.agents) ? currentContents.agents : [],
          orchestratorBuild: {
            updatedAt: now,
            createdAgentIds,
            entryWorkflowId,
          },
        };

        deps.db.update(schema.appInstances)
          .set({
            name: appName,
            entryWorkflowId,
            packageContents: nextContents,
            status: 'active',
            updatedAt: now,
          })
          .where(eq(schema.appInstances.id, appRow.id))
          .run();

        deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.APP_CANVAS_UPDATED, {
          appId: appRow.id,
          slug: appRow.slug,
          appName,
          entryWorkflowId,
          graph: appGraph,
          updatedAt: now,
        });
        deps.bus.publish(REALTIME_ROOMS.app(appRow.id), REALTIME_EVENTS.APP_CANVAS_UPDATED, {
          appId: appRow.id,
          slug: appRow.slug,
          appName,
          entryWorkflowId,
          graph: appGraph,
          updatedAt: now,
        });

        return {
          appId: appRow.id,
          slug: appRow.slug,
          name: appName,
          entryWorkflowId,
          createdAgentIds,
          path: `/apps/${appRow.slug}`,
          canvasPath: `/apps/${appRow.slug}?layer=canvas`,
          message: `Updated "${appName}" with ${entryWorkflowId ? 'an entry workflow' : 'app architecture'} and refreshed the canvas.`,
        };
      },
    },
    {
      definition: {
        id: 'agentis.plan',
        family: 'inspect',
        description: 'Break a complex objective into executable steps.',
        inputSchema: { type: 'object', properties: { goal: { type: 'string' }, context: { type: 'string' } }, required: ['goal'] },
        mutating: false,
      },
      handler: async (args) => {
        const goal = String(args.goal ?? '').trim();
        return { goal, steps: buildPlan(goal, String(args.context ?? '')) };
      },
    },
    {
      definition: {
        id: 'agentis.evaluate',
        family: 'inspect',
        description: 'Evaluate an artifact against criteria.',
        inputSchema: { type: 'object', properties: { artifact: { type: 'string' }, criteria: { type: 'string' } }, required: ['artifact', 'criteria'] },
        mutating: false,
      },
      handler: async (args) => {
        const artifact = String(args.artifact ?? '');
        const criteria = String(args.criteria ?? '');
        const missing = ['correctness', 'completeness', 'clarity'].filter((term) => criteria.toLowerCase().includes(term) && !artifact.toLowerCase().includes(term));
        const score = Math.max(0.35, Math.min(0.95, artifact.length > 120 ? 0.78 : 0.62));
        return { score, criteria, reasoning: missing.length ? `Review ${missing.join(', ')} before shipping.` : 'No obvious structural gaps detected.', recommendations: missing };
      },
    },
    {
      definition: {
        id: 'agentis.reflect',
        family: 'inspect',
        description: 'Self-critique the current approach and recommend the next action.',
        inputSchema: { type: 'object', properties: { situation: { type: 'string' }, goal: { type: 'string' } }, required: ['situation', 'goal'] },
        mutating: false,
      },
      handler: async (args) => ({
        goal: String(args.goal ?? ''),
        critique: `Current situation: ${String(args.situation ?? '').slice(0, 500)}`,
        nextAction: 'Use platform tools for real state, reduce assumptions, and proceed with the smallest reversible action.',
      }),
    },
    {
      definition: {
        id: 'agentis.workflow.validate',
        family: 'build',
        description: 'Validate a graph against the engine’s static checks (cycles, dangling refs).',
        inputSchema: { type: 'object', properties: { graph: { type: 'object' } }, required: ['graph'] },
        mutating: false,
      },
      handler: async (args, _ctx) => {
        // Delegate to the existing validator. Imported lazily to keep the handler
        // file independent of engine wiring.
        const { validateWorkflowGraph } = await import('../../engine/validateGraph.js');
        try {
          validateWorkflowGraph(args.graph as WorkflowGraph);
          return { valid: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'invalid graph';
          return { valid: false, errorMessage: message };
        }
      },
    },
  ]);
}

function titleFromDescription(description: string): string {
  const cleaned = description
    .replace(/^build\s+(me\s+)?(a|an|the)?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned.length > 0 ? cleaned : 'Generated Workflow';
  return base.length > 80 ? `${base.slice(0, 77)}...` : capitalize(base);
}

function appNameFromGoal(goal: string): string {
  const title = titleFromDescription(goal)
    .replace(/\s+workflow$/i, '')
    .replace(/\s+app$/i, '')
    .trim();
  return `${title || 'Agentis'} app`;
}

function normalizeSurface(value: unknown): AppSurface | null {
  const record = recordFromUnknown(value);
  const type = typeof record.type === 'string' ? record.type : '';
  if (!['thread', 'dashboard', 'api', 'webhook_receiver', 'stream', 'embed', 'artifact', 'page'].includes(type)) {
    return null;
  }
  return {
    type: type as AppSurface['type'],
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  };
}

function createRequestedAgents(
  value: unknown,
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; ambientId?: string | null; userId: string },
  appId: string,
): string[] {
  if (!Array.isArray(value)) return [];
  const created: string[] = [];
  const now = new Date().toISOString();
  for (const item of value) {
    const record = recordFromUnknown(item);
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;
    const id = randomUUID();
    const capabilityTags = Array.isArray(record.capabilityTags)
      ? record.capabilityTags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    deps.db.insert(schema.agents).values({
      id,
      workspaceId: ctx.workspaceId,
      ambientId: ctx.ambientId ?? null,
      userId: ctx.userId,
      packageId: null,
      name,
      description: typeof record.description === 'string' ? record.description : null,
      adapterType: typeof record.adapterType === 'string' ? record.adapterType : 'http',
      capabilityTags,
      config: { ...recordFromUnknown(record.config), appId },
      status: 'offline',
      colorHex: typeof record.colorHex === 'string' ? record.colorHex : '#34d399',
      instructions: typeof record.instructions === 'string' ? record.instructions : null,
      avatarGlyph: typeof record.avatarGlyph === 'string' ? record.avatarGlyph : initials(name),
      role: typeof record.role === 'string' ? record.role : 'worker',
      createdAt: now,
      updatedAt: now,
    }).run();
    created.push(id);
    deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), REALTIME_EVENTS.AGENT_CREATED, {
      agent: { id, name, role: typeof record.role === 'string' ? record.role : 'worker', status: 'offline' },
      source: 'app.compose',
      appId,
    });
  }
  return created;
}

function loadOrBuildEntryWorkflow(
  workflowId: string | null,
  goal: string,
  appName: string,
  deps: ToolHandlerDeps,
  workspaceId: string,
): { title: string; graph: WorkflowGraph; settings: Record<string, unknown> } {
  if (workflowId) {
    const existing = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)).get();
    if (!existing || existing.workspaceId !== workspaceId) throw new Error(`workflow ${workflowId} not found`);
    return {
      title: existing.title,
      graph: existing.graph as WorkflowGraph,
      settings: recordFromUnknown(existing.settings),
    };
  }
  const graph = buildWorkflowDraft(goal, deps, workspaceId);
  validateWorkflowGraph(graph);
  return {
    title: `${appName.replace(/\s+app$/i, '')} workflow`,
    graph,
    settings: {},
  };
}

function buildAppGraphTemplate(appName: string, workflowTitle: string, entryWorkflowId: string): AppGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: 'app_core',
        type: 'app_core',
        title: appName,
        position: { x: 80, y: 160 },
        zone: 'core',
        config: { kind: 'app_core', entryWorkflowId, description: 'Main app surface' },
      },
      {
        id: 'entry_workflow',
        type: 'entry_workflow',
        title: workflowTitle,
        position: { x: 390, y: 160 },
        zone: 'core',
        config: { kind: 'entry_workflow', workflowId: entryWorkflowId },
      },
      {
        id: 'output_surface',
        type: 'output_surface',
        title: 'Results',
        position: { x: 700, y: 160 },
        zone: 'outputs',
        config: { kind: 'output_surface', artifactType: 'document', outputKey: 'result' },
      },
    ],
    edges: [
      { id: 'edge_core_entry', source: 'app_core', target: 'entry_workflow', type: 'activates', label: 'runs' },
      { id: 'edge_entry_output', source: 'entry_workflow', target: 'output_surface', type: 'feeds', label: 'produces' },
    ],
  };
}

function inferAppCategory(goal: string): string {
  const lower = goal.toLowerCase();
  if (/lead|deal|sales|crm/.test(lower)) return 'Sales';
  if (/support|ticket|customer/.test(lower)) return 'Support';
  if (/research|analy[sz]e|competitor|market/.test(lower)) return 'Research';
  if (/ops|operation|schedule|coordinate/.test(lower)) return 'Operations';
  return 'Automation';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return (parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || 'A').slice(0, 2);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function buildWorkflowDraft(description: string, deps: ToolHandlerDeps, workspaceId: string): WorkflowGraph {
  const lower = description.toLowerCase();
  const nodes: WorkflowNode[] = [
    {
      id: 'trigger_manual',
      type: 'trigger',
      title: 'Manual Trigger',
      position: { x: 0, y: 80 },
      config: { kind: 'trigger', triggerType: 'manual' },
    },
  ];

  if (/research|search|analy[sz]e|document|knowledge|competitor|url/.test(lower)) {
    nodes.push({
      id: 'knowledge_context',
      type: 'knowledge',
      title: 'Gather Context',
      position: { x: 260, y: 20 },
      config: {
        kind: 'knowledge',
        queryMode: 'dynamic',
        query: description,
        retrievalMode: 'contextual',
        topK: 6,
      },
    });
  }

  const agent = deps.db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all()
    .find((row) => row.status !== 'error');
  nodes.push({
    id: 'agent_execute',
    type: 'agent_task',
    title: /write|draft|compose|email|post|report/.test(lower) ? 'Draft Output' : 'Execute Task',
    position: { x: 520, y: 80 },
    config: {
      kind: 'agent_task',
      agentId: agent?.id,
      capabilityTags: inferCapabilityTags(lower),
      prompt: description,
      inputKeys: ['trigger', 'knowledge_context'],
      outputKeys: ['result'],
    },
  });

  if (/approve|review|human|check|confirm/.test(lower)) {
    nodes.push({
      id: 'human_review',
      type: 'checkpoint',
      title: 'Human Review',
      position: { x: 780, y: 80 },
      config: { kind: 'checkpoint', approvalMode: 'manual' },
    });
  }

  nodes.push({
    id: 'store_result',
    type: 'scratchpad',
    title: 'Store Result',
    position: { x: nodes.some((node) => node.id === 'human_review') ? 1040 : 780, y: 80 },
    config: { kind: 'scratchpad', operation: 'write', key: 'final_result', valuePath: 'result' },
  });

  const ordered = nodes.map((node) => node.id);
  const edges = ordered.slice(0, -1).map((source, index) => ({
    id: `edge_${source}_${ordered[index + 1]}`,
    source,
    target: ordered[index + 1]!,
  }));

  return { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function inferCapabilityTags(description: string): string[] {
  const tags = new Set<string>();
  if (/research|search|competitor|url/.test(description)) tags.add('research');
  if (/write|draft|compose|email|post|report/.test(description)) tags.add('writing');
  if (/analy[sz]e|score|evaluate|metric/.test(description)) tags.add('analysis');
  if (/send|slack|discord|telegram|email|post/.test(description)) tags.add('operations');
  return Array.from(tags);
}

function nodeReason(node: WorkflowNode): string {
  const reasons: Record<string, string> = {
    trigger: 'Entry point: this starts the workflow.',
    knowledge: 'Retrieves relevant workspace knowledge before acting.',
    agent_task: 'Delegates the main work to a configured agent.',
    checkpoint: 'Adds a human decision gate before continuing.',
    scratchpad: 'Stores the final output for later steps or inspection.',
    skill_task: 'Runs a fast in-process skill.',
    router: 'Branches execution based on conditions.',
    merge: 'Collects branch results before continuing.',
    subflow: 'Calls another workflow as a reusable subflow.',
  };
  return reasons[node.config.kind] ?? `${node.config.kind} node`;
}

function publishCanvas(
  deps: ToolHandlerDeps,
  ctx: { workspaceId: string; agentId?: string; runId?: string },
  event: RealtimeEventName,
  payload: Record<string, unknown>,
): void {
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : null;
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  deps.bus.publish(REALTIME_ROOMS.workspace(ctx.workspaceId), event, payload);
  if (workflowId) deps.bus.publish(REALTIME_ROOMS.workflow(workflowId), event, payload);
  if (runId) deps.bus.publish(REALTIME_ROOMS.run(runId), event, payload);
  if (ctx.agentId) deps.bus.publish(REALTIME_ROOMS.conversation(ctx.agentId), event, payload);
}

function buildPlan(goal: string, context: string): Array<{ step: number; action: string }> {
  const prefix = context.trim() ? `Considering ${context.trim().slice(0, 120)}, ` : '';
  return [
    { step: 1, action: `${prefix}identify the concrete target state and required IDs.` },
    { step: 2, action: 'Inspect current Agentis state with read-only tools.' },
    { step: 3, action: `Apply the smallest action that advances: ${goal}.` },
    { step: 4, action: 'Verify the result and report the platform state back to the operator.' },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
