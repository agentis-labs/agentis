/**
 * createWorkflowFromDescription - model-assisted or agent-authored creation.
 *
 * A configured fast runtime may synthesize the graph. Otherwise the calling
 * agent authors graphDraft or patchDraft. Every path flows through structural
 * repair, delivery/state enrichment, and inspectable trace output.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schemas, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { createWorkflowFromDescription } from '../../src/services/agentisToolHandlers/build.js';
import { SpecialistAgentService } from '../../src/services/specialistAgents.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';

/** A minimal valid LLM-synthesized graph (trigger → agent_task → terminal). */
function synthGraph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 't', type: 'trigger', title: 'Schedule', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * *' } },
      { id: 'a', type: 'agent_task', title: 'Gather', position: { x: 240, y: 0 }, config: { kind: 'agent_task', agentRole: 'researcher', prompt: 'gather items', inputKeys: ['t'], outputKeys: ['result'] } },
      { id: 'o', type: 'return_output', title: 'Done', position: { x: 480, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 'o' }],
  } as unknown as WorkflowGraph;
}

function editableGraph(): WorkflowGraph {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'trigger', type: 'trigger', title: 'Manual Input', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
      { id: 'transform', type: 'transform', title: 'Original Transform', position: { x: 240, y: 0 }, config: { kind: 'transform', expression: '({ value: trigger.value })' } },
      { id: 'output', type: 'return_output', title: 'Result', position: { x: 480, y: 0 }, config: { kind: 'return_output', renderAs: 'json' } },
    ],
    edges: [
      { id: 'trigger-transform', source: 'trigger', target: 'transform' },
      { id: 'transform-output', source: 'transform', target: 'output' },
    ],
  } as WorkflowGraph;
}

/** A fake EvaluatorRuntime whose completeStructured returns a fixed payload. */
function fakeRuntime(payload: unknown) {
  return { completeStructured: async () => payload } as unknown as NonNullable<ToolHandlerDeps['evaluatorRuntime']>;
}

