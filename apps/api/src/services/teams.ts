import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AgentisError, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { EventBus } from '../event-bus.js';

export interface TeamCreateArgs {
  workspaceId: string;
  userId: string;
  name: string;
  slug?: string;
  description?: string | null;
  iconGlyph?: string | null;
  colorHex?: string | null;
  profile?: Record<string, unknown>;
}

export interface TeamUpdateArgs {
  name?: string;
  slug?: string;
  description?: string | null;
  iconGlyph?: string | null;
  colorHex?: string | null;
  profile?: Record<string, unknown>;
}

export interface TeamContextPatch {
  operatingPrinciples?: string;
  constraints?: string;
  handoffs?: string;
  successMetrics?: string;
  escalationRules?: string;
  sharedPrompt?: string;
}

export class TeamService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly bus: EventBus,
  ) {}

  list(workspaceId: string, userId: string) {
    this.ensureForWorkspace(workspaceId, userId);
    return this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.workspaceId, workspaceId))
      .all()
      .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
  }

  get(workspaceId: string, userId: string, teamId: string) {
    this.ensureForWorkspace(workspaceId, userId);
    const team = this.db
      .select()
      .from(schema.teams)
      .where(and(eq(schema.teams.id, teamId), eq(schema.teams.workspaceId, workspaceId)))
      .get();
    if (!team) throw new AgentisError('RESOURCE_NOT_FOUND', 'Team not found');
    return team;
  }

  create(args: TeamCreateArgs) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const slug = uniqueSlug(this.db, args.workspaceId, args.slug ?? args.name);
    this.db.transaction(() => {
      this.db.insert(schema.ambients)
        .values({
          id,
          workspaceId: args.workspaceId,
          userId: args.userId,
          name: args.name,
          kind: 'team',
          settings: { teamId: id },
          createdAt: now,
          updatedAt: now,
        })
        .run();
      this.db.insert(schema.teams)
        .values({
          id,
          workspaceId: args.workspaceId,
          ambientId: id,
          userId: args.userId,
          name: args.name,
          slug,
          description: args.description ?? null,
          iconGlyph: args.iconGlyph ?? initialGlyph(args.name),
          colorHex: args.colorHex ?? null,
          profile: args.profile ?? {},
          createdAt: now,
          updatedAt: now,
        })
        .run();
      this.createEmptyContext(id, args.workspaceId, args.userId, args.userId, now);
    });
    const team = this.get(args.workspaceId, args.userId, id);
    this.bus.publish(REALTIME_ROOMS.workspace(args.workspaceId), REALTIME_EVENTS.TEAM_CREATED, { team });
    return team;
  }

  update(workspaceId: string, userId: string, teamId: string, patch: TeamUpdateArgs) {
    const existing = this.get(workspaceId, userId, teamId);
    const next = {
      name: patch.name ?? existing.name,
      slug: patch.slug ? uniqueSlug(this.db, workspaceId, patch.slug, teamId) : existing.slug,
      description: patch.description === undefined ? existing.description : patch.description,
      iconGlyph: patch.iconGlyph === undefined ? existing.iconGlyph : patch.iconGlyph,
      colorHex: patch.colorHex === undefined ? existing.colorHex : patch.colorHex,
      profile: patch.profile ?? (existing.profile as Record<string, unknown>),
      updatedAt: new Date().toISOString(),
    };
    this.db.transaction(() => {
      this.db.update(schema.teams).set(next).where(eq(schema.teams.id, teamId)).run();
      if (patch.name) {
        this.db.update(schema.ambients)
          .set({ name: patch.name, updatedAt: next.updatedAt })
          .where(eq(schema.ambients.id, existing.ambientId))
          .run();
      }
    });
    const team = { ...existing, ...next };
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.TEAM_UPDATED, { team });
    return team;
  }

  delete(workspaceId: string, userId: string, teamId: string) {
    const teams = this.list(workspaceId, userId);
    if (teams.length <= 1) throw new AgentisError('RESOURCE_CONFLICT', 'Cannot delete the last team');
    const team = teams.find((row) => row.id === teamId);
    if (!team) throw new AgentisError('RESOURCE_NOT_FOUND', 'Team not found');
    const fallback = teams.find((row) => row.id !== teamId) ?? null;
    this.db.transaction(() => {
      const workspace = this.db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get();
      if (workspace?.defaultAmbientId === team.ambientId && fallback) {
        this.db.update(schema.workspaces)
          .set({ defaultAmbientId: fallback.ambientId, updatedAt: new Date().toISOString() })
          .where(eq(schema.workspaces.id, workspaceId))
          .run();
      }
      this.db.delete(schema.rooms)
        .where(and(eq(schema.rooms.workspaceId, workspaceId), eq(schema.rooms.teamId, teamId)))
        .run();
      this.db.delete(schema.ambients).where(eq(schema.ambients.id, team.ambientId)).run();
    });
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.TEAM_DELETED, { id: teamId });
    return { ok: true };
  }

  context(workspaceId: string, userId: string, teamId: string) {
    const team = this.get(workspaceId, userId, teamId);
    let row = this.db
      .select()
      .from(schema.teamContext)
      .where(eq(schema.teamContext.teamId, team.id))
      .get();
    if (!row) {
      this.createEmptyContext(team.id, workspaceId, userId, userId, new Date().toISOString());
      row = this.db.select().from(schema.teamContext).where(eq(schema.teamContext.teamId, team.id)).get();
    }
    return row!;
  }

  updateContext(workspaceId: string, userId: string, teamId: string, patch: TeamContextPatch) {
    const existing = this.context(workspaceId, userId, teamId);
    const next = {
      operatingPrinciples: patch.operatingPrinciples ?? existing.operatingPrinciples,
      constraints: patch.constraints ?? existing.constraints,
      handoffs: patch.handoffs ?? existing.handoffs,
      successMetrics: patch.successMetrics ?? existing.successMetrics,
      escalationRules: patch.escalationRules ?? existing.escalationRules,
      sharedPrompt: patch.sharedPrompt ?? existing.sharedPrompt,
      updatedByUserId: userId,
      updatedAt: new Date().toISOString(),
    };
    this.db.update(schema.teamContext).set(next).where(eq(schema.teamContext.id, existing.id)).run();
    this.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.TEAM_CONTEXT_UPDATED, {
      teamId,
      context: { ...existing, ...next },
    });
    return { ...existing, ...next };
  }

  stats(workspaceId: string, userId: string, teamId: string) {
    const team = this.get(workspaceId, userId, teamId);
    const agents = this.db.select().from(schema.agents)
      .where(eq(schema.agents.workspaceId, workspaceId)).all()
      .filter((agent) => agent.ambientId === team.ambientId);
    const workflows = this.db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
      .filter((workflow) => workflow.ambientId === team.ambientId);
    const approvals = this.db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.workspaceId, workspaceId)).all()
      .filter((approval) => approval.ambientId === team.ambientId && approval.status === 'pending');
    return {
      agents: agents.length,
      liveAgents: agents.filter((agent) => agent.status === 'online' || agent.status === 'busy').length,
      workflows: workflows.length,
      pendingApprovals: approvals.length,
    };
  }

  ensureForWorkspace(workspaceId: string, userId: string) {
    const ambients = this.db.select().from(schema.ambients).where(eq(schema.ambients.workspaceId, workspaceId)).all();
    for (const ambient of ambients) {
      this.ensureForAmbient(workspaceId, userId, ambient.id);
    }
  }

  ensureForAmbient(workspaceId: string, userId: string, ambientId: string) {
    const ambient = this.db
      .select()
      .from(schema.ambients)
      .where(and(eq(schema.ambients.id, ambientId), eq(schema.ambients.workspaceId, workspaceId)))
      .get();
    if (!ambient) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ambient not found');
    let team = this.db.select().from(schema.teams).where(eq(schema.teams.ambientId, ambient.id)).get();
    if (!team) {
      const now = new Date().toISOString();
      this.db.insert(schema.teams)
        .values({
          id: ambient.id,
          workspaceId,
          ambientId: ambient.id,
          userId: ambient.userId ?? userId,
          name: ambient.name,
          slug: uniqueSlug(this.db, workspaceId, ambient.name, ambient.id),
          description: ambient.kind === 'local' ? 'Default local execution team.' : `${ambient.kind} execution team.`,
          iconGlyph: initialGlyph(ambient.name),
          colorHex: null,
          profile: { ambientKind: ambient.kind, settings: ambient.settings ?? {} },
          createdAt: ambient.createdAt,
          updatedAt: ambient.updatedAt,
        })
        .run();
      this.createEmptyContext(ambient.id, workspaceId, userId, userId, now);
      team = this.db.select().from(schema.teams).where(eq(schema.teams.ambientId, ambient.id)).get();
    }
    return team!;
  }

  private createEmptyContext(teamId: string, workspaceId: string, userId: string, updatedByUserId: string, now: string) {
    this.db.insert(schema.teamContext)
      .values({
        id: randomUUID(),
        teamId,
        workspaceId,
        userId,
        operatingPrinciples: '',
        constraints: '',
        handoffs: '',
        successMetrics: '',
        escalationRules: '',
        sharedPrompt: '',
        updatedByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'team';
}

function uniqueSlug(db: AgentisSqliteDb, workspaceId: string, value: string, ignoreId?: string): string {
  const base = slugify(value);
  const rows = db.select().from(schema.teams).where(eq(schema.teams.workspaceId, workspaceId)).all();
  const existing = new Set(rows.filter((row) => row.id !== ignoreId).map((row) => row.slug));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

function initialGlyph(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || 'T';
}
