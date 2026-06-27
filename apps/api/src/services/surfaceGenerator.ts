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
  uiPatchOpSchema,
  viewNodeSchema,
  type CollectionInfo,
  type SurfaceAction,
  type UiPatchOp,
  type ViewNode,
} from '@agentis/core';
import { z } from 'zod';
import { buildArchetypeSurface, repairSurface } from '@agentis/core';
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
  const collectionNames = args.collections.map((c) => c.name);
  // Every result passes the deterministic layout floor before it's returned.
  const finalize = (g: GeneratedSurface): GeneratedSurface => ({ ...g, view: repairSurface(g.view, { collections: collectionNames }).view });
  const fallback = scaffold(args.collections);

  if (!args.completer) return finalize({ ...fallback, source: 'fallback' });

  try {
    const raw = await args.completer.completeStructured<Record<string, unknown>>({
      system: SYSTEM_PROMPT,
      user: userPrompt(args.prompt, args.collections, args.surface),
      workspaceId: args.workspaceId,
      maxTokens: 4000,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!raw) return finalize({ ...fallback, source: 'fallback' });
    const parsed = generatedSchema.safeParse(raw);
    if (!parsed.success) return finalize({ ...fallback, source: 'fallback' });
    return finalize({ view: parsed.data.view, actions: parsed.data.actions ?? [], source: 'model' });
  } catch {
    return finalize({ ...fallback, source: 'fallback' });
  }
}

// ── Phase 4 — conversational surface construction (NL → SurfacePatch) ──────

export interface GenerateSurfacePatchArgs {
  /** The operator's plain-language instruction ("show only deals over $20k"). */
  instruction: string;
  /** The surface's current ViewNode tree — the patch is computed against this. */
  current: ViewNode;
  collections: CollectionInfo[];
  /** The workspace's structured-completion source. Omit → no-op (empty ops). */
  completer?: StructuredCompleter;
  workspaceId: string;
  surface?: string;
  signal?: AbortSignal;
}

export interface GeneratedPatch {
  ops: UiPatchOp[];
  source: 'model' | 'none';
}

const generatedPatchSchema = z.object({ ops: z.array(uiPatchOpSchema) });

/**
 * Turn a natural-language instruction + the current surface tree into a minimal
 * `SurfacePatch[]` (the same `set`/`insert`/`remove` op grammar `ui_patch` applies
 * live). The model is shown the exact current tree and the slash-path convention,
 * and must return ONLY the ops needed — so editing a surface feels like talking
 * to a designer who re-renders as you speak. Degrades to an empty op list (a safe
 * no-op) when no model is configured or the output is unusable; the caller keeps
 * the surface untouched. Model-agnostic via the {@link StructuredCompleter} contract.
 */
export async function generateSurfacePatch(args: GenerateSurfacePatchArgs): Promise<GeneratedPatch> {
  if (!args.completer) return { ops: [], source: 'none' };
  try {
    const raw = await args.completer.completeStructured<Record<string, unknown>>({
      system: PATCH_SYSTEM_PROMPT,
      user: patchUserPrompt(args.instruction, args.current, args.collections, args.surface),
      workspaceId: args.workspaceId,
      maxTokens: 2000,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!raw) return { ops: [], source: 'none' };
    const parsed = generatedPatchSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ops.length === 0) return { ops: [], source: 'none' };
    return { ops: parsed.data.ops, source: 'model' };
  } catch {
    return { ops: [], source: 'none' };
  }
}

