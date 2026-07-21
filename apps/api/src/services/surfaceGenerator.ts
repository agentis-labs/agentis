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
- Any inserted ViewNode must be valid AG-UI grammar (Stack/Row/Grid/Card/Hero/KPIStrip/Table/Chart/Kanban/RecordMaster/Roadmap/PipelineFlow/DataBoard/Funnel/Timeline/Form/Button/Text/Heading/Metric/Badge/Callout/OrchestrationPanel/RunMonitor/AgentFeed/ApprovalsInbox/AgentRegion/…). Bind Table/Chart/Kanban/RecordMaster/Roadmap only to collections that EXIST (listed below) and to real fields — never invent data. OrchestrationPanel/RunMonitor/AgentFeed/ApprovalsInbox need no bind — they read the App's own workflows/runs/approvals live.
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
- TWO TIERS, PICK PER SURFACE: for an operable data app (records, boards, live-ops, editable, data-bound) author the
  typed nodes below — that is the default here. For a bespoke showpiece / pixel-perfect custom dashboard, or anything the
  typed composites would render flat, emit a CodeSurface (see KEY NODES) and write real code with full design control.
- NEVER emit one tall stack of identical cards. COMPOSE a layout: a Hero or Toolbar header; a Split
  (main content + an activity rail) or a Grid; Tabs/Accordion for progressive disclosure instead of one
  giant scroll.
- Choose a THEME on the ROOT node's style: { "style": { "theme": "analytics"|"product"|"editorial"|"operations", "density": "comfortable"|"compact" } }.
  analytics = KPI dashboards; product = consumer-grade; editorial = content-forward; operations = dense command centers.
- Every surface renders on the flagship Agentis design system — premium cards, a real type scale, auto-formatted
  values, designed light AND dark. Optional ROOT knobs: "appearance": "light"|"dark" pins one (default follows the
  platform); "accent" re-brands the accent hue; "design" picks a structural VARIANT when the domain demands it —
  "aurora" (bigger numerals), "soft" (rounder, friendlier), "editorial" (big flat type), "console" (dense grid).
  Default (no "design") is the flagship: set nothing unless you have a reason.
- The App Shell already names the App/page. Do NOT start a surface with a Hero or Heading that repeats the App name;
  if a header is useful, name the job/state ("Outreach queue", "Pipeline review") instead of the product.
- Spacing follows the design-system rhythm. Omit "gap" unless needed; when needed use 8, 12, 16, 20, or 24 only.
  Never create visual distance with oversized gaps, blank cards, or ad hoc spacer rows. Use Grid spans/Split rails.
- Visualize, don't narrate: use Chart (line/area/bar/pie/donut, multi-series via "series"), KPIStrip, Sparkline,
  ProgressBar, Timeline — not paragraphs of Text.
