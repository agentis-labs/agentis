/**
 * surfaceGenerator — agent-assisted AG-UI surface authoring.
 *
 * Given a natural-language prompt and the App's collection schemas, asks the
 * workspace's structured-completion model to author a typed `ViewNode` tree (the
 * same grammar the renderer + chat `agentis.ui.render` tool use). The output is
 * validated against `viewNodeSchema`; anything unparseable falls back to a
 * deterministic starter scaffold so the builder is never left empty.
 *
 * Model-agnostic by construction: it speaks only the {@link StructuredCompleter}
 * contract (no temperature/response_format negotiation), so any configured model
 * — or none — works.
 */

import {
  surfaceActionSchema,
  viewNodeSchema,
  type CollectionInfo,
  type SurfaceAction,
  type ViewNode,
} from '@agentis/core';
import { z } from 'zod';
import type { StructuredCompleter } from './structuredCompleter.js';

export interface GenerateSurfaceArgs {
  prompt: string;
  collections: CollectionInfo[];
  /** The workspace's structured-completion source. Omit → deterministic scaffold. */
  completer?: StructuredCompleter;
  workspaceId: string;
  surface?: string;
  signal?: AbortSignal;
}

export interface GeneratedSurface {
  view: ViewNode;
  actions: SurfaceAction[];
  source: 'model' | 'fallback';
}

const generatedSchema = z.object({
  view: viewNodeSchema,
  actions: z.array(surfaceActionSchema).optional(),
});

