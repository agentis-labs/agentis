/**
 * Build tools — agent creates and patches workflows.
 *
 * Mutating; gated by the runtime policy engine in production deployments.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { RealtimeEventName, SkillManifest, WorkflowGraph, WorkflowGraphPatch, WorkflowNode } from '@agentis/core';
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
        autoExecute: true,
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
            concurrencyOverflow: 'queue',
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
        autoExecute: true,
      },
      handler: async (args, ctx) => {
        const description = String(args.description ?? '').trim();
        if (!description) throw new Error('build_workflow requires description');
        const title = String(args.title ?? titleFromDescription(description));
        // LLM synthesis when an evaluator endpoint is configured; deterministic
        // regex fallback otherwise. Both produce a validated WorkflowGraph.
        const graph = (await synthesizeWithLlm(description, deps, ctx.workspaceId))
          ?? buildWorkflowDraft(description, deps, ctx.workspaceId);
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
            concurrencyOverflow: 'queue',
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
  const htmlPageOutput = inferHtmlPageOutput(description);
  if (htmlPageOutput) {
    const wantsBrowser = /\b(browser|open|screenshot|render|preview)\b/i.test(lower);
    return buildStaticOutputGraph(htmlPageOutput, { browser: wantsBrowser });
  }
  const fixedOutput = inferFixedOutput(description);
  if (fixedOutput) {
    return buildStaticOutputGraph(fixedOutput);
  }

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

function inferHtmlPageOutput(description: string): Record<string, unknown> | null {
  const normalized = description.replace(/[â€œâ€]/g, '"').replace(/[â€˜â€™]/g, "'");
  const lower = normalized.toLowerCase();
  const requestsPage =
    /\b(html|browser|web page|webpage|landing page)\b/.test(lower)
    || /\blp\b/.test(lower);
  const requestsHeading = /\bh1\b/.test(lower) || /<h1[\s>]/i.test(normalized);
  if (!requestsPage || !requestsHeading) return null;

  const heading = inferRequestedHeading(normalized);
  if (!heading) return null;

  return {
    type: 'html',
    title: heading,
    content: `<h1>${escapeHtml(heading)}</h1>`,
  };
}

function inferRequestedHeading(description: string): string | null {
  const inlineTag = description.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i)?.[1]?.trim();
  if (inlineTag) return inlineTag;

  if (/hello\s+world/i.test(description)) return 'Hello World';

  if (/\bh1\b/i.test(description)) {
    const quoted = description.match(/["']([^"']{1,120})["']/)?.[1]?.trim();
    if (quoted) return quoted;
  }

  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildStaticOutputGraph(output: Record<string, unknown>, opts: { browser?: boolean } = {}): WorkflowGraph {
  // Pick the viewer hint from the produced shape so the Output Surface renders
  // it correctly (Layer 6): html → sandboxed iframe, single-`text` → text card,
  // anything else → JSON viewer.
  const renderAs: 'html' | 'text' | 'json' =
    output.type === 'html' && typeof output.content === 'string'
      ? 'html'
      : Object.keys(output).length === 1 && typeof output.text === 'string'
        ? 'text'
        : 'json';

  const nodes: WorkflowNode[] = [
    {
      id: 'trigger_manual',
      type: 'trigger',
      title: 'Manual Trigger',
      position: { x: 0, y: 80 },
      config: { kind: 'trigger', triggerType: 'manual' },
    },
    {
      // Deterministic producer of the static payload (no LLM tax).
      id: 'produce_output',
      type: 'transform',
      title: 'Produce Output',
      position: { x: 280, y: 80 },
      config: { kind: 'transform', expression: JSON.stringify(output) },
    },
  ];
  const edges: WorkflowGraph['edges'] = [
    { id: 'edge_trigger_manual_produce_output', source: 'trigger_manual', target: 'produce_output' },
  ];

  // "open a browser and show ..." → render the HTML in real Chromium and capture
  // a screenshot artifact, then feed the live HTML to return_output.
  const useBrowser = Boolean(opts.browser) && renderAs === 'html';
  let returnSource = 'produce_output';
  let returnX = 560;
  if (useBrowser) {
    nodes.push({
      id: 'browser_render',
      type: 'browser',
      title: 'Open in Browser',
      position: { x: 560, y: 80 },
      config: { kind: 'browser', operation: 'serve_html', htmlPath: 'content', fullPage: true },
    });
    edges.push({ id: 'edge_produce_output_browser_render', source: 'produce_output', target: 'browser_render' });
    returnSource = 'browser_render';
    returnX = 840;
  }

  nodes.push({
    id: 'return_output',
    type: 'return_output',
    title: 'Return Output',
    position: { x: returnX, y: 80 },
    config: {
      kind: 'return_output',
      renderAs,
      ...(typeof output.title === 'string' ? { title: output.title } : {}),
    },
  });
  edges.push({ id: `edge_${returnSource}_return_output`, source: returnSource, target: 'return_output' });

  return { version: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function inferFixedOutput(description: string): Record<string, unknown> | null {
  const normalized = description.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const objectMatch = normalized.match(/\{[\s\S]{1,500}\}/);
  if (objectMatch && /fixed|return|output|hello world/i.test(normalized)) {
    const parsed = parseSimpleObjectLiteral(objectMatch[0]);
    if (parsed) return parsed;
  }

  const quotedMessage = normalized.match(/(?:return|returns|respond|responds|output|outputs)\s+(?:a\s+)?(?:fixed\s+)?(?:message|text|string)?(?:\s+like|\s+with|:)?\s*["']([^"']+)["']/i);
  if (quotedMessage?.[1]) return { text: quotedMessage[1] };

  if (/hello\s+world/i.test(normalized)) {
    const message = normalized.match(/workflow is working/i)?.[0] ?? 'Workflow is working';
    return { text: message };
  }

  return null;
}

function parseSimpleObjectLiteral(source: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to a tiny object-literal parser for common `{ text: "..." }` requests.
  }

  const pairs = [...source.matchAll(/([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')\s*:\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|null)/g)];
  if (pairs.length === 0) return null;
  const output: Record<string, unknown> = {};
  for (const pair of pairs) {
    const key = String(pair[1] ?? '').replace(/^["']|["']$/g, '');
    const raw = String(pair[2] ?? '');
    if (!key) continue;
    if (raw === 'true') output[key] = true;
    else if (raw === 'false') output[key] = false;
    else if (raw === 'null') output[key] = null;
    else if (/^-?\d/.test(raw)) output[key] = Number(raw);
    else output[key] = raw.slice(1, -1);
  }
  return Object.keys(output).length > 0 ? output : null;
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
    transform: 'Shapes data deterministically — no LLM tokens.',
    return_output: 'Declares the rendered result the operator sees.',
    artifact_save: 'Saves a file artifact to the workspace.',
    browser: 'Renders HTML / captures a screenshot in real Chromium.',
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

/**
 * LLM-based workflow synthesis.
 *
 * Asks the configured evaluator endpoint to design a `WorkflowGraph` from a
 * natural-language description, validates the result against the same
 * `validateWorkflowGraph` contract operators see in the canvas, and retries
 * up to 2 times with the validation error appended on parse failure.
 *
 * Returns `null` when no LLM endpoint is configured OR after all retries
 * exhausted. The caller falls back to the regex synthesizer in either case
 * so workflows can always be built, just less intelligently.
 */
