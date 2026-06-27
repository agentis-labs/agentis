/**
 * Agentic App tool family (AGENTIC-APPS-10X §4/§5) — the chat-driven build path.
 *
 * Exposes App creation, the typed Datastore, and AG-UI surface authoring to the
 * chat agent through the registry. With these an operator can say "build me a
 * CRM" and the agent creates the App, defines collections, renders a data-bound
 * UI, and declares actions — no developer in the loop.
 *
 * App scoping: every tool resolves the target App from an explicit `appId`
 * argument, falling back to the current viewport when the operator is already on
 * an App surface. `agentis.app.create` returns the `appId` the agent then threads
 * through the rest of the build.
 */

import {
  AgentisError,
  collectionSchemaSchema,
  createAppSchema,
  dataQuerySchema,
  surfaceActionSchema,
  uiPatchOpSchema,
  uiPerformRegionSchema,
  viewNodeSchema,
  type AgentisToolContext,
} from '@agentis/core';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { buildAppStores, type AppStores } from '@agentis/app';
import { generateSurfaceView, generateSurfacePatch } from '../surfaceGenerator.js';
import { resolveSynthesisCompleter } from './build.js';
import type { StructuredCompleter } from '../structuredCompleter.js';

function resolveAppId(args: Record<string, unknown>, ctx: AgentisToolContext): string {
  if (typeof args.appId === 'string' && args.appId.trim()) return args.appId;
  if (ctx.viewport?.resourceKind === 'app' && ctx.viewport.resourceId) return ctx.viewport.resourceId;
  // Ambient App for the turn — a resident channel agent's App (Living Apps Phase 0).
  if (typeof ctx.appId === 'string' && ctx.appId.trim()) return ctx.appId;
  throw new AgentisError('VALIDATION_FAILED', 'no App in context — pass appId (or open the app first)');
}

// §1.3 — the Datastore→Brain bridge must not dump raw record fields (PII/secrets)
// into durable, recall-injected memory. We mask secret-like keys and obvious PII
// values (emails, phone numbers) and cap length. The agent is asked to pass a
// concise `summary` instead; this scrub is the safety net when it doesn't.
const SECRET_KEY = /(secret|token|api[_-]?key|password|passwd|credential|bearer|private[_-]?key|ssn|cvv|card[_-]?number)/i;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
function scrubForMemory(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
  if (Array.isArray(value)) return value.map(scrubForMemory);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrubForMemory(v);
    }
    return out;
  }
  return value;
}

/** A workflow id from an explicit arg, or the workflow the operator is viewing. */
function resolveWorkflowId(args: Record<string, unknown>, ctx: AgentisToolContext, name = 'workflowId'): string {
  if (typeof args[name] === 'string' && (args[name] as string).trim()) return args[name] as string;
  if (ctx.viewport?.resourceKind === 'workflow' && ctx.viewport.resourceId) return ctx.viewport.resourceId;
  throw new AgentisError('VALIDATION_FAILED', `'${name}' is required (or open the workflow first)`);
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AgentisError('VALIDATION_FAILED', `'${name}' must be a non-empty string`);
  return value;
}

function obj(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentisError('VALIDATION_FAILED', `'${name}' must be an object`);
  return value as Record<string, unknown>;
}

const appIdProp = { appId: { type: 'string', description: 'Target App id. Omit to use the App currently open.' } } as const;

