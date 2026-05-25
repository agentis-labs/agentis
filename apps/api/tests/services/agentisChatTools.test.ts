import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerInspectTools } from '../../src/services/agentisToolHandlers/inspect.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
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
    adapters: {} as ToolHandlerDeps['adapters'],
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

function seedSkill(overrides: Partial<typeof schema.skills.$inferInsert> = {}) {
  const id = randomUUID();
  ctx.db.insert(schema.skills).values({
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
    const output = result.output as { skills: Array<{ id: string; slug: string; entrypoint: string; inputSchema: unknown }> };
    expect(output.skills).toEqual([
      expect.objectContaining({
        id: skillId,
        slug: 'http_fetch',
        entrypoint: 'http_fetch',
        inputSchema: expect.objectContaining({ type: 'object' }),
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
    // Ends in a return_output node.
    expect(output.graph.nodes.at(-1)).toEqual(expect.objectContaining({ type: 'return_output' }));
    // Analyst carries the injected aarrr-framework skill.
    const analyst = output.graph.nodes.find((n) => (n.config as { agentRole?: string }).agentRole === 'analyst');
    expect((analyst!.config as { skills?: string[] }).skills).toContain('aarrr-framework');
  });
});
