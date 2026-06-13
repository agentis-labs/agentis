/**
 * /v1/specialists — the specialist registry surface
 * (docs/SPECIALISTS-10X-ARCHITECTURE-PLAN.md, near-term API).
 *
 * A specialist is an expert *role*, not just an agent row: it is defined by the
 * platform library, a workspace-authored custom definition, an AI-generated
 * definition, or a community install — and may or may not be materialized as a
 * runnable agent yet. This route unifies those sources into one
 * `SpecialistSummary` list and lets operators author new specialists that the
 * engine can route to immediately (custom `agentRole` becomes legal at dispatch).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError, normalizeRole } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { SpecialistAgentService } from '../services/specialistAgents.js';
import type { AgentLibraryService } from '../services/agentLibrary.js';
import type { SpecialistLoadoutService, LoadoutMode } from '../services/specialistLoadoutService.js';
import type { AbilityService } from '../services/abilityService.js';
import type { SpecialistProfileService } from '../services/specialistProfileService.js';
import type { SpecialistMindService } from '../services/specialistMindService.js';
import type { SpecialistDemandRouter } from '../services/specialistDemandRouter.js';
import type { SpecialistRuntimeService } from '../services/specialistRuntimeService.js';
import type { SpecialistEvalService } from '../services/specialistEvalService.js';
import type { SpecialistTemplateService } from '../services/specialistTemplateService.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface SpecialistRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  specialists: SpecialistAgentService;
  agentLibrary: AgentLibraryService;
  loadouts: SpecialistLoadoutService;
  abilities: AbilityService;
  profiles: SpecialistProfileService;
  mind: SpecialistMindService;
  router: SpecialistDemandRouter;
  runtime: SpecialistRuntimeService;
  evals: SpecialistEvalService;
  templates: SpecialistTemplateService;
}

/** Build the loadout-ability name/mode pairs for a role (used in cards). */
function loadoutAbilityList(deps: SpecialistRoutesDeps, workspaceId: string, role: string): Array<{ name: string; mode: string }> {
  const entries = deps.loadouts.listForRole(workspaceId, role).filter((e) => e.enabled);
  return entries.map((e) => ({ name: deps.abilities.tryGet(e.abilityId)?.name ?? e.abilityId, mode: e.mode }));
}

export interface SpecialistSummary {
  role: string;
  name: string;
  description: string;
  source: 'platform' | 'custom' | 'community' | 'generated';
  status: 'live' | 'offline' | 'draft';
  agentId: string | null;
  tools: string[];
  capabilityTags: string[];
  avatarGlyph: string;
  colorHex: string;
}

const LIVE_STATUSES = new Set(['online', 'idle', 'busy']);

const createSchema = z
  .object({
    role: z.string().trim().max(64).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    instructions: z.string().max(20_000).optional(),
    model: z.string().trim().max(100).optional(),
    tools: z.array(z.string().trim().min(1)).max(40).optional(),
    capabilityTags: z.array(z.string().trim().min(1)).max(40).optional(),
    colorHex: z.string().trim().max(9).optional(),
    avatarGlyph: z.string().trim().max(8).optional(),
  })
  .refine((d) => Boolean(d.role?.trim() || d.name?.trim()), {
    message: 'a role or name is required',
  });

