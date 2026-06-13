/**
 * A2A surface — Agentis speaks Agent2Agent (UNIVERSAL-HARNESS §8, Pillar 5).
 *
 * Discovery (Agent Cards):
 *   GET  /v1/a2a/agent-card.json         → the workspace's A2A Agent Card; its
 *                                          skills are the published workflows.
 *   GET  /v1/a2a/agents                  → per-agent cards (capability discovery)
 *   GET  /v1/a2a/agents/:id/card         → one agent's card
 *
 * Interaction (task reception):
 *   POST /v1/a2a/message:send            → run the addressed skill (published
 *                                          workflow), await it, return an A2A
 *                                          Task with the output as an artifact.
 *
 * A2A is the horizontal (agent↔agent) complement to MCP's vertical (agent↔tool)
 * surface. Reception reuses the exact `runPublishedWorkflow` mechanism MCP uses,
 * so the two protocol surfaces cannot drift.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { AgentisError, type WorkflowGraph } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import { runPublishedWorkflow, inputSchemaFor } from '../engine/runPublishedWorkflow.js';
import { requireAuth } from '../middleware/auth.js';
import { getWorkspace, requireWorkspace } from '../middleware/workspace.js';

const PROTOCOL_VERSION = '0.3.0';

export interface A2aRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  adapters: AdapterManager;
  engine: WorkflowEngine;
  /** Records the inbound A2A call as a conversation-theater interaction. */
  activity?: import('../services/activityFeed.js').ActivityFeedService;
}

interface WorkflowSkill {
  id: string;            // the published slug — used as the A2A skill id
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildA2aRoutes(deps: A2aRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Discovery: the workspace Agent Card ──────────────────────────────────
  app.get('/agent-card.json', (c) => {
    const ws = getWorkspace(c);
    const skills = publishedSkills(deps.db, ws.workspaceId);
    return c.json({
      protocolVersion: PROTOCOL_VERSION,
      name: 'Agentis workspace',
      description: 'Agentis orchestration workspace exposed as an A2A agent. Skills are published workflows.',
      version: '1.0.0',
      url: '/v1/a2a',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['text', 'application/json'],
      defaultOutputModes: ['text', 'application/json'],
      skills: skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: ['workflow'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      })),
    });
  });

  // ── Discovery: per-agent cards ───────────────────────────────────────────
  app.get('/agents', (c) => {
    const ws = getWorkspace(c);
    const rows = deps.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ws.workspaceId)).all();
    return c.json({ agents: rows.map((a) => buildAgentCard(deps, a)) });
  });

  app.get('/agents/:id/card', (c) => {
    const ws = getWorkspace(c);
    const agent = deps.db.select().from(schema.agents)
      .where(and(eq(schema.agents.id, c.req.param('id')), eq(schema.agents.workspaceId, ws.workspaceId))).get();
    if (!agent) return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'agent not found' } }, 404);
    return c.json(buildAgentCard(deps, agent));
  });

  // ── Interaction: A2A message:send ────────────────────────────────────────
  app.post('/message:send', async (c) => {
    const ws = getWorkspace(c);
    const body = (await c.req.json().catch(() => ({}))) as A2aSendParams;
    const message = body.message;
    if (!message || !Array.isArray(message.parts)) {
      throw new AgentisError('VALIDATION_FAILED', 'message.parts is required');
    }
    const skillId = body.skillId ?? message.skillId;
    if (!skillId) throw new AgentisError('VALIDATION_FAILED', 'a skillId (published workflow slug) is required');

    const wf = publishedWorkflowBySlug(deps.db, ws.workspaceId, skillId);
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `no published A2A skill '${skillId}'`);

    const inputs = inputsFromParts(message.parts);
    const taskId = randomUUID();
    // CONVERSATION THEATER: record the inbound agent-to-agent call.
    try {
      deps.activity?.record({
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        eventType: 'a2a.message_received',
        actorType: 'agent',
        actorId: null,
        entityType: 'workflow',
        entityId: wf.id,
        summary: `A2A: an external agent invoked skill “${skillId}”`,
        metadata: { skillId, workflowId: wf.id },
      });
    } catch { /* best-effort */ }
    const run = await runPublishedWorkflow({
      db: deps.db, engine: deps.engine,
      workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id,
      workflowId: wf.id, graph: wf.graph as WorkflowGraph, inputs,
    });

    // A2A Task shape: id, status.state, artifacts[].
    const state = run.status === 'COMPLETED' || run.status === 'COMPLETED_WITH_CONTRACT_VIOLATION'
      ? 'completed'
      : run.terminal ? 'failed' : 'working';
    return c.json({
      id: taskId,
      contextId: run.runId,
      kind: 'task',
      status: { state, timestamp: new Date().toISOString() },
      artifacts: run.output != null ? [{
        artifactId: randomUUID(),
        name: `${skillId}-output`,
        parts: [{ kind: 'data', data: run.output }],
      }] : [],
    });
  });

  return app;
}

