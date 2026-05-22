import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AdapterType, AgentisToolContext, ChatMessage, NormalizedTask } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

const V1_ADAPTERS = new Set<AdapterType>(['openclaw', 'hermes_agent', 'claude_code', 'codex', 'cursor', 'http']);

export function registerAgentTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.agents.list',
        family: 'inspect',
        description: 'List agents available in the workspace.',
        inputSchema: {
          type: 'object',
          properties: { teamId: { type: 'string' }, status: { type: 'string' } },
        },
        mutating: false,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        const status = args.status ? normalizeStatus(String(args.status)) : null;
        const agents = deps.db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.workspaceId, ctx.workspaceId))
          .all()
          .filter((agent) => !status || normalizeStatus(agent.status) === status)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
            adapterType: agent.adapterType,
            runtimeModel: agent.runtimeModel,
            role: agent.role,
            capabilityTags: agent.capabilityTags,
            registered: Boolean(deps.adapters.get(agent.id)),
          }));
        return { count: agents.length, agents, ignoredFilters: args.teamId ? ['teamId'] : [] };
      },
    },
    createAgentTool('agentis.agents.create'),
    createAgentTool('agentis.agent.spawn'),
    {
      definition: {
        id: 'agentis.agent.dispatch',
        family: 'run',
        description: 'Dispatch a task to an existing agent. Uses chat when the adapter supports it, otherwise dispatches a normalized task.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            task: { type: 'string' },
            input: { type: 'object' },
          },
          required: ['agentId', 'task'],
        },
        mutating: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        const agentId = String(args.agentId);
        const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
        if (!agent || agent.workspaceId !== ctx.workspaceId) throw new Error(`agent ${agentId} not found`);
        if (agent.isPaused || agent.status === 'paused') {
          return { dispatched: false, agentId, reason: 'agent_paused', message: 'This agent is in standby mode. Disable standby before dispatching tasks.' };
        }
        const registration = deps.adapters.get(agentId);
        if (!registration) {
          return { dispatched: false, agentId, reason: 'adapter_unavailable', message: 'The agent exists but its harness is not connected.' };
        }

        const task = String(args.task);
        const capabilities = registration.adapter.capabilities?.();
        if (registration.adapter.chat && capabilities?.interactiveChat !== false) {
          const messages: ChatMessage[] = [
            { role: 'system', content: agent.instructions ?? `You are ${agent.name}, an Agentis agent.` },
            { role: 'user', content: task },
          ];
          let response = '';
          for await (const delta of registration.adapter.chat(messages, [])) {
            if (delta.type === 'text') response += delta.delta;
            if (delta.type === 'done') break;
          }
          return { dispatched: true, mode: 'chat', agentId, response };
        }

        const taskId = randomUUID();
        const normalized: NormalizedTask = {
          taskId,
          runId: ctx.runId ?? `chat_${ctx.conversationId ?? randomUUID()}`,
          workflowId: 'agent_dispatch',
          nodeId: taskId,
          title: task.slice(0, 120) || 'Agent task',
          description: task,
          inputData: args.input && typeof args.input === 'object' && !Array.isArray(args.input)
            ? args.input as Record<string, unknown>
            : { task },
          scratchpadSnapshot: {},
          capabilityTags: Array.isArray(agent.capabilityTags) ? agent.capabilityTags.map(String) : [],
          timeoutMs: 120_000,
        };
        await deps.adapters.dispatchTask(normalized, agentId);
        return { dispatched: true, mode: 'task', agentId, taskId, runId: normalized.runId };
      },
    },
    {
      definition: {
        id: 'agentis.team.design',
        family: 'build',
        description: 'Design an agent team blueprint for an objective.',
        inputSchema: {
          type: 'object',
          properties: { brief: { type: 'string' }, teamName: { type: 'string' }, teamId: { type: 'string' } },
          required: ['brief'],
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const brief = String(args.brief ?? '');
        const agents = deps.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspaceId)).all();
        const suggestedRoles = designRoles(brief);
        return {
          teamName: args.teamName ?? 'Generated Team',
          teamId: args.teamId ?? null,
          objective: brief,
          existingAgents: agents.map((agent) => ({ id: agent.id, name: agent.name, tags: agent.capabilityTags })),
          proposedAgents: suggestedRoles,
          coordination: [
            'Orchestrator owns planning, status checks, and final synthesis.',
            'Specialist agents receive narrow tasks with explicit outputs.',
            'Reviewer checks quality before user-facing delivery.',
          ],
        };
      },
    },
  ]);

  function createAgentTool(id: 'agentis.agents.create' | 'agentis.agent.spawn') {
    return {
      definition: {
        id,
        family: 'build' as const,
        description: id === 'agentis.agent.spawn' ? 'Create a new agent from a role brief.' : 'Create a new agent.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            instructions: { type: 'string' },
            role: { type: 'string' },
            adapterType: { type: 'string' },
            runtimeModel: { type: 'string' },
            capabilityTags: { type: 'array', items: { type: 'string' } },
            config: { type: 'object' },
          },
          required: ['name'],
        },
        mutating: true,
      },
      handler: async (args: Record<string, unknown>, ctx: AgentisToolContext) => {
        const now = new Date().toISOString();
        const adapterType = normalizeAdapterType(args.adapterType);
        const config = args.config && typeof args.config === 'object' && !Array.isArray(args.config)
          ? args.config as Record<string, unknown>
          : defaultConfig(adapterType);
        const agent = {
          id: randomUUID(),
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          userId: ctx.userId,
          gatewayId: null,
          packageId: null,
          name: String(args.name),
          adapterType,
          capabilityTags: parseStringArray(args.capabilityTags),
          config,
          status: 'offline',
          lastHeartbeatAt: null,
          currentTaskId: null,
          colorHex: null,
          instructions: args.instructions ? String(args.instructions) : null,
          avatarGlyph: null,
          runtimeModel: args.runtimeModel ? String(args.runtimeModel) : null,
          role: args.role ? String(args.role) : 'agent',
          createdAt: now,
          updatedAt: now,
        };
        deps.db.insert(schema.agents).values(agent).run();
        return { agent, created: true, harnessConfigured: Boolean(args.config) };
      },
    };
  }
}