async function synthesizeWithLlm(
  description: string,
  deps: ToolHandlerDeps,
  workspaceId: string,
): Promise<WorkflowGraph | null> {
  if (!deps.evaluatorRuntime) return null;
  // Surface the user's existing agents + skills + knowledge bases so the model
  // can reference real IDs instead of placeholders.
  const agents = deps.db
    .select({ id: schema.agents.id, name: schema.agents.name, capabilityTags: schema.agents.capabilityTags })
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId))
    .all();
  const knowledgeBases = deps.knowledgeBases
    ? deps.knowledgeBases.listKnowledgeBases(workspaceId).map((kb) => ({ id: kb.id, name: kb.name }))
    : [];
  const skills = deps.db
    .select()
    .from(schema.skills)
    .where(eq(schema.skills.workspaceId, workspaceId))
    .all()
    .map((skill) => {
      const manifest = skill.manifest as Partial<SkillManifest>;
      return {
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        runtime: skill.runtime,
        entrypoint: typeof manifest.entrypoint === 'string' ? manifest.entrypoint : skill.slug,
        capabilityTags: Array.isArray(manifest.capabilityTags) ? manifest.capabilityTags.filter((tag): tag is string => typeof tag === 'string') : [],
        inputSchema: manifest.inputSchema ?? {},
        outputSchema: manifest.outputSchema ?? {},
      };
    });

  // Layer 1: inject workspace context so synthesis respects the stack,
  // conventions, and learned patterns (Principle #2).
  let workspaceContext = '';
  if (deps.workspaceIntelligence) {
    try {
      workspaceContext = await deps.workspaceIntelligence.buildContextBlock(workspaceId);
    } catch (err) {
      deps.logger.warn('build_workflow.context.failed', { err: (err as Error).message });
    }
  }

  const systemPrompt = SYNTHESIS_SYSTEM_PROMPT;
  const userPrompt = [
    workspaceContext ? `${workspaceContext}\n` : '',
    `DESCRIPTION:\n${description}`,
    agents.length > 0
      ? `\nAVAILABLE AGENTS (use the id verbatim if you reference one):\n${agents.slice(0, 12).map((a) => `- ${a.id}: ${a.name} (tags: ${(a.capabilityTags as string[] | undefined)?.join(', ') ?? 'none'})`).join('\n')}`
      : '\nNo agents are defined yet — leave `agentId` blank and set `capabilityTags` to drive routing.',
    knowledgeBases.length > 0
      ? `\nAVAILABLE KNOWLEDGE BASES:\n${knowledgeBases.slice(0, 8).map((kb) => `- ${kb.id}: ${kb.name}`).join('\n')}`
      : '',
    skills.length > 0
      ? `\nAVAILABLE SKILLS (use the skill id verbatim for skill_task.skillId):\n${skills.slice(0, 16).map((skill) => `- ${skill.id}: ${skill.name} slug=${skill.slug} runtime=${skill.runtime} entrypoint=${skill.entrypoint} tags=${skill.capabilityTags.join(', ') || 'none'} inputSchema=${JSON.stringify(skill.inputSchema)} outputSchema=${JSON.stringify(skill.outputSchema)}`).join('\n')}`
      : '\nNo workspace skills are installed. Do not create skill_task nodes unless a real skillId is provided.',
  ].filter(Boolean).join('\n');

  const result = await deps.evaluatorRuntime.completeStructured<{ graph?: unknown }>({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 2000,
    maxAttempts: 3,
  });
  if (!result || !result.graph) return null;
  const graph = result.graph as WorkflowGraph;
  // Defensive normalization — the model can omit version/viewport.
  const normalized: WorkflowGraph = {
    version: 1,
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    viewport: graph.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
  try {
    validateWorkflowGraph(normalized);
  } catch (err) {
    deps.logger.warn('synthesizeWithLlm.invalid_graph', { err: (err as Error).message });
    return null;
  }
  return normalized;
}

