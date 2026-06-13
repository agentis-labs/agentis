import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerInspectTools } from '../../src/services/agentisToolHandlers/inspect.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import { registerCapabilityTools } from '../../src/services/agentisToolHandlers/capability.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => ctx.close());

function deps(): ToolHandlerDeps {
  return {
    db: ctx.db,
    logger: ctx.logger,
    bus: ctx.bus,
    engine: {} as ToolHandlerDeps['engine'],
    adapters: { get: () => undefined } as unknown as ToolHandlerDeps['adapters'],
    ledger: { listForRun: async () => [] } as unknown as ToolHandlerDeps['ledger'],
    scratchpad: {} as ToolHandlerDeps['scratchpad'],
    approvals: { list: () => [] } as unknown as ToolHandlerDeps['approvals'],
    activity: {} as ToolHandlerDeps['activity'],
    replay: {} as ToolHandlerDeps['replay'],
  };
}

function toolContext() {
  return {
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    caller: 'test',
  };
}

function seedSkill(overrides: Partial<typeof schema.extensions.$inferInsert> = {}) {
  const id = randomUUID();
  ctx.db.insert(schema.extensions).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    packageId: null,
    name: 'http_fetch',
    slug: 'http_fetch',
    version: '1.0.0',
    runtime: 'builtin',
    manifest: {
      name: 'http_fetch',
      slug: 'http_fetch',
      version: '1.0.0',
      runtime: 'builtin',
      entrypoint: 'http_fetch',
      capabilityTags: ['builtin', 'http'],
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      outputSchema: { type: 'object' },
    },
    ...overrides,
  }).run();
  return id;
}

describe('agent-facing skill tools', () => {
  it('lists workspace skills with real IDs and schemas', async () => {
    const skillId = seedSkill();
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerInspectTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.skills.list',
      arguments: { query: 'http', runtime: 'builtin' },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { extensions: Array<{ id: string; slug: string; runtime: string; capabilityTags: string[] }> };
    expect(output.extensions).toEqual([
      expect.objectContaining({
        id: skillId,
        slug: 'http_fetch',
        runtime: 'builtin',
        capabilityTags: expect.arrayContaining(['http']),
      }),
    ]);
  });

  it('inspects a skill by slug before workflow wiring', async () => {
    const skillId = seedSkill();
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerInspectTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.skill.inspect',
      arguments: { slug: 'http_fetch' },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { found: boolean; usableInWorkflows: boolean; skill: { id: string; capabilityTags: string[] } };
    expect(output.found).toBe(true);
    expect(output.usableInWorkflows).toBe(true);
    expect(output.skill.id).toBe(skillId);
    expect(output.skill.capabilityTags).toContain('http');
  });
});

describe('agent-facing capability authoring tools', () => {
  it('resolves an installed listener capability before creation', async () => {
    const extensionId = seedSkill({
      name: 'AI News Site Monitor',
      slug: 'ai_news_site_monitor',
      runtime: 'node_worker',
      manifest: {
        name: 'AI News Site Monitor',
        slug: 'ai_news_site_monitor',
        version: '1.0.0',
        runtime: 'node_worker',
        entrypoint: 'ai_news_site_monitor.js',
        description: 'Monitors an AI news site for new posts.',
        capabilityTags: ['listener', 'monitoring', 'ai-news'],
        permissions: ['network', 'listener', 'listener.emit'],
        operations: [{
          name: 'fetchRecentPosts',
          inputSchema: {},
          outputSchema: {},
          isListenerSource: true,
        }],
      },
    });
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerCapabilityTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.extension.resolve',
      arguments: {
        query: 'AI News Site Monitor',
        requiresListenerSource: true,
        capabilityTags: ['monitoring', 'ai-news'],
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      recommendation: 'reuse',
      selectedExtensionId: extensionId,
      candidates: [
        expect.objectContaining({
          extensionId,
          reusable: true,
          listenerOperations: ['fetchRecentPosts'],
        }),
      ],
    }));
  });

  it('creates and queues a reusable ability from intent', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const draftCalls: unknown[] = [];
    const toolDeps = deps();
    toolDeps.abilityCreation = {
      draft: async (input: unknown) => {
        draftCalls.push(input);
        return {
          ability: {
            id: 'ability_1',
            name: 'Social Post Monitor',
            slug: 'social-post-monitor',
            compileStatus: 'queued',
          },
          synthesized: true,
          notes: [],
        };
      },
    } as ToolHandlerDeps['abilityCreation'];
    registerCapabilityTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.ability.create',
      arguments: {
        intent: 'Monitor public social posts for topics and extract matching links.',
        name: 'Social Post Monitor',
        domainTag: 'monitoring',
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(draftCalls).toEqual([expect.objectContaining({
      workspaceId: ctx.workspace.id,
      authorId: ctx.user.id,
      from: 'intent',
      name: 'Social Post Monitor',
      domainTag: 'monitoring',
    })]);
    expect(result.output).toEqual(expect.objectContaining({
      abilityId: 'ability_1',
      compileStatus: 'queued',
    }));
  });

  it('creates a listener extension and returns its real executable ID', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const createCalls: unknown[] = [];
    const toolDeps = deps();
    toolDeps.extensionLibrary = {
      createNodeWorkerExtension: async (scope: unknown, input: unknown) => {
        createCalls.push({ scope, input });
        return {
          id: 'extension_1',
          path: 'extensions/social-listener.md',
          manifest: {
            name: 'Social Listener',
            slug: 'social-listener',
            runtime: 'node_worker',
            operations: [{ name: 'listen' }],
          },
        };
      },
    } as ToolHandlerDeps['extensionLibrary'];
    registerCapabilityTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.extension.create',
      arguments: {
        name: 'Social Listener',
        source: 'export async function listen(input, ctx) { await ctx.emit(input); }',
        permissions: ['listener', 'listener.emit', 'root'],
        operations: [{
          name: 'listen',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          isListenerSource: true,
        }],
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(createCalls).toEqual([expect.objectContaining({
      scope: expect.objectContaining({ workspaceId: ctx.workspace.id, userId: ctx.user.id }),
      input: expect.objectContaining({
        name: 'Social Listener',
        permissions: ['listener', 'listener.emit'],
      }),
    })]);
    expect(result.output).toEqual(expect.objectContaining({
      extensionId: 'extension_1',
      operations: ['listen'],
    }));
  });
});

