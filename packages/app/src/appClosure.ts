/**
 * appClosure — everything an Agentic App needs to actually RUN somewhere else.
 *
 * Export used to ship what the App *owns* (`WHERE appId = :appId`). That is not
 * the same as what it *needs*: an `agent_task` calls an agent that is merely
 * seated elsewhere, a `subflow` calls a workflow that was never adopted, a
 * `knowledge` node reads a workspace-scoped base. Ship only what is owned and the
 * package installs "successfully" as a skeleton that fails at run time.
 *
 * This computes the transitive closure over the App's workflow graphs — via the
 * one shared reference table (`appRefs.ts`) — and returns it as data. That single
 * structure drives export selection, the manifest, and the import preview, so the
 * three can never disagree about what an App consists of.
 *
 * Two classes of dependency, and the distinction matters:
 *   - `transportable` — copied into the package (workflows, agents, knowledge,
 *     extensions, collections).
 *   - declared only — named so the installer can supply them, never copied
 *     (credentials and channel tokens must not travel; connector slugs resolve
 *     against the target's in-process registry and are code, not rows).
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { referencedIds, walkNodeRefs, scriptRefs } from './appRefs.js';

/** The reserved collection + key a conversation script is stored under. */
export const CONVERSATION_SCRIPT_COLLECTION = 'conversation_script';
export const CONVERSATION_SCRIPT_KEY = 'script';

/** Read the App's conversation script (the `.script` payload), or null. */
export function readConversationScript(db: AgentisSqliteDb, appId: string): unknown {
  const collection = db
    .select({ id: schema.appCollections.id })
    .from(schema.appCollections)
    .where(and(eq(schema.appCollections.appId, appId), eq(schema.appCollections.name, CONVERSATION_SCRIPT_COLLECTION)))
    .get();
  if (!collection) return null;
  const row = db
    .select({ dataJson: schema.appRecords.dataJson })
    .from(schema.appRecords)
    .where(and(eq(schema.appRecords.collectionId, collection.id), eq(schema.appRecords.appId, appId)))
    .all();
  for (const r of row) {
    const data = r.dataJson as { key?: unknown; script?: unknown } | null;
    if (data?.key === CONVERSATION_SCRIPT_KEY && data.script) return data.script;
  }
  return null;
}

export type ClosureKind =
  | 'workflow'
  | 'agent'
  | 'knowledgeBase'
  | 'extension'
  | 'collection'
  | 'credential'
  | 'connection'
  | 'connector';

export interface ClosureItem {
  kind: ClosureKind;
  /** Source-workspace id, or the name/slug for things resolved by name. */
  id: string;
  label: string;
  /** The App cannot run without it — unticking earns a warning, never a block. */
  required: boolean;
  /** Directly owned by the App vs pulled in because something references it. */
  ownedByApp: boolean;
  /** Why it is here, in operator language. */
  reason: string;
  /** Copied into the package (true) or only declared for the installer (false). */
  transportable: boolean;
}

export interface AppClosure {
  items: ClosureItem[];
  /** Ids of workflows to serialize (App-owned + transitively referenced). */
  workflowIds: string[];
  agentIds: string[];
  knowledgeBaseIds: string[];
  extensionIds: string[];
  warnings: string[];
}

/** Group the closure by kind — the shape the preview tree renders. */
export function groupClosure(closure: AppClosure): Record<ClosureKind, ClosureItem[]> {
  const out = {} as Record<ClosureKind, ClosureItem[]>;
  for (const item of closure.items) {
    (out[item.kind] ??= []).push(item);
  }
  return out;
}

