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
  appWorkflowBindingSchema,
  collectionSchemaSchema,
  createAppSchema,
  dataQuerySchema,
  repairSurface,
  surfaceActionSchema,
  uiPatchOpSchema,
  uiPerformRegionSchema,
  viewNodeSchema,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  CONSTANTS,
  type AgentisToolContext,
  type AppSurface,
} from '@agentis/core';
import { z } from 'zod';
import { and, eq, sql as sqlOp } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisToolRegistry } from '../agentisToolRegistry.js';
import type { ToolHandlerDeps } from './deps.js';
import { buildAppStores, type AppStores } from '@agentis/app';
import { publishAgentCreation } from '../agent/agentWorkProgress.js';
import { generateSurfaceView, generateSurfacePatch } from '../surfaceGenerator.js';
import { resolveSynthesisCompleter } from './build.js';
import type { StructuredCompleter } from '../structuredCompleter.js';


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

function surfaceOutline(surface: AppSurface): Array<{ nodeId: string; type: string; path: string; collection?: string }> {
  const nodes: Array<{ nodeId: string; type: string; path: string; collection?: string }> = [];
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}/${index}`)); return; }
    const item = value as Record<string, unknown>;
    if (typeof item.type === 'string' && typeof item.nodeId === 'string') {
      const collection = item.bind && typeof item.bind === 'object' && typeof (item.bind as Record<string, unknown>).collection === 'string'
        ? String((item.bind as Record<string, unknown>).collection)
        : undefined;
      nodes.push({ nodeId: item.nodeId, type: item.type, path: path || '/', ...(collection ? { collection } : {}) });
    }
    for (const [key, child] of Object.entries(item)) {
      if (key !== 'style' && key !== 'args' && key !== 'bind') walk(child, `${path}/${key}`);
    }
  };
  walk(surface.view, '');
  return nodes;
}

// Advertised shapes MUST match the enforced zod (datastore.ts) — a loose schema
// here makes the agent send the wrong shape and hit INTERNAL_TOOL_ERROR. These
// mirror `querySortSchema` / `queryFilterSchema` exactly. (Drift is asserted in
// agentisDataToolContract.test.ts.)
const sortProp = {
  sort: {
    type: 'array',
    description: 'Sort order (highest priority first). Each entry is an OBJECT, not a string. Example: [{ "field": "createdAt", "dir": "desc" }].',
    items: {
      type: 'object',
      properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
      required: ['field'],
    },
  },
} as const;
const filterProp = {
  filter: {
    type: 'object',
    description: 'Field → match. A bare value means equality; an operator uses { "op": "eq|ne|gt|gte|lt|lte|contains|in", "value": ... }. Example: { "status": "open", "score": { "op": "gte", "value": 8 } }.',
  },
} as const;

/** Surface a concrete datastore creation on the live feed (best-effort). */
function emitCreation(
  deps: ToolHandlerDeps,
  ctx: AgentisToolContext,
  creation: { creationKind: 'record' | 'collection'; title: string; collection?: string; count?: number },
): void {
  try {
    publishAgentCreation(deps.bus, {
      workspaceId: ctx.workspaceId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      ...creation,
    });
  } catch {
    /* telemetry must never fail a write */
  }
}

/** Read a workflow's App-binding off `settings.appBinding` with safe defaults. */
function readWorkflowBinding(settings: unknown): z.infer<typeof appWorkflowBindingSchema> {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).appBinding : undefined;
  const parsed = appWorkflowBindingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : appWorkflowBindingSchema.parse({});
}

/** Detect a dependency cycle in a workflowId → dependsOn[] adjacency map (DFS). */
function firstDependencyCycle(graph: Map<string, string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return [...stack.slice(stack.indexOf(next)), next];
      if (c === WHITE) { const cyc = visit(next); if (cyc) return cyc; }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };
  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) { const cyc = visit(node); if (cyc) return cyc; }
  }
  return null;
}

const chainItemSchema = z.object({
  workflowId: z.string().min(1),
  order: z.number().int().min(0).optional(),
  operatorEntrypoint: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
  chainOn: z.enum(['success', 'failure', 'always']).optional(),
  concurrency: z.enum(['parallel', 'exclusive']).optional(),
  enabled: z.boolean().optional(),
  purpose: z.string().max(400).optional(),
  when: z.string().max(2000).nullable().optional(),
  delay: z
    .object({
      ms: z.number().int().min(0).max(CONSTANTS.MAX_START_DELAY_MS).optional(),
      jitterMs: z.number().int().min(0).max(CONSTANTS.MAX_START_DELAY_MS).optional(),
    })
    .nullable()
    .optional(),
});

export function registerAppDataTools(registry: AgentisToolRegistry, deps: ToolHandlerDeps): void {
  const stores: AppStores = buildAppStores({ db: deps.db, bus: deps.bus });
  const { store, data, surfaces } = stores;

  /** Publish a workflow-binding change to the workflow + app + workspace rooms so
   *  the canvas / App control plane / home refetch the new order live. */
  const publishBindingChange = (workspaceId: string, appId: string, workflowId: string): void => {
    try {
      const payload = { workflowId, appId };
      deps.bus.publish(REALTIME_ROOMS.workflow(workflowId), REALTIME_EVENTS.WORKFLOW_UPDATED, payload);
      deps.bus.publish(REALTIME_ROOMS.app(appId), REALTIME_EVENTS.APP_UPDATED, { appId, op: 'updated' });
      deps.bus.publish(REALTIME_ROOMS.workspace(workspaceId), REALTIME_EVENTS.APP_UPDATED, { appId, op: 'updated' });
    } catch {
      /* realtime must never fail a write */
    }
  };

  /**
   * Resolve the target App for a data/surface tool call. Order: explicit `appId`
   * arg → the App the operator is viewing → the turn's ambient App. When none of
   * those apply, resolve UNAMBIGUOUSLY (the common single-App workspace) instead of
   * making the agent hunt for it; otherwise fail with the exact appIds to choose
   * from so the agent's next call is correct (n8n "tell me what to fill" ergonomics).
   */
  const resolveAppId = (args: Record<string, unknown>, ctx: AgentisToolContext): string => {
    if (typeof args.appId === 'string' && args.appId.trim()) return args.appId.trim();
    if (ctx.viewport?.resourceKind === 'app' && ctx.viewport.resourceId) return ctx.viewport.resourceId;
    if (typeof ctx.appId === 'string' && ctx.appId.trim()) return ctx.appId.trim();
    const apps = store.list(ctx.workspaceId, {});
    if (apps.length === 1) return apps[0]!.id;
    if (apps.length === 0) {
      throw new AgentisError('VALIDATION_FAILED', 'no App in context and this workspace has no Apps yet — create one (agentis.app.create) or pass appId.');
    }
    const list = apps.slice(0, 10).map((app) => `${app.name} (appId: ${app.id})`).join('; ');
    throw new AgentisError('VALIDATION_FAILED', `no App in context — pass "appId". Available apps: ${list}.`);
  };

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
        description: 'List the Agentic Apps in this workspace (id, name, slug, status). Archived apps are hidden unless includeArchived is true. Use to find an App to operate on.',
        inputSchema: { type: 'object', properties: { includeArchived: { type: 'boolean', description: 'Include archived apps (default false).' } } },
        mutating: false,
        autoExecute: true,
      },
      handler: (args, ctx) => ({
        apps: store.list(ctx.workspaceId, {})
          .filter((app) => (args.includeArchived === true ? true : app.status !== 'archived'))
          .map((app) => ({ appId: app.id, name: app.name, slug: app.slug, status: app.status })),
      }),
    },
    {
      definition: {
        id: 'agentis.app.archive',
        family: 'app',
        description: 'Archive an App (soft, reversible): it is hidden from the default app list and its triggers should be paused, but nothing is destroyed and it can be restored. Use this to retire a duplicate or superseded App instead of deleting it. Pass restore:true to un-archive.',
        inputSchema: { type: 'object', properties: { ...appIdProp, restore: { type: 'boolean', description: 'Un-archive instead of archive.' } } },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const updated = store.update(ctx.workspaceId, appId, { status: args.restore === true ? 'active' : 'archived' });
        return { appId: updated.id, name: updated.name, status: updated.status, archived: updated.status === 'archived' };
      },
    },
    {
      definition: {
        id: 'agentis.app.delete',
        family: 'app',
        description: 'PERMANENTLY delete an App, its collections/records/surfaces, AND its workflows with their run history. Destructive and irreversible. Called WITHOUT confirm:true it returns a preview of exactly what will be removed — review it, then call again with confirm:true. Pass keepWorkflows:true to retire the App but keep its workflows as standalone ones. Prefer agentis.app.archive unless the App must truly be erased.',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            confirm: { type: 'boolean', description: 'Must be true to actually delete. Omit/false to get a preview first.' },
            keepWorkflows: { type: 'boolean', description: 'Keep this App\'s workflows as standalone workflows instead of deleting them with it. Default false — workflows go with the App.' },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const app = store.get(ctx.workspaceId, appId);
        const keepWorkflows = args.keepWorkflows === true;
        const preview = store.deletionPreview(ctx.workspaceId, appId);
        const totalRuns = preview.workflows.reduce((sum, wf) => sum + wf.runCount, 0);
        if (args.confirm !== true) {
          return {
            deleted: false,
            preview: true,
            app: { appId: app.id, name: app.name, status: app.status },
            willRemove: keepWorkflows
              ? 'this App, its collections/records and surfaces'
              : `this App, its collections/records and surfaces, and ${preview.workflows.length} workflow(s) with ${totalRuns} run(s)`,
            workflows: preview.workflows,
            ...(keepWorkflows
              ? { willSurviveAsStandalone: preview.workflows.map((wf) => wf.workflowId) }
              : {}),
            next:
              `Call agentis.app.delete again with { appId: "${appId}", confirm: true } to proceed`
              + (keepWorkflows
                ? '.'
                : `, or add keepWorkflows:true to retire the App but keep its ${preview.workflows.length} workflow(s).`)
              + ' agentis.app.archive retires it reversibly instead.',
          };
        }
        const result = store.delete(ctx.workspaceId, appId, {
          keepWorkflows,
          onWorkflowDeleting: (workflowId) => {
            for (const run of deps.db
              .select({ id: schema.workflowRuns.id })
              .from(schema.workflowRuns)
              .where(and(
                eq(schema.workflowRuns.workflowId, workflowId),
                sqlOp`${schema.workflowRuns.status} NOT IN ('COMPLETED','FAILED','CANCELLED','COMPLETED_WITH_CONTRACT_VIOLATION')`,
              ))
              .all()) {
              void deps.engine.cancelRun(run.id).catch(() => { /* the cascade removes it anyway */ });
            }
          },
        });
        return {
          deleted: true,
          appId,
          name: app.name,
          workflowsDeleted: result.deletedWorkflowIds,
          workflowsKeptAsStandalone: result.keptWorkflowIds,
          runsRemoved: keepWorkflows ? 0 : totalRuns,
        };
      },
    },
    {
      definition: {
        id: 'agentis.app.update',
        family: 'app',
        description:
          'Update an App\'s identity/organization: rename it, change its icon, or retarget its owning specialist agent (ownerAgentId) or Domain/Space (domainId). Use to fix a wrong name, assign an owner, or move an App under a Domain. Does NOT touch workflows, data, or surfaces (use the workflow/data/ui tools for those).',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            name: { type: 'string', description: 'New display name.' },
            description: { type: 'string' },
            icon: { type: 'string', description: 'Emoji or short icon token.' },
            ownerAgentId: { type: 'string', description: 'Specialist agent that owns this App. null to clear.' },
            domainId: { type: 'string', description: 'Domain/Space this App belongs to. null to clear.' },
          },
        },
        mutating: true,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const patch: Record<string, unknown> = {};
        if (typeof args.name === 'string') patch.name = args.name.trim();
        if (typeof args.description === 'string') patch.description = args.description;
        if (typeof args.icon === 'string') patch.icon = args.icon;
        if ('ownerAgentId' in args) patch.ownerAgentId = args.ownerAgentId === null ? null : String(args.ownerAgentId);
        if ('domainId' in args) patch.domainId = args.domainId === null ? null : String(args.domainId);
        if (Object.keys(patch).length === 0) {
          throw new AgentisError('VALIDATION_FAILED', 'app.update: pass at least one field to change (name, description, icon, ownerAgentId, domainId).');
        }
        const updated = store.update(ctx.workspaceId, appId, patch); // emits APP_UPDATED
        return { appId: updated.id, name: updated.name, icon: updated.icon, ownerAgentId: updated.ownerAgentId, domainId: updated.domainId };
      },
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
        id: 'agentis.workflow.chain',
        // `build`, not `app`: composing workflows IS authoring. Under `app` an
        // agent filtering to the build family never saw the only tool that can
        // link what it just built.
        family: 'build',
        description:
          'Wire the App-level RUN ORDER and DEPENDENCIES between workflows — the "runs after" chaining the App Orchestrator executes. ' +
          'CRITICAL DISTINCTION: `order` is ONLY a display/tie-break sort number — it does NOT make workflows run one-after-another. To actually chain them (B waits for A), you MUST set `dependsOn`. ' +
          'To make workflows run in SEQUENCE (the usual intent of "put them in order" / "run them one after another"), pass `sequence`: an ordered list of workflow IDs — this sets BOTH order AND the dependsOn chain (each depends on the previous) in one call. That is what shows up as ticked "runs after" boxes. ' +
          'dependsOn is a CONJUNCTION: a workflow depending on [A, C] runs ONCE, when the last of A and C is satisfied — never once per upstream. ' +
          'Use `workflows` instead (or as well) for fine-grained per-workflow control. A link expresses FIVE things: ' +
          'WHEN — chainOn ("success" default = ACCOMPLISHED verdict when the upstream has a spec; "failure" = a true error branch that fires only when it settled WITHOUT succeeding; "always" = any terminal settle, for finally/cleanup); ' +
          'WHETHER — `when`, a predicate over the upstream result (e.g. "upstream.output.leadCount > 0"), so B runs after A only if A produced something worth running B for; ' +
          'HOW LONG AFTER — `delay: { ms, jitterMs }`, a link-level wait without needing a wait node (jitterMs spreads dependents that share a rate-limited downstream); ' +
          'HOW MANY — the conjunction above; and ' +
          'WITH WHAT — the dependent receives `upstreamOutput` (the upstream\'s real terminal output), plus upstreamRunId/Status/Outcome. ' +
          'Also: concurrency ("parallel" | "exclusive" = skip an orchestrated start while a run is still active), enabled, purpose, order. ' +
          '`operatorEntrypoint:false` keeps an event/channel/schedule-driven root out of Run Pipeline while leaving it enabled for its real persisted trigger. ' +
          'Omitted fields are preserved. Rejects self-dependencies and cycles (including cycles formed together with event rules).',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'App whose workflows to order. Omit to use the App in context.' },
            sequence: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ordered workflow IDs to run one-after-another. Sets order AND wires dependsOn as a linear chain (2nd runs after 1st, 3rd after 2nd, …). The simplest way to fulfill "run these in order".',
            },
            chainOn: { type: 'string', enum: ['success', 'failure', 'always'], description: 'Applied to every link when using `sequence`. "success" requires an ACCOMPLISHED verdict when the upstream has a definition-of-done spec; "failure" fires only when it settled without succeeding; "always" fires on any terminal settle.' },
            workflows: {
              type: 'array',
              description: 'Per-workflow bindings for fine control. Each: { workflowId, order?, dependsOn?: [workflowId], chainOn?, when?, delay?, concurrency?, enabled?, purpose? }.',
              items: {
                type: 'object',
                properties: {
                  workflowId: { type: 'string' },
                  order: { type: 'number' },
                  operatorEntrypoint: { type: 'boolean', description: 'False for roots started only by a channel, event rule, webhook, listener, or schedule; they stay enabled but Run Pipeline will not start them.' },
                  dependsOn: { type: 'array', items: { type: 'string' }, description: 'Workflow IDs that must ALL finish before this one starts (a conjunction — it fires once, when the last is satisfied).' },
                  chainOn: { type: 'string', enum: ['success', 'failure', 'always'] },
                  when: {
                    type: 'string',
                    description: 'Predicate over the upstream result; the link fires only when true. Scope: { upstream: { workflowId, status, verdict, output }, app: { id } }. Example: "upstream.output.leadCount > 0". An invalid expression HOLDS the link rather than firing it.',
                  },
                  delay: {
                    type: 'object',
                    description: 'Wait after the dependencies are satisfied, before starting. { ms, jitterMs } — jitterMs adds a random extra in [0, jitterMs) so simultaneous dependents do not all fire on the same instant.',
                    properties: { ms: { type: 'number' }, jitterMs: { type: 'number' } },
                  },
                  concurrency: { type: 'string', enum: ['parallel', 'exclusive'] },
                  enabled: { type: 'boolean' },
                  purpose: { type: 'string' },
                },
                required: ['workflowId'],
              },
            },
          },
        },
        mutating: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        // `sequence` = the ergonomic "run these one after another": expand it into
        // per-workflow patches that set BOTH order and the dependsOn chain, so the
        // agent can't set a hollow display-order with no real "runs after" links.
        const sequenceItems: z.infer<typeof chainItemSchema>[] = [];
        if (Array.isArray(args.sequence)) {
          const seq = z.array(z.string().min(1)).min(1).parse(args.sequence);
          const seqChainOn = args.chainOn === 'always' || args.chainOn === 'failure'
            ? args.chainOn
            : 'success' as const;
          seq.forEach((workflowId, i) => {
            sequenceItems.push({ workflowId, order: i, dependsOn: i === 0 ? [] : [seq[i - 1]!], chainOn: seqChainOn });
          });
        }
        const explicitItems = args.workflows !== undefined ? z.array(chainItemSchema).parse(args.workflows) : [];
        // Explicit per-workflow entries win over the sequence-derived ones (later merge).
        const items = [...sequenceItems, ...explicitItems];
        if (items.length === 0) {
          throw new AgentisError('VALIDATION_FAILED', 'workflow.chain: pass `sequence` (ordered workflow IDs to run one-after-another) or `workflows` (per-workflow bindings).');
        }
        const memberIds = store.listWorkflowIds(ctx.workspaceId, appId);
        const memberSet = new Set(memberIds);

        // Read every member's CURRENT binding so we can validate the full graph
        // (cycles, dependsOn membership) against the post-patch state before writing.
        const rows = deps.db
          .select({ id: schema.workflows.id, title: schema.workflows.title, settings: schema.workflows.settings })
          .from(schema.workflows)
          .where(and(eq(schema.workflows.workspaceId, ctx.workspaceId), eq(schema.workflows.appId, appId)))
          .all();
        const titleById = new Map(rows.map((r) => [r.id, r.title]));
        const settingsById = new Map(rows.map((r) => [r.id, r.settings]));
        const bindings = new Map(rows.map((r) => [r.id, readWorkflowBinding(r.settings)]));

        // Apply patches in-memory first.
        const changed = new Set<string>();
        for (const item of items) {
          if (!memberSet.has(item.workflowId)) {
            throw new AgentisError('VALIDATION_FAILED', `workflow ${item.workflowId} is not part of app ${appId} — adopt it first with agentis.app.adopt_workflow, or fix the id. App workflows: ${memberIds.join(', ') || '(none)'}.`);
          }
          for (const dep of item.dependsOn ?? []) {
            if (dep === item.workflowId) throw new AgentisError('VALIDATION_FAILED', `workflow ${item.workflowId} cannot depend on itself.`);
            if (!memberSet.has(dep)) throw new AgentisError('VALIDATION_FAILED', `dependsOn "${dep}" (for ${item.workflowId}) is not a workflow in app ${appId}.`);
          }
          const { workflowId, ...patch } = item;
          const merged = appWorkflowBindingSchema.parse({ ...bindings.get(workflowId), ...patch });
          bindings.set(workflowId, merged);
          changed.add(workflowId);
        }

        // Reject cycles across the FULL post-patch dependency graph — including
        // links made by the OTHER mechanism. A dependsOn chain and an event rule
        // could previously form a loop that neither validator saw on its own,
        // caught only by a runtime depth cap after the damage was done.
        const graph = new Map([...bindings].map(([id, b]) => [id, (b.dependsOn ?? []).filter((d) => memberSet.has(d))]));
        const eventRules = deps.db
          .select({
            source: schema.workflowEventSubscriptions.sourceWorkflowId,
            target: schema.workflowEventSubscriptions.targetWorkflowId,
          })
          .from(schema.workflowEventSubscriptions)
          .where(and(
            eq(schema.workflowEventSubscriptions.workspaceId, ctx.workspaceId),
            eq(schema.workflowEventSubscriptions.enabled, true),
          ))
          .all();
        const viaEventRule = new Set<string>();
        for (const rule of eventRules) {
          if (!memberSet.has(rule.source) || !memberSet.has(rule.target)) continue;
          // An event rule source→target is the same "target runs after source"
          // edge dependsOn expresses, so it belongs in the same graph.
          const existing = graph.get(rule.target) ?? [];
          if (!existing.includes(rule.source)) {
            graph.set(rule.target, [...existing, rule.source]);
            viaEventRule.add(`${rule.source}->${rule.target}`);
          }
        }
        const cycle = firstDependencyCycle(graph);
        if (cycle) {
          const crossesMechanism = cycle.some((id, i) => viaEventRule.has(`${cycle[i + 1] ?? cycle[0]}->${id}`));
          throw new AgentisError(
            'VALIDATION_FAILED',
            `this would form a cycle: ${cycle.join(' → ')}. Workflows cannot depend on each other in a loop.`
            + (crossesMechanism
              ? ' Note: part of this loop is an existing EVENT RULE (agentis.workflow.rule), not a dependsOn link — inspect both before rewiring.'
              : ''),
          );
        }

        // Commit only the changed workflows, then publish realtime.
        const now = new Date().toISOString();
        for (const workflowId of changed) {
          const settings = (settingsById.get(workflowId) as Record<string, unknown> | undefined) ?? {};
          deps.db.update(schema.workflows)
            .set({ settings: { ...settings, appBinding: bindings.get(workflowId) }, updatedAt: now })
            .where(eq(schema.workflows.id, workflowId))
            .run();
          publishBindingChange(ctx.workspaceId, appId, workflowId);
        }

        const runOrder = memberIds
          .map((id) => ({
            workflowId: id,
            title: titleById.get(id) ?? id,
            order: bindings.get(id)?.order ?? 0,
            dependsOn: (bindings.get(id)?.dependsOn ?? []).map((d) => ({ workflowId: d, title: titleById.get(d) ?? d })),
          }))
          .sort((a, b) => a.order - b.order);
        // A real chain has ≥1 dependsOn link. Warn when the operator set an ORDER on
        // multiple workflows but wired NO dependencies — that's a display sort only,
        // not "runs after", and the run-all would start them all as roots.
        const anyDependency = runOrder.some((w) => w.dependsOn.length > 0);
        const note = !anyDependency && runOrder.length > 1
          ? 'This set an ORDER only — no "runs after" links, so the workflows are NOT chained (they would all start as roots). To make them run one-after-another, call again with `sequence: [<ids in order>]`.'
          : undefined;
        return { appId, updated: [...changed], chained: anyDependency, runOrder, ...(note ? { note } : {}) };
      },
    },
    {
      definition: {
        id: 'agentis.app.scaffold',
        family: 'app',
        description:
          'Set up an App\'s DATA model and kick off its interface. Defines the datastore `collections`, then: if a separate design model is configured it drafts a starter surface; otherwise it returns a DESIGN BRIEF and you author the interface yourself with agentis.ui.render (the better result — you understand the domain). Either way, treat any starter as a starting point and enrich it into a real operating interface via ui.render / ui.patch — do not ship the generic default. Use when the operator asks for an app with an interface (CRM, dashboard, tracker, pipeline, board, portal, interface). An App with logic but no UI/data is INCOMPLETE.',
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
        //    should author the interface itself — it understands the operating model
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
              `Data is ready. Now AUTHOR the operating interface for "${prompt}" by calling agentis.ui.render — compose a bespoke surface from the full grammar ` +
              `(KPIStrip / Hero / Tabs / Split / DataBoard / StatusBoard / Timeline / Funnel / Gauge / ProgressBar / Callout / Chart / Table / Form / ActivityStream) ` +
              `bound to these collections: ${names}. Lead with the KPIs that matter, then the pipeline/board, the gates/approvals queues, validation status, and an activity rail ` +
              `(ActivityStream) in a Split. Declare every button/form action first with agentis.ui.action_schema (kind: workflow | tool | data). Do NOT render a generic card list.`,
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
      handler: (args, ctx) => {
        const info = data.defineCollection(ctx.workspaceId, resolveAppId(args, ctx), { name: str(args.name, 'name'), schema: collectionSchemaSchema.parse(args.schema) });
        emitCreation(deps, ctx, { creationKind: 'collection', title: info.name });
        return info;
      },
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
      handler: (args, ctx) => {
        const collection = str(args.collection, 'collection');
        const rec = data.insert(ctx.workspaceId, resolveAppId(args, ctx), collection, obj(args.record, 'record'), ctx.agentId);
        emitCreation(deps, ctx, { creationKind: 'record', title: collection, collection, count: 1 });
        return rec;
      },
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
      handler: (args, ctx) => {
        const collection = str(args.collection, 'collection');
        const rec = data.upsert(ctx.workspaceId, resolveAppId(args, ctx), collection, obj(args.match, 'match'), obj(args.record, 'record'), ctx.agentId);
        emitCreation(deps, ctx, { creationKind: 'record', title: collection, collection, count: 1 });
        return rec;
      },
    },
    {
      definition: {
        id: 'agentis.data.batch',
        family: 'app',
        description: 'Apply up to 200 App datastore insert/update/upsert/delete operations in one ordered tool call. Use this for migrations or repairing many records; never issue dozens of data.update calls.',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            operations: {
              type: 'array',
              maxItems: 200,
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['insert', 'update', 'upsert', 'delete'] },
                  collection: { type: 'string' },
                  id: { type: 'string' },
                  record: { type: 'object' },
                  patch: { type: 'object' },
                  match: { type: 'object' },
                },
                required: ['op', 'collection'],
              },
            },
          },
          required: ['operations'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const operations = Array.isArray(args.operations) ? args.operations : [];
        if (operations.length === 0 || operations.length > 200) {
          throw new AgentisError('VALIDATION_FAILED', 'operations must contain between 1 and 200 datastore mutations');
        }
        const appId = resolveAppId(args, ctx);
        // One batch is one state transition. If operation 57 fails, operations
        // 0-56 must not remain committed while the harness retries or repairs the
        // payload; that partial-write behavior is exactly how serial agent repair
        // loops corrupt an otherwise recoverable App.
        const results = deps.db.transaction(() => {
          const applied: Array<{ index: number; op: string; collection: string; id?: string }> = [];
          for (const [index, raw] of operations.entries()) {
            const operation = obj(raw, `operations.${index}`);
            const op = str(operation.op, `operations.${index}.op`);
            const collection = str(operation.collection, `operations.${index}.collection`);
            if (op === 'insert') {
              const record = data.insert(ctx.workspaceId, appId, collection, obj(operation.record, `operations.${index}.record`), ctx.agentId);
              applied.push({ index, op, collection, id: record.id });
            } else if (op === 'update') {
              const id = str(operation.id, `operations.${index}.id`);
              data.update(ctx.workspaceId, appId, collection, id, obj(operation.patch, `operations.${index}.patch`));
              applied.push({ index, op, collection, id });
            } else if (op === 'upsert') {
              const record = data.upsert(ctx.workspaceId, appId, collection, obj(operation.match, `operations.${index}.match`), obj(operation.record, `operations.${index}.record`), ctx.agentId);
              applied.push({ index, op, collection, id: record.id });
            } else if (op === 'delete') {
              const id = str(operation.id, `operations.${index}.id`);
              data.delete(ctx.workspaceId, appId, collection, id);
              applied.push({ index, op, collection, id });
            } else {
              throw new AgentisError('VALIDATION_FAILED', `operations.${index}.op must be insert, update, upsert, or delete`);
            }
          }
          return applied;
        });
        const byOperation = results.reduce<Record<string, number>>((counts, result) => {
          counts[result.op] = (counts[result.op] ?? 0) + 1;
          return counts;
        }, {});
        return { ok: true, appId, applied: results.length, byOperation, results, summary: `Applied ${results.length} datastore mutation(s) in one tool call.` };
      },
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
        description: 'Query App collection records. Filter ops: eq/ne/gt/gte/lt/lte/contains/in, or a bare value for equality. Sort entries are objects: { "field", "dir" }.',
        inputSchema: { type: 'object', properties: { ...appIdProp, collection: { type: 'string' }, ...filterProp, ...sortProp, limit: { type: 'number' }, cursor: { type: 'string' } }, required: ['collection'] },
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
          'THE way to build a powerful App interface: YOU design and author the surface as a typed ViewNode tree — a bespoke operating interface, not a generic card list. You know the domain you just built, so compose a real interface from the full grammar:\n' +
          '• Headline metrics — KPIStrip (multiple labelled values + deltas + sparks), Metric, Gauge, ProgressBar, Callout.\n' +
          '• Layout — Hero (title banner), Tabs, Accordion, Split (main + right rail, ratio), Toolbar, Stack/Row/Grid, Divider.\n' +
          '• Data, bound to collections via { bind: { collection, query?, sort?, limit?, live? } } — Kanban (real drag update + governed transitions + state-aware right-click contextActions/cardActions), RecordMaster, Table (columns + rowActions), List, StatusBoard, Timeline, Funnel, Calendar, Inbox, Chart.\n' +
          '• Agent-native — ActivityStream (your live work feed), Narrative, ConversationThread, ChatThread.\n' +
          '• Rich content — DocumentViewer, CodeViewer, MediaGallery, MapView, Image, Avatar, Badge. CodeSurface/CustomView render your own sandboxed JS/HTML for anything bespoke.\n' +
          '• PIXEL-PERFECT tier — CodeSurface is a first-class, co-equal path (not a fallback): reach for it when you want full design control or the typed composites would look generic. It renders full-bleed and auto-heights to a whole dashboard page, on-brand in light AND dark, with a rich ui kit (cards, grids, metric tiles with depth, status pills, area/line/bar/donut charts) and the agentis bridge (data.query, actions.invoke, state, navigation). Requires the App\'s custom-code policy. Keep typed nodes for operable/editable/data-bound apps.\n' +
          '• Inputs — Form (fields + submit action), Button (action). Declare every button/form action first with ui.action_schema (kind: workflow | tool | data).\n' +
          'Compose for the operating model you designed: lead with the KPIs that matter, then the pipeline/board, gates/approvals queues, validation status, and an activity rail (ActivityStream) in a Split. Replaces the surface view. Prefer this over a generic scaffold — a capable agent authoring the interface directly is how Agentis ships powerful apps.',
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
        description: 'Mutate part of an existing surface view by path. Inspect first; for deletion prefer agentis.ui.remove with a stable nodeId. ops: [{ op: "set"|"insert"|"remove", path, value?|node? }].',
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
        id: 'agentis.ui.inspect',
        family: 'app',
        description:
          'Read the current persisted App interface before editing it. Compact by default: returns each surface plus a semantic node outline (stable nodeId/type/path/collection) and declared actions, avoiding the token cost of dumping the full tree. Pass surface and includeTree:true only when exact properties are needed.',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            surface: { type: 'string', description: 'Optional surface name. Omit to list/outline every surface.' },
            includeTree: { type: 'boolean', description: 'Include the complete ViewNode tree. Defaults false.' },
          },
        },
        mutating: false,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const selected = typeof args.surface === 'string' && args.surface.trim()
          ? [surfaces.get(ctx.workspaceId, appId, args.surface.trim())]
          : surfaces.list(ctx.workspaceId, appId);
        return {
          appId,
          surfaces: selected.map((surface) => ({
            name: surface.name,
            kind: surface.kind,
            revision: surface.revision,
            shareable: surface.shareable,
            actions: surface.actions.map((action) => ({ name: action.name, kind: action.kind, target: action.target })),
            nodes: surfaceOutline(surface),
            ...(args.includeTree === true ? { view: surface.view } : {}),
          })),
        };
      },
    },
    {
      definition: {
        id: 'agentis.ui.remove',
        family: 'app',
        description:
          'Reliably remove one UI component by stable nodeId, or delete an entire surface. Use agentis.ui.inspect first to get nodeIds. Component deletion re-validates and revisions the tree. Whole-surface deletion requires deleteSurface:true AND confirmSurfaceName exactly matching surface; it never happens accidentally.',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            surface: { type: 'string' },
            nodeId: { type: 'string', description: 'Stable semantic id returned by ui.inspect. Required for component deletion.' },
            deleteSurface: { type: 'boolean', description: 'Delete the entire surface instead of one component.' },
            confirmSurfaceName: { type: 'string', description: 'For whole-surface deletion, must exactly equal surface.' },
          },
          required: ['surface'],
        },
        mutating: true,
        autoExecute: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const surface = str(args.surface, 'surface');
        if (args.deleteSurface === true) {
          if (args.confirmSurfaceName !== surface) {
            const current = surfaces.get(ctx.workspaceId, appId, surface);
            return {
              deleted: false,
              confirmationRequired: true,
              surface,
              revision: current.revision,
              nodes: surfaceOutline(current).length,
              instruction: `call again with deleteSurface:true and confirmSurfaceName:"${surface}"`,
            };
          }
          surfaces.delete(ctx.workspaceId, appId, surface);
          return { deleted: true, surface };
        }
        const nodeId = str(args.nodeId, 'nodeId');
        const result = surfaces.removeNode(ctx.workspaceId, appId, surface, nodeId);
        return { removed: true, surface, nodeId, revision: result.revision };
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
          'PERFORM a transient region into a stable AgentRegion slot on a surface, live — the interface composes itself. Use to push an unprompted panel into the operator\'s view when you notice something (e.g. render a "churn risk" panel into the "attention" region because 12 deals stalled at pricing). The frame stays stable; this child is ephemeral and dismissable by the operator — UNLESS you pass pin:true (then it freezes into the stored surface). ALWAYS pass a short `reason` (it is shown to the operator as "added because …"). Pass clear:true to dismiss a region. The surface must already contain an AgentRegion with this `region` id (render the frame with one first).',
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
      // INTERFACE-OVERHAUL-10X: the gate's findings BEFORE persisting — the UI
      // equivalent of a workflow dry-run. Author → lint → render.
      definition: {
        id: 'agentis.ui.lint',
        family: 'app',
        description:
          'Lint a surface against the layout floor + operability gate (RENDERED ≠ OPERABLE) WITHOUT persisting. ' +
          'Pass view (and optionally actions) to check a PROPOSED tree before ui.render, or just surface to audit the stored one. ' +
          'Returns operable (true = no repairs needed) plus the exact fixes the gate would apply at persist ' +
          '(orphan workflow actions wired into the header, buttons on undeclared actions stripped, dead binds removed, legacy kinds migrated). ' +
          'A surface that needs repairs is a defect — fix the tree and lint again. Flow: author → lint → render.',
        inputSchema: {
          type: 'object',
          properties: {
            ...appIdProp,
            surface: { type: 'string', description: 'Surface name (its stored tree/actions are used when view/actions are omitted). Defaults to "home".' },
            view: { type: 'object', description: 'Proposed ViewNode tree to lint (omit to lint the stored surface).' },
            actions: { type: 'array', description: 'Proposed SurfaceAction[] to lint against (omit to use the stored declarations).' },
          },
        },
        mutating: false,
        autoExecute: true,
        mcpExposed: true,
      },
      handler: (args, ctx) => {
        const appId = resolveAppId(args, ctx);
        const surfaceName = typeof args.surface === 'string' && args.surface.trim() ? args.surface.trim() : 'home';
        let stored: AppSurface | null = null;
        try { stored = surfaces.get(ctx.workspaceId, appId, surfaceName); } catch { stored = null; }

        // A proposed tree that fails the schema is the first-class lint finding.
        if (args.view !== undefined) {
          const parsed = viewNodeSchema.safeParse(args.view);
          if (!parsed.success) {
            return {
              operable: false,
              schemaErrors: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('/') || '(root)'}: ${i.message}`),
              fixes: [],
              hint: 'The view does not parse as a ViewNode tree — fix the schema errors before anything else.',
            };
          }
        }
        const view = args.view !== undefined ? viewNodeSchema.parse(args.view) : stored?.view ?? null;
        if (!view) {
          throw new AgentisError('VALIDATION_FAILED', `nothing to lint: surface "${surfaceName}" has no stored view — pass a proposed view or render first`);
        }
        const actions = Array.isArray(args.actions) ? z.array(surfaceActionSchema).parse(args.actions) : stored?.actions ?? [];
        const collectionNames = data.listCollections(ctx.workspaceId, appId).map((c) => c.name);
        const { fixes } = repairSurface(view, {
          collections: collectionNames,
          ...(actions.length > 0 ? { actions } : {}),
        });
        return {
          operable: fixes.length === 0,
          fixes,
          actionsConsidered: actions.length,
          collections: collectionNames,
          hint: fixes.length === 0
            ? 'Passes the gate — render it.'
            : 'These repairs WILL be auto-applied at persist; a cleaner surface fixes them at the source and lints again.',
        };
      },
    },
    {
      // Living Apps Phase 2 — the resident agent FLAGS a thread for the operator
      // instead of interrupting. Use when you hit something only a human can decide
      // ("the customer wants a discount I'm not authorized to give", "this looks
      // like a complaint that needs a manager"). The App interface shows a count + a
      // ◆ marker on the thread; the operator clears it by stepping in. Pass clear:true
      // to withdraw the flag once it's resolved. Targets the current thread.
      definition: {
        id: 'agentis.conversation.flag_needs_attention',
        family: 'app',
        description: 'Flag the CURRENT conversation as needing the human operator (you do not interrupt — you raise a hand). Use when a decision is above your authority or a situation needs a person ("wants a discount I can\'t approve", "angry customer asking for a manager"). The App interface surfaces it as a count + a marker. Pass clear:true to withdraw the flag once resolved.',
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
  ], { defaultMcpExposed: true });
  // ^ Every tool in this family is an agent-facing App build/operate tool (create,
  //   define data, render/patch/declare-actions on surfaces, insert/query records).
  //   MCP-native harnesses build apps with exactly these, so expose the whole family
  //   over MCP — not just the in-process chat. Previously ui.render / ui.action_schema /
  //   data.* were registered but NOT mcpExposed, so an MCP agent could scaffold + compose
  //   but never RENDER the first surface — a dead end. (Explicit per-entry flags win.)
}