describe('agentis.build_workflow fallback synthesis', () => {
  it('builds a fixed Hello World workflow as trigger to output transform', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: {
        title: 'Hello World',
        description: 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.',
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { workflowId: string; graph: WorkflowGraph };
    const workflow = ctx.db.select().from(schema.workflows).all().find((row) => row.id === output.workflowId);
    expect(workflow).toBeDefined();
    // New shape: trigger → transform (produce_output) → return_output(renderAs).
    expect(output.graph.nodes).toHaveLength(3);
    expect(output.graph.nodes[1]).toEqual(expect.objectContaining({
      id: 'produce_output',
      type: 'transform',
      config: expect.objectContaining({ kind: 'transform', expression: '{"text":"Workflow is working"}' }),
    }));
    expect(output.graph.nodes[2]).toEqual(expect.objectContaining({
      id: 'return_output',
      type: 'return_output',
      config: expect.objectContaining({ kind: 'return_output', renderAs: 'text' }),
    }));
  });

  it('reuses the current MCP agent draft instead of creating duplicate workflows', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());
    const mcpContext = {
      ...toolContext(),
      caller: 'mcp',
      agentId: randomUUID(),
      conversationId: undefined,
    };

    // Domain-agnostic: a re-build with the same MCP context must REVISE the same
    // workflow, never spawn a twin. (Uses the deterministic fast-path so the test
    // needs no model; the dedup latch under test is connector-agnostic.)
    const description = 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.';
    const first = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: { title: 'Hello World', description },
    }, mcpContext);
    const second = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: { title: 'Hello World', description },
    }, mcpContext);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstId = (first.output as { workflowId: string }).workflowId;
    const secondId = (second.output as { workflowId: string }).workflowId;
    expect(secondId).toBe(firstId);
    const workflows = ctx.db.select().from(schema.workflows).all();
    expect(workflows).toHaveLength(1);
  });

  it('instantiates a research-report template as a specialist pipeline', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: {
        title: 'Competitor brief',
        description: 'Every Monday, research our top competitors and write a report summarizing key moves.',
      },
    }, toolContext());

    expect(result.ok).toBe(true);
    const output = result.output as { graph: WorkflowGraph };
    const roles = output.graph.nodes
      .filter((n) => n.config.kind === 'agent_task')
      .map((n) => (n.config as { agentRole?: string }).agentRole);
    expect(roles).toEqual(['researcher', 'analyst', 'writer']);
    // Weekly schedule was inferred from "Every Monday".
    const trigger = output.graph.nodes.find((n) => n.type === 'trigger');
    expect((trigger!.config as { triggerType?: string }).triggerType).toBe('cron');
    // Produces a return_output terminal path even after recurring-state repair
    // appends workflow_store bookkeeping nodes.
    const terminal = output.graph.nodes.find((n) => n.type === 'return_output');
    expect(terminal).toBeTruthy();
    expect(output.graph.edges.some((e) => e.target === terminal!.id)).toBe(true);
    // Analyst carries the injected aarrr-framework skill.
    const analyst = output.graph.nodes.find((n) => (n.config as { agentRole?: string }).agentRole === 'analyst');
    expect((analyst!.config as { skills?: string[] }).skills).toContain('aarrr-framework');
  });
});
