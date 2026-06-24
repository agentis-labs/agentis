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
  viewNodeSchema,
  type AgentisToolContext,
} from '@agentis/core';
import { z } from 'zod';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { buildAppStores, type AppStores } from '@agentis/app';

function resolveAppId(args: Record<string, unknown>, ctx: AgentisToolContext): string {
  if (typeof args.appId === 'string' && args.appId.trim()) return args.appId;
  if (ctx.viewport?.resourceKind === 'app' && ctx.viewport.resourceId) return ctx.viewport.resourceId;
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
        description: 'Create a new Agentic App (a full-stack product the agent operates: identity + surfaces + logic + data). Pass adoptWorkflowId to TURN AN EXISTING WORKFLOW INTO AN APP (the workflow becomes the App\'s logic — nothing is rebuilt). Returns the appId to thread through data_* and ui_*.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, adoptWorkflowId: { type: 'string', description: 'Existing workflow id to adopt as the App\'s logic. Omit to start empty.' } }, required: ['name'] },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const adoptWorkflowId = typeof args.adoptWorkflowId === 'string' && args.adoptWorkflowId.trim() ? args.adoptWorkflowId : undefined;
        const input = createAppSchema.parse({
          name: str(args.name, 'name'),
          description: typeof args.description === 'string' ? args.description : '',
          ...(adoptWorkflowId ? { entryWorkflowId: adoptWorkflowId } : {}),
        });
        const app = store.create(ctx.workspaceId, ctx.userId, input);
        return { appId: app.id, slug: app.slug, name: app.name, adoptedWorkflowId: adoptWorkflowId ?? null };
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
        description: 'Author an App surface as a typed ViewNode tree (Stack/Row/Grid/Card/Text/Heading/Metric/Table/List/Form/Button/Chart/Badge/CustomView). Tables/Lists bind to a collection ({ bind: { collection, query?, sort?, limit? } }); Buttons/Forms reference an action declared with ui.action_schema. Replaces the surface view.',
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
  ]);
}