export function registerAppDataTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const stores: AppStores = buildAppStores({ db: deps.db, bus: deps.bus });
  const { store, data, surfaces } = stores;

  registry.registerMany([
    {
      definition: {
        id: 'agentis.app.create',
        family: 'app',
        description: 'Create — or RESOLVE — the Agentic App (a full-stack product the agent operates: identity + surfaces + logic + data). This is idempotent: if the workflow you pass as adoptWorkflowId already belongs to an App (every built workflow does — build_workflow returns its appId), or an App with this name already exists, it REUSES that App instead of making a duplicate. So to refine an existing App, just edit it (data_*/ui_* with its appId) — do not create a renamed twin. Pass adoptWorkflowId to turn a bare workflow into an App. Returns the appId (and reused:true when an existing App was resolved).',
        inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, adoptWorkflowId: { type: 'string', description: 'Existing workflow id to adopt as the App\'s logic. If it already has an owning App, that App is reused. Omit to start empty.' } }, required: ['name'] },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const name = str(args.name, 'name');
        const description = typeof args.description === 'string' ? args.description : '';
        const adoptWorkflowId = typeof args.adoptWorkflowId === 'string' && args.adoptWorkflowId.trim() ? args.adoptWorkflowId : undefined;
        const norm = (value: string) => value.trim().toLowerCase();

        // 1) The workflow is already an App's logic (build_workflow anchors every
        //    new workflow to an App-of-one). Reuse that App — never spawn a twin —
        //    and adopt the operator's intended name/description onto it.
        if (adoptWorkflowId) {
          const ownerAppId = store.appIdForWorkflow(ctx.workspaceId, adoptWorkflowId);
          if (ownerAppId) {
            const updated = store.update(ctx.workspaceId, ownerAppId, { name, ...(description ? { description } : {}) });
            return { appId: updated.id, slug: updated.slug, name: updated.name, adoptedWorkflowId: adoptWorkflowId, reused: true };
          }
        }

        // 2) An App with this exact name already exists → resolve it (this is what
        //    "review/recreate the Fashion Store app" must hit instead of creating
        //    a `-2` duplicate). Adopt the workflow into it when provided.
        const existingByName = store.list(ctx.workspaceId, {}).find((app) => norm(app.name) === norm(name));
        if (existingByName) {
          if (adoptWorkflowId) store.adoptWorkflow(ctx.workspaceId, existingByName.id, adoptWorkflowId);
          return { appId: existingByName.id, slug: existingByName.slug, name: existingByName.name, adoptedWorkflowId: adoptWorkflowId ?? null, reused: true };
        }

        // 3) Genuinely new App.
        const app = store.create(
          ctx.workspaceId,
          ctx.userId,
          createAppSchema.parse({ name, description, ...(adoptWorkflowId ? { entryWorkflowId: adoptWorkflowId } : {}) }),
        );
        return { appId: app.id, slug: app.slug, name: app.name, adoptedWorkflowId: adoptWorkflowId ?? null, reused: false };
      },
    },
    {
      definition: {
        id: 'agentis.app.list',
        family: 'app',
        description: 'List the Agentic Apps in this workspace (id, name, slug, status). Use to find an App to operate on.',
        inputSchema: { type: 'object', properties: {} },
        mutating: false,
        autoExecute: true,
      },
      handler: (_args, ctx) => ({
        apps: store.list(ctx.workspaceId, {}).map((app) => ({ appId: app.id, name: app.name, slug: app.slug, status: app.status })),
      }),
    },
    {
      definition: {
        id: 'agentis.app.adopt_workflow',
        family: 'app',
        description: 'Adopt an existing workflow into an App as additional logic (the workflow keeps running; it just gains an owning App). Use when refactoring/adding a workflow to an App you already created or are viewing.',
        inputSchema: { type: 'object', properties: { ...appIdProp, workflowId: { type: 'string', description: 'Workflow to adopt. Omit to use the workflow currently open.' } } },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const workflowId = resolveWorkflowId(args, ctx);
        store.adoptWorkflow(ctx.workspaceId, appId, workflowId);
        return { appId, adoptedWorkflowId: workflowId, workflowIds: store.listWorkflowIds(ctx.workspaceId, appId) };
      },
    },
    {
      definition: {
        id: 'agentis.app.scaffold',
        family: 'app',
        description:
          'Set up an App\'s DATA model and kick off its interface. Defines the datastore `collections`, then: if a separate design model is configured it drafts a starter surface; otherwise it returns a DESIGN BRIEF and you author the console yourself with agentis.ui.render (the better result — you understand the domain). Either way, treat any starter as a starting point and enrich it into a real operating console via ui.render / ui.patch — do not ship the generic default. Use when the operator asks for an app with an interface (CRM, dashboard, tracker, pipeline, board, portal, console). An App with logic but no UI/data is INCOMPLETE.',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            prompt: { type: 'string', description: 'What the interface should be, in plain language (e.g. "Lead CRM: pipeline board grouped by stage, an add-lead form, a total-pipeline-value metric").' },
            surface: { type: 'string', description: 'Surface name to author. Defaults to "home".' },
            collections: { type: 'array', description: 'Data format to define first: [{ name, schema: { fields: [{ key, type: "string"|"number"|"boolean"|"date"|"json", required?, indexed? }] } }]. Omit to bind to the App\'s existing collections.' },
          },
          required: ['prompt'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const surface = typeof args.surface === 'string' && args.surface.trim() ? args.surface.trim() : 'home';
        const prompt = str(args.prompt, 'prompt');

        // 1) Define the data format first so the surface can bind to real fields.
        const collectionsDefined: string[] = [];
        if (Array.isArray(args.collections)) {
          for (const raw of args.collections) {
            const c = obj(raw, 'collection');
            const collectionName = str(c.name, 'collection.name');
            data.defineCollection(ctx.workspaceId, appId, { name: collectionName, schema: collectionSchemaSchema.parse(c.schema) });
            collectionsDefined.push(collectionName);
          }
        }

        // 2) Author the surface. The capable AGENT that just designed this domain
        //    should author the console itself — it understands the operating model
        //    a schema-only scaffold never could. So when no SEPARATE design model
        //    is configured, return a design brief and let the agent author via
        //    ui.render (the powerful path). A configured design model may draft a
        //    starter the agent then enriches.
        const collections = data.listCollections(ctx.workspaceId, appId);
        let completer: StructuredCompleter | undefined;
        try { completer = resolveSynthesisCompleter(deps, ctx.workspaceId, ctx.agentId, prompt); } catch { completer = undefined; }
        if (!completer) {
          const names = collections.map((c) => c.name).join(', ') || '(define collections first)';
          return {
            appId,
            surface,
            collectionsDefined,
            source: 'agent_author' as const,
            authorYourself: true,
            directive:
              `Data is ready. Now AUTHOR the operating console for "${prompt}" by calling agentis.ui.render — compose a bespoke surface from the full grammar ` +
              `(KPIStrip / Hero / Tabs / Split / DataBoard / StatusBoard / Timeline / Funnel / Gauge / ProgressBar / Callout / Chart / Table / Form / AgentConsole / ActivityStream) ` +
              `bound to these collections: ${names}. Lead with the KPIs that matter, then the pipeline/board, the gates/approvals queues, validation status, and an operator rail ` +
              `(AgentConsole + ActivityStream) in a Split. Declare every button/form action first with agentis.ui.action_schema (kind: workflow | tool | data). Do NOT render a generic card list.`,
          };
        }

        const generated = await generateSurfaceView({
          prompt,
          collections,
          workspaceId: ctx.workspaceId,
          surface,
          completer,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });

        // 3) Persist actions before the view (forms/buttons reference them).
        if (generated.actions.length > 0) surfaces.setActions(ctx.workspaceId, appId, surface, generated.actions);
        const rendered = surfaces.render(ctx.workspaceId, appId, surface, generated.view);
        return { appId, surface: rendered.name, revision: rendered.revision, collectionsDefined, actions: generated.actions.length, source: generated.source };
      },
    },
    {
      definition: {
        id: 'agentis.data.define_collection',
        family: 'app',
        description: 'Define (or update) a typed Datastore collection on an App. Fields: { key, type: "string"|"number"|"boolean"|"date"|"json", required?, indexed? }.',
        inputSchema: { type: 'object', properties: { ...appIdProp, name: { type: 'string' }, schema: { type: 'object' } }, required: ['name', 'schema'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => data.defineCollection(ctx.workspaceId, resolveAppId(args, ctx), { name: str(args.name, 'name'), schema: collectionSchemaSchema.parse(args.schema) }),
    },
    {
      definition: {
        id: 'agentis.data.insert',
        family: 'app',
        description: 'Insert a record into an App collection (validated against its schema).',
        inputSchema: { type: 'object', properties: { ...appIdProp, collection: { type: 'string' }, record: { type: 'object' } }, required: ['collection', 'record'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => data.insert(ctx.workspaceId, resolveAppId(args, ctx), str(args.collection, 'collection'), obj(args.record, 'record'), ctx.agentId),
    },
    {
      definition: {
        id: 'agentis.data.update',
        family: 'app',
        description: 'Patch an App collection record by id.',
        inputSchema: { type: 'object', properties: { ...appIdProp, collection: { type: 'string' }, id: { type: 'string' }, patch: { type: 'object' } }, required: ['collection', 'id', 'patch'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => data.update(ctx.workspaceId, resolveAppId(args, ctx), str(args.collection, 'collection'), str(args.id, 'id'), obj(args.patch, 'patch')),
    },
    {
      definition: {
        id: 'agentis.data.upsert',
        family: 'app',
        description: 'Insert, or update the first record matching `match`.',
        inputSchema: { type: 'object', properties: { ...appIdProp, collection: { type: 'string' }, match: { type: 'object' }, record: { type: 'object' } }, required: ['collection', 'match', 'record'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => data.upsert(ctx.workspaceId, resolveAppId(args, ctx), str(args.collection, 'collection'), obj(args.match, 'match'), obj(args.record, 'record'), ctx.agentId),
    },
    {
      definition: {
        id: 'agentis.data.delete',
        family: 'app',
        description: 'Delete an App collection record by id.',
        inputSchema: { type: 'object', properties: { ...appIdProp, collection: { type: 'string' }, id: { type: 'string' } }, required: ['collection', 'id'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        data.delete(ctx.workspaceId, resolveAppId(args, ctx), str(args.collection, 'collection'), str(args.id, 'id'));
        return { deleted: true };
      },
    },
    {
      definition: {
        id: 'agentis.data.query',
        family: 'app',
        description: 'Query App collection records. Filter ops: eq/ne/gt/gte/lt/lte/contains/in, or a bare value for equality.',
        inputSchema: { type: 'object', properties: { ...appIdProp, collection: { type: 'string' }, filter: { type: 'object' }, sort: { type: 'array' }, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['collection'] },
        mutating: false,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const query = dataQuerySchema.parse({
          ...(args.filter !== undefined ? { filter: args.filter } : {}),
          ...(args.sort !== undefined ? { sort: args.sort } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        });
        return data.query(ctx.workspaceId, resolveAppId(args, ctx), str(args.collection, 'collection'), query);
      },
    },
    {
      definition: {
        id: 'agentis.data.promote_memory',
        family: 'app',
        description: 'Promote a Datastore record into the workspace Brain as a durable memory (one-way bridge — data stays source of truth). Pass `summary` with the concise, durable LESSON to remember (not raw fields); without it, the record is stored with secrets/PII masked. The Datastore remains the source of truth — do not promote whole records to recall them later.',
        inputSchema: { type: 'object', properties: { ...appIdProp, collection: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string', description: 'The durable lesson/fact to remember, in plain language. Preferred over dumping record fields.' } }, required: ['collection', 'id'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        if (!deps.memory) throw new AgentisError('VALIDATION_FAILED', 'workspace memory service not available');
        const appId = resolveAppId(args, ctx);
        const collection = str(args.collection, 'collection');
        const id = str(args.id, 'id');
        const record = data.getRecord(ctx.workspaceId, appId, collection, id);
        const title = typeof args.title === 'string' && args.title.trim() ? args.title : `${collection} record`;
        // §1.3 — prefer the agent's plain-language lesson; fall back to a
        // secret/PII-scrubbed, length-capped projection of the record (never raw).
        const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : null;
        const content = (summary ?? JSON.stringify(scrubForMemory(record.data))).slice(0, 600);
        const memoryId = deps.memory.write({
          workspaceId: ctx.workspaceId,
          // Bind to the App's brain scope (AGENTIC-APPS-10X §5.4), not the whole
          // workspace — so what an App learns lives with the App.
          scopeId: appId,
          kind: 'fact',
          source: 'agent',
          title,
          content,
          trust: 0.8,
          importance: 0.65,
          tags: ['app_datastore', 'promoted', collection],
          provenance: { source: 'data_promote_memory', appId, collection, recordId: id, agentId: ctx.agentId ?? null },
        });
        return { promoted: true, memoryId };
      },
    },
    {
      definition: {
        id: 'agentis.ui.render',
        family: 'app',
        description:
          'THE way to build a powerful App interface: YOU design and author the surface as a typed ViewNode tree — a bespoke operating console, not a generic card list. You know the domain you just built, so compose a real console from the full grammar:\n' +
          '• Headline metrics — KPIStrip (multiple labelled values + deltas + sparks), Metric, Gauge, ProgressBar, Callout.\n' +
          '• Layout — Hero (title banner), Tabs, Accordion, Split (main + right rail, ratio), Toolbar, Stack/Row/Grid, Divider.\n' +
          '• Data, bound to collections via { bind: { collection, query?, sort?, limit?, live? } } — DataBoard (kanban by groupBy), Table (columns + rowActions), List, StatusBoard, Timeline, Funnel, Calendar, Inbox, Chart (line/bar/area/pie).\n' +
          '• Agent-native — AgentConsole (operator command line), ActivityStream (your live work feed), Narrative, ConversationThread, ChatThread.\n' +
          '• Rich content — DocumentViewer, CodeViewer, MediaGallery, MapView, Image, Avatar, Badge. CodeSurface/CustomView render your own sandboxed JS/HTML for anything bespoke.\n' +
          '• Inputs — Form (fields + submit action), Button (action). Declare every button/form action first with ui.action_schema (kind: workflow | tool | data).\n' +
          'Compose for the operating model you designed: lead with the KPIs that matter, then the pipeline/board, gates/approvals queues, validation status, and an operator rail (AgentConsole + ActivityStream) in a Split. Replaces the surface view. Prefer this over a generic scaffold — a capable agent authoring the console directly is how Agentis ships powerful apps.',
        inputSchema: { type: 'object', properties: { ...appIdProp, surface: { type: 'string' }, view: { type: 'object' } }, required: ['surface', 'view'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const result = surfaces.render(ctx.workspaceId, resolveAppId(args, ctx), str(args.surface, 'surface'), viewNodeSchema.parse(args.view));
        return { rendered: true, surface: result.name, revision: result.revision };
      },
    },
    {
      definition: {
        id: 'agentis.ui.patch',
        family: 'app',
        description: 'Mutate part of an existing surface view. ops: [{ op: "set"|"insert"|"remove", path, value?|node? }].',
        inputSchema: { type: 'object', properties: { ...appIdProp, surface: { type: 'string' }, ops: { type: 'array' } }, required: ['surface', 'ops'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const ops = z.array(uiPatchOpSchema).min(1).parse(args.ops);
        const result = surfaces.patch(ctx.workspaceId, resolveAppId(args, ctx), str(args.surface, 'surface'), ops);
        return { patched: true, surface: result.name, revision: result.revision };
      },
    },
    {
      definition: {
        id: 'agentis.ui.compose',
        family: 'app',
        description:
          'Edit an App surface by INSTRUCTION, like talking to a designer who re-renders as you speak — "show only deals over $20k", "put the funnel above the activity feed", "make the board group by stage". A design model reads the surface\'s CURRENT tree + the App\'s collections and emits a minimal SurfacePatch (set/insert/remove ops) that is applied live and re-renders in place. Preferred over hand-authoring ui.patch op paths for natural-language layout/filter/restyle requests. Returns the ops applied (empty when no design model is configured or the instruction can\'t be satisfied — then fall back to ui.render / ui.patch).',
        inputSchema: { type: 'object', properties: { ...appIdProp, surface: { type: 'string' }, instruction: { type: 'string', description: 'Plain-language change to make to the surface.' } }, required: ['surface', 'instruction'] },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: async (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const surfaceName = str(args.surface, 'surface');
        const instruction = str(args.instruction, 'instruction');
        const current = surfaces.get(ctx.workspaceId, appId, surfaceName);
        if (current.view == null) throw new AgentisError('VALIDATION_FAILED', `surface ${surfaceName} has no view to compose against; call ui.render first`);
        let completer: StructuredCompleter | undefined;
        try { completer = resolveSynthesisCompleter(deps, ctx.workspaceId, ctx.agentId, instruction); } catch { completer = undefined; }
        const generated = await generateSurfacePatch({
          instruction,
          current: current.view,
          collections: data.listCollections(ctx.workspaceId, appId),
          workspaceId: ctx.workspaceId,
          surface: surfaceName,
          ...(completer ? { completer } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (generated.ops.length === 0) {
          return { composed: false, surface: surfaceName, ops: 0, source: generated.source, reason: completer ? 'no change derived from the instruction' : 'no design model configured' };
        }
        const result = surfaces.patch(ctx.workspaceId, appId, surfaceName, generated.ops);
        return { composed: true, surface: result.name, revision: result.revision, ops: generated.ops.length, source: generated.source };
      },
    },
    {
      definition: {
        id: 'agentis.ui.perform_region',
        family: 'app',
        description:
          'PERFORM a transient region into a stable AgentRegion slot on a surface, live — the console composes itself. Use to push an unprompted panel into the operator\'s view when you notice something (e.g. render a "churn risk" panel into the "attention" region because 12 deals stalled at pricing). The frame stays stable; this child is ephemeral and dismissable by the operator — UNLESS you pass pin:true (then it freezes into the stored surface). ALWAYS pass a short `reason` (it is shown to the operator as "added because …"). Pass clear:true to dismiss a region. The surface must already contain an AgentRegion with this `region` id (render the frame with one first).',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            surface: { type: 'string' },
            region: { type: 'string', description: 'The AgentRegion slot id to perform into.' },
            view: { type: 'object', description: 'The ViewNode to render into the slot. Omit with clear:true to dismiss.' },
            reason: { type: 'string', description: 'Why this appeared — shown to the operator (e.g. "12 deals stalled at pricing").' },
            pin: { type: 'boolean', description: 'Freeze this into the stored surface so it persists across reloads.' },
            clear: { type: 'boolean', description: 'Dismiss the region (no view needed).' },
          },
          required: ['surface', 'region'],
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const parsed = uiPerformRegionSchema.parse({
          surface: args.surface,
          region: args.region,
          ...(args.view !== undefined ? { view: args.view } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.pin !== undefined ? { pin: args.pin } : {}),
          ...(args.clear !== undefined ? { clear: args.clear } : {}),
        });
        const result = surfaces.performRegion(ctx.workspaceId, appId, parsed.surface, {
          region: parsed.region,
          ...(parsed.view !== undefined ? { view: parsed.view } : {}),
          ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
          ...(parsed.pin !== undefined ? { pin: parsed.pin } : {}),
          ...(parsed.clear !== undefined ? { clear: parsed.clear } : {}),
        });
        return { performed: true, surface: result.name, region: parsed.region, revision: result.revision, pinned: parsed.pin === true, cleared: parsed.clear === true };
      },
    },
    {
      definition: {
        id: 'agentis.ui.action_schema',
        family: 'app',
        description: 'Declare the actions a surface\'s buttons/forms may invoke. Each resolves to a workflow run, an agent tool, or a datastore op ("collection.insert" etc).',
        inputSchema: { type: 'object', properties: { ...appIdProp, surface: { type: 'string' }, actions: { type: 'array' } }, required: ['surface', 'actions'] },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const actions = z.array(surfaceActionSchema).parse(args.actions);
        surfaces.setActions(ctx.workspaceId, resolveAppId(args, ctx), str(args.surface, 'surface'), actions);
        return { ok: true, actions: actions.length };
      },
    },
    {
      // Living Apps Phase 2 — the resident agent FLAGS a thread for the operator
      // instead of interrupting. Use when you hit something only a human can decide
      // ("the customer wants a discount I'm not authorized to give", "this looks
      // like a complaint that needs a manager"). The App console shows a count + a
      // ◆ marker on the thread; the operator clears it by stepping in. Pass clear:true
      // to withdraw the flag once it's resolved. Targets the current thread.
      definition: {
        id: 'agentis.conversation.flag_needs_attention',
        family: 'app',
        description: 'Flag the CURRENT conversation as needing the human operator (you do not interrupt — you raise a hand). Use when a decision is above your authority or a situation needs a person ("wants a discount I can\'t approve", "angry customer asking for a manager"). The App console surfaces it as a count + a marker. Pass clear:true to withdraw the flag once resolved.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'One line on WHY a human is needed (shown to the operator).' },
            clear: { type: 'boolean', description: 'Withdraw an existing flag (the situation is resolved).' },
          },
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const conversationId = ctx.conversationId;
        if (!conversationId) throw new AgentisError('VALIDATION_FAILED', 'no conversation in context — flag_needs_attention runs inside a live thread');
        const clear = args.clear === true;
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 500) : null;
        const conv = deps.db
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(and(eq(schema.conversations.id, conversationId), eq(schema.conversations.workspaceId, ctx.workspaceId)))
          .get();
        if (!conv) throw new AgentisError('RESOURCE_NOT_FOUND', `conversation ${conversationId} not found`);
        deps.db.update(schema.conversations).set({
          needsAttention: clear ? 0 : 1,
          needsAttentionReason: clear ? null : reason,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.conversations.id, conversationId)).run();
        return { conversationId, needsAttention: !clear, reason: clear ? null : reason };
      },
    },
  ]);
}
