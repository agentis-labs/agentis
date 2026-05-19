import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';
import { TeamService } from '../services/teams.js';

const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  iconGlyph: z.string().max(8).nullable().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  profile: z.record(z.unknown()).optional(),
});

const updateTeamSchema = createTeamSchema.partial();

const contextSchema = z.object({
  operatingPrinciples: z.string().max(12000).optional(),
  constraints: z.string().max(12000).optional(),
  handoffs: z.string().max(12000).optional(),
  successMetrics: z.string().max(12000).optional(),
  escalationRules: z.string().max(12000).optional(),
  sharedPrompt: z.string().max(24000).optional(),
});

const designSchema = z.object({
  brief: z.string().trim().min(1).max(4000),
  applyContext: z.boolean().default(false),
});

export function buildTeamRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus: EventBus;
  teams: TeamService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const teams = deps.teams.list(ws.workspaceId, ws.user.id);
    return c.json({
      teams: teams.map((team) => ({ ...team, stats: deps.teams.stats(ws.workspaceId, ws.user.id, team.id) })),
    });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const body = createTeamSchema.parse(await c.req.json());
    const team = deps.teams.create({ workspaceId: ws.workspaceId, userId: ws.user.id, ...body });
    return c.json({ team }, 201);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const id = c.req.param('id');
    const team = deps.teams.get(ws.workspaceId, ws.user.id, id);
    return c.json({
      team,
      context: deps.teams.context(ws.workspaceId, ws.user.id, id),
      stats: deps.teams.stats(ws.workspaceId, ws.user.id, id),
      agents: agentsForTeam(deps.db, ws.workspaceId, team.ambientId),
      workflows: workflowsForTeam(deps.db, ws.workspaceId, team.ambientId),
      approvals: approvalsForTeam(deps.db, ws.workspaceId, team.ambientId),
    });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const team = deps.teams.update(
      ws.workspaceId,
      ws.user.id,
      c.req.param('id'),
      updateTeamSchema.parse(await c.req.json()),
    );
    return c.json({ team });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.teams.delete(ws.workspaceId, ws.user.id, c.req.param('id')));
  });

  app.get('/:id/context', (c) => {
    const ws = getWorkspace(c);
    return c.json({ context: deps.teams.context(ws.workspaceId, ws.user.id, c.req.param('id')) });
  });

  app.patch('/:id/context', async (c) => {
    const ws = getWorkspace(c);
    const context = deps.teams.updateContext(
      ws.workspaceId,
      ws.user.id,
      c.req.param('id'),
      contextSchema.parse(await c.req.json()),
    );
    return c.json({ context });
  });

  app.get('/:id/agents', (c) => {
    const ws = getWorkspace(c);
    const team = deps.teams.get(ws.workspaceId, ws.user.id, c.req.param('id'));
    return c.json({ agents: agentsForTeam(deps.db, ws.workspaceId, team.ambientId) });
  });

  app.get('/:id/workflows', (c) => {
    const ws = getWorkspace(c);
    const team = deps.teams.get(ws.workspaceId, ws.user.id, c.req.param('id'));
    return c.json({ workflows: workflowsForTeam(deps.db, ws.workspaceId, team.ambientId) });
  });

  app.post('/:id/design', async (c) => {
    const ws = getWorkspace(c);
    const team = deps.teams.get(ws.workspaceId, ws.user.id, c.req.param('id'));
    const body = designSchema.parse(await c.req.json());
    const proposal = proposeTeamDesign(team.name, body.brief);
    let context = deps.teams.context(ws.workspaceId, ws.user.id, team.id);
    if (body.applyContext) {
      context = deps.teams.updateContext(ws.workspaceId, ws.user.id, team.id, proposal.context);
    }
    return c.json({ proposal, applied: body.applyContext, context });
  });

  return app;
}

function agentsForTeam(db: AgentisSqliteDb, workspaceId: string, ambientId: string) {
  return db.select().from(schema.agents).where(eq(schema.agents.workspaceId, workspaceId)).all()
    .filter((agent) => agent.ambientId === ambientId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function workflowsForTeam(db: AgentisSqliteDb, workspaceId: string, ambientId: string) {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .filter((workflow) => workflow.ambientId === ambientId)
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
}

function approvalsForTeam(db: AgentisSqliteDb, workspaceId: string, ambientId: string) {
  return db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.workspaceId, workspaceId)).all()
    .filter((approval) => approval.ambientId === ambientId && approval.status === 'pending' && !approval.dismissedAt)
    .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));
}

function proposeTeamDesign(teamName: string, brief: string) {
  const normalized = `${teamName} ${brief}`.toLowerCase();
  const isMarketing = /market|growth|brand|content|campaign|sales|launch/.test(normalized);
  const isResearch = /research|analysis|competitive|insight|experiment|survey/.test(normalized);
  const agents = isMarketing
    ? [
        { name: 'Growth Strategist', role: 'Owns campaign direction, channels, and launch sequencing.', capabilityTags: ['strategy', 'marketing', 'planning'] },
        { name: 'Content Operator', role: 'Turns briefs into publishable assets and distribution variants.', capabilityTags: ['content', 'copy', 'distribution'] },
        { name: 'Performance Analyst', role: 'Reads metrics, extracts lessons, and proposes next bets.', capabilityTags: ['analytics', 'reporting', 'experimentation'] },
      ]
    : isResearch
      ? [
          { name: 'Research Lead', role: 'Frames questions, designs evidence plans, and maintains source quality.', capabilityTags: ['research', 'synthesis', 'evidence'] },
          { name: 'Signal Scout', role: 'Finds relevant external signals, competitors, and examples.', capabilityTags: ['search', 'competitive-intel', 'curation'] },
          { name: 'Insight Synthesizer', role: 'Converts raw notes into decisions, risks, and next actions.', capabilityTags: ['analysis', 'writing', 'decision-support'] },
        ]
      : [
          { name: 'Product Engineer', role: 'Implements scoped changes and keeps the system aligned with architecture.', capabilityTags: ['engineering', 'implementation', 'testing'] },
          { name: 'System Reviewer', role: 'Reviews diffs, tests assumptions, and catches integration risk.', capabilityTags: ['review', 'quality', 'architecture'] },
          { name: 'Release Operator', role: 'Prepares validation, rollout notes, and follow-up work.', capabilityTags: ['release', 'ops', 'documentation'] },
        ];
  return {
    summary: `A proposed operating model for ${teamName}.`,
    agents,
    context: {
      operatingPrinciples: [
        'Keep work visible through approvals, run status, and memory updates.',
        'Prefer small autonomous steps with explicit handoffs over hidden long-running work.',
        'Escalate early when confidence, access, or budget is uncertain.',
      ].join('\n'),
      constraints: [
        'Do not create parallel systems when an existing Agentis primitive can be extended.',
        'Keep scope tied to the team purpose and current workspace context.',
        'Record durable learnings in memory when they change future execution.',
      ].join('\n'),
      handoffs: agents.map((agent) => `${agent.name}: ${agent.role}`).join('\n'),
      successMetrics: isMarketing
        ? 'Campaigns shipped, learnings captured, qualified engagement improved.'
        : isResearch
          ? 'Decision confidence improved, source quality preserved, next actions clarified.'
          : 'Working changes shipped, regressions caught, architectural alignment preserved.',
      escalationRules: 'Ask for operator approval before irreversible external actions, credential use, major spend, or ambiguous strategic tradeoffs.',
      sharedPrompt: `Team brief:\n${brief}`,
    },
  };
}