/**
 * Environment tools — agent operates approvals and resolves operator gates.
 *
 * `agentis.approval.resolve` is the only tool here that mutates external
 * state. It is gated by the standard workspace ownership check.
 */

import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { SkillManifest } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { runBuiltin } from '../builtinSkills.js';

export function registerEnvironmentTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  registry.registerMany([
    {
      definition: {
        id: 'agentis.approval.resolve',
        family: 'environment',
        description: 'Approve or reject a pending approval.',
        inputSchema: {
          type: 'object',
          properties: {
            approvalId: { type: 'string' },
            decision: { type: 'string', enum: ['approve', 'reject'] },
            reason: { type: 'string' },
          },
          required: ['approvalId', 'decision'],
        },
        mutating: true,
      },
      handler: async (args, ctx) => {
        const result = await deps.approvals.resolve({
          workspaceId: ctx.workspaceId,
          approvalId: String(args.approvalId),
          decision: args.decision as 'approve' | 'reject',
          reason: args.reason ? String(args.reason) : undefined,
        });
        return {
          approvalId: result.id,
          status: result.status,
          resolvedAt: result.resolvedAt,
        };
      },
    },
    {
      definition: {
        id: 'agentis.viewport.context',
        family: 'environment',
        description: 'Return the agent’s view of its current environment (workspace, ambient, latest activity).',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
      },
      handler: async (_args, ctx) => {
        return {
          workspaceId: ctx.workspaceId,
          ambientId: ctx.ambientId ?? null,
          userId: ctx.userId,
          caller: ctx.caller,
          conversationId: ctx.conversationId ?? null,
          runId: ctx.runId ?? null,
          viewport: ctx.viewport ?? null,
        };
      },
    },
    {
      definition: {
        id: 'agentis.canvas.context',
        family: 'environment',
        description: 'Read the operator viewport context plus selected workflow/run/agent details.',
        inputSchema: {
          type: 'object',
          properties: {
            resourceId: { type: 'string' },
            resourceKind: { type: 'string' },
          },
        },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const resourceId = args.resourceId ? String(args.resourceId) : ctx.viewport?.resourceId ?? ctx.viewport?.activeRunId ?? null;
        const resourceKind = args.resourceKind ? String(args.resourceKind) : ctx.viewport?.resourceKind ?? null;
        return {
          viewport: ctx.viewport ?? null,
          resource: resourceId && resourceKind
            ? loadViewportResource(deps, ctx.workspaceId, resourceKind, resourceId)
            : null,
        };
      },
    },
    {
      definition: {
        id: 'agentis.apps.status',
        family: 'inspect',
        description: 'Check gateway and registered adapter health for the workspace.',
        inputSchema: { type: 'object', properties: { gatewayId: { type: 'string' } } },
        mutating: false,
      },
      handler: async (args, ctx) => {
        const gateways = deps.db
          .select()
          .from(schema.openclawGateways)
          .where(eq(schema.openclawGateways.workspaceId, ctx.workspaceId))
          .all()
          .filter((gateway) => !args.gatewayId || gateway.id === String(args.gatewayId));
        const adapterHealth = await Promise.all(
          deps.adapters.list()
            .filter((registration) => {
              const agent = deps.db.select().from(schema.agents).where(eq(schema.agents.id, registration.agentId)).get();
              return agent?.workspaceId === ctx.workspaceId;
            })
            .map(async (registration) => ({
              agentId: registration.agentId,
              adapterType: registration.adapterType,
              health: await deps.adapters.healthCheck(registration.agentId),
            })),
        );
        return {
          gateways: gateways.map((gateway) => ({
            id: gateway.id,
            name: gateway.name,
            status: gateway.status,
            gatewayUrl: gateway.gatewayUrl,
            lastHeartbeatAt: gateway.lastHeartbeatAt,
            healthSnapshot: gateway.healthSnapshot,
          })),
          adapters: adapterHealth,
          onlineCount: gateways.filter((gateway) => gateway.status === 'connected').length,
        };
      },
    },
    {
      definition: {
        id: 'http_fetch',
        family: 'data',
        description: 'Fetch an HTTP(S) URL using the built-in SSRF-guarded fetcher.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            method: { type: 'string' },
            headers: { type: 'object' },
            body: {},
          },
          required: ['url'],
        },
        mutating: false,
      },
      handler: async (args) => {
        const outcome = await runBuiltin(
          { entrypoint: 'http_fetch' } as SkillManifest,
          {
            url: args.url,
            method: args.method,
            headers: parseJsonObject(args.headers),
            body: parsePossibleJson(args.body),
          },
          {},
        );
        if (!outcome.ok) throw new Error(outcome.message ?? 'http_fetch failed');
        return outcome.output;
      },
    },
  ]);
}

function loadViewportResource(deps: ToolHandlerDeps, workspaceId: string, kind: string, id: string): unknown {
  if (kind === 'workflow') {
    const row = deps.db.select().from(schema.workflows).where(eq(schema.workflows.id, id)).get();
    return row?.workspaceId === workspaceId ? { kind, workflow: row } : { kind, id, found: false };
  }
  if (kind === 'run') {
    const row = deps.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).get();
    return row?.workspaceId === workspaceId ? { kind, run: row } : { kind, id, found: false };
  }
  if (kind === 'agent') {
    const row = deps.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
    return row?.workspaceId === workspaceId ? { kind, agent: row } : { kind, id, found: false };
  }
  if (kind === 'team') {
    const row = deps.db.select().from(schema.teams).where(eq(schema.teams.id, id)).get();
    return row?.workspaceId === workspaceId ? { kind, team: row } : { kind, id, found: false };
  }
  return { kind, id, found: false };
}

function parseJsonObject(value: unknown): Record<string, string> {
  const parsed = parsePossibleJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}

function parsePossibleJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}