const PATCH_SYSTEM_PROMPT = `You are a live interface designer for an "Agentic App". The operator speaks an
instruction and you re-arrange their surface by emitting a MINIMAL set of patch ops against the CURRENT tree.
Return ONE strict JSON object: { "ops": <SurfacePatch[]> }. No prose, no markdown.

A SurfacePatch op is one of:
- { "op":"set", "path":"<slash/path>", "value":<any> } — replace the value at a path.
- { "op":"insert", "path":"<slash/path-to-an-array>", "node":<ViewNode>, "index"?:<number> } — splice a node into an array (default: append).
- { "op":"remove", "path":"<slash/path>" } — delete the value/array-element at a path.

PATHS are slash-separated and walk the JSON tree from the root node; numeric segments index arrays.
Example: "children/0/title" is the title of the first child; "children/2" is the third child (for remove/insert into "children").

RULES:
- Emit ONLY the ops needed to satisfy the instruction. Do not rebuild the whole tree. If you'd touch most of it, that's a render, not a patch — still, prefer the fewest surgical ops.
- Preserve everything the instruction doesn't mention. Keep the stable frame.
- Any inserted ViewNode must be valid AG-UI grammar (Stack/Row/Grid/Card/Hero/KPIStrip/Table/Chart/DataBoard/Funnel/Timeline/Form/Button/Text/Heading/Metric/Badge/Callout/AgentRegion/…). Bind Table/Chart/Board only to collections that EXIST (listed below) and to real fields — never invent data.
- To filter/sort a data panel, set its bind, e.g. { "op":"set", "path":"children/1/bind/query", "value":{ "amount": { "gt": 20000 } } } or set bind/sort / bind/limit.
- To reorder, use remove + insert (or set the whole array). To restyle, set the node's "style" object (theme/tone/elevation/pad/accent enums only).
- If the instruction is impossible against this tree, return { "ops": [] }.`;

function patchUserPrompt(instruction: string, current: ViewNode, collections: CollectionInfo[], surface?: string): string {
  const schema = collections.length === 0
    ? 'NONE — do not bind to any collection.'
    : collections
        .map((collection) => `- ${collection.name}: ${collection.schema.fields.map((field) => `${field.key}:${field.type}`).join(', ')}`)
        .join('\n');
  return [
    surface ? `Surface name: ${surface}` : '',
    'Available collections (name: fields):',
    schema,
    '',
    'CURRENT surface tree (patch against this exact JSON):',
    JSON.stringify(current),
    '',
    `Operator instruction: ${instruction}`,
  ].filter(Boolean).join('\n');
}

