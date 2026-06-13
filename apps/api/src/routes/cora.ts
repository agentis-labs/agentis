/**
 * /v1/cora — the Workspace Brain's organizational intelligence engine
 * (RFC §15). Engineering namespace; the UI surfaces this as the Brain
 * "Sources" tab — never as a "CORA" page.
 *
 * Querying is NOT here: conversational answers go through the orchestrator
 * (RFC §14.5). These routes are onboarding, sources, claims, governance,
 * grants, influences, and migration.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { CoraSourceFabric } from '../cora/sourceFabric.js';
import type { EvidenceLedgerService } from '../cora/evidenceLedger.js';
import type { ClaimService } from '../cora/claimService.js';
import type { IdentityService } from '../cora/identityService.js';
import type { CoraModelService } from '../cora/modelService.js';
import type { CoraContextComposer } from '../cora/contextComposer.js';
import type { CoraMigrationService } from '../cora/migrationService.js';
import type { CoraDiscoveryService } from '../cora/discovery.js';
import type { CoraRuntime } from '../cora/coraRuntime.js';
import { buildOrganizationalOverlay } from '../cora/graphProjection.js';
import type { CoraInvestigationService } from '../cora/investigationService.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';

export interface CoraRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  fabric: CoraSourceFabric;
  ledger: EvidenceLedgerService;
  claims: ClaimService;
  identity: IdentityService;
  model: CoraModelService;
  composer: CoraContextComposer;
  migration: CoraMigrationService;
  discovery: CoraDiscoveryService;
  runtime: CoraRuntime;
  investigations: CoraInvestigationService;
}

const grantSchema = z.object({
  mode: z.enum(['none', 'full_delegated', 'agent_decides', 'human_approval']),
  allowedSources: z.array(z.string()).optional(),
  allowedDomains: z.array(z.string()).optional(),
  maxConfidentiality: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
  allowedAudiences: z.array(z.enum(['private', 'customer', 'public'])).optional(),
  protectedDomainPolicy: z.enum(['deny', 'approval_required', 'authoritative_only']).optional(),
  tokenBudgetPerRun: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
});

/**
 * Unauthenticated webhook ingress (mounted beside /v1/webhooks). The shared
 * per-connection secret in the path is the auth; payload bodies are ignored —
 * receipt only schedules an authoritative incremental sync (§7.4).
 */
export function buildCoraWebhookRoutes(deps: { fabric: CoraSourceFabric }) {
  const app = new Hono();
  app.post('/:connectionId/:secret', (c) => {
    const result = deps.fabric.handleWebhookHint(c.req.param('connectionId'), c.req.param('secret'));
    // 200 either way — never leak which connection ids/secrets exist.
    return c.json({ ok: result.accepted });
  });
  return app;
}

