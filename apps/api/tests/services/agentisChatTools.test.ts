import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { schema } from '@agentis/db/sqlite';
import type { WorkflowGraph } from '@agentis/core';
import { AgentisToolRegistry } from '../../src/services/agentisToolRegistry.js';
import { registerInspectTools } from '../../src/services/agentisToolHandlers/inspect.js';
import { registerBuildTools } from '../../src/services/agentisToolHandlers/build.js';
import { registerCapabilityTools } from '../../src/services/agentisToolHandlers/capability.js';
import { registerChannelTools } from '../../src/services/agentisToolHandlers/channel.js';
import type { ToolHandlerDeps } from '../../src/services/agentisToolHandlers/deps.js';
import { ChannelBridge } from '../../src/services/channelBridge.js';
import type { PersistentChannelTransport } from '../../src/services/channelBridge.js';
import { ConversationStore } from '../../src/services/conversationStore.js';
import type { ChannelAdapter, ParsedInboundMessage } from '../../src/adapters/channels/types.js';
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

class StubTelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly sent: Array<{ chatId: string; body: string }> = [];
  async send(args: { chatId: string; body: string }): Promise<void> {
    this.sent.push({ chatId: args.chatId, body: args.body });
  }
  verify(): boolean { return true; }
  parseInbound(): ParsedInboundMessage | null { return null; }
}

function stubPersistentTransport(sent: Array<{ connectionId: string; chatId: string; body: string }>): PersistentChannelTransport {
  return {
    handles: (conn) => conn.kind === 'whatsapp',
    requiresNoToken: (kind) => kind === 'whatsapp',
    status: () => ({ status: 'open' }),
    send: async (connectionId, chatId, body) => { sent.push({ connectionId, chatId, body }); },
  };
}

function seedAgent() {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id,
    workspaceId: ctx.workspace.id,
    ambientId: ctx.ambient.id,
    userId: ctx.user.id,
    name: 'Orchestrator',
    adapterType: 'http',
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

  // NOTE: the "reusable ability from intent" test was removed 2026-07-05 — the
  // Abilities subsystem (agentis.ability.create + ToolHandlerDeps.abilityCreation)
  // was deleted wholesale on 2026-07-04 in favor of Living Skills in the Brain
  // (SKILL.md materializer + brain skill/example atoms), which has its own tests.

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

describe('agent-facing native channel tools', () => {
  it('lists channels with health and sends to the saved default target', async () => {
    const adapter = new StubTelegramAdapter();
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
      adapters: { telegram: adapter },
    });
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'telegram',
      name: 'Telegram main',
      token: 'bot-token',
      defaultChatId: '777',
    });
    ctx.db.update(schema.channelConnections).set({ status: 'active' }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const listed = await registry.execute({
      toolId: 'agentis.channel.list',
      arguments: { kind: 'telegram' },
    }, toolContext());
    expect(listed.ok).toBe(true);
    expect(listed.output).toEqual(expect.objectContaining({
      count: 1,
      channels: [expect.objectContaining({ id: connection.id, kind: 'telegram', defaultChatId: '777' })],
    }));

    const sent = await registry.execute({
      toolId: 'agentis.channel.send',
      arguments: { kind: 'telegram', to: 'default', body: 'hello over native channel' },
    }, toolContext());
    expect(sent.ok).toBe(true);
    expect(sent.output).toEqual(expect.objectContaining({
      sent: true,
      connectionId: connection.id,
      to: '777',
    }));
    expect(adapter.sent).toEqual([{ chatId: '777', body: 'hello over native channel' }]);
  });

  it('returns an actionable error when target resolution is ambiguous', async () => {
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
      adapters: { telegram: new StubTelegramAdapter() },
    });
    const agentId = seedAgent();
    for (const suffix of ['one', 'two']) {
      bridge.create({
        workspaceId: ctx.workspace.id,
        ambientId: null,
        userId: ctx.user.id,
        agentId,
        kind: 'telegram',
        name: `Telegram ${suffix}`,
        token: `bot-token-${suffix}`,
        defaultChatId: suffix,
      });
    }
    ctx.db.update(schema.channelConnections).set({ status: 'active' }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.channel.send',
      arguments: { kind: 'telegram', to: 'default', body: 'hello' },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      sent: false,
      errorCode: 'CHANNEL_TARGET_AMBIGUOUS_OR_MISSING',
    }));
  });

  it('sends WhatsApp to an explicit phone number without a saved default target', async () => {
    const bridge = new ChannelBridge({
      db: ctx.db,
      vault: ctx.vault,
      conversations: new ConversationStore({ db: ctx.db, bus: ctx.bus }),
      bus: ctx.bus,
      logger: ctx.logger,
    });
    const sent: Array<{ connectionId: string; chatId: string; body: string }> = [];
    bridge.setPersistentTransport(stubPersistentTransport(sent));
    const agentId = seedAgent();
    const { connection } = bridge.create({
      workspaceId: ctx.workspace.id,
      ambientId: null,
      userId: ctx.user.id,
      agentId,
      kind: 'whatsapp',
      name: 'WhatsApp QR',
    });
    ctx.db.update(schema.channelConnections).set({ status: 'active' }).run();

    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    const toolDeps = deps();
    toolDeps.channels = bridge;
    registerChannelTools(registry, toolDeps);

    const result = await registry.execute({
      toolId: 'agentis.channel.send',
      arguments: { kind: 'whatsapp', to: '+55 11 99999-9999', body: 'hello wa' },
    }, toolContext());

    expect(result.ok).toBe(true);
    expect(result.output).toEqual(expect.objectContaining({
      sent: true,
      connectionId: connection.id,
      to: '5511999999999@s.whatsapp.net',
      targetSource: 'explicit',
    }));
    expect(sent).toEqual([{ connectionId: connection.id, chatId: '5511999999999@s.whatsapp.net', body: 'hello wa' }]);
  });
});

