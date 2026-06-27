/**
 * Agentic App routes (AGENTIC-APPS-10X-MASTERPLAN §3).
 *
 * CRUD + membership + workflow adoption for the App entity. Surfaces (§4) and
 * datastore (§5) routes mount separately in later phases. Thin layer over
 * `AppStore`; all workspace-scoping and validation live here.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  AgentisError,
  createAppSchema,
  updateAppSchema,
  appMemberRoleSchema,
  appStatusSchema,
  defineCollectionSchema,
  insertRecordSchema,
  updateRecordSchema,
  upsertRecordSchema,
  dataQuerySchema,
  collectionsInView,
  upsertSurfaceSchema,
  uiRenderSchema,
  uiPerformRegionSchema,
  appManifestEnvelopeSchema,
  promoteAppEnvironmentSchema,
  upsertAppEnvironmentSchema,
  type AppInstallPreview,
  type AppRecord,
} from '@agentis/core';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { WorkflowGraph, AgentTool } from '@agentis/core';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import type { WorkflowEngine } from '../engine/WorkflowEngine.js';
import type { AgentToolRuntime } from '../services/agentToolRuntime.js';
import { runPublishedWorkflow } from '../engine/runPublishedWorkflow.js';
import { buildAppStores, AppEnvironmentStore, AppLifecycle, AppPackager, AppTestHarness } from '@agentis/app';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { scanArtifactBytes, type ScanFinding } from '../services/registryScanner.js';
import { generateSurfaceView } from '../services/surfaceGenerator.js';
import type { StructuredCompleter } from '../services/structuredCompleter.js';
import type { AppStaffingService } from '../services/appStaffing.js';
import type { ConversationStore } from '../services/conversationStore.js';
import type { AppContactService } from '../services/appContacts.js';
import type { ConversationParticipantService } from '../services/conversationParticipants.js';
import type { AppLearningService } from '../services/appLearning.js';
import { AppLearningService as AppLearningStatic } from '../services/appLearning.js';
import type { ConversationSimulatorService } from '../services/conversationSimulator.js';

export interface AppRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus?: EventBus;
  /** Enables `kind:'workflow'` actions (run a workflow synchronously). */
  engine?: WorkflowEngine;
  /** Enables `kind:'tool'` actions (invoke an agent tool in App context). */
  toolRuntime?: AgentToolRuntime;
  /** Powers agent-assisted surface generation. Omit → deterministic scaffold only. */
  completer?: StructuredCompleter;
  /** Births an App's cast at creation (Phase R). Omit → Apps are created unstaffed. */
  staffing?: AppStaffingService;
  /** Append + realtime-publish operator messages into a live thread (Phase 2 takeover). */
  conversations?: ConversationStore;
  /** Deliver an operator's reply out to the origin channel (Phase 2 takeover). */
  channels?: { deliverToConnection(args: { connectionId: string; chatId: string; body: string }): Promise<void> };
  /** App relationship pipeline — list/update contacts (Phase 3). */
  contacts?: AppContactService;
  /** Multi-party threads (G1) — list/add/remove conversation participants + warm handoff. */
  participants?: ConversationParticipantService;
  /** Conversational learning loop (Phase M2) — record outcomes, surface learnings. */
  learning?: AppLearningService;
  /** Conversation rehearsal (Phase 5 · G8) — drive a synthetic customer + score the run. */
  simulator?: ConversationSimulatorService;
}

const addMemberSchema = z.object({
  agentId: z.string().min(1),
  role: appMemberRoleSchema.default('worker'),
});

const adoptWorkflowSchema = z.object({ workflowId: z.string().min(1) });
const renameSurfaceSchema = z.object({ name: z.string().trim().min(1).max(120) });
const generateSurfaceRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  surface: z.string().min(1).optional(),
});
const operatorCommandSchema = z.object({ command: z.string().trim().min(1).max(4000) });
const takeoverSchema = z.object({ active: z.boolean() });
const operatorSendSchema = z.object({ body: z.string().trim().min(1).max(8000) });
const addParticipantSchema = z.object({
  participantType: z.enum(['agent', 'human', 'contact']),
  participantId: z.string().trim().min(1).max(255).nullable().optional(),
  role: z.enum(['primary', 'specialist', 'operator', 'customer']).default('specialist'),
  active: z.boolean().default(true),
});
const contactPatchSchema = z.object({
  stage: z.string().trim().max(64).nullable().optional(),
  goal: z.string().trim().max(2000).nullable().optional(),
  displayName: z.string().trim().max(255).nullable().optional(),
  nextTouchAt: z.string().datetime().nullable().optional(),
  data: z.record(z.unknown()).optional(),
});
const contactOutcomeSchema = z.object({
  outcome: z.enum(['won', 'lost', 'abandoned']),
  note: z.string().trim().max(2000).nullable().optional(),
  setStage: z.string().trim().max(64).nullable().optional(),
});