export function computeAppClosure(db: AgentisSqliteDb, workspaceId: string, appId: string): AppClosure {
  const items: ClosureItem[] = [];
  const warnings: string[] = [];
  const add = (item: ClosureItem) => {
    if (!items.some((existing) => existing.kind === item.kind && existing.id === item.id)) items.push(item);
  };

  // ── 1. Workflows: App-owned, then everything they reach, transitively. ──────
  const owned = db
    .select({ id: schema.workflows.id, title: schema.workflows.title, graph: schema.workflows.graph })
    .from(schema.workflows)
    .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
    .all();

  const graphsById = new Map(owned.map((w) => [w.id, w]));
  for (const w of owned) {
    add({ kind: 'workflow', id: w.id, label: w.title, required: true, ownedByApp: true, reason: 'Belongs to this App', transportable: true });
  }

  // The App's conversation script (a datastore row, not a graph) references
  // workflows and agents too. Fold those in so a workflow a stage runs but no
  // graph calls still travels — otherwise the imported script points at a
  // "workflow outside this App".
  const script = readConversationScript(db, appId);
  const scriptWorkflowIds = scriptRefs(script).filter((r) => r.kind === 'workflow').map((r) => r.value);
  const scriptAgentIds = scriptRefs(script).filter((r) => r.kind === 'agent').map((r) => r.value);

  const queue = [...owned.flatMap((w) => referencedIds(w.graph, 'workflow')), ...scriptWorkflowIds];
  const seenWorkflows = new Set(owned.map((w) => w.id));
  // Depth guard: a workflow chain could otherwise drag in an unbounded graph.
  for (let guard = 0; queue.length > 0 && guard < 500; guard += 1) {
    const refId = queue.shift()!;
    if (seenWorkflows.has(refId)) continue;
    seenWorkflows.add(refId);
    const child = db
      .select({ id: schema.workflows.id, title: schema.workflows.title, graph: schema.workflows.graph })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, refId)))
      .get();
    if (!child) {
      warnings.push(`A sub-workflow (${refId}) no longer exists — that step will not run after import.`);
      continue;
    }
    graphsById.set(child.id, child);
    add({ kind: 'workflow', id: child.id, label: child.title, required: true, ownedByApp: false, reason: 'Called as a sub-workflow', transportable: true });
    queue.push(...referencedIds(child.graph, 'workflow'));
  }

  const allGraphs = [...graphsById.values()];
  /** First human-readable "used by <node> in <workflow>" for a referenced value. */
  const reasonFor = (value: string): string => {
    for (const w of allGraphs) {
      const hit = walkNodeRefs(w.graph).find((ref) => ref.value === value);
      if (hit) return `Used by a ${hit.nodeKind.replace(/_/g, ' ')} step in "${w.title}"`;
    }
    return 'Referenced by this App';
  };

  // ── 2. Agents: seated on the App, PLUS any invoked from a workflow node. ────
  const memberRows = db.select().from(schema.appMembers).where(eq(schema.appMembers.appId, appId)).all();
  const appRow = db.select({ ownerAgentId: schema.apps.ownerAgentId }).from(schema.apps).where(eq(schema.apps.id, appId)).get();
  const seatedIds = new Set<string>(memberRows.map((m) => m.agentId));
  if (appRow?.ownerAgentId) seatedIds.add(appRow.ownerAgentId);
  const referencedAgentIds = new Set([...allGraphs.flatMap((w) => referencedIds(w.graph, 'agent')), ...scriptAgentIds]);
  const agentIds = [...new Set([...seatedIds, ...referencedAgentIds])];

  if (agentIds.length > 0) {
    const rows = db.select().from(schema.agents)
      .where(and(eq(schema.agents.workspaceId, workspaceId), inArray(schema.agents.id, agentIds))).all();
    const found = new Set(rows.map((r) => r.id));
    for (const row of rows) {
      const seated = seatedIds.has(row.id);
      add({
        kind: 'agent',
        id: row.id,
        label: row.name,
        required: referencedAgentIds.has(row.id),
        ownedByApp: seated,
        reason: seated ? 'On this App’s team' : reasonFor(row.id),
        transportable: true,
      });
    }
    for (const missing of agentIds.filter((id) => !found.has(id))) {
      warnings.push(`A step calls an agent (${missing}) that no longer exists — that step will not run after import.`);
    }
  }

  // ── 3. Knowledge: bases scoped to the App, PLUS any a node reads. ───────────
  const scopedKbs = db.select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name })
    .from(schema.knowledgeBases)
    .where(and(eq(schema.knowledgeBases.workspaceId, workspaceId), eq(schema.knowledgeBases.scopeId, appId)))
    .all();
  for (const kb of scopedKbs) {
    add({ kind: 'knowledgeBase', id: kb.id, label: kb.name, required: false, ownedByApp: true, reason: 'This App’s knowledge', transportable: true });
  }
  const referencedKbIds = [...new Set(allGraphs.flatMap((w) => referencedIds(w.graph, 'knowledgeBase')))]
    .filter((id) => !scopedKbs.some((kb) => kb.id === id));
  if (referencedKbIds.length > 0) {
    const rows = db.select({ id: schema.knowledgeBases.id, name: schema.knowledgeBases.name })
      .from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.workspaceId, workspaceId), inArray(schema.knowledgeBases.id, referencedKbIds)))
      .all();
    for (const kb of rows) {
      // Copied rather than re-pointed: a workspace-scoped base may be shared, and
      // the imported App should own its knowledge instead of coupling to another.
      add({ kind: 'knowledgeBase', id: kb.id, label: kb.name, required: true, ownedByApp: false, reason: reasonFor(kb.id), transportable: true });
    }
  }

  // ── 4. Extensions referenced by extension_task / listener sources. ──────────
  const extIds = [...new Set(allGraphs.flatMap((w) => referencedIds(w.graph, 'extension')))];
  if (extIds.length > 0) {
    const rows = db.select().from(schema.extensions)
      .where(and(eq(schema.extensions.workspaceId, workspaceId), inArray(schema.extensions.id, extIds))).all();
    for (const row of rows) {
      // `builtin` extensions ship with every install — declare, never copy.
      const builtin = row.runtime === 'builtin';
      add({
        kind: 'extension',
        id: row.id,
        label: row.name,
        required: true,
        ownedByApp: false,
        reason: builtin ? 'Built in — must exist on the target' : reasonFor(row.id),
        transportable: !builtin,
      });
    }
  }

  // ── 5. Collections the App owns (schemas always; rows only in full). ────────
  for (const col of db.select().from(schema.appCollections).where(eq(schema.appCollections.appId, appId)).all()) {
    add({ kind: 'collection', id: col.name, label: col.name, required: true, ownedByApp: true, reason: 'This App’s data', transportable: true });
  }

  // ── 6. Declared-only: secrets and code-resident connectors never travel. ────
  const credIds = [...new Set(allGraphs.flatMap((w) => referencedIds(w.graph, 'credential')))];
  if (credIds.length > 0) {
    const rows = db.select({ id: schema.credentials.id, name: schema.credentials.name, credentialType: schema.credentials.credentialType })
      .from(schema.credentials)
      .where(and(eq(schema.credentials.workspaceId, workspaceId), inArray(schema.credentials.id, credIds)))
      .all();
    for (const row of rows) {
      add({ kind: 'credential', id: row.id, label: `${row.name} (${row.credentialType})`, required: true, ownedByApp: false, reason: 'Must be reconnected after import', transportable: false });
    }
  }
  for (const conn of db.select().from(schema.channelConnections).where(eq(schema.channelConnections.appId, appId)).all()) {
    add({ kind: 'connection', id: conn.id, label: `${conn.name} (${conn.kind})`, required: false, ownedByApp: true, reason: 'Channel must be reconnected after import', transportable: false });
  }
  for (const slug of new Set(allGraphs.flatMap((w) => walkNodeRefs(w.graph).filter((r) => r.kind === 'connector').map((r) => r.value)))) {
    add({ kind: 'connector', id: slug, label: slug, required: true, ownedByApp: false, reason: 'Connector must be available on the target', transportable: false });
  }

  return {
    items,
    workflowIds: items.filter((i) => i.kind === 'workflow').map((i) => i.id),
    agentIds: items.filter((i) => i.kind === 'agent').map((i) => i.id),
    knowledgeBaseIds: items.filter((i) => i.kind === 'knowledgeBase').map((i) => i.id),
    extensionIds: items.filter((i) => i.kind === 'extension' && i.transportable).map((i) => i.id),
    warnings,
  };
}
