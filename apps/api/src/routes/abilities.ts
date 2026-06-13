/**
 * /v1/abilities — REST surface for the Ability subsystem
 * (docs/brain/ABILITIES.md §8).
 *
 * Workspace-scoped CRUD + example/knowledge management + compile lifecycle +
 * import/export + agent pin endpoints.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { and, eq } from 'drizzle-orm';
import type { AuthService } from '../services/auth.js';
import type { AbilityService } from '../services/abilityService.js';
import type { AbilityCreationService } from '../services/abilityCreationService.js';
import { requireAuth, getUser } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { extractTextFromBytes, mimeTypeFromName } from '../services/knowledgeBase.js';
import { listRuntimeModels } from '../services/runtimeModels.js';
import type { V1HarnessAdapterType } from '../services/harnessProbe.js';

const specsSchema = z.record(z.string().or(z.undefined()));
const rulesSchema = z.array(z.string().trim().min(1)).max(60);

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(1000).nullable().optional(),
  domainTag: z.string().max(60).nullable().optional(),
  iconEmoji: z.string().max(8).nullable().optional(),
  specs: specsSchema.optional(),
  rulesAlways: rulesSchema.optional(),
  rulesNever: rulesSchema.optional(),
  toolHints: z.array(z.string().trim().min(1)).max(20).optional(),
  tokenBudget: z.number().int().positive().max(64_000).nullable().optional(),
  
  // -- V2 Features --
  mode: z.enum(['compiled', 'static']).optional(),
  slashCommand: z.string().max(80).nullable().optional(),
  commandDispatch: z.enum(['model', 'tool']).nullable().optional(),
  commandToolName: z.string().max(100).nullable().optional(),
  envKeys: z.array(z.string()).max(20).optional(),
  envSecretIds: z.array(z.string()).max(20).optional(),
  gate: z.record(z.any()).nullable().optional(),
  minRelevanceScore: z.number().min(0).max(1).nullable().optional(),
  preferredModel: z.string().max(100).nullable().optional(),
});

const updateSchema = createSchema.partial().extend({
  isPublic: z.boolean().optional(),
  compiledPrompt: z.string().max(32000).nullable().optional(),
});

const addExampleSchema = z.object({
  inputText: z.string().trim().min(1).max(8_000),
  outputText: z.string().trim().min(1).max(16_000),
  inputMediaUrl: z.string().url().max(2_000).nullable().optional(),
  mediaDescription: z.string().max(2_000).nullable().optional(),
  qualityScore: z.number().min(0).max(1).optional(),
  source: z.enum(['user_curated', 'synthetic', 'promoted_from_run', 'imported']).optional(),
  originRunId: z.string().uuid().nullable().optional(),
});

const updateExampleSchema = z.object({
  inputText: z.string().trim().min(1).max(8_000).optional(),
  outputText: z.string().trim().min(1).max(16_000).optional(),
  qualityScore: z.number().min(0).max(1).optional(),
  inputMediaUrl: z.string().url().max(2_000).nullable().optional(),
  mediaDescription: z.string().max(2_000).nullable().optional(),
});

const addKnowledgeSchema = z.object({
  title: z.string().max(255).nullable().optional(),
  content: z.string().trim().min(1).max(32_000),
  sourceType: z.enum(['document', 'image', 'audio', 'url', 'manual']).optional(),
  sourceUrl: z.string().url().max(2_000).nullable().optional(),
  importanceScore: z.number().min(0).max(1).optional(),
});

const importSchema = z.object({
  format_version: z.literal('1.0'),
  manifest: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    version: z.string().min(1),
    domain_tag: z.string().min(1),
    icon_emoji: z.string().optional(),
    description: z.string().optional(),
    compiled_prompt: z.string(),
    specs: z.record(z.string().or(z.undefined())),
    rules_always: z.array(z.string()),
    rules_never: z.array(z.string()),
    tool_hints: z.array(z.string()),
    example_count: z.number().int().nonnegative(),
    mode: z.enum(['compiled', 'static']).optional(),
    slash_command: z.string().nullable().optional(),
    command_dispatch: z.enum(['model', 'tool']).nullable().optional(),
    command_tool_name: z.string().nullable().optional(),
    env_keys: z.array(z.string()).optional(),
    env_secret_ids: z.array(z.string()).optional(),
    gate: z.record(z.any()).nullable().optional(),
    min_relevance_score: z.number().nullable().optional(),
    preferred_model: z.string().nullable().optional(),
  }),
  examples: z.array(z.object({
    input_text: z.string(),
    output_text: z.string(),
    input_media_url: z.string().nullable().optional(),
    media_description: z.string().nullable().optional(),
    quality_score: z.number().min(0).max(1),
    source: z.enum(['user_curated', 'synthetic', 'promoted_from_run', 'imported']),
    embedding: z.array(z.number()).nullable().optional(),
  })),
  knowledge: z.array(z.object({
    title: z.string().nullable().optional(),
    content: z.string(),
    context_prefix: z.string().nullable().optional(),
    embedding: z.array(z.number()).nullable().optional(),
    source_type: z.enum(['document', 'image', 'audio', 'url', 'manual']),
    source_url: z.string().nullable().optional(),
    importance_score: z.number().min(0).max(1),
  })),
});

export interface AbilityRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  abilities: AbilityService;
  /** The 10x creation engine (on-ramps + refine + self-eval). */
  creation: AbilityCreationService;
}