- MISSION-CONTROL-FIRST for an App overview (the App is an operational unit, not a form): lead with the headline
  numbers (a KPIStrip or PipelineFlow), then — when the App owns workflows — an OrchestrationPanel (the operator
  sees every workflow's rules and can run/pause/chain them) with the LIVE rail beside the working area: a Grid of
  { the working composite (span 2) , a Stack of RunMonitor + AgentFeed (span 1) }. The operator should see what the
  agents are DOING right now without scrolling. Put data-entry Forms behind a Tab, never at the top.
- PICK THE WORKING COMPOSITE for the data, not a plain Table by default:
  • Kanban — anything with a status/stage field the operator moves through states (deals, tickets, orders, content,
    hiring). Drag writes the field back: give it "update": { "action": "<declared update action>" }.
  • RecordMaster — people/things with many fields (CRM contacts, customers, inventory, employees, vendors — the
    ERP shape). Master list + full record page + related child collections.
  • Roadmap — anything with dates (plans, releases, campaigns, editorial calendars).
  • PipelineFlow — the stage funnel summary (counts, values, conversion) — pairs above a Kanban.
  • Chart/Table — metrics and logs.
- The runtime wraps every surface in an App Shell (sidebar pages + topbar + ops drawer) — you author PAGE CONTENT,
  never navigation. Root style may set "shell": "full"|"minimal"|"none" to override (default: full when the app has
  multiple pages or workflows). Compose MULTIPLE surfaces for a real product (home = mission control; plus a
  working page per job: board, records, roadmap, inbox) — each surface becomes a page in the shell's sidebar.
- Shape hierarchy with bounded style intent on any node: "style": { "elevation":"flat"|"raised"|"inset"|"outline",
  "pad":"none"|"sm"|"md"|"lg"|"xl", "tone":"neutral"|"accent"|"success"|"warning"|"danger"|"info",
  "accent":"blue"|"teal"|"purple"|"orange"|..., "size":"sm"|"md"|"lg"|"xl", "span":1-12 }. (No raw CSS — these enums only.)
- HIERARCHY COMES FROM ELEVATION AND TYPE, NOT DECORATION. The page is the base layer; "raised" Cards lift off it;
  "inset" wells recess into a Card (perfect for a KPIStrip's metric tiles). Don't box what a Stack + a label can already
  separate. Let the type scale do the work — a bold numeral over a quiet uppercase label reads instantly with no chrome.
- RESTRAINT: at most ONE accent per surface. Color is a signal that belongs to DATA — status pills, +/- deltas, chart
  series, live pulses. Chrome (cards, headers, labels, borders) stays neutral. A surface where everything is colored says
  nothing. When a panel is empty, write a calm one-line invitation ("No leads yet — a run will populate this"), never a
  dark box that reads as broken, and never eight of them.

THE OPERABILITY CONTRACT (hard-gated at persist — RENDERED ≠ OPERABLE):
- EVERY action you declare must be reachable from a control. Workflow actions go on the Hero's "actions"
  (the page-header action bar) or a Button; "<collection>.insert" behind a Form; "<collection>.update" powers
  Kanban drag and the built-in record drawer; "<collection>.delete" as a Table rowAction.
- A Button/Form that references an action you did NOT declare is dead — the gate strips it. Declare AND wire, always.
- Rows drill into a record drawer automatically; the kit formats every value (URLs → links, SCREAMING_SNAKE
  statuses → humanized tone pills, ISO dates → relative time, numbers → locale-grouped). NEVER hand-format values
  or narrate them into Text nodes.
- The gate auto-repairs what you miss (wires orphan workflow actions into the header, adds row deletes, inserts the
  OrchestrationPanel when the app drives workflows) — but a surface that needs repair is a defect. Author it operable.

NEVER (these produce broken UIs and are auto-stripped by the layout auditor — don't waste output on them):
- NEVER use Image nodes as a header, and never put text-baked generated images at the top. Lead with a Hero (it looks great with NO image — a gradient) + a KPIStrip or Chart.
- NEVER nest Cards inside Cards inside Cards. ONE level of boxing. Group with Stack/Grid; use Card only for a genuine panel.
- NEVER cram a Split — ratios stay balanced (1 to 2.5); the rail is ~320px, the main pane is the star.
- NEVER repeat the App name as page content below the App Shell title. One title is enough.
- NEVER use arbitrary or oversized layout gaps. The card rhythm is 8/12/16/20/24px.
- NEVER build 4+ data panels for one sparse collection. If the app has little/empty data, build ONE table or board + the activity rail — not a wall of "No records" panels.
- NEVER bind a Table/Chart/Board/List/Inbox to a collection or field that isn't listed below. Don't invent data.

AGENT-NATIVE composites (foreground the operator — usually in a side rail, not the whole page):
- { "type":"ActivityStream", "limit"?:number } — live feed of the agent's work.
- { "type":"DataBoard", "bind":{ "collection":string }, "groupBy":string, "titleField"?:string } — kanban over a status field.
- { "type":"AgentRegion", "region":string, "title"?:string, "placeholder"?:string } — a STABLE, usually-empty slot that the agent PERFORMS into live (it composes a panel here unprompted when it notices something — e.g. "churn risk"). Place ONE near the top of the activity rail (region:"attention") on a resident interface so the interface can compose itself. Leave it empty in the initial tree.

KEY NODES:
- Layout: Stack | Row | Grid(columns?) | Split(left,right,ratio?) | Tabs(tabs:[{label,children}]) | Accordion(sections:[{title,defaultOpen?,children}]) | Toolbar(title?,children) | Hero(title,subtitle?,eyebrow?,actions?)
- Container: Card(title?,children) | Section(title?,children)
- Content: Heading|Text|Markdown(value) | Metric(label,value,delta?) | KPIStrip(items:[{label,value,delta?,tone?,spark?:number[]}]) | Badge(value,tone?) | Callout(value,title?) | ProgressBar(value,max?,label?) | Sparkline(points?:number[] | bind+y) | Avatar(name?,src?) | Divider | Image(src)
- Data-bound: Table(bind,columns:[{key,label?}],rowActions?) | List(bind,item) | Chart(bind,chartType,x,y,series?:[{y,label?,color?}],area?,stacked?,curve?) | Timeline(bind?,items?,titleField?,detailField?,atField?)
- Working composites (the archetype workhorses — prefer these over a bare Table when the shape fits):
  Kanban(bind,groupBy,columns?:string[],columnLabels?:object,titleField?,subtitleField?,badgeField?,valueField?,orderField?,update?:{action},transitions?:[{from?:string[],to:string[],when?}],cardActions?,contextActions?,emptyLabel?) — drag-across-columns board. update must reference a declared "<collection>.update" action. Set orderField to a numeric field to let the operator drag-REORDER cards within a column (the drop writes a value between neighbours). context/card actions support {action,label?,description?,icon?,tone?,visibleWhen?,disabledWhen?,disabledReason?,confirm?}; predicates are {all?:[{field,op,value?}],any?:[...]}. Use these universal record-state rules instead of app-specific UI logic.
  RecordMaster(bind,titleField?,subtitleField?,statusField?,searchFields?,sections?:[{title?,fields}],related?:[{collection,foreignKey,title?,titleField?}],recordActions?) — CRM/ERP master-detail record workspace.
  Roadmap(bind,labelField,startField,endField?,laneField?,statusField?) — time lanes from date fields.
  PipelineFlow(bind?,stageField?,valueField?,stages?:[{key,label?}]) — staged funnel with counts/values + conversion %.
- Domain (use these to fit the app): ChatThread(title?,source?,bind?,roleField?,contentField?,messages?,channel?,send?,placeholder?) and Inbox(source?,bind?,titleField?,channelField?,messagesBind?,matchField?,send?) — conversations. SET source:"conversations" to bind to the App's REAL live channel threads (the resident inbox — a 24/7 sales/support desk; no bind needed, it reads the App's connected channels); use the default source:"collection" with a bind only to show conversation rows stored in a datastore collection; MediaGen(title?,generate?,bind?,srcField?) — image/media generation; Funnel(stages?:[{label,value}] | bind+labelField+valueField) — marketing/sales conversion; Calendar(events?:[{date,label}] | bind+dateField+labelField) — scheduling; Gauge(label?,value,max?,tone?) — a single metric.
- Interactive: Form(fields:[{key,label?,type,required?,options?}],submit:{action},submitLabel?) | Button(label,action:{action,args?},variant?)
- Live operations (app-scoped, NO bind — they read the App's own workflows/runs/approvals over the realtime bus):
  OrchestrationPanel(title?,controls?) — the App's control plane: every workflow with its rules (schedule cron, runs-after chains, concurrency, enable/pause), live status, a Run button per row + Run-pipeline. Drop ONE on the App's home. It already owns those controls: do not declare a duplicate Run Pipeline surface action unless a separate custom form collects genuinely different required inputs. (WorkflowControl is its legacy alias.)
  RunMonitor(title?,workflowIds?,limit?,controls?) — the App's runs LIVE: status pulse, node progress, elapsed, cancel/pause/resume, expandable per-run activity.
  AgentFeed(title?,limit?) — watch the agent think: live reasoning/tool/node stream from the App's runs.
  ApprovalsInbox(title?,limit?) — pending human gates with one-click approve/reject.
  Compose home as: OrchestrationPanel + Grid[ working composite (span 2) | Stack[RunMonitor, AgentFeed] (span 1) ].
- CodeSurface (first-class, co-equal tier — the PIXEL-PERFECT path, not a fallback): { "type":"CodeSurface", "code":<plain JS string>, "collections":[<names the code reads>] } — choose it when you want full design control or the typed composites would look generic. Renders FULL-BLEED and auto-heights to its content (a whole dashboard page, not a boxed widget), on-brand in light AND dark. Runs in a hardened, zero-egress sandbox with a rich \`ui\` kit (cards, grids, metric tiles with depth, status pills, ui.chart.area/line/bar/donut) and the \`agentis\` bridge (agentis.data.query, agentis.actions.invoke, agentis.state, agentis.navigation, and agentis.realtime.subscribe(event, cb) to FOLLOW live events — e.g. "app.data_changed" to re-query on a datastore write, so a CodeSurface stays live like the typed nodes) and \`root\` (mount). Requires the app's custom-code policy to be enabled. Keep typed AG-UI for operable/editable/data-bound apps; reach for CodeSurface for the bespoke showpiece.

Bindable = a literal, or { "$row":"field" } (current row), or { "$state":"key" } (UI state).
Never put template expressions like "{{count:collection}}" in visible labels, Metric values, KPIs, Text, or Markdown.
If you need live counts, use bound composites (PipelineFlow/Kanban/Table/Chart) or a literal placeholder number until data exists.
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
