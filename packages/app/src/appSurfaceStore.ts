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
  repairSurface,
  viewNodeSchema,
  surfaceActionSchema,
  upsertSurfaceSchema,
  type AppSurface,
  type SurfaceAction,
  type SurfaceKind,
  type SurfaceRegionPush,
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

  /** The app's real collection names — used by the layout auditor to drop dead binds. */
  private collectionNames(appId: string): string[] {
    return this.db
      .select({ name: schema.appCollections.name })
      .from(schema.appCollections)
      .where(eq(schema.appCollections.appId, appId))
      .all()
      .map((r) => r.name);
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
  delete(workspaceId: string, appId: string, name: string): void {
    this.requireApp(workspaceId, appId);
    const existing = this.rowByName(appId, name);
    if (!existing) throw new AgentisError('RESOURCE_NOT_FOUND', `surface not found: ${name}`);
    this.db.delete(schema.appSurfaces).where(eq(schema.appSurfaces.id, existing.id)).run();
  }

  render(workspaceId: string, appId: string, name: string, view: unknown): AppSurface {
    this.requireApp(workspaceId, appId);
    const parsed = viewNodeSchema.parse(view);
    // Layout floor + operability gate: auto-repair agent-authored trees before
    // they ship. The gate (RENDERED ≠ OPERABLE) runs against the surface's
    // declared actions; when none are declared yet (render-then-declare flow),
    // it defers to setActions, which re-audits with the real action set.
    const existingRow = this.rowByName(appId, name);
    const declared = (existingRow?.actionsJson ?? []) as SurfaceAction[];
    const repaired = repairSurface(parsed, {
      collections: this.collectionNames(appId),
      ...(declared.length > 0 ? { actions: declared } : {}),
    }).view;
    this.requireCustomCodeAllowed(workspaceId, appId, repaired);
    const existing = this.rowByName(appId, name);
    const now = new Date().toISOString();
    if (!existing) {
      this.upsert(workspaceId, appId, { name, kind: 'page', view: repaired });
    } else {
      this.db
        .update(schema.appSurfaces)
        .set({ viewJson: repaired, revision: existing.revision + 1, updatedAt: now })
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
    const repaired = repairSurface(parsed, {
      collections: this.collectionNames(appId),
      ...(current.actions.length > 0 ? { actions: current.actions } : {}),
    }).view;
    this.requireCustomCodeAllowed(workspaceId, appId, repaired);
    const now = new Date().toISOString();
    this.db
      .update(schema.appSurfaces)
      .set({ viewJson: repaired, revision: current.revision + 1, updatedAt: now })
      .where(and(eq(schema.appSurfaces.appId, appId), eq(schema.appSurfaces.name, name)))
      .run();
    const surface = this.get(workspaceId, appId, name);
    this.deps.emit?.({ appId, workspaceId, event: 'patch', surfaceId: surface.id, revision: surface.revision, payload: { ops } });
    return surface;
  }

  /**
   * ui_perform_region (Phase M3 / G12) — the agent PERFORMS a transient region
   * into a stable `AgentRegion` slot, live. The performed child is ephemeral: it
   * is broadcast over the realtime bus (SURFACE_RENDER carrying `region`) and the
   * renderer drops it into the matching slot WITHOUT it being stored — so the
   * stable frame never drifts. Only when `pin:true` is the child frozen into the
   * persisted tree (so a reload keeps it). `clear:true` dismisses the region
   * (and un-pins the stored slot). Every push carries an explainable `reason`.
   */
  performRegion(
    workspaceId: string,
    appId: string,
    name: string,
    args: { region: string; view?: ViewNode | null; reason?: string; pin?: boolean; clear?: boolean },
  ): AppSurface {
    const current = this.get(workspaceId, appId, name);
    if (current.view == null) throw new AgentisError('VALIDATION_FAILED', `surface ${name} has no view; render the frame (with an AgentRegion) first`);
    if (!findRegion(current.view, args.region)) {
      throw new AgentisError('VALIDATION_FAILED', `surface ${name} has no AgentRegion "${args.region}"; add one to the frame first`);
    }
    const child = args.clear ? null : (args.view ?? null);
    const repairedChild = child ? repairSurface(child, { collections: this.collectionNames(appId) }).view : null;
    if (repairedChild) this.requireCustomCodeAllowed(workspaceId, appId, repairedChild);

    let revision = current.revision;
    // Pinned (or cleared) regions mutate the stored tree so a reload is stable;
    // an un-pinned performance leaves the persisted slot empty (it's transient).
    if (args.pin || args.clear) {
      const nextTree = setRegion(current.view, args.region, {
        child: args.pin ? repairedChild : undefined,
        pinned: args.pin === true,
        reason: args.clear ? undefined : args.reason,
      });
      const now = new Date().toISOString();
      this.db
        .update(schema.appSurfaces)
        .set({ viewJson: nextTree, revision: current.revision + 1, updatedAt: now })
        .where(and(eq(schema.appSurfaces.appId, appId), eq(schema.appSurfaces.name, name)))
        .run();
      revision = current.revision + 1;
    }

    const payload: SurfaceRegionPush = {
      appId,
      surfaceId: current.id,
      surface: name,
      region: args.region,
      view: repairedChild,
      ...(args.reason ? { reason: args.reason } : {}),
      pinned: args.pin === true,
      at: new Date().toISOString(),
    };
    this.deps.emit?.({ appId, workspaceId, event: 'render', surfaceId: current.id, revision, payload });
    return this.get(workspaceId, appId, name);
  }

  /** ui_action_schema — declare the actions a surface may invoke. Declaring
   * actions re-runs the operability gate against the stored tree, so an action
   * declared AFTER the render (the common agent flow) still gets wired into a
   * control — a declared-but-unreachable workflow action cannot persist. */
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

    // Re-audit the stored tree with the now-authoritative action set.
    const stored = existing.viewJson as ViewNode | null;
    if (stored && parsed.length > 0) {
      const { view: audited, fixes } = repairSurface(stored, { collections: this.collectionNames(appId), actions: parsed });
      if (fixes.length > 0) {
        this.db
          .update(schema.appSurfaces)
          .set({ viewJson: audited, revision: existing.revision + 1, updatedAt: new Date().toISOString() })
          .where(eq(schema.appSurfaces.id, existing.id))
          .run();
        const surface = this.get(workspaceId, appId, name);
        this.deps.emit?.({ appId, workspaceId, event: 'render', surfaceId: surface.id, revision: surface.revision, payload: { view: surface.view } });
        return surface;
      }
    }
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

/** Find an `AgentRegion` slot by its region id anywhere in the tree. */
function findRegion(node: ViewNode, region: string): boolean {
  if (node.type === 'AgentRegion') {
    if (node.region === region) return true;
    return node.child ? findRegion(node.child, region) : false;
  }
  if (node.type === 'Split') return findRegion(node.left, region) || findRegion(node.right, region);
  if (node.type === 'List') return findRegion(node.item, region);
  if (node.type === 'Tabs') return node.tabs.some((t) => t.children.some((c) => findRegion(c, region)));
  if (node.type === 'Accordion') return node.sections.some((s) => s.children.some((c) => findRegion(c, region)));
  if ('children' in node && Array.isArray((node as { children?: unknown }).children)) {
    return (node as { children: ViewNode[] }).children.some((c) => findRegion(c, region));
  }
  return false;
}

/** Return a copy of the tree with the matching `AgentRegion` slot's fields updated. */
function setRegion(node: ViewNode, region: string, patch: { child?: ViewNode | null; pinned?: boolean; reason?: string }): ViewNode {
  if (node.type === 'AgentRegion' && node.region === region) {
    const next = { ...node } as Extract<ViewNode, { type: 'AgentRegion' }>;
    if ('child' in patch) next.child = patch.child ?? undefined;
    if (patch.pinned !== undefined) next.pinned = patch.pinned;
    if ('reason' in patch) next.reason = patch.reason;
    return next;
  }
  if (node.type === 'AgentRegion' && node.child) return { ...node, child: setRegion(node.child, region, patch) };
  if (node.type === 'Split') return { ...node, left: setRegion(node.left, region, patch), right: setRegion(node.right, region, patch) };
  if (node.type === 'List') return { ...node, item: setRegion(node.item, region, patch) };
  if (node.type === 'Tabs') return { ...node, tabs: node.tabs.map((t) => ({ ...t, children: t.children.map((c) => setRegion(c, region, patch)) })) };
  if (node.type === 'Accordion') return { ...node, sections: node.sections.map((s) => ({ ...s, children: s.children.map((c) => setRegion(c, region, patch)) })) };
  if ('children' in node && Array.isArray((node as { children?: unknown }).children)) {
    return { ...node, children: (node as { children: ViewNode[] }).children.map((c) => setRegion(c, region, patch)) } as ViewNode;
  }
  return node;
}

function containsCustomView(node: ViewNode): boolean {
  if (node.type === 'CustomView') return true;
  if ('children' in node) return node.children.some(containsCustomView);
  if (node.type === 'List') return containsCustomView(node.item);
  if (node.type === 'Split') return containsCustomView(node.left) || containsCustomView(node.right);
  if (node.type === 'AgentRegion') return node.child ? containsCustomView(node.child) : false;
  return false;
}