// Conversation rehearsal (Phase 5 · G8). A scenario drives a synthetic customer
// against the resident agent and scores the transcript. Patterns are plain
// substrings (case-insensitive); guardrails/expectations are matched against agent replies.
const simulatePatternSchema = z.string().trim().min(1).max(400);
const simulateGuardrailSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  pattern: simulatePatternSchema,
});
const simulateExpectationSchema = simulateGuardrailSchema;
const simulateScenarioSchema = z.object({
  name: z.string().trim().min(1).max(200),
  persona: z.object({
    name: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(4000),
  }),
  goal: z.string().trim().min(1).max(2000),
  customerTurns: z.array(z.string().trim().min(1).max(4000)).max(12).optional(),
  maxTurns: z.number().int().min(1).max(12).optional(),
  goalSignals: z.array(simulatePatternSchema).max(20).optional(),
  guardrails: z.array(simulateGuardrailSchema).max(20).optional(),
  expectations: z.array(simulateExpectationSchema).max(20).optional(),
});
const simulateRequestSchema = z.object({
  scenario: simulateScenarioSchema,
  agentId: z.string().trim().min(1).max(255).optional(),
});

const createAppRequestSchema = createAppSchema.extend({
  /** Create the first App workflow in the same transaction as the App itself. */
  createEntryWorkflow: z.boolean().default(false),
  entryWorkflowTitle: z.string().trim().min(1).max(255).optional(),
  /** Starter graph for the entry workflow (template gallery, masterplan 5.5). Empty when omitted. */
  entryWorkflowGraph: z.object({ version: z.literal(1), nodes: z.array(z.unknown()), edges: z.array(z.unknown()) }).passthrough().optional(),
}).refine(
  (input) => !(input.createEntryWorkflow && input.entryWorkflowId),
  { message: 'entryWorkflowId and createEntryWorkflow cannot be used together' },
);

const importAppSchema = z.object({
  envelope: appManifestEnvelopeSchema,
  permissionsAcknowledged: z.array(z.string()).default([]),
});

const appTestSchema = z.object({
  envelope: appManifestEnvelopeSchema,
  actions: z.array(z.object({
    surface: z.string().min(1),
    name: z.string().min(1),
    args: z.record(z.unknown()).optional(),
  })).default([]),
  assertions: z.array(z.object({
    collection: z.string().min(1),
    query: dataQuerySchema.optional(),
    count: z.number().int().nonnegative().optional(),
    includes: z.record(z.unknown()).optional(),
  })).default([]),
});

/** Opaque public-share token: base64url("appId\0surfaceName"). The `shareable`
 * flag on the surface is the real gate; the token just avoids id enumeration. */
const SHARE_TOKEN_SEPARATOR = '\u001f';

function encodeShareToken(appId: string, surface: string): string {
  return Buffer.from(`${appId}${SHARE_TOKEN_SEPARATOR}${surface}`, 'utf8').toString('base64url');
}
function decodeShareToken(token: string): { appId: string; surface: string } | null {
  try {
    const [appId, surface] = Buffer.from(token, 'base64url').toString('utf8').split(SHARE_TOKEN_SEPARATOR);
    return appId && surface ? { appId, surface } : null;
  } catch {
    return null;
  }
}

function scanAppEnvelope(envelope: unknown): ScanFinding[] {
  const label =
    envelope && typeof envelope === 'object' && 'manifest' in envelope
      ? String((envelope as { manifest?: { identity?: { slug?: unknown } } }).manifest?.identity?.slug ?? '.agentisapp')
      : '.agentisapp';
  const scan = scanArtifactBytes(Buffer.from(JSON.stringify(envelope ?? null), 'utf8'), label);
  const blockers = scan.findings.filter((finding) => finding.severity === 'block');
  if (blockers.length > 0) {
    throw new AgentisError('APP_PACKAGE_SCAN_BLOCKED', 'App import blocked by security scan', {
      details: { findings: blockers },
    });
  }
  return scan.findings.filter((finding) => finding.severity === 'warn');
}

function appendScanWarnings(preview: AppInstallPreview, findings: ScanFinding[]): AppInstallPreview {
  const scanWarnings = findings.map((finding) => `${finding.rule}: ${finding.detail}`);
  return {
    ...preview,
    scanWarnings,
    warnings: [...preview.warnings, ...scanWarnings.map((warning) => `Security scan warning: ${warning}`)],
  };
}

function assertAppPermissionsAcknowledged(preview: AppInstallPreview, acknowledged: string[]): void {
  const expected = [...preview.permissions].sort();
  const actual = [...acknowledged].sort();
  if (expected.length === actual.length && expected.every((permission, index) => permission === actual[index])) return;
  throw new AgentisError('APP_PERMISSIONS_NOT_ACKNOWLEDGED', 'App permissions must be acknowledged before install', {
    details: { expected, acknowledged: actual },
  });
}

/** Validate a domain (or subdomain) belongs to this workspace before assigning. */
function ensureAppDomain(db: AgentisSqliteDb, workspaceId: string, domainId: string): void {
  const domain = db
    .select({ id: schema.domains.id })
    .from(schema.domains)
    .where(and(eq(schema.domains.id, domainId), eq(schema.domains.workspaceId, workspaceId)))
    .get();
  if (!domain) throw new AgentisError('RESOURCE_NOT_FOUND', `domain ${domainId} not found`);
}

