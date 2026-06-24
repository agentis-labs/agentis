/**
 * AppSurfaceStore — persistence + mutation for AG-UI surfaces (AGENTIC-APPS-10X §4).
 *
 * A surface holds an agent-authored `ViewNode` tree and the actions its
 * buttons/forms may invoke. `render` replaces the tree (ui_render); `patch`
 * applies fine-grained ops (ui_patch). Both bump `revision` and emit a realtime
 * event so the AppRuntime updates live. Surfaces are App-owned and decoupled
 * from any single workflow (unlike the legacy WorkflowGraph.surfaces JSON).
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  AgentisError,
  appPolicySchema,
  viewNodeSchema,
  surfaceActionSchema,
  upsertSurfaceSchema,
  type AppSurface,
  type SurfaceAction,
  type SurfaceKind,
  type UiPatchOp,
  type ViewNode,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

type SurfaceRow = typeof schema.appSurfaces.$inferSelect;

export type SurfaceEvent = 'render' | 'patch';

export interface AppSurfaceStoreDeps {
  db: AgentisSqliteDb;
  /** Realtime sink. Optional so tests/minimal embedders skip the bus. */
  emit?: (args: { appId: string; workspaceId: string; event: SurfaceEvent; surfaceId: string; revision: number; payload: unknown }) => void;
}

export class AppSurfaceStore {
  constructor(private readonly deps: AppSurfaceStoreDeps) {}
  private get db() {
    return this.deps.db;
  }

  private requireApp(workspaceId: string, appId: string): void {
    const row = this.db
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
  }

  private requireCustomCodeAllowed(workspaceId: string, appId: string, view: ViewNode | null | undefined): void {
    if (!view || !containsCustomView(view)) return;
    const row = this.db
      .select({ policyJson: schema.apps.policyJson })
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId)))
      .get();
    const policy = appPolicySchema.parse(row?.policyJson ?? {});
    if (policy.customCode !== 'allowed') {
      throw new AgentisError('VALIDATION_FAILED', 'CustomView requires app.policy.customCode = "allowed"');
    }
  }

  private toSurface(row: SurfaceRow): AppSurface {
    return {
      id: row.id,
      appId: row.appId,
      name: row.name,
      kind: row.kind as SurfaceKind,
      view: (row.viewJson ?? null) as ViewNode | null,
      actions: (row.actionsJson ?? []) as SurfaceAction[],
      shareable: row.shareable,
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  }

  private rowByName(appId: string, name: string): SurfaceRow | undefined {
    return this.db
      .select()
      .from(schema.appSurfaces)
      .where(and(eq(schema.appSurfaces.appId, appId), eq(schema.appSurfaces.name, name)))
      .get();
  }

  list(workspaceId: string, appId: string): AppSurface[] {
    this.requireApp(workspaceId, appId);
    return this.db
      .select()
      .from(schema.appSurfaces)
      .where(eq(schema.appSurfaces.appId, appId))
      .orderBy(asc(schema.appSurfaces.name))
      .all()
      .map((r) => this.toSurface(r));
  }

  get(workspaceId: string, appId: string, name: string): AppSurface {
    this.requireApp(workspaceId, appId);
    const row = this.rowByName(appId, name);
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `surface not found: ${name}`);
    return this.toSurface(row);
  }

  getById(appId: string, surfaceId: string): AppSurface | undefined {
    const row = this.db
      .select()
      .from(schema.appSurfaces)
      .where(and(eq(schema.appSurfaces.appId, appId), eq(schema.appSurfaces.id, surfaceId)))
      .get();
    return row ? this.toSurface(row) : undefined;
  }

  /** Create or replace a surface definition (human builder / compose path). */
  upsert(workspaceId: string, appId: string, input: unknown): AppSurface {
    this.requireApp(workspaceId, appId);
    const data = upsertSurfaceSchema.parse(input);
    this.requireCustomCodeAllowed(workspaceId, appId, data.view);
    const now = new Date().toISOString();
    const existing = this.rowByName(appId, data.name);
    if (existing) {
      this.db
        .update(schema.appSurfaces)
        .set({
          kind: data.kind,
          ...(data.view !== undefined ? { viewJson: data.view } : {}),
          ...(data.actions !== undefined ? { actionsJson: data.actions } : {}),
          ...(data.shareable !== undefined ? { shareable: data.shareable } : {}),
          revision: existing.revision + 1,
          updatedAt: now,
        })
        .where(eq(schema.appSurfaces.id, existing.id))
        .run();
      return this.get(workspaceId, appId, data.name);
    }
    const id = randomUUID();
    this.db
      .insert(schema.appSurfaces)
      .values({
        id,
        appId,
        workspaceId,
        name: data.name,
        kind: data.kind,
        viewJson: data.view ?? null,
        actionsJson: data.actions ?? [],
        shareable: data.shareable ?? false,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.get(workspaceId, appId, data.name);
  }

  rename(workspaceId: string, appId: string, currentName: string, nextName: string): AppSurface {
    this.requireApp(workspaceId, appId);
    const name = nextName.trim();
    if (!name) throw new AgentisError('VALIDATION_FAILED', 'Surface name is required');
    if (name.length > 120) throw new AgentisError('VALIDATION_FAILED', 'Surface name is too long');
    const existing = this.rowByName(appId, currentName);
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `surface not found: ${currentName}`);
    if (name !== currentName && this.rowByName(appId, name)) {
      throw new AgentisError('VALIDATION_FAILED', `surface already exists: ${name}`);
    }
    this.db
      .update(schema.appSurfaces)
      .set({ name, revision: existing.revision + 1, updatedAt: new Date().toISOString() })
      .where(eq(schema.appSurfaces.id, existing.id))
      .run();
    const surface = this.get(workspaceId, appId, name);
    this.deps.emit?.({
      appId,
      workspaceId,
      event: 'render',
      surfaceId: surface.id,
      revision: surface.revision,
      payload: { name: surface.name, view: surface.view },
    });
    return surface;
  }

  /** ui_render — replace the surface's full ViewNode tree. Creates the surface if absent. */
  render(workspaceId: string, appId: string, name: string, view: unknown): AppSurface {
    this.requireApp(workspaceId, appId);
    const parsed = viewNodeSchema.parse(view);
    this.requireCustomCodeAllowed(workspaceId, appId, parsed);
    const existing = this.rowByName(appId, name);
    const now = new Date().toISOString();
    if (!existing) {
      this.upsert(workspaceId, appId, { name, kind: 'page', view: parsed });
    } else {
      this.db
        .update(schema.appSurfaces)
        .set({ viewJson: parsed, revision: existing.revision + 1, updatedAt: now })
        .where(eq(schema.appSurfaces.id, existing.id))
        .run();
    }
    const surface = this.get(workspaceId, appId, name);
    this.deps.emit?.({ appId, workspaceId, event: 'render', surfaceId: surface.id, revision: surface.revision, payload: { view: surface.view } });
    return surface;
  }

  /** ui_patch — apply ops to the persisted tree. */
  patch(workspaceId: string, appId: string, name: string, ops: UiPatchOp[]): AppSurface {
    const current = this.get(workspaceId, appId, name);
    if (current.view == null) throw new AgentisError('VALIDATION_FAILED', `surface ${name} has no view to patch; call ui_render first`);
    let tree = structuredClone(current.view) as unknown;
    for (const op of ops) tree = applyPatchOp(tree, op);
    const parsed = viewNodeSchema.parse(tree);
    this.requireCustomCodeAllowed(workspaceId, appId, parsed);
    const now = new Date().toISOString();
    this.db
      .update(schema.appSurfaces)
      .set({ viewJson: parsed, revision: current.revision + 1, updatedAt: now })
      .where(and(eq(schema.appSurfaces.appId, appId), eq(schema.appSurfaces.name, name)))
      .run();
    const surface = this.get(workspaceId, appId, name);
    this.deps.emit?.({ appId, workspaceId, event: 'patch', surfaceId: surface.id, revision: surface.revision, payload: { ops } });
    return surface;
  }

  /** ui_action_schema — declare the actions a surface may invoke. */
  setActions(workspaceId: string, appId: string, name: string, actions: SurfaceAction[]): AppSurface {
    this.requireApp(workspaceId, appId);
    const parsed = actions.map((a) => surfaceActionSchema.parse(a));
    const existing = this.rowByName(appId, name);
    if (!existing) {
      return this.upsert(workspaceId, appId, { name, kind: 'page', actions: parsed });
    }
    this.db
      .update(schema.appSurfaces)
      .set({ actionsJson: parsed, updatedAt: new Date().toISOString() })
      .where(eq(schema.appSurfaces.id, existing.id))
      .run();
    return this.get(workspaceId, appId, name);
  }
}