const SYSTEM_PROMPT = `You are a senior product designer + frontend engineer. You design interfaces for "Agentic Apps"
by emitting a typed UI tree (AG-UI). An Agentic App is operated by an AGENT; the human watches, directs,
and approves. Output a designer-grade surface — never a wall of identical cards.
Return ONE strict JSON object: { "view": <ViewNode>, "actions": <SurfaceAction[]> }. No prose, no markdown.

CRAFT RULES (this is what separates a great surface from a dumb one):
- NEVER emit one tall stack of identical cards. COMPOSE a layout: a Hero or Toolbar header; a Split
  (main content + an operator rail) or a Grid; Tabs/Accordion for progressive disclosure instead of one
  giant scroll.
- Choose a THEME on the ROOT node's style: { "style": { "theme": "console"|"analytics"|"product"|"editorial", "density": "comfortable"|"compact" } }.
  console = dense ops command center; analytics = KPI dashboards; product = consumer-grade; editorial = content-forward.
- Visualize, don't narrate: use Chart (line/area/bar/pie/donut, multi-series via "series"), KPIStrip, Sparkline,
  ProgressBar, Timeline — not paragraphs of Text.
- Shape hierarchy with bounded style intent on any node: "style": { "elevation":"flat"|"raised"|"inset"|"outline",
  "pad":"none"|"sm"|"md"|"lg"|"xl", "tone":"neutral"|"accent"|"success"|"warning"|"danger"|"info",
  "accent":"blue"|"teal"|"purple"|"orange"|..., "size":"sm"|"md"|"lg"|"xl", "span":1-12 }. (No raw CSS — these enums only.)

NEVER (these produce broken UIs and are auto-stripped by the layout auditor — don't waste output on them):
- NEVER use Image nodes as a header, and never put text-baked generated images at the top. Lead with a Hero (it looks great with NO image — a gradient) + a KPIStrip or Chart.
- NEVER nest Cards inside Cards inside Cards. ONE level of boxing. Group with Stack/Grid; use Card only for a genuine panel.
- NEVER cram a Split — ratios stay balanced (1 to 2.5); the rail is ~320px, the main pane is the star.
- NEVER build 4+ data panels for one sparse collection. If the app has little/empty data, build ONE table or board + the operator rail — not a wall of "No records" panels.
- NEVER bind a Table/Chart/Board/List/Inbox to a collection or field that isn't listed below. Don't invent data.

AGENT-NATIVE composites (foreground the operator — usually in a side rail, not the whole page):
- { "type":"AgentConsole" } — the operator's presence + a command line.
- { "type":"ActivityStream", "limit"?:number } — live feed of the agent's work.
- { "type":"DataBoard", "bind":{ "collection":string }, "groupBy":string, "titleField"?:string } — kanban over a status field.
- { "type":"AgentRegion", "region":string, "title"?:string, "placeholder"?:string } — a STABLE, usually-empty slot that the agent PERFORMS into live (it composes a panel here unprompted when it notices something — e.g. "churn risk"). Place ONE near the top of the operator rail (region:"attention") on a resident/console surface so the console can compose itself. Leave it empty in the initial tree.

KEY NODES:
- Layout: Stack | Row | Grid(columns?) | Split(left,right,ratio?) | Tabs(tabs:[{label,children}]) | Accordion(sections:[{title,defaultOpen?,children}]) | Toolbar(title?,children) | Hero(title,subtitle?,eyebrow?,actions?)
- Container: Card(title?,children) | Section(title?,children)
- Content: Heading|Text|Markdown(value) | Metric(label,value,delta?) | KPIStrip(items:[{label,value,delta?,tone?,spark?:number[]}]) | Badge(value,tone?) | Callout(value,title?) | ProgressBar(value,max?,label?) | Sparkline(points?:number[] | bind+y) | Avatar(name?,src?) | Divider | Image(src)
- Data-bound: Table(bind,columns:[{key,label?}],rowActions?) | List(bind,item) | Chart(bind,chartType,x,y,series?:[{y,label?,color?}],area?,stacked?,curve?) | Timeline(bind?,items?,titleField?,detailField?,atField?)
- Domain (use these to fit the app): ChatThread(title?,source?,bind?,roleField?,contentField?,messages?,channel?,send?,placeholder?) and Inbox(source?,bind?,titleField?,channelField?,messagesBind?,matchField?,send?) — conversations. SET source:"conversations" to bind to the App's REAL live channel threads (the resident inbox — a 24/7 sales/support desk; no bind needed, it reads the App's connected channels); use the default source:"collection" with a bind only to show conversation rows stored in a datastore collection; MediaGen(title?,generate?,bind?,srcField?) — image/media generation; Funnel(stages?:[{label,value}] | bind+labelField+valueField) — marketing/sales conversion; Calendar(events?:[{date,label}] | bind+dateField+labelField) — scheduling; Gauge(label?,value,max?,tone?) — a single metric.
- Interactive: Form(fields:[{key,label?,type,required?,options?}],submit:{action},submitLabel?) | Button(label,action:{action,args?},variant?)
- Escape hatch (LAST RESORT, only when the nodes above cannot express it): { "type":"CodeSurface", "code":<plain JS string>, "collections":[<names the code reads>] } — runs in a hardened, zero-egress sandbox with \`ui\` (component+chart kit: ui.card/row/grid/metric/badge/table/heading/text + ui.chart.bar/line/donut) and \`agentis\` (agentis.data.query, agentis.actions.invoke) and \`root\` (mount). Requires the app's custom-code policy. Prefer typed nodes.

Bindable = a literal, or { "$row":"field" } (current row), or { "$state":"key" } (UI state).
SurfaceAction = { "name":string, "kind":"data"|"workflow"|"tool", "target":string }. For datastore ops target is "<collection>.insert" | "<collection>.update" | "<collection>.delete".

Rules:
- Bind Table/List/Chart/DataBoard/Timeline to collections that EXIST (listed in the prompt). Never invent collection or field names.
- A create Form's submit must reference a declared "data" action targeting "<collection>.insert".
- Pick the theme + layout that fit the domain. Lead with a Hero, then a Split/Grid — not a flat stack.`;

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

/**
 * Deterministic, archetype-shaped scaffold — a themed command center, never a
 * tall stack of identical cards. The taste engine (`referenceTemplates`) picks
 * an archetype + theme from the collection shape, so even with no model the
 * surface looks like a designer built it.
 */
function scaffold(collections: CollectionInfo[]): { view: ViewNode; actions: SurfaceAction[] } {
  const { view, actions } = buildArchetypeSurface(collections);
  return { view, actions };
}