function normalizeStatus(status: string): string {
  const value = status.toLowerCase();
  if (value === 'idle') return 'online';
  if (value === 'paused') return 'offline';
  return value;
}

function normalizeAdapterType(value: unknown): AdapterType {
  const adapterType = String(value ?? 'http') as AdapterType;
  return V1_ADAPTERS.has(adapterType) ? adapterType : 'http';
}

function defaultConfig(adapterType: AdapterType): Record<string, unknown> {
  if (adapterType === 'http') {
    return { adapterType, baseUrl: '', dispatchPath: '/dispatch', dispatchTimeoutMs: 30_000 };
  }
  return { adapterType };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function designRoles(brief: string): Array<{ name: string; role: string; capabilityTags: string[]; instructions: string }> {
  const lower = brief.toLowerCase();
  const roles = [
    {
      name: 'Planner',
      role: 'orchestrator',
      capabilityTags: ['planning', 'coordination'],
      instructions: 'Break the objective into tasks, route work, and track completion.',
    },
  ];
  if (/research|competitor|market|document|url/.test(lower)) {
    roles.push({
      name: 'Researcher',
      role: 'agent',
      capabilityTags: ['research', 'analysis'],
      instructions: 'Gather evidence, cite sources, and return concise findings.',
    });
  }
  if (/write|content|email|post|report/.test(lower)) {
    roles.push({
      name: 'Writer',
      role: 'agent',
      capabilityTags: ['writing'],
      instructions: 'Turn structured findings into polished user-facing output.',
    });
  }
  roles.push({
    name: 'Reviewer',
    role: 'reviewer',
    capabilityTags: ['quality', 'review'],
    instructions: 'Check completeness, risks, and alignment before delivery.',
  });
  return roles;
}