/**
 * Apply a single ui_patch op to a plain ViewNode tree. Paths are slash-separated
 * (e.g. "children/0/title"); numeric segments index arrays. Kept deliberately
 * small — the typed-tree tier is the default; deep mutation is the exception.
 */
function applyPatchOp(root: unknown, op: UiPatchOp): unknown {
  if (op.op === 'set') {
    return setAtPath(root, splitPath(op.path), op.value);
  }
  if (op.op === 'remove') {
    return removeAtPath(root, splitPath(op.path));
  }
  // insert into an array at path (path points at the array; index optional)
  const segments = splitPath(op.path);
  const target = getAtPath(root, segments);
  if (!Array.isArray(target)) throw new AgentisError('VALIDATION_FAILED', `insert target is not an array: ${op.path}`);
  const arr = target.slice();
  const at = op.index ?? arr.length;
  arr.splice(at, 0, op.node);
  return setAtPath(root, segments, arr);
}

function splitPath(path: string): Array<string | number> {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : s));
}

function getAtPath(root: unknown, segments: Array<string | number>): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

function setAtPath(root: unknown, segments: Array<string | number>, value: unknown): unknown {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  const clone: Record<string | number, unknown> = Array.isArray(root)
    ? [...(root as unknown[])] as unknown as Record<string | number, unknown>
    : { ...(root as Record<string | number, unknown>) };
  clone[head!] = setAtPath(clone[head!], rest, value);
  return clone;
}

function removeAtPath(root: unknown, segments: Array<string | number>): unknown {
  if (segments.length === 0) return undefined;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (Array.isArray(root)) {
      const arr = [...(root as unknown[])];
      arr.splice(Number(head), 1);
      return arr;
    }
    const obj = { ...(root as Record<string | number, unknown>) };
    delete obj[head!];
    return obj;
  }
  const clone: Record<string | number, unknown> = Array.isArray(root)
    ? [...(root as unknown[])] as unknown as Record<string | number, unknown>
    : { ...(root as Record<string | number, unknown>) };
  clone[head!] = removeAtPath(clone[head!], rest);
  return clone;
}

function containsCustomView(node: ViewNode): boolean {
  if (node.type === 'CustomView') return true;
  if ('children' in node) return node.children.some(containsCustomView);
  if (node.type === 'List') return containsCustomView(node.item);
  return false;
}