export function buildCoraRoutes(deps: CoraRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Onboarding (§15.1) ────────────────────────────────────

  app.get('/onboarding', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      profile: deps.discovery.getProfile(ws.workspaceId),
      learningPlan: deps.discovery.getLearningPlan(ws.workspaceId),
    });
  });

  app.post('/onboarding/discover', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.discovery.discover(ws.workspaceId));
  });

  app.post('/onboarding/sample', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === 'string' ? body.connectionId : null;
    if (!connectionId) throw new AgentisError('VALIDATION_FAILED', 'connectionId is required');
    const outcome = await deps.fabric.runSync({ workspaceId: ws.workspaceId, connectionId, mode: 'sample' });
    const recent = deps.ledger.listRecent(ws.workspaceId, 5);
    return c.json({ outcome, sample: recent });
  });

  app.post('/onboarding/launch', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      name: z.string().optional(),
      intent: z.string().optional(),
      operatingShape: z.string().optional(),
      charter: z.string().optional(),
      acceptSources: z.array(z.string()).optional(),
      acceptGrants: z.array(z.object({
        agentId: z.string(),
        mode: z.enum(['none', 'full_delegated', 'agent_decides', 'human_approval']),
      })).optional(),
    }).safeParse(body);
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', parsed.error.message);
    const result = deps.discovery.launch({ workspaceId: ws.workspaceId, ownerUserId: ws.user.id, ...parsed.data });
    // First learning pass (backfill → extract → snapshot) starts immediately;
    // launch ack stays fast (§14.12). The runtime then continues on its tick.
    void (async () => {
      for (const connectionId of result.connectionIds) {
        await deps.fabric.runSync({ workspaceId: ws.workspaceId, connectionId, mode: 'backfill' })
          .catch(() => deps.discovery.updateLearningPlanStage(ws.workspaceId, 'sync', 'attention'));
      }
      await deps.runtime.tickWorkspace(ws.workspaceId);
    })().catch(() => {});
    return c.json(result, 201);
  });

  // ── Sources ───────────────────────────────────────────────

  app.get('/sources', (c) => {
    const ws = getWorkspace(c);
    return c.json({
      connections: deps.fabric.listConnections(ws.workspaceId),
      available: deps.fabric.listRegisteredSources(),
    });
  });

  app.post('/sources', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      sourceType: z.string().min(1),
      displayName: z.string().optional(),
      credentialId: z.string().nullable().optional(),
      includedScopes: z.array(z.string()).optional(),
      excludedScopes: z.array(z.string()).optional(),
      learningBrief: z.record(z.string(), z.unknown()).optional(),
      reasoningMode: z.enum(['core', 'adaptive', 'deep']).optional(),
    }).safeParse(body);
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', parsed.error.message);
    return c.json(deps.fabric.createConnection({ workspaceId: ws.workspaceId, ...parsed.data }), 201);
  });

  app.get('/sources/:id', (c) => {
    const ws = getWorkspace(c);
    const connection = deps.fabric.getConnection(ws.workspaceId, c.req.param('id'));
    if (!connection) throw new AgentisError('RESOURCE_NOT_FOUND', 'Source connection not found');
    return c.json(connection);
  });

  app.patch('/sources/:id', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const updated = deps.fabric.updateConnection(ws.workspaceId, c.req.param('id'), body);
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', 'Source connection not found');
    return c.json(updated);
  });

  app.post('/sources/:id/sync', async (c) => {
    const ws = getWorkspace(c);
    const mode = c.req.query('mode') === 'backfill' ? 'backfill' : 'incremental';
    const outcome = await deps.fabric.runSync({ workspaceId: ws.workspaceId, connectionId: c.req.param('id'), mode });
    // A manual sync runs the full learning pass: extract → snapshot → stages.
    await deps.runtime.tickWorkspace(ws.workspaceId).catch(() => {});
    return c.json(outcome);
  });

  app.get('/sources/:id/scopes', async (c) => {
    const ws = getWorkspace(c);
    return c.json(await deps.fabric.discoverConnectionScopes(ws.workspaceId, c.req.param('id')));
  });

  app.post('/sources/:id/webhook/arm', (c) => {
    const ws = getWorkspace(c);
    const connection = deps.fabric.getConnection(ws.workspaceId, c.req.param('id'));
    if (!connection) throw new AgentisError('RESOURCE_NOT_FOUND', 'Source connection not found');
    return c.json(deps.fabric.armWebhook(ws.workspaceId, connection.id));
  });

  app.get('/sources/:id/runs', (c) => {
    const ws = getWorkspace(c);
    return c.json({ runs: deps.fabric.listSyncRuns(ws.workspaceId, c.req.param('id')) });
  });

  app.get('/learning-plan', (c) => {
    const ws = getWorkspace(c);
    return c.json({ plan: deps.discovery.getLearningPlan(ws.workspaceId) });
  });

  // ── Evidence + claims (§15.2) ─────────────────────────────

  app.get('/evidence/:id', (c) => {
    const ws = getWorkspace(c);
    const version = deps.ledger.getVersion(ws.workspaceId, c.req.param('id'));
    if (!version) throw new AgentisError('RESOURCE_NOT_FOUND', 'Evidence version not found');
    return c.json(version);
  });

  app.get('/claims', (c) => {
    const ws = getWorkspace(c);
    const status = c.req.query('status') as 'candidate' | 'active' | 'disputed' | undefined;
    return c.json({ claims: deps.claims.listClaims(ws.workspaceId, { status }) });
  });

  app.get('/claims/:id', (c) => {
    const ws = getWorkspace(c);
    const claim = deps.claims.getClaim(ws.workspaceId, c.req.param('id'));
    if (!claim) throw new AgentisError('RESOURCE_NOT_FOUND', 'Claim not found');
    // Enrich evidence links with citation summaries (title, native link,
    // liveness) so the detail rail can render grounded citations directly.
    const evidence = deps.claims.listEvidence(ws.workspaceId, claim.id).map((row) => {
      const version = deps.ledger.getVersion(ws.workspaceId, row.evidenceVersionId);
      const normalized = (version?.normalizedJson ?? {}) as { title?: string; nativeUrl?: string; objectType?: string };
      return {
        ...row,
        citation: version ? {
          title: normalized.title ?? row.evidenceVersionId.slice(0, 8),
          nativeUrl: normalized.nativeUrl ?? null,
          objectType: normalized.objectType ?? 'unknown',
          observedAt: version.observedAt,
          live: deps.ledger.isVersionLive(ws.workspaceId, row.evidenceVersionId),
        } : null,
      };
    });
    return c.json({ claim, evidence });
  });

  /** Organizational overlay for the Workspace Brain Map (§14.4). */
  app.get('/graph', (c) => {
    const ws = getWorkspace(c);
    return c.json({ graph: buildOrganizationalOverlay(deps.db, ws.workspaceId) });
  });

  app.post('/claims/:id/approve', (c) => {
    const ws = getWorkspace(c);
    const updated = deps.claims.setStatus(ws.workspaceId, c.req.param('id'), 'active');
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', 'Claim not found');
    return c.json(updated);
  });

  app.post('/claims/:id/reject', (c) => {
    const ws = getWorkspace(c);
    const updated = deps.claims.setStatus(ws.workspaceId, c.req.param('id'), 'rejected');
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', 'Claim not found');
    deps.composer.revokeInfluencesForClaims(ws.workspaceId, [updated.id]);
    return c.json(updated);
  });

  // ── Conflicts + identity (§15.4) ──────────────────────────

  app.get('/conflicts', (c) => {
    const ws = getWorkspace(c);
    return c.json({ conflicts: deps.claims.listConflicts(ws.workspaceId, { unresolvedOnly: c.req.query('all') !== 'true' }) });
  });

  app.post('/conflicts/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({
      resolution: z.enum(['confidence_winner', 'authority_winner', 'temporal_successor', 'human_decision']),
      winnerClaimId: z.string().optional(),
    }).safeParse(body);
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', parsed.error.message);
    const resolved = deps.claims.resolveConflict({ workspaceId: ws.workspaceId, conflictId: c.req.param('id'), ...parsed.data });
    if (!resolved) throw new AgentisError('RESOURCE_NOT_FOUND', 'Conflict not found');
    return c.json(resolved);
  });

  app.get('/identity-links', (c) => {
    const ws = getWorkspace(c);
    return c.json({ reviewQueue: deps.identity.listReviewQueue(ws.workspaceId) });
  });

  app.post('/identity-links/:id/resolve', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const decision = body.decision === 'approve' ? 'approve' : 'reject';
    const link = deps.identity.resolveLink(ws.workspaceId, c.req.param('id'), decision, ws.user.id);
    if (!link) throw new AgentisError('RESOURCE_NOT_FOUND', 'Identity link not found');
    return c.json(link);
  });

  app.get('/entities', (c) => {
    const ws = getWorkspace(c);
    return c.json({ entities: deps.identity.listEntities(ws.workspaceId, { kind: c.req.query('kind') ?? undefined }) });
  });

  // ── Model (§15.2) ─────────────────────────────────────────

  app.get('/model/artifacts', (c) => {
    const ws = getWorkspace(c);
    return c.json({ artifacts: deps.model.listArtifacts(ws.workspaceId, { kind: c.req.query('kind') ?? undefined }) });
  });

  app.get('/model/snapshot', (c) => {
    const ws = getWorkspace(c);
    return c.json({ snapshot: deps.model.activeSnapshot(ws.workspaceId) });
  });

  app.post('/model/snapshot', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.model.buildSnapshot(ws.workspaceId), 201);
  });

  // ── Agent grants + influences (§15.5–§15.6) ───────────────

  app.get('/agents/:agentId/grant', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.composer.resolveGrant(ws.workspaceId, c.req.param('agentId')));
  });

  app.put('/agents/:agentId/grant', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = grantSchema.safeParse(body);
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', parsed.error.message);
    return c.json(deps.composer.putGrant({ workspaceId: ws.workspaceId, agentId: c.req.param('agentId'), ...parsed.data }));
  });

  app.delete('/agents/:agentId/grant', (c) => {
    const ws = getWorkspace(c);
    deps.composer.deleteGrant(ws.workspaceId, c.req.param('agentId'));
    return c.json({ deleted: true });
  });

  app.get('/behavior-influences', (c) => {
    const ws = getWorkspace(c);
    return c.json({ influences: deps.composer.listInfluences(ws.workspaceId, { agentId: c.req.query('agentId') ?? undefined }) });
  });

  app.post('/behavior-influences/:id/revoke', (c) => {
    const ws = getWorkspace(c);
    deps.composer.revokeInfluence(ws.workspaceId, c.req.param('id'));
    return c.json({ revoked: true });
  });

  // ── Investigations (§15.3) ────────────────────────────────

  app.get('/investigations', (c) => {
    const ws = getWorkspace(c);
    return c.json({ investigations: deps.investigations.list(ws.workspaceId) });
  });

  app.get('/investigations/:id', (c) => {
    const ws = getWorkspace(c);
    const investigation = deps.investigations.get(ws.workspaceId, c.req.param('id'));
    if (!investigation) throw new AgentisError('RESOURCE_NOT_FOUND', 'Investigation not found');
    return c.json(investigation);
  });

  app.post('/investigations', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw new AgentisError('VALIDATION_FAILED', 'question is required');
    const result = await deps.investigations.run({
      workspaceId: ws.workspaceId,
      question,
      requester: { ownerId: ws.user.id },
    });
    return c.json(result, 201);
  });

  // ── Knowledge access requests (§9.5) ──────────────────────

  app.get('/access-requests', (c) => {
    const ws = getWorkspace(c);
    return c.json({ requests: deps.composer.listAccessRequests(ws.workspaceId, { status: c.req.query('status') ?? 'pending' }) });
  });

  app.post('/access-requests/:id/approve', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const scope = ['once', 'run', 'session', 'standing'].includes(body.scope) ? body.scope : 'once';
    const updated = deps.composer.decideAccessRequest({
      workspaceId: ws.workspaceId,
      requestId: c.req.param('id'),
      decision: 'approve',
      scope,
      decidedBy: ws.user.id,
    });
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', 'Access request not found');
    return c.json(updated);
  });

  app.post('/access-requests/:id/reject', (c) => {
    const ws = getWorkspace(c);
    const updated = deps.composer.decideAccessRequest({
      workspaceId: ws.workspaceId,
      requestId: c.req.param('id'),
      decision: 'reject',
      decidedBy: ws.user.id,
    });
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', 'Access request not found');
    return c.json(updated);
  });

  // ── Authority profiles (§10.4) ────────────────────────────

  app.get('/authority-profiles', (c) => {
    const ws = getWorkspace(c);
    return c.json({ profiles: deps.claims.getAuthorityProfiles(ws.workspaceId) });
  });

  app.put('/authority-profiles/:predicate', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const sourceTypes = Array.isArray(body.sourceTypes) ? body.sourceTypes.filter((s: unknown): s is string => typeof s === 'string') : [];
    return c.json({ profiles: deps.claims.setAuthorityProfile(ws.workspaceId, c.req.param('predicate'), sourceTypes) });
  });

  // ── Migration (§15.6) ─────────────────────────────────────

  app.get('/migration-candidates', (c) => {
    const ws = getWorkspace(c);
    return c.json({ candidates: deps.migration.list(ws.workspaceId) });
  });

  app.get('/migration-candidates/:id', (c) => {
    const ws = getWorkspace(c);
    const candidate = deps.migration.get(ws.workspaceId, c.req.param('id'));
    if (!candidate) throw new AgentisError('RESOURCE_NOT_FOUND', 'Migration candidate not found');
    return c.json({ candidate, gate: deps.migration.trustGate(ws.workspaceId, candidate.id) });
  });

  app.post('/migration-candidates/:id/evaluate', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.migration.evaluate(ws.workspaceId, c.req.param('id')));
  });

  app.post('/migration-candidates/:id/investigate', (c) => {
    const ws = getWorkspace(c);
    const updated = deps.migration.setStatus(ws.workspaceId, c.req.param('id'), 'investigating');
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', 'Migration candidate not found');
    return c.json(updated);
  });

  app.post('/migration-candidates/:id/draft', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.migration.generateDraft(ws.workspaceId, c.req.param('id')));
  });

  app.post('/migration-candidates/:id/shadow', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.migration.shadow(ws.workspaceId, c.req.param('id')));
  });

  app.post('/migration-candidates/:id/approve', (c) => {
    const ws = getWorkspace(c);
    return c.json(deps.migration.approve(ws.workspaceId, c.req.param('id'), ws.user.id));
  });

  app.post('/migration-candidates/:id/reject', (c) => {
    const ws = getWorkspace(c);
    const updated = deps.migration.setStatus(ws.workspaceId, c.req.param('id'), 'rejected');
    if (!updated) throw new AgentisError('RESOURCE_NOT_FOUND', 'Migration candidate not found');
    return c.json(updated);
  });

  return app;
}