// ─── Agent Card builder ─────────────────────────────────────────────────────

function buildAgentCard(deps: A2aRoutesDeps, agent: typeof schema.agents.$inferSelect) {
  const capabilities = deps.adapters.capabilities(agent.id);
  const affordances = capabilities?.affordances ?? {};
  const tags = Array.isArray(agent.capabilityTags) ? (agent.capabilityTags as string[]) : [];
  const abilities = deps.db
    .select({ name: schema.abilities.name, slug: schema.abilities.slug, domainTag: schema.abilities.domainTag })
    .from(schema.agentAbilityPins)
    .innerJoin(schema.abilities, eq(schema.agentAbilityPins.abilityId, schema.abilities.id))
    .where(and(eq(schema.agentAbilityPins.agentId, agent.id), eq(schema.agentAbilityPins.enabled, true)))
    .all();

  const affordanceTags = Object.entries(affordances).filter(([, v]) => v === true).map(([k]) => k);
  const skills = [
    ...abilities.map((ab) => ({
      id: `ability:${ab.slug}`,
      name: ab.name,
      description: ab.domainTag ? `${ab.name} (${ab.domainTag})` : ab.name,
      tags: ['ability', ...(ab.domainTag ? [ab.domainTag] : [])],
    })),
    ...tags.map((t) => ({ id: `tag:${t}`, name: t, description: `Capability tag: ${t}`, tags: ['capability'] })),
  ];

  return {
    protocolVersion: PROTOCOL_VERSION,
    name: agent.name,
    description: agent.description ?? `${agent.name} — ${agent.adapterType} agent on Agentis`,
    version: '1.0.0',
    url: `/v1/a2a/agents/${agent.id}`,
    provider: { organization: 'Agentis', adapterType: agent.adapterType },
    capabilities: {
      streaming: capabilities?.interactiveChat ?? false,
      pushNotifications: false,
      // Surface Agentis affordances so peers can route to the right agent.
      affordances: affordanceTags,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface A2aPart { kind?: string; text?: string; data?: unknown }
interface A2aMessage { role?: string; parts: A2aPart[]; skillId?: string }
interface A2aSendParams { skillId?: string; message?: A2aMessage }

/** Map A2A message parts → workflow inputs. DataParts merge as structured inputs; TextParts become `input`. */
function inputsFromParts(parts: A2aPart[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const texts: string[] = [];
  for (const part of parts) {
    if (part.kind === 'data' && part.data && typeof part.data === 'object' && !Array.isArray(part.data)) {
      Object.assign(inputs, part.data as Record<string, unknown>);
    } else if (typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  if (texts.length > 0 && inputs.input === undefined) inputs.input = texts.join('\n');
  return inputs;
}

function publishedSkills(db: AgentisSqliteDb, workspaceId: string): WorkflowSkill[] {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .map((r) => ({ r, mcp: mcpOf(r.settings) }))
    .filter((x) => x.mcp.published && x.mcp.slug)
    .map(({ r, mcp }) => ({
      id: mcp.slug!,
      name: r.title,
      description: r.description ?? r.title,
      inputSchema: inputSchemaFor(r.graph as WorkflowGraph),
    }));
}

function publishedWorkflowBySlug(db: AgentisSqliteDb, workspaceId: string, slug: string) {
  return db.select().from(schema.workflows).where(eq(schema.workflows.workspaceId, workspaceId)).all()
    .find((r) => { const m = mcpOf(r.settings); return Boolean(m.published && m.slug === slug); });
}

function mcpOf(settings: unknown): { published?: boolean; slug?: string } {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).mcp : undefined;
  return s && typeof s === 'object' ? (s as { published?: boolean; slug?: string }) : {};
}