export function buildSpecialistRoutes(deps: SpecialistRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  /**
   * GET /v1/specialists — every known specialist (platform, custom, generated,
   * community), enriched with whether it is materialized as a runnable agent.
   */
  app.get('/', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const summaries = await listSpecialists(deps, workspaceId);
    return c.json({ specialists: summaries, count: summaries.length });
  });

  app.get('/templates', async (c) => {
    return c.json({ templates: deps.templates.list() });
  });

  app.get('/request/recent', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
    return c.json({ decisions: deps.router.recent(workspaceId, limit) });
  });

  app.post('/request', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const userId = getUser(c).id;
    const body = await c.req.json().catch(() => ({}));
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid specialist request');
    }
    const route = await deps.router.request(workspaceId, userId, parsed.data);
    return c.json({ route });
  });

  /**
   * POST /v1/specialists — author a human-defined specialist. Persists its
   * definition to the workspace agent library and materializes the agent row
   * idempotently, so workflows/orchestrators can route to its role at once.
   */
  app.post('/', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const userId = getUser(c).id;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid specialist');
    }
    const result = await deps.specialists.authorSpecialist(workspaceId, userId, {
      ...parsed.data,
      source: 'custom',
    });
    // Phase 1 — author the durable profile alongside the agent.
    deps.profiles.ensureFromDef(workspaceId, result.def, userId);
    const summary = toSummary(result.def, { id: result.agentId, status: 'offline' });
    return c.json({ specialist: summary, created: result.created }, result.created ? 201 : 200);
  });

  app.post('/:role/compile', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const userId = getUser(c).id;
    const def = deps.specialists.defForRole(workspaceId, role);
    deps.profiles.ensureFromDef(workspaceId, def, userId);
    const mind = await deps.mind.compile(workspaceId, role);
    const cases = deps.evals.ensureStarterCases(workspaceId, role);
    const profile = deps.profiles.patch(workspaceId, role, { status: cases.length >= 3 ? 'ready' : 'draft' });
    const card = deps.profiles.generateCard(workspaceId, role, {
      def,
      tools: [...def.tools],
      abilities: loadoutAbilityList(deps, workspaceId, role),
      modalities: { inputs: ['text', 'file', 'image'], outputs: ['text', 'artifact'] },
    });
    return c.json({ profile, mind, evals: { cases: cases.length }, card });
  });

  app.get('/:role/compile-status', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const profile = deps.profiles.get(workspaceId, role) ?? deps.profiles.ensureFromDef(workspaceId, deps.specialists.defForRole(workspaceId, role));
    const mind = deps.mind.getMind(workspaceId, role);
    const loadout = deps.loadouts.listForRole(workspaceId, role);
    const cases = deps.evals.ensureStarterCases(workspaceId, role);
    const warnings = [
      !mind || mind.sources.length === 0 ? 'Add at least one mind source before trusting this specialist broadly.' : null,
      loadout.filter((entry) => entry.enabled).length === 0 ? 'No ability loadout configured.' : null,
      cases.length < 3 ? 'At least 3 eval cases are required before ready.' : null,
    ].filter(Boolean);
    return c.json({
      status: {
        role,
        profileStatus: profile.status,
        mindStatus: mind?.status ?? 'missing',
        sourceCount: mind?.sources.length ?? 0,
        atomCount: mind?.atoms.length ?? 0,
        loadoutCount: loadout.filter((entry) => entry.enabled).length,
        evalCaseCount: cases.length,
        ready: profile.status === 'ready' && (mind?.atoms.length ?? 0) > 0 && cases.length >= 3,
        warnings,
      },
    });
  });

  app.post('/:role/publish', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    await deps.mind.compile(workspaceId, role);
    deps.evals.ensureStarterCases(workspaceId, role);
    const def = deps.specialists.defForRole(workspaceId, role);
    deps.profiles.ensureFromDef(workspaceId, def, getUser(c).id);
    const profile = deps.profiles.patch(workspaceId, role, { status: 'ready' });
    const card = deps.profiles.generateCard(workspaceId, role, {
      def,
      tools: [...def.tools],
      abilities: loadoutAbilityList(deps, workspaceId, role),
      modalities: { inputs: ['text', 'file', 'image'], outputs: ['text', 'artifact'] },
    });
    return c.json({ profile, card });
  });

  // ── Specialist profile + card (Phase 1) ─────────────────────

  app.get('/:role/card', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const def = deps.specialists.defForRole(workspaceId, role);
    const card = deps.profiles.generateCard(workspaceId, role, {
      def,
      tools: [...def.tools],
      abilities: loadoutAbilityList(deps, workspaceId, role),
    });
    return c.json({ card });
  });

  app.get('/:role', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const def = deps.specialists.defForRole(workspaceId, role);
    // Materialize a profile lazily so the detail view always has one.
    const profile = deps.profiles.get(workspaceId, role) ?? deps.profiles.ensureFromDef(workspaceId, def);
    return c.json({ profile, loadout: loadoutAbilityList(deps, workspaceId, role) });
  });

  app.patch('/:role', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const body = await c.req.json().catch(() => ({}));
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid profile patch');
    }
    // Ensure a profile exists before patching.
    deps.profiles.get(workspaceId, role) ?? deps.profiles.ensureFromDef(workspaceId, deps.specialists.defForRole(workspaceId, role));
    const profile = deps.profiles.patch(workspaceId, role, parsed.data);
    return c.json({ profile });
  });

  app.get('/:role/mind', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    return c.json({
      mind: deps.mind.getMind(workspaceId, role) ?? {
        role: normalizeRole(role),
        summary: null,
        status: 'missing',
        sources: [],
        atoms: [],
        media: [],
      },
    });
  });

  app.post('/:role/mind/sources', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const body = await c.req.json().catch(() => ({}));
    const parsed = mindSourceSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid mind source');
    }
    if (parsed.data.kind === 'image') {
      const base64 = parsed.data.imageBase64 ? stripDataUrl(parsed.data.imageBase64) : '';
      if (!base64) throw new AgentisError('VALIDATION_FAILED', 'imageBase64 is required for image sources');
      const result = await deps.mind.addImageSource(workspaceId, role, {
        title: parsed.data.title,
        bytes: Buffer.from(base64, 'base64'),
        mimeType: parsed.data.mimeType ?? 'image/png',
        caption: parsed.data.caption,
        trust: parsed.data.trust,
      });
      return c.json(result, 201);
    }
    if (!parsed.data.content?.trim()) {
      throw new AgentisError('VALIDATION_FAILED', 'content is required for text/file/url sources');
    }
    const result = await deps.mind.addTextSource(workspaceId, role, {
      kind: parsed.data.kind,
      title: parsed.data.title,
      uri: parsed.data.uri,
      content: parsed.data.content,
      trust: parsed.data.trust,
    });
    return c.json(result, 201);
  });

  app.post('/:role/mind/atoms', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const body = await c.req.json().catch(() => ({}));
    const parsed = mindAtomSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid mind atom');
    }
    const atom = await deps.mind.addAtom(workspaceId, role, parsed.data);
    return c.json({ atom }, 201);
  });

  app.post('/:role/mind/compile', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const mind = await deps.mind.compile(workspaceId, c.req.param('role'));
    return c.json({ mind });
  });

  app.delete('/:role/mind/sources/:sourceId', async (c) => {
    const { workspaceId } = getWorkspace(c);
    deps.mind.removeSource(workspaceId, c.req.param('sourceId'));
    return c.json({ ok: true });
  });

  app.get('/:role/runs', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 20)));
    return c.json({ runs: deps.runtime.listRuns(workspaceId, c.req.param('role'), limit) });
  });

  app.get('/:role/evals', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const cases = deps.evals.ensureStarterCases(workspaceId, role);
    const runs = deps.evals.listRuns(workspaceId, role);
    const qualityEvents = deps.evals.qualityEvents(workspaceId, role);
    return c.json({ cases, runs, qualityEvents });
  });

  app.post('/:role/evals', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const body = await c.req.json().catch(() => ({}));
    const parsed = evalCaseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid eval case');
    }
    const evalCase = deps.evals.addCase(workspaceId, role, parsed.data);
    return c.json({ case: evalCase }, 201);
  });

  app.post('/:role/evals/:caseId/run', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const body = await c.req.json().catch(() => ({}));
    const parsed = evalRunSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid eval run');
    }
    const run = deps.evals.runCase(workspaceId, role, c.req.param('caseId'), parsed.data.output);
    return c.json({ run }, 201);
  });

  app.post('/:role/evals/runs/:runId/promote', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const run = await deps.evals.promoteRunToMind(workspaceId, role, c.req.param('runId'));
    return c.json({ run });
  });

  // ── Ability loadouts (Phase 3) ──────────────────────────────
  // A specialist's professional DNA: which abilities are required/preferred/
  // optional/forbidden for a functional role.

  app.get('/:role/abilities', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const entries = deps.loadouts.listForRole(workspaceId, role);
    const abilities = deps.abilities.list(workspaceId).map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      description: a.description ?? null,
      domainTag: a.domainTag ?? null,
      compileStatus: a.compileStatus,
    }));
    const byId = new Map(abilities.map((a) => [a.id, a]));
    const loadout = entries.map((e) => ({ ...e, ability: byId.get(e.abilityId) ?? null }));
    return c.json({ role, loadout, abilities });
  });

  app.put('/:role/abilities/:abilityId', async (c) => {
    const { workspaceId } = getWorkspace(c);
    const role = c.req.param('role');
    const abilityId = c.req.param('abilityId');
    if (!deps.abilities.tryGet(abilityId)) {
      throw new AgentisError('RESOURCE_NOT_FOUND', `ability ${abilityId} not found`);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = loadoutSchema.safeParse(body);
    if (!parsed.success) {
      throw new AgentisError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'invalid loadout');
    }
    const entry = deps.loadouts.setEntry(workspaceId, role, abilityId, {
      mode: parsed.data.mode as LoadoutMode | undefined,
      priority: parsed.data.priority,
      minRelevanceScore: parsed.data.minRelevanceScore ?? null,
      conflictPolicy: parsed.data.conflictPolicy,
      enabled: parsed.data.enabled,
    });
    return c.json({ entry });
  });

  app.delete('/:role/abilities/:abilityId', async (c) => {
    const { workspaceId } = getWorkspace(c);
    deps.loadouts.removeEntry(workspaceId, c.req.param('role'), c.req.param('abilityId'));
    return c.json({ ok: true });
  });

  return app;
}

const profilePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().max(160).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  identityPrompt: z.string().max(20_000).nullable().optional(),
  responsibilityContract: z.string().max(8_000).nullable().optional(),
  boundaries: z.string().max(8_000).nullable().optional(),
  status: z.enum(['draft', 'ready', 'degraded', 'archived']).optional(),
  runtimeProfile: z.record(z.unknown()).optional(),
}).strict();

const requestSchema = z.object({
  task: z.string().trim().min(1).max(20_000),
  modality: z.string().trim().max(40).optional(),
  desiredTopology: z.enum(['direct', 'supervisor', 'sequential', 'swarm', 'hierarchical', 'shadow']).optional(),
  constraints: z.record(z.unknown()).optional(),
  callerAgentId: z.string().nullable().optional(),
  workflowId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  materialize: z.boolean().optional(),
  createRun: z.boolean().optional(),
}).strict();

const mindSourceSchema = z.object({
  kind: z.enum(['text', 'url', 'file', 'image', 'run', 'brain_atom', 'ability']).default('text'),
  title: z.string().trim().max(160).optional(),
  uri: z.string().trim().max(2000).optional(),
  content: z.string().max(100_000).optional(),
  trust: z.string().trim().max(40).optional(),
  imageBase64: z.string().max(8_000_000).optional(),
  mimeType: z.string().trim().max(80).optional(),
  caption: z.string().trim().max(1000).optional(),
}).strict();

const mindAtomSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  atomType: z.enum(['fact', 'preference', 'rule', 'visual_pattern', 'anti_pattern', 'example', 'decision']).optional(),
  sourceId: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
}).strict();

const evalCaseSchema = z.object({
  name: z.string().trim().min(1).max(160),
  input: z.string().trim().min(1).max(20_000),
  expected: z.string().max(20_000).nullable().optional(),
  rubric: z.string().max(20_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).max(20).optional(),
}).strict();

const evalRunSchema = z.object({
  output: z.string().max(100_000).optional(),
}).strict();

const loadoutSchema = z.object({
  mode: z.enum(['required', 'preferred', 'optional', 'forbidden']).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  minRelevanceScore: z.number().min(0).max(1).nullable().optional(),
  conflictPolicy: z.enum(['specialist_wins', 'ability_wins', 'newest_wins', 'evaluator_decides']).optional(),
  enabled: z.boolean().optional(),
});

/** Union the library definitions with materialized agents into one summary list. */
async function listSpecialists(deps: SpecialistRoutesDeps, workspaceId: string): Promise<SpecialistSummary[]> {
  // `list` warms the library sync cache that defForRole consults below.
  const defs = await deps.agentLibrary.list(workspaceId);
  const agents = deps.specialists.list(workspaceId);
  const agentByRole = new Map<string, { id: string; status: string }>();
  for (const a of agents) {
    if (a.role) agentByRole.set(normalizeRole(a.role), { id: a.id, status: a.status });
  }
  const roles = new Set<string>();
  for (const d of defs) roles.add(normalizeRole(d.role));
  for (const role of agentByRole.keys()) roles.add(role);

  return [...roles]
    .map((role) => toSummary(deps.specialists.defForRole(workspaceId, role), agentByRole.get(role) ?? null))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toSummary(
  def: { role: string; source?: string; name: string; description: string; tools: readonly string[]; capabilityTags: string[]; avatarGlyph: string; colorHex: string },
  agent: { id: string; status: string } | null,
): SpecialistSummary {
  const status: SpecialistSummary['status'] = !agent
    ? 'draft'
    : LIVE_STATUSES.has(agent.status)
      ? 'live'
      : 'offline';
  return {
    role: def.role,
    name: def.name,
    description: def.description,
    source: (def.source as SpecialistSummary['source']) ?? 'custom',
    status,
    agentId: agent?.id ?? null,
    tools: [...def.tools],
    capabilityTags: def.capabilityTags,
    avatarGlyph: def.avatarGlyph,
    colorHex: def.colorHex,
  };
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
}