describe('createWorkflowFromDescription — model-assisted creation', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  /** Deps with a synthesis model (and optional reviewer) — the real path. */
  function depsWithModel(opts: { synth?: unknown; reviewer?: unknown } = {}): ToolHandlerDeps {
    const synth = opts.synth === undefined ? fakeRuntime({ graph: synthGraph() }) : (opts.synth ? fakeRuntime(opts.synth) : null);
    const reviewer = opts.reviewer ? fakeRuntime(opts.reviewer) : null;
    return {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      resolveEvaluatorRuntime: (_ws: string, role: 'synthesis' | 'evaluation') =>
        (role === 'evaluation' ? reviewer : synth) ?? undefined,
    } as unknown as ToolHandlerDeps;
  }

  it('accepts an agent-authored graph draft when no synthesis model is configured', async () => {
    const depsNoModel = { db: ctx.db, logger: ctx.logger, bus: ctx.bus } as unknown as ToolHandlerDeps;
    const res = await createWorkflowFromDescription(depsNoModel, {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'gather AI news and summarize it',
      graphDraft: synthGraph(),
      stream: false,
    });

    expect((res as { trace: { synthesis: string } }).trace.synthesis).toBe('agent_draft');
    const graph = res.graph as WorkflowGraph;
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
    expect(graph.nodes.some((n) => (n.config as { kind?: string }).kind === 'return_output')).toBe(true);
  });

  it('falls back to the building agent\'s OWN model when no runtime is configured', async () => {
    // No resolveEvaluatorRuntime / evaluatorRuntime — only a chat-capable agent
    // adapter (the agent already answering the operator's chat). Synthesis must
    // build through it via the universal chat() contract.
    const adapterDeps = {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      adapters: {
        get: (_agentId: string) => ({
          adapter: {
            chat: async function* () {
              yield { type: 'text', delta: JSON.stringify({ graph: synthGraph() }) };
              yield { type: 'done', finishReason: 'stop' };
            },
          },
        }),
      },
    } as unknown as ToolHandlerDeps;

    const res = await createWorkflowFromDescription(adapterDeps, {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id, agentId: 'orchy',
      description: 'gather AI news and summarize it', stream: false,
    });
    expect((res as { trace: { synthesis: string } }).trace.synthesis).toBe('llm');
    expect((res.graph as WorkflowGraph).nodes.length).toBeGreaterThan(0);
  });

  it('requires a draft instead of recursively calling a slow CLI harness', async () => {
    let chatCalls = 0;
    const adapterDeps = {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      adapters: {
        get: (_agentId: string) => ({
          adapter: {
            capabilities: () => ({ interactiveChat: true, toolForwarding: 'mcp_native' }),
            chat: async function* () {
              chatCalls += 1;
              yield { type: 'done', finishReason: 'stop' };
            },
          },
        }),
      },
    } as unknown as ToolHandlerDeps;

    await expect(createWorkflowFromDescription(adapterDeps, {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id, agentId: 'orchy',
      description: 'Take a deep look into C:\\Users\\antar\\OneDrive\\Documentos\\stores and build an Agentis workflow with a rendered dashboard output.',
      stream: false,
    })).rejects.toMatchObject({ code: 'WORKFLOW_DRAFT_REQUIRED' });

    expect(chatCalls, 'the build tool must never recursively invoke the calling harness').toBe(0);
  });

  it('fails honestly instead of fabricating a graph when model synthesis fails', async () => {
    // A model is available but its endpoint keeps erroring. The failure must be
    // surfaced without persisting a fabricated fallback graph.
    const runtime = {
      completeStructured: async () => null,
      lastError: 'model backend returned 400: temperature does not support 0',
    };
    const deps = {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      resolveEvaluatorRuntime: (_ws: string, role: 'synthesis' | 'evaluation') =>
        (role === 'synthesis' ? runtime : undefined),
    } as unknown as ToolHandlerDeps;

    await expect(createWorkflowFromDescription(deps, {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'gather AI news and summarize it', stream: false,
    })).rejects.toMatchObject({ code: 'WORKFLOW_SYNTHESIS_UNAVAILABLE' });

    expect(ctx.db.select().from(schema.workflows).all()).toHaveLength(0);
  });

  it('does NOT create a duplicate when the SAME request builds twice (cross-caller dedup)', async () => {
    // The per-conversation latch can't span two latch keys (a retried/duplicated
    // turn, or chat racing an mcp_native harness over MCP). The workspace-level
    // content dedup must collapse them: the second identical build updates the
    // first workflow instead of spawning a twin.
    const description = 'every morning gather AI news and email me a digest, deduped';
    const first = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description, stream: false,
    });
    const second = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description, stream: false,
    });
    expect(second.workflowId).toBe(first.workflowId);
    const rows = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, ctx.workspace.id)).all();
    expect(rows, 'one request must yield exactly one workflow').toHaveLength(1);
  });

  it('applies targeted edits as patches while preserving workflow identity and metadata', async () => {
    const existing = editableGraph();
    ctx.db.insert(schema.workflows).values({
      id: 'workflow-edit',
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Stable Workflow Title',
      description: 'Original durable purpose',
      graph: existing,
      settings: {},
      concurrencyOverflow: 'queue',
    }).run();
    let synthesisUserPrompt = '';
    const runtime = {
      completeStructured: async (args: { user: string }) => {
        if (!synthesisUserPrompt) synthesisUserPrompt = args.user;
        return {
          patch: {
            addNodes: [],
            updateNodes: [{
              ...existing.nodes[1],
              title: 'Updated Transform',
              config: { kind: 'transform', expression: '({ value: String(trigger.value) })' },
            }],
            removeNodeIds: [],
            addEdges: [],
            removeEdgeIds: [],
          },
        };
      },
    };
    const deps = {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      resolveEvaluatorRuntime: (_ws: string, role: 'synthesis' | 'evaluation') =>
        (role === 'synthesis' ? runtime : undefined),
    } as unknown as ToolHandlerDeps;

    const result = await createWorkflowFromDescription(deps, {
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      workflowId: 'workflow-edit',
      description: 'make the transform stringify its value',
      stream: false,
    });

    const saved = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, 'workflow-edit')).get()!;
    expect(result.workflowId).toBe('workflow-edit');
    expect(saved.title).toBe('Stable Workflow Title');
    expect(saved.description).toBe('Original durable purpose');
    expect((saved.graph as WorkflowGraph).nodes.map((node) => node.id)).toEqual(existing.nodes.map((node) => node.id));
    expect((saved.graph as WorkflowGraph).nodes.find((node) => node.id === 'transform')?.title).toBe('Updated Transform');
    expect(synthesisUserPrompt).toContain('THIS IS AN IN-PLACE EDIT');
    expect(synthesisUserPrompt).toContain('CURRENT WORKFLOW GRAPH');
  });

  it('applies an agent-authored patch without invoking a synthesis model', async () => {
    const existing = editableGraph();
    ctx.db.insert(schema.workflows).values({
      id: 'workflow-agent-patch',
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Agent Patch Workflow',
      description: 'Original durable purpose',
      graph: existing,
      settings: {},
      concurrencyOverflow: 'queue',
    }).run();
    const updatedTransform = {
      ...existing.nodes[1],
      title: 'Agent Authored Transform',
      config: { kind: 'transform' as const, expression: '({ value: String(trigger.value) })' },
    };

    const result = await createWorkflowFromDescription(
      { db: ctx.db, logger: ctx.logger, bus: ctx.bus } as unknown as ToolHandlerDeps,
      {
        workspaceId: ctx.workspace.id,
        ambientId: null,
        userId: ctx.user.id,
        workflowId: 'workflow-agent-patch',
        description: 'make the transform stringify its value',
        patchDraft: {
          addNodes: [],
          updateNodes: [updatedTransform],
          removeNodeIds: [],
          addEdges: [],
          removeEdgeIds: [],
        },
        stream: false,
      },
    );

    const saved = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, 'workflow-agent-patch')).get()!;
    expect((result as { trace: { synthesis: string } }).trace.synthesis).toBe('agent_patch');
    expect((saved.graph as WorkflowGraph).nodes.find((node) => node.id === 'transform')?.title).toBe('Agent Authored Transform');
  });

  it('rejects destructive edit output and leaves the persisted workflow unchanged', async () => {
    const existing = editableGraph();
    ctx.db.insert(schema.workflows).values({
      id: 'workflow-protected',
      workspaceId: ctx.workspace.id,
      userId: ctx.user.id,
      title: 'Protected Workflow',
      description: 'Keep this graph intact',
      graph: existing,
      settings: {},
      concurrencyOverflow: 'queue',
    }).run();
    let synthesisCalls = 0;
    const replacement = synthGraph();
    const runtime = {
      completeStructured: async () => {
        synthesisCalls += 1;
        return { graph: replacement };
      },
      lastError: null,
    };
    const deps = {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      resolveEvaluatorRuntime: (_ws: string, role: 'synthesis' | 'evaluation') =>
        (role === 'synthesis' ? runtime : undefined),
    } as unknown as ToolHandlerDeps;

    await expect(createWorkflowFromDescription(deps, {
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      workflowId: 'workflow-protected',
      description: 'change the output formatting',
      stream: true,
    })).rejects.toMatchObject({ code: 'WORKFLOW_SYNTHESIS_UNAVAILABLE' });

    const saved = ctx.db.select().from(schema.workflows).where(eq(schema.workflows.id, 'workflow-protected')).get()!;
    expect(synthesisCalls).toBe(3); // bounded self-correction passes (raised 2 → 3)
    expect(saved.title).toBe('Protected Workflow');
    expect(saved.description).toBe('Keep this graph intact');
    expect(saved.graph).toEqual(existing);
  });

  it('aborts before any model spend when the turn signal is already canceled', async () => {
    // The operator disconnected (or the turn deadline fired) before the build
    // started. The build must throw OPERATION_CANCELED at the first stage boundary
    // and NEVER call the (billable) synthesis model — the fix for the runaway that
    // kept spending after the chat already said "failed".
    let synthesisCalls = 0;
    const runtime = {
      completeStructured: async () => { synthesisCalls += 1; return { graph: synthGraph() }; },
    };
    const deps = {
      db: ctx.db, logger: ctx.logger, bus: ctx.bus,
      resolveEvaluatorRuntime: (_ws: string, role: 'synthesis' | 'evaluation') =>
        (role === 'synthesis' ? runtime : undefined),
    } as unknown as ToolHandlerDeps;
    const controller = new AbortController();
    controller.abort();

    await expect(
      createWorkflowFromDescription(deps, {
        workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
        description: 'every morning gather AI news and email me a digest', stream: false,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELED' });
    expect(synthesisCalls, 'must not call the model after cancel').toBe(0);
  });

  it('splices an email integration node into an "…and email me" workflow (repair on the LLM graph)', async () => {
    const res = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'search the web for news about AI and send me the most important items via email',
      stream: false,
    });
    const graph = res.graph as WorkflowGraph;
    // Generic "email" now defaults to AgentMail (agent-native email, no OAuth).
    const integration = graph.nodes.find(
      (n) => (n.config as { kind?: string }).kind === 'integration'
        && (n.config as { integrationId?: string }).integrationId === 'agentmail',
    );
    expect(integration, 'expected an agentmail integration node').toBeTruthy();
    expect((integration!.config as { inputs?: { subject?: string; markdown?: string } }).inputs?.subject).toContain('Workflow result:');
    expect((integration!.config as { inputs?: { subject?: string; markdown?: string } }).inputs?.markdown?.trim().length).toBeGreaterThan(0);
    const terminal = graph.nodes.find((n) => (n.config as { kind?: string }).kind === 'return_output');
    expect(graph.edges.some((e) => e.source === integration!.id && e.target === terminal!.id)).toBe(true);
    expect((res as { trace: { synthesis: string } }).trace.synthesis).toBe('llm');
  });

  it('adds workflow_store dedup state for a cron LLM graph (Rule 13 repair)', async () => {
    const res = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'every morning gather AI news and email me a digest', stream: false,
    });
    const graph = res.graph as WorkflowGraph;
    expect(graph.nodes.filter((n) => (n.config as { kind?: string }).kind === 'workflow_store')).toHaveLength(2);
  });

  it('runs the reviewer and surfaces critiques in the inspectable trace', async () => {
    const res = await createWorkflowFromDescription(
      depsWithModel({ reviewer: { critiques: [{ rule: 4, severity: 'warn', message: 'Fetching should use http_request, not an agent_task.' }] } }),
      {
        workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
        description: 'fetch the latest AI papers and summarize them', stream: false,
      },
    );
    const trace = (res as { trace: { synthesis: string; reviewed: boolean; reviewRounds: number; critiques: Array<{ rule: number }> } }).trace;
    expect(trace.synthesis).toBe('llm');
    expect(trace.reviewed).toBe(true);
    expect(trace.reviewRounds).toBe(1);
    expect(trace.critiques).toHaveLength(1);
    expect(trace.critiques[0]!.rule).toBe(4);
  });

  it('fills the operator\'s own email into a self-directed "email me" delivery (F5 zero-config)', async () => {
    // Give the operator a verified email; a self-directed request should route to it.
    ctx.db.update(schema.users).set({ email: 'op@acme.com' }).where(eq(schema.users.id, ctx.user.id)).run();
    const res = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'search the web for AI news and send me the most important items via email',
      stream: false,
    });
    const graph = res.graph as WorkflowGraph;
    const mail = graph.nodes.find(
      (n) => (n.config as { integrationId?: string }).integrationId === 'agentmail',
    );
    expect(mail, 'expected an agentmail delivery node').toBeTruthy();
    expect((mail!.config as { inputs?: { to?: string } }).inputs?.to).toBe('op@acme.com');
  });

  it('does NOT hijack the recipient when an explicit external address is named', async () => {
    ctx.db.update(schema.users).set({ email: 'op@acme.com' }).where(eq(schema.users.id, ctx.user.id)).run();
    const res = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'gather AI news and email it to team@example.com every morning',
      stream: false,
    });
    const graph = res.graph as WorkflowGraph;
    const mail = graph.nodes.find((n) => ['agentmail', 'gmail'].includes((n.config as { integrationId?: string }).integrationId ?? ''));
    // Either no recipient was force-filled, or it is not the operator's address.
    expect((mail?.config as { inputs?: { to?: string } } | undefined)?.inputs?.to).not.toBe('op@acme.com');
    expect((mail?.config as { inputs?: { to?: string } } | undefined)?.inputs?.to).toBe('team@example.com');
  });

  it('materializes the cast — commissions a real specialist and pins it to the node (F7)', async () => {
    const deps = depsWithModel();
    (deps as { specialists?: SpecialistAgentService }).specialists = new SpecialistAgentService(ctx.db);
    const res = await createWorkflowFromDescription(deps, {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'gather AI news and summarize it', stream: false,
    });
    // The synth graph's agent_task (agentRole: researcher) gets a real pinned agentId.
    const graph = res.graph as WorkflowGraph;
    const task = graph.nodes.find((n) => (n.config as { kind?: string }).kind === 'agent_task');
    const agentId = (task!.config as { agentId?: string }).agentId;
    expect(agentId, 'agent_task should be pinned to a commissioned specialist').toBeTruthy();
    // A real specialist agent row now exists for the researcher role.
    const specialist = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, agentId!)).get();
    expect(specialist?.role).toBe('researcher');
    // The cast is surfaced in the result.
    expect((res as { cast: Array<{ role: string }> }).cast.some((c) => c.role === 'researcher')).toBe(true);
    expect((res as { estimatedDurationMs: number }).estimatedDurationMs).toBeGreaterThan(0);
  });

  it('produces a graph that passes the API edit-time schema (autosave never rejects a build)', async () => {
    // Regression: the build persisted graphs the engine accepted but the PATCH
    // /v1/workflows zod schema rejected (e.g. a node with no title), so every
    // autosave failed with VALIDATION_FAILED. The build output must satisfy the
    // same schema the API uses.
    const res = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'gather AI news and email me a digest every morning', stream: false,
    });
    const parsed = schemas.workflowGraphSchema.safeParse(res.graph);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
    // Every node has a non-empty title (backfilled from the kind when missing).
    for (const n of (res.graph as WorkflowGraph).nodes) {
      expect(typeof n.title === 'string' && n.title.trim().length > 0).toBe(true);
    }
  });

  it('does not add a delivery node when none was requested', async () => {
    const res = await createWorkflowFromDescription(depsWithModel(), {
      workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id,
      description: 'summarize a block of text into three bullet points', stream: false,
    });
    const graph = res.graph as WorkflowGraph;
    expect(graph.nodes.some((n) => (n.config as { kind?: string }).kind === 'integration')).toBe(false);
  });
});
