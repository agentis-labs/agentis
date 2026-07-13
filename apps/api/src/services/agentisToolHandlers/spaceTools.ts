/**
 * Domain/Space tools — let the agent organize the org structure it builds into,
 * not just read it (`agentis.space.summary`). Mirrors the `/v1/domains` REST
 * routes the UI uses: create, update, delete a Domain (a.k.a. Space), with the
 * same manager-assignment + parent-nesting semantics and SPACE_* realtime.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS, type AgentisToolContext } from '@agentis/core';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'space';
}
function tagForDomain(name: string): string {
  return name.trim().slice(0, 80);
}

function loadDomain(deps: ToolHandlerDeps, workspaceId: string, id: string) {
  const row = deps.db.select().from(schema.domains)
    .where(and(eq(schema.domains.id, id), eq(schema.domains.workspaceId, workspaceId))).get();
  if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `space/domain ${id} not found`);
  return row;
}
function assertAgent(deps: ToolHandlerDeps, workspaceId: string, agentId: string): void {
  const a = deps.db.select({ id: schema.agents.id }).from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId))).get();
  if (!a) throw new AgentisError('RESOURCE_NOT_FOUND', `manager agent ${agentId} not found in this workspace`);
}

export function registerSpaceTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const emit = (workspaceId: string, event: typeof REALTIME_EVENTS.SPACE_CREATED | typeof REALTIME_EVENTS.SPACE_UPDATED | typeof REALTIME_EVENTS.SPACE_DELETED, spaceId: string) => {
    try { deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), event, { workspaceId, spaceId }); } catch { /* realtime never fails a write */ }
  };

  registry.registerMany([
    {
      definition: {
        id: 'agentis.space.create',
        family: 'environment',
        mcpExposed: true,
        description: 'Create a Domain/Space to organize agents, apps, and workflows (e.g. "Marketing", "Support"). Optionally assign a manager agent and nest it under a parent Domain (making it a Subdomain). Use to structure a growing workspace instead of leaving everything flat.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            colorHex: { type: 'string', description: 'Hex color like #3b82f6.' },
            iconEmoji: { type: 'string' },
            managerId: { type: 'string', description: 'Agent that manages this Domain (its responsible specialist).' },
            parentDomainId: { type: 'string', description: 'Nest under this Domain as a Subdomain.' },
          },
          required: ['name'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx: AgentisToolContext) => {
        const name = String(args.name ?? '').trim();
        if (!name) throw new AgentisError('VALIDATION_FAILED', 'space.create requires a name');
        if (typeof args.managerId === 'string' && args.managerId) assertAgent(deps, ctx.workspaceId, args.managerId);
        let parentManagerId: string | null = null;
        if (typeof args.parentDomainId === 'string' && args.parentDomainId) {
          parentManagerId = loadDomain(deps, ctx.workspaceId, args.parentDomainId).managerId ?? null;
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        deps.db.insert(schema.domains).values({
          id, workspaceId: ctx.workspaceId, userId: ctx.userId, name,
          slug: slugify(typeof args.slug === 'string' && args.slug ? args.slug : name),
          description: typeof args.description === 'string' ? args.description : null,
          colorHex: typeof args.colorHex === 'string' ? args.colorHex : null,
          iconEmoji: typeof args.iconEmoji === 'string' ? args.iconEmoji : null,
          managerId: typeof args.managerId === 'string' && args.managerId ? args.managerId : null,
          parentDomainId: typeof args.parentDomainId === 'string' && args.parentDomainId ? args.parentDomainId : null,
          createdAt: now, updatedAt: now,
        }).run();
        // The manager becomes this Domain's responsible specialist.
        if (typeof args.managerId === 'string' && args.managerId) {
          const set: Record<string, unknown> = { spaceId: id, spaceTag: tagForDomain(name), updatedAt: now };
          if (parentManagerId) set.reportsTo = parentManagerId;
          deps.db.update(schema.agents).set(set)
            .where(and(eq(schema.agents.id, args.managerId), eq(schema.agents.workspaceId, ctx.workspaceId))).run();
        }
        emit(ctx.workspaceId, REALTIME_EVENTS.SPACE_CREATED, id);
        return { spaceId: id, name };
      },
    },
    {
      definition: {
        id: 'agentis.space.update',
        family: 'environment',
        mcpExposed: true,
        description: 'Update a Domain/Space: rename, change color/icon/description, reassign its manager, or re-nest it under a different parent Domain.',
        inputSchema: {
          type: 'object',
          properties: {
            spaceId: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            colorHex: { type: 'string' },
            iconEmoji: { type: 'string' },
            managerId: { type: 'string', description: 'null to clear.' },
            parentDomainId: { type: 'string', description: 'null to un-nest.' },
          },
          required: ['spaceId'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx: AgentisToolContext) => {
        const spaceId = String(args.spaceId ?? '').trim();
        loadDomain(deps, ctx.workspaceId, spaceId);
        if (typeof args.managerId === 'string' && args.managerId) assertAgent(deps, ctx.workspaceId, args.managerId);
        if (typeof args.parentDomainId === 'string' && args.parentDomainId) {
          if (args.parentDomainId === spaceId) throw new AgentisError('VALIDATION_FAILED', 'a Domain cannot be its own parent.');
          loadDomain(deps, ctx.workspaceId, args.parentDomainId);
        }
        const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
        if (typeof args.name === 'string' && args.name.trim()) set.name = args.name.trim();
        if (typeof args.description === 'string') set.description = args.description;
        if (typeof args.colorHex === 'string') set.colorHex = args.colorHex;
        if (typeof args.iconEmoji === 'string') set.iconEmoji = args.iconEmoji;
        if ('managerId' in args) set.managerId = args.managerId === null ? null : String(args.managerId);
        if ('parentDomainId' in args) set.parentDomainId = args.parentDomainId === null ? null : String(args.parentDomainId);
        deps.db.update(schema.domains).set(set).where(eq(schema.domains.id, spaceId)).run();
        emit(ctx.workspaceId, REALTIME_EVENTS.SPACE_UPDATED, spaceId);
        return { spaceId, updated: Object.keys(set).filter((k) => k !== 'updatedAt') };
      },
    },
    {
      definition: {
        id: 'agentis.space.delete',
        family: 'environment',
        mcpExposed: true,
        description: 'Delete a Domain/Space. Its agents, apps, and workflows are NOT deleted — they just become un-grouped (their domain is cleared). Subdomains un-nest. Low-risk and reversible by re-creating and re-assigning.',
        inputSchema: { type: 'object', properties: { spaceId: { type: 'string' } }, required: ['spaceId'] },
        mutating: true,
      },
      handler: (args, ctx: AgentisToolContext) => {
        const spaceId = String(args.spaceId ?? '').trim();
        const domain = loadDomain(deps, ctx.workspaceId, spaceId);
        // FKs are ON DELETE SET NULL for agents/apps/workflows.spaceId + subdomain
        // parent, so deleting the row cleanly un-groups everything.
        deps.db.delete(schema.domains).where(eq(schema.domains.id, spaceId)).run();
        emit(ctx.workspaceId, REALTIME_EVENTS.SPACE_DELETED, spaceId);
        return { deleted: true, spaceId, name: domain.name };
      },
    },
  ]);
}