export async function generateSurfaceView(args: GenerateSurfaceArgs): Promise<GeneratedSurface> {
  const fallback = scaffold(args.collections);

  if (!args.completer) return { ...fallback, source: 'fallback' };

  try {
    const raw = await args.completer.completeStructured<Record<string, unknown>>({
      system: SYSTEM_PROMPT,
      user: userPrompt(args.prompt, args.collections, args.surface),
      workspaceId: args.workspaceId,
      maxTokens: 4000,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!raw) return { ...fallback, source: 'fallback' };
    const parsed = generatedSchema.safeParse(raw);
    if (!parsed.success) return { ...fallback, source: 'fallback' };
    return { view: parsed.data.view, actions: parsed.data.actions ?? [], source: 'model' };
  } catch {
    return { ...fallback, source: 'fallback' };
  }
}

const SYSTEM_PROMPT = `You design operator interfaces for "Agentic Apps" by emitting a typed UI tree (AG-UI).
An Agentic App is operated by an AGENT; the human watches, directs, and approves. So a great surface
foregrounds the agent and its work — it is NOT a static dashboard of cards.
Return ONE strict JSON object: { "view": <ViewNode>, "actions": <SurfaceAction[]> }. No prose, no markdown.

AGENT-NATIVE composites (lead with these for an operator surface):
- { "type":"AgentConsole", "title"?:string, "prompt"?:string } — the operator agent's presence + a command line the human uses to direct it.
- { "type":"ActivityStream", "title"?:string, "limit"?:number } — a live feed of the agent's work.
- { "type":"DataBoard", "bind":{ "collection":string }, "groupBy":string, "titleField"?:string } — a kanban over a collection grouped by a status/stage field.

ViewNode types:
- Layout: { "type":"Stack"|"Row"|"Grid", "gap"?:number, "children":ViewNode[] }
- Container: { "type":"Card"|"Section", "title"?:string, "children":ViewNode[] }
- Content: { "type":"Text"|"Heading"|"Markdown", "value":string }
- Metric: { "type":"Metric", "label":string, "value":Bindable, "delta"?:Bindable }
- Image: { "type":"Image", "src":Bindable, "alt"?:string }
- Badge: { "type":"Badge", "value":Bindable, "tone"?:"neutral"|"success"|"warning"|"danger" }
- Divider: { "type":"Divider" }
- Table (data-bound): { "type":"Table", "bind":{ "collection":string, "limit"?:number }, "columns":[{ "key":string, "label"?:string }], "rowActions"?:ActionRef[] }
- List (data-bound): { "type":"List", "bind":{ "collection":string }, "item":ViewNode }
- Chart (data-bound): { "type":"Chart", "bind":{ "collection":string }, "chartType":"line"|"bar"|"pie", "x":string, "y":string }
- Form: { "type":"Form", "fields":[{ "key":string, "label"?:string, "type":"text"|"number"|"textarea"|"select"|"checkbox"|"date", "required"?:boolean, "options"?:[{value,label}] }], "submit":{ "action":string }, "submitLabel"?:string }
- Button: { "type":"Button", "label":string, "action":{ "action":string, "args"?:object }, "variant"?:"primary"|"secondary"|"danger" }

Bindable = a literal, or { "$row":"field" } (current row), or { "$state":"key" } (UI state).
ActionRef = { "action":string, "args"?:object } and must reference an entry in "actions".
SurfaceAction = { "name":string, "kind":"data"|"workflow"|"tool", "target":string }. For datastore ops, target is "collection.insert" | "collection.update" | "collection.delete".

Rules:
- Bind tables/lists/charts to collections that EXIST (listed in the prompt). Never invent collection or field names.
- A create Form's submit must reference a declared "data" action targeting "<collection>.insert".
- Root node should be a Stack. Prefer a Heading, then sections. Keep it focused and clean.`;

function userPrompt(prompt: string, collections: CollectionInfo[], surface?: string): string {
  const schema = collections.length === 0
    ? 'NONE yet — do not bind to any collection; use static content (Heading/Text/Metric) and explain that data can be added later.'
    : collections
        .map((collection) => `- ${collection.name}: ${collection.schema.fields.map((field) => `${field.key}:${field.type}`).join(', ')}`)
        .join('\n');
  return [
    surface ? `Surface name: ${surface}` : '',
    'Available collections (name: fields):',
    schema,
    '',
    `Build this surface: ${prompt}`,
  ].filter(Boolean).join('\n');
}

// ── Deterministic fallback ──────────────────────────────────────

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function scaffold(collections: CollectionInfo[]): { view: ViewNode; actions: SurfaceAction[] } {
  const collection = collections[0];
  // Always lead with the operator presence + its live activity — the agentic core.
  const children: ViewNode[] = [
    { type: 'AgentConsole' },
    { type: 'ActivityStream', title: 'Live activity' },
  ];

  if (!collection) {
    children.push({ type: 'Text', value: 'Define a collection in the Data tab and the operator will manage its records right here.' });
    return { view: { type: 'Stack', gap: 16, children }, actions: [] };
  }

  const fields = collection.schema.fields.filter((field) => field.key !== 'id');
  const columns = (fields.length > 0 ? fields : collection.schema.fields)
    .slice(0, 5)
    .map((field) => ({ key: field.key, label: humanize(field.key) }));
  const formFields = (fields.length > 0 ? fields : [{ key: 'name', type: 'string' as const, required: false, indexed: false }])
    .map((field) => ({
      key: field.key,
      label: humanize(field.key),
      type: field.type === 'number' ? 'number' as const
        : field.type === 'boolean' ? 'checkbox' as const
        : field.type === 'date' ? 'date' as const
        : field.type === 'json' ? 'textarea' as const
        : 'text' as const,
      ...(field.required ? { required: true } : {}),
    }));
  const createAction = `create_${collection.name}`;
  const statusField = fields.find((field) => ['status', 'stage', 'state'].includes(field.key))?.key;
  const titleField = fields.find((field) => field.type === 'string')?.key;

  // If the collection has a status field, a board is far more "app" than a table.
  const dataView: ViewNode = statusField
    ? { type: 'DataBoard', bind: { collection: collection.name, live: true, limit: 100 }, groupBy: statusField, ...(titleField ? { titleField } : {}) }
    : { type: 'Card', title: collection.name, children: [{ type: 'Table', bind: { collection: collection.name, live: true, limit: 25 }, columns }] };

  children.push(
    { type: 'Card', title: `Add to ${collection.name}`, children: [{ type: 'Form', fields: formFields, submit: { action: createAction }, submitLabel: 'Add' }] },
    dataView,
  );

  return { view: { type: 'Stack', gap: 16, children }, actions: [{ name: createAction, kind: 'data', target: `${collection.name}.insert` }] };
}