export function buildAppRoutes(deps: AppRoutesDeps) {
  const app = new Hono<{ Variables: { user: { id: string } } }>();
  const { store, data, surfaces } = buildAppStores(deps);
  const packager = new AppPackager(deps.db);
  const lifecycle = new AppLifecycle(deps.db);
  const environments = new AppEnvironmentStore(deps.db);

  // ── Public, unauthed surface sharing (AGENTIC-APPS-10X §4.7) ────────────────
  // Registered BEFORE auth. Gated by the surface's `shareable` flag.
  const loadShared = (token: string) => {
    const decoded = decodeShareToken(token);
    if (!decoded) throw new AgentisError('RESOURCE_NOT_FOUND', 'share link invalid');
    const appRow = deps.db
      .select({ id: schema.apps.id, workspaceId: schema.apps.workspaceId, name: schema.apps.name, icon: schema.apps.icon })
      .from(schema.apps)
      .where(eq(schema.apps.id, decoded.appId))
      .get();
    if (!appRow) throw new AgentisError('RESOURCE_NOT_FOUND', 'share link invalid');
    const surface = surfaces.get(appRow.workspaceId, appRow.id, decoded.surface);
    if (!surface.shareable) throw new AgentisError('RESOURCE_NOT_FOUND', 'share link invalid');
    return { appRow, surface };
  };

  app.get('/public/surfaces/:token', (c) => {
    const { appRow, surface } = loadShared(c.req.param('token'));
    return c.json({ data: { app: { name: appRow.name, icon: appRow.icon }, surface } });
  });

  app.post('/public/surfaces/:token/query', async (c) => {
    const { appRow, surface } = loadShared(c.req.param('token'));
    const body = (await c.req.json().catch(() => ({}))) as { collection?: string } & Record<string, unknown>;
    if (!body.collection) throw new AgentisError('VALIDATION_FAILED', 'collection required');
    // Authorization: a public share may read ONLY the collections its own view
    // binds — never a sibling collection it doesn't display. Without this, a
    // share link to one surface could enumerate every collection in the app.
    if (!collectionsInView(surface.view).has(body.collection)) {
      throw new AgentisError('RESOURCE_NOT_FOUND', 'collection not available on this surface');
    }
    const query = dataQuerySchema.parse({
      ...(body.filter !== undefined ? { filter: body.filter } : {}),
      ...(body.sort !== undefined ? { sort: body.sort } : {}),
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
    });
    return c.json(data.query(appRow.workspaceId, appRow.id, body.collection, query));
  });

  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/:id/surfaces/:name/share', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const name = c.req.param('name');
    surfaces.upsert(ws.workspaceId, appId, { ...surfaces.get(ws.workspaceId, appId, name), shareable: true });
    const token = encodeShareToken(appId, name);
    const url = new URL(c.req.url);
    url.pathname = `/public/apps/${encodeURIComponent(token)}`;
    url.search = '';
    return c.json({ data: { token, url: url.toString() } });
  });

  app.get('/', (c) => {
    const ws = getWorkspace(c);
    const statusRaw = c.req.query('status');
    const status = statusRaw ? appStatusSchema.parse(statusRaw) : undefined;
    return c.json({ data: store.list(ws.workspaceId, status ? { status } : {}) });
  });

  app.post('/', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const parsed = createAppRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid app input');
    const { createEntryWorkflow, entryWorkflowTitle, entryWorkflowGraph, ...input } = parsed.data;
    if (input.domainId) ensureAppDomain(deps.db, ws.workspaceId, input.domainId);

    // Birth the App's cast (Phase R). Best-effort — re-reads so the new owner shows.
    const staffNewApp = async (app: AppRecord): Promise<AppRecord> => {
      if (!deps.staffing) return app;
      await deps.staffing.staffApp({
        workspaceId: ws.workspaceId,
        userId: user.id,
        appId: app.id,
        name: app.name,
        description: app.description ?? '',
      });
      return store.get(ws.workspaceId, app.id);
    };

    if (!createEntryWorkflow) {
      return c.json({ data: await staffNewApp(store.create(ws.workspaceId, user.id, input)) }, 201);
    }

    let created: AppRecord | null = null;
    deps.db.transaction(() => {
      const entryWorkflowId = randomUUID();
      deps.db.insert(schema.workflows).values({
        id: entryWorkflowId,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId ?? null,
        userId: user.id,
        title: entryWorkflowTitle ?? `${input.name} workflow`,
        graph: entryWorkflowGraph ?? { version: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        settings: {},
        concurrencyOverflow: 'queue',
      }).run();
      created = store.create(ws.workspaceId, user.id, { ...input, entryWorkflowId });
    });
    if (!created) throw new AgentisError('INTERNAL_ERROR', 'Failed to create app workflow');
    return c.json({ data: await staffNewApp(created) }, 201);
  });

  /**
   * Promote a legacy bare workflow to a first-class App-of-one. The workflow
   * itself is preserved verbatim; the transaction only assigns its owner App.
   */
  app.post('/from-workflow/:workflowId', (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const workflowId = c.req.param('workflowId');
    let appRecord: AppRecord | null = null;
    let promoted = false;

    deps.db.transaction(() => {
      const workflow = deps.db
        .select({ id: schema.workflows.id, title: schema.workflows.title, appId: schema.workflows.appId })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.id, workflowId)))
        .get();
      if (!workflow) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${workflowId}`);
      if (workflow.appId) {
        appRecord = store.get(ws.workspaceId, workflow.appId);
      } else {
        promoted = true;
        appRecord = store.create(ws.workspaceId, user.id, {
          name: workflow.title,
          description: '',
          entryWorkflowId: workflow.id,
        });
      }
    });

    if (!appRecord) throw new AgentisError('INTERNAL_ERROR', 'Failed to promote workflow to app');
    return c.json({ data: appRecord }, promoted ? 201 : 200);
  });

  app.get('/:id', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: store.get(ws.workspaceId, c.req.param('id')) });
  });

  // ── Packaging — `.agentisapp` export/import (§7.2) ──────────

  app.get('/:id/export', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: packager.export(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/import/preview', async (c) => {
    const envelope = appManifestEnvelopeSchema.parse(await c.req.json());
    const warnings = scanAppEnvelope(envelope);
    return c.json({ data: appendScanWarnings(packager.preview(envelope), warnings) });
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = importAppSchema.parse(await c.req.json());
    const warnings = scanAppEnvelope(body.envelope);
    const preview = appendScanWarnings(packager.preview(body.envelope), warnings);
    assertAppPermissionsAcknowledged(preview, body.permissionsAcknowledged);
    return c.json({ data: packager.import(ws.workspaceId, user.id, body.envelope) }, 201);
  });

  app.post('/test', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = appTestSchema.parse(await c.req.json());
    scanAppEnvelope(body.envelope);
    const manifest = packager.deserialize(body.envelope);
    const result = new AppTestHarness(deps.db).runIsolated(ws.workspaceId, user.id, {
      manifest,
      actions: body.actions,
      assertions: body.assertions,
    });
    return c.json({ data: result });
  });

  app.post('/:id/upgrade/preview', async (c) => {
    const ws = getWorkspace(c);
    const envelope = appManifestEnvelopeSchema.parse(await c.req.json());
    const manifest = packager.deserialize(envelope);
    return c.json({ data: lifecycle.planUpgrade(ws.workspaceId, c.req.param('id'), manifest) });
  });

  app.post('/:id/upgrade', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const envelope = appManifestEnvelopeSchema.parse(await c.req.json());
    const manifest = packager.deserialize(envelope);
    return c.json({ data: lifecycle.upgrade(ws.workspaceId, user.id, c.req.param('id'), manifest, { installedChecksum: envelope.checksum }) });
  });

  app.post('/:id/rollback/:snapshotId', (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    return c.json({ data: lifecycle.rollback(ws.workspaceId, user.id, c.req.param('id'), c.req.param('snapshotId')) });
  });

  app.get('/:id/environments', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: environments.list(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/environments/:name/snapshot', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = z.object({ kind: z.enum(['dev', 'staging', 'production']).default('dev') }).parse(await c.req.json().catch(() => ({})));
    return c.json({ data: environments.snapshotRuntime(ws.workspaceId, user.id, c.req.param('id'), c.req.param('name'), body.kind) });
  });

  app.put('/:id/environments/:name', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = upsertAppEnvironmentSchema.parse(await c.req.json());
    return c.json({ data: environments.upsert(ws.workspaceId, user.id, c.req.param('id'), c.req.param('name'), body) });
  });

  app.post('/:id/environments/:name/promote', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const body = promoteAppEnvironmentSchema.parse(await c.req.json());
    return c.json({ data: environments.promote(ws.workspaceId, user.id, c.req.param('id'), c.req.param('name'), body) });
  });

  app.patch('/:id', async (c) => {
    const ws = getWorkspace(c);
    const parsed = updateAppSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid app update');
    if (parsed.data.domainId) ensureAppDomain(deps.db, ws.workspaceId, parsed.data.domainId);
    return c.json({ data: store.update(ws.workspaceId, c.req.param('id'), parsed.data) });
  });

  app.delete('/:id', (c) => {
    const ws = getWorkspace(c);
    store.delete(ws.workspaceId, c.req.param('id'));
    return c.json({ data: { ok: true } });
  });

  // ── Membership ──────────────────────────────────────────────

  app.get('/:id/members', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: store.listMembers(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/members', async (c) => {
    const ws = getWorkspace(c);
    const parsed = addMemberSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid member input');
    store.addMember(ws.workspaceId, c.req.param('id'), parsed.data.agentId, parsed.data.role);
    return c.json({ data: store.listMembers(ws.workspaceId, c.req.param('id')) }, 201);
  });

  app.delete('/:id/members/:agentId', (c) => {
    const ws = getWorkspace(c);
    store.removeMember(ws.workspaceId, c.req.param('id'), c.req.param('agentId'));
    return c.json({ data: { ok: true } });
  });

  /**
   * The App's cast (Phase R) — members joined with agent identity, the operator
   * marked, ordered operator-first. Powers the Team strip in the App view.
   */
  app.get('/:id/team', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const app = store.get(ws.workspaceId, appId);
    const rows = deps.db
      .select({
        agentId: schema.appMembers.agentId,
        memberRole: schema.appMembers.role,
        name: schema.agents.name,
        functionalRole: schema.agents.role,
        colorHex: schema.agents.colorHex,
        avatarGlyph: schema.agents.avatarGlyph,
        status: schema.agents.status,
      })
      .from(schema.appMembers)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.appMembers.agentId))
      .where(and(eq(schema.appMembers.appId, appId), eq(schema.agents.workspaceId, ws.workspaceId)))
      .all();
    const members = rows
      .map((r) => ({ ...r, isOwner: r.agentId === app.ownerAgentId }))
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || (a.memberRole === 'operator' ? -1 : 1));
    return c.json({ data: { ownerAgentId: app.ownerAgentId, members } });
  });

  // ── Live conversations (Living Apps Phase 1) ────────────────
  // The App's real customer threads — the `conversations`/`messages` spine
  // scoped to this App (conversations.app_id), NOT a datastore snapshot. Powers
  // the live Inbox/ChatThread nodes (source:'conversations').

  app.get('/:id/conversations', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId); // 404s if the App is not in this workspace
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const rows = deps.db
      .select({
        id: schema.conversations.id,
        title: schema.conversations.title,
        channelChatId: schema.conversations.channelChatId,
        lastMessageAt: schema.conversations.lastMessageAt,
        unreadCount: schema.conversations.unreadCount,
        handoffState: schema.conversations.handoffState,
        kind: schema.channelConnections.kind,
      })
      .from(schema.conversations)
      .leftJoin(schema.channelConnections, eq(schema.channelConnections.id, schema.conversations.channelConnectionId))
      .where(and(eq(schema.conversations.workspaceId, ws.workspaceId), eq(schema.conversations.appId, appId)))
      .orderBy(desc(schema.conversations.lastMessageAt))
      .limit(limit)
      .all();
    return c.json({ data: rows.map((r) => ({
      id: r.id,
      title: r.title ?? r.channelChatId ?? 'Conversation',
      channel: r.kind ?? null,
      lastMessageAt: r.lastMessageAt,
      unread: r.unreadCount ?? 0,
      handoffState: r.handoffState ?? null,
    })) });
  });

  app.get('/:id/conversations/:conversationId/messages', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    // Authorize: the thread must belong to this App in this workspace.
    const conv = deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, ws.workspaceId),
        eq(schema.conversations.appId, appId),
      ))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const rows = deps.db
      .select({
        id: schema.conversationMessages.id,
        authorType: schema.conversationMessages.authorType,
        body: schema.conversationMessages.body,
        createdAt: schema.conversationMessages.createdAt,
        metadata: schema.conversationMessages.metadata,
      })
      .from(schema.conversationMessages)
      .where(eq(schema.conversationMessages.conversationId, conversationId))
      .orderBy(desc(schema.conversationMessages.createdAt))
      .limit(limit)
      .all();
    // Map persisted author/metadata to a chat role: channel-inbound + operator = user.
    const messages = rows.reverse().map((r) => {
      const meta = (r.metadata ?? {}) as { channelInbound?: boolean };
      const role: 'user' | 'agent' | 'system' =
        r.authorType === 'operator' || meta.channelInbound ? 'user' : r.authorType === 'system' ? 'system' : 'agent';
      return { id: r.id, role, content: r.body, at: r.createdAt };
    });
    return c.json({ data: messages });
  });

  // Operator takeover (Phase 2): park the resident agent so a human drives the
  // thread, or hand it back. `active:false` returns control to the agent.
  app.post('/:id/conversations/:conversationId/takeover', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    const parsed = takeoverSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid takeover input');
    const conv = deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.workspaceId, ws.workspaceId), eq(schema.conversations.appId, appId)))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
    const handoffState = parsed.data.active ? 'human' : null;
    deps.db.update(schema.conversations).set({ handoffState, updatedAt: new Date().toISOString() }).where(eq(schema.conversations.id, conversationId)).run();
    return c.json({ data: { conversationId, handoffState } });
  });

  // Operator send (Phase 2): post a human reply into the live thread and deliver it
  // to the origin channel. The customer sees one continuous agent — no seam.
  app.post('/:id/conversations/:conversationId/send', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    const parsed = operatorSendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid send input');
    const conv = deps.db
      .select({ id: schema.conversations.id, channelConnectionId: schema.conversations.channelConnectionId, channelChatId: schema.conversations.channelChatId })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.workspaceId, ws.workspaceId), eq(schema.conversations.appId, appId)))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
    const body = parsed.data.body.trim();
    let delivered = false;
    if (conv.channelConnectionId && conv.channelChatId && deps.channels) {
      try {
        await deps.channels.deliverToConnection({ connectionId: conv.channelConnectionId, chatId: conv.channelChatId, body });
        delivered = true;
      } catch {
        delivered = false;
      }
    }
    deps.conversations?.appendOutbound({
      workspaceId: ws.workspaceId,
      conversationId,
      operatorId: user.id,
      body,
      deliveryStatus: delivered ? 'delivered' : 'failed',
      metadata: { operatorTakeover: true, channelReply: true, ...(conv.channelChatId ? { channelChatId: conv.channelChatId } : {}) },
    });
    return c.json({ data: { conversationId, delivered } });
  });

  // ── Multi-party participants (Living Apps Phase 2 · G1) ─────
  // The cast in a thread beside conversations.agentId (the primary): a customer,
  // the resident agent, an escalation specialist, a human operator. An active
  // 'specialist' agent becomes the inbound responder (warm handoff); hand back by
  // removing it. Authorized exactly like the conversation routes above.

  const authorizeConversation = (workspaceId: string, appId: string, conversationId: string): void => {
    const conv = deps.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
        eq(schema.conversations.appId, appId),
      ))
      .get();
    if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found in this app`);
  };

  app.get('/:id/conversations/:conversationId/participants', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    authorizeConversation(ws.workspaceId, appId, conversationId);
    if (!deps.participants) return c.json({ data: [] });
    // Seed the primary from conversations.agentId so the cast is never empty.
    deps.participants.ensurePrimary(conversationId);
    return c.json({ data: deps.participants.list(conversationId) });
  });

  app.post('/:id/conversations/:conversationId/participants', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    authorizeConversation(ws.workspaceId, appId, conversationId);
    if (!deps.participants) throw new AgentisError('INTERNAL_ERROR', 'participants service unavailable');
    const parsed = addParticipantSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid participant input');
    if (parsed.data.participantType !== 'contact' && !parsed.data.participantId) {
      throw new AgentisError('VALIDATION_FAILED', 'participantId is required for agent/human participants');
    }
    deps.participants.ensurePrimary(conversationId);
    const id = deps.participants.add({
      conversationId,
      participantType: parsed.data.participantType,
      participantId: parsed.data.participantId ?? null,
      role: parsed.data.role,
      active: parsed.data.active,
    });
    if (!id) throw new AgentisError('INTERNAL_ERROR', 'failed to add participant');
    return c.json({ data: { id, participants: deps.participants.list(conversationId) } });
  });

  app.delete('/:id/conversations/:conversationId/participants/:participantId', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    const conversationId = c.req.param('conversationId');
    authorizeConversation(ws.workspaceId, appId, conversationId);
    if (!deps.participants) throw new AgentisError('INTERNAL_ERROR', 'participants service unavailable');
    const participantId = c.req.param('participantId');
    const removed = deps.participants.remove(conversationId, participantId);
    if (!removed) throw new AgentisError('RESOURCE_NOT_FOUND', `participant ${participantId} not found`);
    return c.json({ data: { id: participantId, participants: deps.participants.list(conversationId) } });
  });

  // ── Relationship pipeline (Living Apps Phase 3) ─────────────
  // The App's contacts (leads/customers) with pipeline state + the proactivity
  // clock. PATCH sets stage/goal/nextTouchAt — the follow-up sweep reads nextTouchAt.

  app.get('/:id/contacts', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.contacts) return c.json({ data: [] });
    return c.json({ data: deps.contacts.list(ws.workspaceId, appId) });
  });

  app.patch('/:id/contacts/:contactId', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.contacts) throw new AgentisError('INTERNAL_ERROR', 'contacts service not available');
    const contactId = c.req.param('contactId');
    const current = deps.contacts.get(ws.workspaceId, contactId);
    if (!current || current.appId !== appId) throw new AgentisError('RESOURCE_NOT_FOUND', `contact ${contactId} not found in this app`);
    const parsed = contactPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid contact patch');
    const updated = deps.contacts.update(ws.workspaceId, contactId, parsed.data);
    // Phase M2 — a stage transition into a terminal stage (won/lost) IS an outcome.
    // Derive it so the learning loop fires with no separate call (non-throwing).
    const derived = AppLearningStatic.outcomeForStage(parsed.data.stage);
    if (derived && deps.learning) {
      void deps.learning.recordOutcome({ workspaceId: ws.workspaceId, appId, contactId, outcome: derived })
        .catch(() => {});
    }
    return c.json({ data: updated });
  });

  // Phase M2 — explicitly record a terminal relationship outcome (won|lost|abandoned).
  // Stamps the contact, deposits a graded lesson into the owner agent's memory plane,
  // and triggers a scoped reflection pass that can graduate recurring wins into an
  // ability. Non-throwing in the service; the loop never breaks the call.
  app.post('/:id/contacts/:contactId/outcome', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.learning) throw new AgentisError('INTERNAL_ERROR', 'learning service not available');
    const contactId = c.req.param('contactId');
    if (deps.contacts) {
      const current = deps.contacts.get(ws.workspaceId, contactId);
      if (!current || current.appId !== appId) throw new AgentisError('RESOURCE_NOT_FOUND', `contact ${contactId} not found in this app`);
    }
    const parsed = contactOutcomeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid outcome (expected won|lost|abandoned)');
    const result = await deps.learning.recordOutcome({
      workspaceId: ws.workspaceId,
      appId,
      contactId,
      outcome: parsed.data.outcome,
      note: parsed.data.note ?? null,
      setStage: parsed.data.setStage ?? null,
    });
    return c.json({ data: result });
  });

  // Phase M2 visibility — "what this agent learned": recent graded lessons +
  // graduated abilities for this App.
  app.get('/:id/learnings', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId);
    if (!deps.learning) return c.json({ data: { appId, ownerAgentId: null, lessons: [], abilities: [] } });
    return c.json({ data: deps.learning.recentLearnings(ws.workspaceId, appId) });
  });

  // ── Conversation rehearsal (Phase 5 · G8) ───────────────────
  // Drive a synthetic customer through a scenario against the resident agent and
  // score the run BEFORE it talks to real money. Sandboxed — no real channel send,
  // the live thread is untouched. Deterministic when the scenario is scripted.
  app.post('/:id/simulate', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId); // authorize + 404 in-workspace
    if (!deps.simulator) throw new AgentisError('INTERNAL_ERROR', 'conversation simulator not available');
    const parsed = simulateRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid simulation scenario');
    const result = await deps.simulator.runScenario({
      workspaceId: ws.workspaceId,
      userId: user.id,
      appId,
      scenario: parsed.data.scenario,
      ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
    });
    return c.json({ data: result });
  });

  // ── Workflow adoption ───────────────────────────────────────

  app.get('/:id/workflows', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: store.listWorkflowIds(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/workflows', async (c) => {
    const ws = getWorkspace(c);
    const parsed = adoptWorkflowSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid adopt input');
    store.adoptWorkflow(ws.workspaceId, c.req.param('id'), parsed.data.workflowId);
    return c.json({ data: store.listWorkflowIds(ws.workspaceId, c.req.param('id')) });
  });

  // ── App Datastore (§5) ──────────────────────────────────────

  app.get('/:id/collections', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: data.listCollections(ws.workspaceId, c.req.param('id')) });
  });

  app.post('/:id/collections', async (c) => {
    const ws = getWorkspace(c);
    const parsed = defineCollectionSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid collection schema');
    return c.json({ data: data.defineCollection(ws.workspaceId, c.req.param('id'), parsed.data) }, 201);
  });

  app.post('/:id/collections/:name/query', async (c) => {
    const ws = getWorkspace(c);
    const parsed = dataQuerySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid query');
    return c.json(data.query(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data));
  });

  app.post('/:id/collections/:name/records', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const parsed = insertRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid record');
    return c.json({ data: data.insert(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data.record, user.id) }, 201);
  });

  app.patch('/:id/collections/:name/records/:recordId', async (c) => {
    const ws = getWorkspace(c);
    const parsed = updateRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid patch');
    return c.json({ data: data.update(ws.workspaceId, c.req.param('id'), c.req.param('name'), c.req.param('recordId'), parsed.data.patch) });
  });

  app.put('/:id/collections/:name/records', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const parsed = upsertRecordSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid upsert');
    return c.json({ data: data.upsert(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data.match, parsed.data.record, user.id) });
  });

  app.delete('/:id/collections/:name/records/:recordId', (c) => {
    const ws = getWorkspace(c);
    data.delete(ws.workspaceId, c.req.param('id'), c.req.param('name'), c.req.param('recordId'));
    return c.json({ data: { ok: true } });
  });

  // ── AG-UI surfaces (§4) ─────────────────────────────────────

  app.get('/:id/surfaces', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: surfaces.list(ws.workspaceId, c.req.param('id')) });
  });

  app.get('/:id/surfaces/:name', (c) => {
    const ws = getWorkspace(c);
    return c.json({ data: surfaces.get(ws.workspaceId, c.req.param('id'), c.req.param('name')) });
  });

  app.patch('/:id/surfaces/:name', async (c) => {
    const ws = getWorkspace(c);
    const parsed = renameSurfaceSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid surface name');
    return c.json({
      data: surfaces.rename(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data.name),
    });
  });

  app.delete('/:id/surfaces/:name', (c) => {
    const ws = getWorkspace(c);
    surfaces.delete(ws.workspaceId, c.req.param('id'), c.req.param('name'));
    return c.json({ data: { ok: true } });
  });

  app.put('/:id/surfaces', async (c) => {
    const ws = getWorkspace(c);
    const parsed = upsertSurfaceSchema.safeParse(await c.req.json());
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid surface');
    return c.json({ data: surfaces.upsert(ws.workspaceId, c.req.param('id'), parsed.data) });
  });

  app.post('/:id/surfaces/:name/render', async (c) => {
    const ws = getWorkspace(c);
    const parsed = uiRenderSchema.shape.view.safeParse((await c.req.json()).view);
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid view tree');
    return c.json({ data: surfaces.render(ws.workspaceId, c.req.param('id'), c.req.param('name'), parsed.data) });
  });

  // Perform a transient region into a stable AgentRegion slot (Phase M3 / G12).
  // Operator-driven pin/dismiss go through here too (pin:true freezes the
  // current performed child into the stored tree; clear:true dismisses it).
  app.post('/:id/surfaces/:name/perform-region', async (c) => {
    const ws = getWorkspace(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = uiPerformRegionSchema.safeParse({ ...body, surface: c.req.param('name') });
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'Invalid perform-region request');
    return c.json({
      data: surfaces.performRegion(ws.workspaceId, c.req.param('id'), parsed.data.surface, {
        region: parsed.data.region,
        ...(parsed.data.view !== undefined ? { view: parsed.data.view } : {}),
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.pin !== undefined ? { pin: parsed.data.pin } : {}),
        ...(parsed.data.clear !== undefined ? { clear: parsed.data.clear } : {}),
      }),
    });
  });

  // Agent-assisted surface authoring: NL prompt → validated ViewNode tree.
  // Falls back to a deterministic scaffold when no model is configured or the
  // model's output is unparseable, so the builder is never left empty.
  app.post('/:id/surfaces/generate', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const parsed = generateSurfaceRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'prompt required');
    const result = await generateSurfaceView({
      prompt: parsed.data.prompt,
      collections: data.listCollections(ws.workspaceId, appId),
      workspaceId: ws.workspaceId,
      ...(parsed.data.surface ? { surface: parsed.data.surface } : {}),
      ...(deps.completer ? { completer: deps.completer } : {}),
    });
    return c.json({ data: result });
  });

  // ── Operator — the agent that runs this App (the agentic core) ──────────────
  // Presence (who is operating + live status) and a command line that runs the
  // App's entry workflow with the human's instruction, so directing the operator
  // produces real work the ActivityStream then narrates live.

  app.get('/:id/operator', (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    store.get(ws.workspaceId, appId); // 404s if the app is not in this workspace
    const members = deps.db
      .select({
        agentId: schema.agents.id,
        name: schema.agents.name,
        status: schema.agents.status,
        colorHex: schema.agents.colorHex,
        role: schema.appMembers.role,
      })
      .from(schema.appMembers)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.appMembers.agentId))
      .where(and(eq(schema.appMembers.appId, appId), eq(schema.agents.workspaceId, ws.workspaceId)))
      .all();
    const operator = members.find((m) => m.role === 'operator') ?? members[0] ?? null;
    const hasWorkflow = store.listWorkflowIds(ws.workspaceId, appId).length > 0;
    return c.json({ data: operator ? { ...operator, canCommand: hasWorkflow && Boolean(deps.engine) } : null });
  });

  app.post('/:id/operator/command', async (c) => {
    const ws = getWorkspace(c);
    const user = c.get('user');
    const appId = c.req.param('id');
    const parsed = operatorCommandSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AgentisError('VALIDATION_FAILED', 'command required');
    if (!deps.engine) throw new AgentisError('VALIDATION_FAILED', 'operator commands are not enabled in this runtime');
    const workflowId = store.listWorkflowIds(ws.workspaceId, appId)[0];
    if (!workflowId) throw new AgentisError('VALIDATION_FAILED', 'this app has no workflow yet — add one so the operator can act');
    const wf = deps.db
      .select({ id: schema.workflows.id, ambientId: schema.workflows.ambientId, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.id, workflowId)))
      .get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${workflowId}`);
    const result = await runPublishedWorkflow({
      db: deps.db,
      engine: deps.engine,
      workspaceId: ws.workspaceId,
      ambientId: wf.ambientId ?? null,
      userId: user.id,
      workflowId: wf.id,
      graph: wf.graph as WorkflowGraph,
      inputs: { command: parsed.data.command },
    });
    return c.json({ data: result });
  });

  // ── Action dispatch — the click → backend loop (§4.4) ───────
  // V1 resolves `kind: 'data'` fully (form/button → datastore mutation →
  // DATA_CHANGED → bound views refetch). 'workflow'/'tool' actions require the
  // engine/tool runtime and are wired in a later pass; they return a clear error.

  app.post('/:id/surfaces/:name/actions/:action', async (c) => {
    const ws = getWorkspace(c);
    const appId = c.req.param('id');
    const surface = surfaces.get(ws.workspaceId, appId, c.req.param('name'));
    const actionName = c.req.param('action');
    const action = surface.actions.find((a) => a.name === actionName);
    if (!action) throw new AgentisError('RESOURCE_NOT_FOUND', `action not declared: ${actionName}`);
    const argsRaw = (await c.req.json().catch(() => ({}))) as { args?: Record<string, unknown> };
    const callArgs = argsRaw.args ?? {};

    if (action.kind === 'data') {
      const [collection, op] = action.target.split('.');
      if (!collection || !op) throw new AgentisError('VALIDATION_FAILED', `data action target must be "collection.op": ${action.target}`);
      const user = c.get('user');
      switch (op) {
        case 'insert':
          return c.json({ data: data.insert(ws.workspaceId, appId, collection, (callArgs.record as Record<string, unknown>) ?? callArgs, user.id) });
        case 'update':
          return c.json({ data: data.update(ws.workspaceId, appId, collection, String(callArgs.id), (callArgs.patch as Record<string, unknown>) ?? {}) });
        case 'upsert':
          return c.json({ data: data.upsert(ws.workspaceId, appId, collection, (callArgs.match as Record<string, unknown>) ?? {}, (callArgs.record as Record<string, unknown>) ?? {}, user.id) });
        case 'delete':
          data.delete(ws.workspaceId, appId, collection, String(callArgs.id));
          return c.json({ data: { ok: true } });
        default:
          throw new AgentisError('VALIDATION_FAILED', `unknown data op: ${op}`);
      }
    }

    if (action.kind === 'workflow') {
      const user = c.get('user');
      const wf = deps.db
        .select({ id: schema.workflows.id, ambientId: schema.workflows.ambientId, graph: schema.workflows.graph })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.workspaceId, ws.workspaceId), eq(schema.workflows.appId, appId), eq(schema.workflows.id, action.target)))
        .get();
      if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${action.target}`);
      if (!deps.engine) throw new AgentisError('VALIDATION_FAILED', 'workflow actions are not enabled in this runtime');
      const result = await runPublishedWorkflow({
        db: deps.db,
        engine: deps.engine,
        workspaceId: ws.workspaceId,
        ambientId: wf.ambientId ?? null,
        userId: user.id,
        workflowId: wf.id,
        graph: wf.graph as WorkflowGraph,
        inputs: callArgs,
      });
      return c.json({ data: result });
    }

    if (action.kind === 'tool') {
      if (!deps.toolRuntime) throw new AgentisError('VALIDATION_FAILED', 'tool actions are not enabled in this runtime');
      const user = c.get('user');
      const res = await deps.toolRuntime.execute(ws.workspaceId, action.target as AgentTool, callArgs, undefined, { appId, agentId: user.id });
      if (!res.ok) throw new AgentisError('VALIDATION_FAILED', res.error ?? 'tool execution failed');
      return c.json({ data: res.result });
    }

    if (action.kind === 'navigate' || action.kind === 'setState') {
      throw new AgentisError('VALIDATION_FAILED', `${action.kind} actions are handled by @agentis/app-client`);
    }

    if (action.kind === 'capability') {
      throw new AgentisError('VALIDATION_FAILED', 'capability actions must be invoked through /v1/capabilities in this runtime');
    }

    throw new AgentisError('VALIDATION_FAILED', `unknown action kind: ${String(action.kind)}`);
  });

  return app;
}