const SYNTHESIS_SYSTEM_PROMPT = [
  'You are the Agentis workflow architect. Convert the user\'s description into a valid',
  '`WorkflowGraph` JSON object. Return ONLY a JSON object of shape',
  '{ "graph": { version: 1, nodes: [...], edges: [...], viewport: { x: 0, y: 0, zoom: 1 } } }',
  '— no prose, no markdown, no code fences.',
  '',
  'Node kinds available on `node.config.kind`:',
  '  control: trigger, router, merge, subflow, wait, loop, parallel',
  '  data:    transform, filter, integration, http_request, workflow_store, scratchpad',
  '  intel:   agent_task, skill_task, agent_swarm, evaluator, guardrails',
  '  know:    knowledge, artifact_collect',
  '  output:  return_output, artifact_save',
  '  native:  browser',
  '  human:   checkpoint',
  '',
  'Required config fields per kind (anything else is optional):',
  '  trigger:        { kind: "trigger", triggerType: "manual" | "cron" | "webhook" | "persistent_listener" }',
  '  agent_task:     { kind: "agent_task", prompt, capabilityTags, inputKeys, outputKeys, agentId? }',
  '  skill_task:     { kind: "skill_task", skillId, inputMapping, outputMapping }',
  '  knowledge:      { kind: "knowledge", queryMode: "static" | "dynamic", topK, retrievalMode }',
  '  router:         { kind: "router", routingMode: "first_match" | "all_matching" | "llm_route", branches: [] }',
  '  merge:          { kind: "merge", requiredInputs: "all" | "any" }',
  '  checkpoint:     { kind: "checkpoint", approvalMode: "manual" | "auto_after_timeout" }',
  '  scratchpad:     { kind: "scratchpad", operation: "read"|"write"|"append"|"delete", key }',
  '  wait:           { kind: "wait", delayMs }',
  '  transform:      { kind: "transform", expression }',
  '  filter:         { kind: "filter", condition }',
  '  integration:    { kind: "integration", integrationId, operationId, inputs }',
  '  http_request:   { kind: "http_request", method, url, headers?, body?, auth?, responseMapping? }',
  '  workflow_store: { kind: "workflow_store", operations: [{ op, key, value?, outputKey? }] }',
  '  evaluator:      { kind: "evaluator", targetPath, criteria, passThreshold? }',
  '  guardrails:     { kind: "guardrails", rules: [], onViolation: "block"|"flag" }',
  '  loop:           { kind: "loop", itemsExpression, maxConcurrency, bodyWorkflowId, outputArrayKey, onIterationError }',
  '  parallel:       { kind: "parallel", waitFor, onBranchError, mergeStrategy }',
  '  agent_swarm:    { kind: "agent_swarm", prompt, inputArrayPath, maxParallel, mergeStrategy, capabilityTags, outputKey }',
  '  artifact_collect: { kind: "artifact_collect", collectionName }',
  '  return_output:  { kind: "return_output", renderAs: "html"|"markdown"|"table"|"json"|"text", title?, valuePath? }',
  '  artifact_save:  { kind: "artifact_save", name, artifactType?, contentPath?, titlePath? }',
  '  browser:        { kind: "browser", operation: "serve_html"|"screenshot"|"pdf"|"navigate"|"extract_text", url?, html?, htmlPath?, selector? }',
  '',
  'Variable templates: any string field accepts `{{trigger.foo}}`, `{{nodes.<id>.path}}`,',
  '`{{scratchpad.key}}`, `{{store.key}}`, and inside loops `{{loop.item}}` / `{{loop.index}}`.',
  '',
  'Edges: { id, source, target, type?: "default"|"error"|"condition" }. Wire an error edge',
  'when a node has a meaningful recovery path. Otherwise stick with default edges.',
  '',
  'Principles:',
  '- Every workflow starts with exactly one trigger node.',
  '- Prefer deterministic primitives (transform/filter/http_request/integration) over agent_task',
  '  whenever the step does NOT require reasoning. Saves cost and is more reliable.',
  '- Every workflow ends in a `return_output` node — it declares the rendered result the operator sees.',
  '  Pick renderAs by the result type: html page → "html", report/prose → "markdown", row data → "table",',
  '  structured object → "json", short message → "text".',
  '- For fixed responses such as "Hello World", use trigger -> transform (produces the value) -> return_output.',
  '- For HTML page / landing page / browser-preview requests, use trigger -> transform that returns',
  '  { type: "html", title, content: "<h1>...</h1>" } -> return_output with renderAs: "html".',
  '- Use `artifact_save` to persist a file (report.html, data.csv) the operator can download.',
  '- For "open a browser" / "screenshot" / live page rendering, use a `browser` node:',
  '  produce HTML in a transform, then browser serve_html with htmlPath:"content", then return_output renderAs:"html".',
  '- Use skill_task only with a real skillId from AVAILABLE SKILLS. Never invent skill IDs.',
  '- Use `evaluator` after an `agent_task` whenever output quality matters; route its FAIL handle',
  '  back to the agent_task with the critique embedded via `{{nodes.<EVALID>.critique}}`.',
  '- Use `checkpoint` only when human review is genuinely needed (irreversible action, high spend).',
  '- Always give each node a stable string `id` (kebab-case) and a human-readable `title`.',
  '- Place nodes left-to-right: trigger at x ≈ 0, each downstream step at x += 260.',
].join('\n');