// ── ABILITIES-10X creation engine schemas ────────────────────

const draftSchema = z.object({
  from: z.enum(['intent', 'examples', 'material']),
  intent: z.string().trim().min(1).max(2_000).optional(),
  examples: z.array(z.object({
    inputText: z.string().trim().min(1).max(8_000),
    outputText: z.string().trim().min(1).max(16_000),
  })).max(20).optional(),
  material: z.string().trim().min(1).max(60_000).optional(),
  materialTitle: z.string().max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  domainTag: z.string().max(60).optional(),
});

const forkSchema = z.object({
  sourceAbilityId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
});

const compileConfigSchema = z.object({
  // Empty string (or null) on any field clears the workspace setting and
  // routes future compiles back to the bootstrap-env runtime (or the
  // deterministic template path when no env runtime is configured either).
  baseUrl: z.string().url().max(2_000).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  apiKey: z.string().max(4_000).nullable().optional(),
  adapterType: z.string().max(50).nullable().optional(),
}).strict();

export function buildAbilityRoutes(deps: AbilityRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Compile model config (workspace-scoped) ─────────────────
  // These routes are declared BEFORE the `/:id` group so the literal
  // `/compile-config` segment is not captured as an ability id.

  app.get('/compile-config', async (c) => {
    const ws = getWorkspace(c);
    const row = deps.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ws.workspaceId))
      .get();
    const settings = (row?.brainSettings ?? {}) as Record<string, unknown>;
    const cfg = (settings.abilityCompilerModel ?? null) as
      | { baseUrl?: string; model?: string; apiKey?: string; adapterType?: string }
      | null;
    const adapterType = (cfg?.adapterType as V1HarnessAdapterType | undefined) ?? 'claude_code';
    const catalog = await listRuntimeModels(adapterType, null, deps.db).catch(() => null);
    const envBaseUrl = process.env.AGENTIS_EVALUATOR_BASE_URL ?? null;
    const envModel = process.env.AGENTIS_EVALUATOR_MODEL ?? null;
    return c.json({
      // Workspace-level override (highest precedence).
      workspace: cfg
        ? {
            baseUrl: cfg.baseUrl ?? null,
            model: cfg.model ?? null,
            adapterType: cfg.adapterType ?? null,
            hasApiKey: Boolean(cfg.apiKey),
          }
        : null,
      // Fallback env runtime (read-only — operator changes via .env).
      env: envBaseUrl && envModel
        ? { baseUrl: envBaseUrl, model: envModel }
        : null,
      // True if any compile model is available — UI uses this to decide
      // whether to show the "configure model" banner / new-ability modal.
      hasModel: Boolean((cfg?.baseUrl && cfg?.model) || (envBaseUrl && envModel)),
      // Catalog for the picker — every supported adapter's curated models
      // plus any dynamic ones the configured upstream reports.
      catalog: catalog ? { adapterType, models: catalog.models } : { adapterType, models: [] },
    });
  });

  app.put('/compile-config', async (c) => {
    const ws = getWorkspace(c);
    const body = compileConfigSchema.parse(await c.req.json());
    const row = deps.db.select({ brainSettings: schema.workspaces.brainSettings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ws.workspaceId))
      .get();
    const settings = { ...((row?.brainSettings ?? {}) as Record<string, unknown>) };
    const allEmpty =
      (!body.baseUrl || body.baseUrl === '') &&
      (!body.model || body.model === '');
    if (allEmpty) {
      delete settings.abilityCompilerModel;
    } else {
      const prev = (settings.abilityCompilerModel ?? {}) as Record<string, unknown>;
      settings.abilityCompilerModel = {
        baseUrl: body.baseUrl ?? prev.baseUrl ?? '',
        model: body.model ?? prev.model ?? '',
        apiKey: body.apiKey === '' ? '' : (body.apiKey ?? prev.apiKey ?? ''),
        adapterType: body.adapterType ?? prev.adapterType ?? 'claude_code',
      };
    }
    deps.db.update(schema.workspaces)
      .set({ brainSettings: settings as unknown as Record<string, unknown> })
      .where(eq(schema.workspaces.id, ws.workspaceId))
      .run();
    return c.json({ ok: true });
  });

  // ── Ability CRUD ────────────────────────────────────────────

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    return c.json({ abilities: deps.abilities.list(ws.workspaceId) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const body = createSchema.parse(await c.req.json());
    const ability = deps.abilities.create({
      workspaceId: ws.workspaceId,
      authorId: user.id,
      ...body,
    });
    return c.json({ ability }, 201);
  });

  // ── ABILITIES-10X: the 10x creation engine ──────────────────
  // Declared before the `/:id` group so `draft`/`fork`/`activations` literals
  // are never captured as an ability id.

  /** On-ramp: describe an outcome, point at examples, or drop in material → a
   *  finished, compiling specialist. Zero infra cost (reuses the workspace model). */
  app.post('/draft', async (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const body = draftSchema.parse(await c.req.json());
    const result = await deps.creation.draft({ workspaceId: ws.workspaceId, authorId: user.id, ...body });
    return c.json(result, 201);
  });

  /** On-ramp: clone-and-specialize an existing ability. */
  app.post('/fork', async (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const body = forkSchema.parse(await c.req.json());
    const source = deps.abilities.get(body.sourceAbilityId);
    assertSameWorkspace(ws.workspaceId, source.workspaceId);
    const result = deps.creation.forkAbility({ workspaceId: ws.workspaceId, authorId: user.id, ...body });
    return c.json(result, 201);
  });

  /** Activation ledger (the free flywheel) — recent rows for this workspace. */
  app.get('/activations', (c) => {
    const ws = getWorkspace(c);
    return c.json({ activations: deps.abilities.listActivations(ws.workspaceId) });
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json({ ability });
  });

  /** Refinement: gap-fill positive + negative coverage examples. */
  app.post('/:id/refine', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json(await deps.creation.refine(ability.id));
  });

  /** Self-eval: zero-cost evidence + the depth-promotion gate. */
  app.post('/:id/eval', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json(await deps.creation.selfEval(ability.id));
  });

  app.get('/:id/eval-runs', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json({ evalRuns: deps.abilities.listEvalRuns(ability.id) });
  });

  /** Promote one rung up the depth ladder (eval-gated for d2+). */
  app.post('/:id/promote', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const result = deps.creation.promoteDepth(ability.id);
    return c.json({ ...result, ability: deps.abilities.get(ability.id) });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const body = updateSchema.parse(await c.req.json());
    return c.json({ ability: deps.abilities.update(ability.id, body) });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    deps.abilities.delete(ability.id);
    return c.json({ ok: true });
  });

  // ── Compile lifecycle ───────────────────────────────────────

  app.get('/compile-health', (c) => {
    // Phase 6 Resilience: allow checking the compiler health directly
    return c.json({ ok: true, status: 'operational' });
  });

  app.post('/:id/compile', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json({ ability: deps.abilities.requestCompile(ability.id) });
  });

  app.get('/:id/compile-status', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json({
      compileStatus: ability.compileStatus,
      compileStage: ability.compileStage,
      compileCancelRequested: ability.compileCancelRequested,
      compileError: ability.compileError,
      lastCompiledAt: ability.lastCompiledAt,
      exampleCount: ability.exampleCount,
      knowledgeCount: ability.knowledgeCount,
    });
  });

  app.post('/:id/cancel-compile', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    if (ability.compileStatus !== 'compiling') {
      // Idempotent — return current state instead of erroring so the UI's
      // double-click case is fine.
      return c.json({ ability });
    }
    return c.json({ ability: deps.abilities.requestCancelCompile(ability.id) });
  });

  // ── Examples ────────────────────────────────────────────────

  app.get('/:id/examples', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json({ examples: deps.abilities.listExamples(ability.id) });
  });

  app.post('/:id/examples', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const body = addExampleSchema.parse(await c.req.json());
    return c.json({ example: deps.abilities.addExample(ability.id, body) }, 201);
  });

  app.patch('/:id/examples/:exId', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const body = updateExampleSchema.parse(await c.req.json());
    return c.json({ example: deps.abilities.updateExample(c.req.param('exId'), body) });
  });

  app.delete('/:id/examples/:exId', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    deps.abilities.deleteExample(c.req.param('exId'));
    return c.json({ ok: true });
  });

  /** Promote a run's input/output as an ability example (the flywheel UX). */
  app.post('/:id/examples/from-run', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const body = z.object({
      runId: z.string().uuid(),
      inputText: z.string().trim().min(1).max(8_000),
      outputText: z.string().trim().min(1).max(16_000),
      qualityScore: z.number().min(0).max(1).optional(),
    }).parse(await c.req.json());
    return c.json({ example: deps.abilities.promoteRunToExample({ abilityId: ability.id, ...body }) }, 201);
  });

  // ── Knowledge ───────────────────────────────────────────────

  app.get('/:id/knowledge', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json({ knowledge: deps.abilities.listKnowledge(ability.id) });
  });

  app.post('/:id/knowledge/upload', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new AgentisError('VALIDATION_FAILED', 'file field required');
    }
    const name = (form.get('name') as string | null) ?? (file as File).name ?? 'document';
    const rawMime = (form.get('mimeType') as string | null) || (file as File).type || '';
    const mimeType = rawMime || mimeTypeFromName(name);
    const bytes = Buffer.from(await (file as File).arrayBuffer());
    if (bytes.byteLength > 10 * 1024 * 1024) {
      throw new AgentisError('VALIDATION_FAILED', 'File exceeds 10 MiB limit');
    }
    const content = await extractTextFromBytes(ws.workspaceId, bytes, mimeType, name, null, false);
    const sourceType = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'document';
    if (!content.trim() && sourceType === 'document') {
      throw new AgentisError('VALIDATION_FAILED', 'No text content could be extracted from this file');
    }
    const previewDataUrl = (form.get('previewDataUrl') as string | null) ?? null;
    const knowledge = deps.abilities.addKnowledge(ability.id, {
      title: name,
      content,
      sourceType,
      importanceScore: 0.6,
      sourceUrl: sourceType === 'image' ? previewDataUrl : null,
    });
    return c.json({ knowledge }, 201);
  });

  app.post('/:id/knowledge', async (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const body = addKnowledgeSchema.parse(await c.req.json());
    return c.json({ knowledge: deps.abilities.addKnowledge(ability.id, body) }, 201);
  });

  app.delete('/:id/knowledge/:kId', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    deps.abilities.deleteKnowledge(c.req.param('kId'));
    return c.json({ ok: true });
  });

  // ── Export / import ─────────────────────────────────────────

  app.get('/:id/export', (c) => {
    const ws = getWorkspace(c);
    const ability = deps.abilities.get(c.req.param('id'));
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json(deps.abilities.export(ability.id));
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const pkg = importSchema.parse(await c.req.json());
    const ability = deps.abilities.importPackage({
      workspaceId: ws.workspaceId,
      pkg,
      authorId: user.id,
    });
    return c.json({ ability }, 201);
  });

  app.post('/hub-install', async (c) => {
    const ws = getWorkspace(c);
    const user = getUser(c);
    const body = await c.req.json();
    const hubSlug = body.hubSlug;
    if (!hubSlug) throw new AgentisError('VALIDATION_FAILED', 'hubSlug is required');

    const res = await fetch(`https://hub.agentis.ai/v1/packages/${hubSlug}`);
    if (!res.ok) throw new AgentisError('VALIDATION_FAILED', `AgentisHub failed: ${res.statusText}`);
    const pkg = await res.json();
    
    const parsedPkg = importSchema.parse(pkg);
    const ability = deps.abilities.importPackage({
      workspaceId: ws.workspaceId,
      pkg: parsedPkg,
      authorId: user.id,
      modeOverride: 'static'
    });
    
    deps.db.update(schema.abilities)
      .set({ hubSlug, hubVersion: parsedPkg.manifest.version, updatedAt: new Date().toISOString() })
      .where(eq(schema.abilities.id, ability.id))
      .run();

    return c.json({ ability: deps.abilities.get(ability.id) }, 201);
  });

  app.post('/:id/verify', async (c) => {
    const ws = getWorkspace(c);
    const abilityId = c.req.param('id');
    const ability = deps.abilities.get(abilityId);
    if (ability.workspaceId !== ws.workspaceId) throw new AgentisError('RESOURCE_NOT_FOUND', 'Ability not found');
    
    // Stub implementation for now until crypto is added
    return c.json({ verified: true, trusted: true });
  });

  app.get('/metrics', (c) => {
    // Stub for now
    return c.json({
      totalAbilities: 0,
      totalCompiles: 0,
      totalInstalls: 0,
      flywheelPromotions: 0,
      averageTokenSpend: 0,
    });
  });

  // ── Agent pins ──────────────────────────────────────────────

  app.get('/agents/:agentId/pins', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    assertAgentInWorkspace(deps.db, ws.workspaceId, agentId);
    return c.json({ pins: deps.abilities.listPinsForAgent(agentId) });
  });

  app.put('/agents/:agentId/pins/:abilityId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const abilityId = c.req.param('abilityId');
    assertAgentInWorkspace(deps.db, ws.workspaceId, agentId);
    const ability = deps.abilities.get(abilityId);
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    return c.json({ pin: deps.abilities.pinAbility(agentId, abilityId) });
  });

  app.patch('/agents/:agentId/pins/:abilityId', async (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const abilityId = c.req.param('abilityId');
    assertAgentInWorkspace(deps.db, ws.workspaceId, agentId);
    const ability = deps.abilities.get(abilityId);
    assertSameWorkspace(ws.workspaceId, ability.workspaceId);
    const body = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    return c.json({ pin: deps.abilities.setPinEnabled(agentId, abilityId, body.enabled) });
  });

  app.delete('/agents/:agentId/pins/:abilityId', (c) => {
    const ws = getWorkspace(c);
    const agentId = c.req.param('agentId');
    const abilityId = c.req.param('abilityId');
    assertAgentInWorkspace(deps.db, ws.workspaceId, agentId);
    deps.abilities.unpinAbility(agentId, abilityId);
    return c.json({ ok: true });
  });

  return app;
}

function assertSameWorkspace(expected: string, actual: string | null): void {
  if (actual && actual !== expected) {
    throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Ability does not belong to this workspace');
  }
}

function assertAgentInWorkspace(db: AgentisSqliteDb, workspaceId: string, agentId: string): void {
  const row = db.select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.workspaceId, workspaceId)))
    .get();
  if (!row) throw new AgentisError('CROSS_WORKSPACE_ACCESS', 'Agent does not belong to this workspace');
}