describe('agentis.build_workflow agent-authored drafts', () => {
  it('builds a fixed Hello World workflow from an agent-authored graph', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: {
        title: 'Hello World',
        description: 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.',
        graphDraft: {
          version: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            { id: 'trigger', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
            { id: 'produce_output', type: 'transform', title: 'Produce Output', position: { x: 280, y: 0 }, config: { kind: 'transform', expression: '{"text":"Workflow is working"}' } },
            { id: 'return_output', type: 'return_output', title: 'Return Output', position: { x: 560, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
          ],
          edges: [
            { id: 'trigger-produce', source: 'trigger', target: 'produce_output' },
            { id: 'produce-output', source: 'produce_output', target: 'return_output' },
          ],
        },
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
    // workflow, never spawn a twin.
    const description = 'Create a manual Hello World workflow that returns the fixed object { text: "Workflow is working" }.';
    const graphDraft = {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'trigger', type: 'trigger', title: 'Manual Trigger', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'manual' } },
        { id: 'output', type: 'return_output', title: 'Return Output', position: { x: 280, y: 0 }, config: { kind: 'return_output', renderAs: 'text' } },
      ],
      edges: [{ id: 'trigger-output', source: 'trigger', target: 'output' }],
    };
    const first = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: { title: 'Hello World', description, graphDraft },
    }, mcpContext);
    const second = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: { title: 'Hello World', description, graphDraft },
    }, mcpContext);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstId = (first.output as { workflowId: string }).workflowId;
    const secondId = (second.output as { workflowId: string }).workflowId;
    expect(secondId).toBe(firstId);
    const workflows = ctx.db.select().from(schema.workflows).all();
    expect(workflows).toHaveLength(1);
  });

  it('instantiates an agent-authored research pipeline with specialist roles', async () => {
    const registry = new AgentisToolRegistry({ logger: ctx.logger });
    registerBuildTools(registry, deps());

    const result = await registry.execute({
      toolId: 'agentis.build_workflow',
      arguments: {
        title: 'Competitor brief',
        description: 'Every Monday, research our top competitors and write a report summarizing key moves.',
        graphDraft: {
          version: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            { id: 'trigger', type: 'trigger', title: 'Weekly Schedule', position: { x: 0, y: 0 }, config: { kind: 'trigger', triggerType: 'cron', schedule: '0 9 * * 1' } },
            { id: 'research', type: 'agent_task', title: 'Research Competitors', position: { x: 280, y: 0 }, config: { kind: 'agent_task', agentRole: 'researcher', prompt: 'Research competitor moves.', inputKeys: ['trigger'], outputKeys: ['findings'] } },
            { id: 'analyze', type: 'agent_task', title: 'Analyze Moves', position: { x: 560, y: 0 }, config: { kind: 'agent_task', agentRole: 'analyst', prompt: 'Analyze the findings.', inputKeys: ['research'], outputKeys: ['analysis'], skills: ['aarrr-framework'] } },
            { id: 'write', type: 'agent_task', title: 'Write Report', position: { x: 840, y: 0 }, config: { kind: 'agent_task', agentRole: 'writer', prompt: 'Write the final report.', inputKeys: ['analyze'], outputKeys: ['report'] } },
            { id: 'output', type: 'return_output', title: 'Return Report', position: { x: 1120, y: 0 }, config: { kind: 'return_output', renderAs: 'markdown' } },
          ],
          edges: [
            { id: 'trigger-research', source: 'trigger', target: 'research' },
            { id: 'research-analyze', source: 'research', target: 'analyze' },
            { id: 'analyze-write', source: 'analyze', target: 'write' },
            { id: 'write-output', source: 'write', target: 'output' },
          ],
        },
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
