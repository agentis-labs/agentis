/**
 * AG-UI â€” the agent-authored UI protocol (AGENTIC-APPS-10X-MASTERPLAN Â§4,
 * extended by GENUI-RENAISSANCE-MASTERPLAN).
 *
 * An agent authors a typed `ViewNode` tree (the "cards" tier) instead of pushing
 * data into fixed blocks. Nodes can bind to App Datastore queries (`bind`),
 * declare user actions (`action`) that resolve to a workflow/tool/data op, and
 * carry **bounded style intent** (`style`) that the renderer maps to the Agentis
 * Design System â€” never raw CSS. Agents emit *intent*, not pixels.
 *
 * Shared by the backend (persistence + validation) and the web renderer. Kept
 * dependency-light: zod schemas validate agent output; the TS types drive the
 * renderer. Every field added here is OPTIONAL â€” old trees stay byte-valid.
 */

import { z } from 'zod';

// â”€â”€ Bindings & actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A literal value or a renderer-bound path (`$bind`/`$row` row data, `$state` local UI state). */
export const bindableSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ $bind: z.string().min(1) }),
  z.object({ $row: z.string().min(1) }),
  z.object({ $state: z.string().min(1) }),
]);
export type Bindable = string | number | boolean | null | { $bind: string } | { $row: string } | { $state: string };

export const dataBindSchema = z.object({
  collection: z.string().min(1),
  /** Filter passed to data_query (same shape as DataQuery.filter). */
  query: z.record(z.unknown()).optional(),
  sort: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).default('asc') })).optional(),
  limit: z.number().int().positive().max(500).optional(),
  /** When true the view re-fetches on DATA_CHANGED for this collection. Default true. */
  live: z.boolean().default(true),
});
export type DataBind = z.infer<typeof dataBindSchema>;

export const actionRefSchema = z.object({
  action: z.string().min(1),
  args: z.record(bindableSchema).optional(),
});
export type ActionRef = z.infer<typeof actionRefSchema>;

// â”€â”€ Style intent (bounded â†’ Design System, never raw CSS) â”€â”€â”€

/** Semantic tone â€” maps to the accent/success/warn/danger/info token families. */
export const toneSchema = z.enum(['neutral', 'accent', 'success', 'warning', 'danger', 'info']);
export type Tone = z.infer<typeof toneSchema>;

/** Named accent palette an agent may pick from (token-backed, no arbitrary hex). */
export const accentSchema = z.enum([
  'accent', 'info', 'success', 'warning', 'danger',
  'orange', 'blue', 'purple', 'teal', 'rose', 'lime',
]);
export type AccentName = z.infer<typeof accentSchema>;

/** Per-surface look preset (read from the ROOT node's style). */
export const surfaceThemeSchema = z.enum(['operations', 'analytics', 'product', 'editorial']);
export type SurfaceTheme = z.infer<typeof surfaceThemeSchema>;

/**
 * Per-surface DESIGN LANGUAGE (root-only) â€” a named bundle of visual decisions
 * (radii, shadow/elevation, card treatment, gradient policy, type scale, palette)
 * that the renderer lowers to scoped CSS variables. Where `theme` sets density +
 * default accent + width, `design` sets the *look*: the same ViewNode tree renders
 * in genuinely different, all-premium styles. Absent â†’ `operations` (elevated).
 * Agents pick an id from this enum â€” never raw CSS (same contract as StyleIntent).
 */
export const designLanguageSchema = z.enum(['agentis', 'operations', 'aurora', 'soft', 'editorial', 'console']);
export type DesignLanguage = z.infer<typeof designLanguageSchema>;

/**
 * Optional, enum-bounded visual intent attachable to any node. The renderer
 * lowers these to existing token classes â€” agents never write CSS. `theme` and
 * `density` are read only from the surface's root node.
 */
export const styleIntentSchema = z.object({
  tone: toneSchema.optional(),
  emphasis: z.enum(['muted', 'normal', 'strong']).optional(),
  elevation: z.enum(['flat', 'raised', 'inset', 'outline']).optional(),
  pad: z.enum(['none', 'sm', 'md', 'lg', 'xl']).optional(),
  align: z.enum(['start', 'center', 'end', 'between']).optional(),
  /** Grid column span (1â€“12). */
  span: z.number().int().positive().max(12).optional(),
  size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
  accent: accentSchema.optional(),
  sticky: z.boolean().optional(),
  scroll: z.boolean().optional(),
  /** Root-only: the surface look preset. */
  theme: surfaceThemeSchema.optional(),
  /** Root-only: the surface design language (look bundle â†’ scoped CSS vars). */
  design: designLanguageSchema.optional(),
  /**
   * Root-only: pin the surface appearance. `auto` (default) follows the platform
   * theme; `light`/`dark` lock the app's own appearance regardless of the chrome.
   */
  appearance: z.enum(['auto', 'light', 'dark']).optional(),
  /** Root-only: information density. */
  density: z.enum(['comfortable', 'compact']).optional(),
  /**
   * Root-only: the App Shell mode. `full` = product chrome (sidebar pages, topbar
   * with live status, ops drawer); `minimal` = topbar only; `none` = bare content
   * (embeds/public shares). Absent â†’ the runtime decides (full when the app has
   * multiple surfaces or bound workflows). The shell is RUNTIME chrome â€” agents
   * author page content, never navigation.
   */
  shell: z.enum(['full', 'minimal', 'none']).optional(),
});
export type StyleIntent = z.infer<typeof styleIntentSchema>;

// â”€â”€ Field / column descriptors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const columnSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  /** Render hint. */
  format: z.enum(['text', 'number', 'date', 'badge', 'boolean']).optional(),
});

export const fieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  type: z.enum(['text', 'number', 'textarea', 'select', 'checkbox', 'date']).default('text'),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
});

// â”€â”€ ViewNode (recursive) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** A simple timeline / status item used by the new composite nodes. */
interface TimelineItem { title: string; detail?: string; at?: string; tone?: Tone }
interface KpiItem { label: string; value: Bindable; delta?: Bindable; tone?: Tone; spark?: number[] }

type ViewNodeBase =
  // â”€â”€ layout â”€â”€
  | { type: 'Stack'; gap?: number; children: ViewNode[] }
  | { type: 'Row' | 'Grid'; gap?: number; widths?: number[]; columns?: number; children: ViewNode[] }
  | { type: 'Card' | 'Section'; title?: string; children: ViewNode[] }
  // master/detail or sidebar shell
  | { type: 'Split'; left: ViewNode; right: ViewNode; ratio?: number }
  // progressive disclosure â€” the "toggles" instead of one giant scroll
  | { type: 'Tabs'; tabs: Array<{ label: string; children: ViewNode[] }> }
  | { type: 'Accordion'; sections: Array<{ title: string; defaultOpen?: boolean; children: ViewNode[] }> }
  // a horizontal control/header bar
  | { type: 'Toolbar'; title?: string; children: ViewNode[] }
  // a prominent header band
  | { type: 'Hero'; title: string; subtitle?: string; eyebrow?: string; media?: Bindable; actions?: ActionRef[] }
  // â”€â”€ content â”€â”€
  | { type: 'Text' | 'Heading' | 'Markdown'; value: string }
  | { type: 'Metric'; label: string; value: Bindable; delta?: Bindable }
  // a row of polished KPI cards (optionally with sparklines)
  | { type: 'KPIStrip'; items: KpiItem[] }
  | { type: 'Image'; src: Bindable; alt?: string }
  | { type: 'Avatar'; name?: Bindable; src?: Bindable; size?: 'sm' | 'md' | 'lg' }
  | { type: 'Callout'; title?: string; value: string }
  | { type: 'ProgressBar'; value: Bindable; max?: number; label?: string }
  // tiny inline trend â€” static points or bound to a collection
  | { type: 'Sparkline'; points?: number[]; bind?: DataBind; y?: string }
  // â”€â”€ data-bound â”€â”€
  | { type: 'Table'; bind: DataBind; columns: z.infer<typeof columnSchema>[]; rowActions?: ActionRef[] }
  | { type: 'List'; bind: DataBind; item: ViewNode }
  | {
      type: 'Chart';
      bind: DataBind;
      chartType: 'line' | 'bar' | 'pie' | 'area' | 'donut';
      x: string;
      y: string;
      series?: Array<{ y: string; label?: string; color?: AccentName }>;
      stacked?: boolean;
      area?: boolean;
      height?: number;
      legend?: boolean;
      curve?: 'linear' | 'smooth';
    }
  // â”€â”€ interactive â”€â”€
  | { type: 'Form'; fields: z.infer<typeof fieldSchema>[]; submit: ActionRef; submitLabel?: string }
  | { type: 'Button'; label: string; action: ActionRef; variant?: 'primary' | 'secondary' | 'danger' }
  | { type: 'Badge'; value: Bindable; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  | { type: 'Divider' }
  // â”€â”€ Agent-native composites â€” what makes a surface an *Agentic* App â”€â”€
  | { type: 'ActivityStream'; title?: string; limit?: number }
  | { type: 'DataBoard'; bind: DataBind; groupBy: string; titleField?: string }
  // chronological events â€” static items or bound to a collection
  | { type: 'Timeline'; title?: string; items?: TimelineItem[]; bind?: DataBind; titleField?: string; detailField?: string; atField?: string }
  | { type: 'DocumentViewer'; title?: string; content: string; format?: 'markdown' | 'plain' | 'json'; downloadName?: string }
  | { type: 'MapView'; title?: string; region?: string; pins?: Array<{ label: string; lat?: number; lng?: number; value?: Bindable }> }
  | { type: 'StatusBoard'; title?: string; items: Array<{ label: string; status: Bindable; detail?: Bindable }> }
  | { type: 'WebEmbed'; title?: string; url: string; height?: number }
  | { type: 'Narrative'; title?: string; value: string; tone?: 'brief' | 'detailed' | 'executive' }
  | { type: 'ConversationThread'; title?: string; messages?: Array<{ role: 'user' | 'assistant' | 'agent' | 'system'; content: string }> }
  | { type: 'CodeViewer'; title?: string; code: string; language?: string; diff?: boolean }
  | { type: 'MediaGallery'; title?: string; items: Array<{ src: Bindable; alt?: string; caption?: string; kind?: 'image' | 'file' | 'video' }> }
  
  | { type: 'AgentRegion'; region: string; title?: string; reason?: string; pinned?: boolean; placeholder?: string; child?: ViewNode }
  // â”€â”€ Domain composites â€” the breadth of agentic apps â”€â”€
  // Interactive conversation (sales outbound, support, CRM). Bound or static; the composer fires `send`.
  | { type: 'ChatThread'; title?: string; source?: 'collection' | 'conversations'; bind?: DataBind; roleField?: string; contentField?: string; atField?: string; messages?: Array<{ role: 'user' | 'agent' | 'system'; content: string; at?: string }>; channel?: string; send?: ActionRef; placeholder?: string }
  // Multi-conversation inbox with channels â€” selecting a conversation shows its thread.
  | { type: 'Inbox'; source?: 'collection' | 'conversations'; bind?: DataBind; titleField?: string; subtitleField?: string; channelField?: string; messagesBind?: DataBind; messageRoleField?: string; messageContentField?: string; matchField?: string; send?: ActionRef }
  // Media / image generation â€” a prompt that fires `generate`, over a gallery of results.
  | { type: 'MediaGen'; title?: string; bind?: DataBind; srcField?: string; captionField?: string; generate?: ActionRef; placeholder?: string }
  // Conversion funnel (marketing / sales).
  | { type: 'Funnel'; title?: string; stages?: Array<{ label: string; value: number }>; bind?: DataBind; labelField?: string; valueField?: string }
  // Calendar / schedule of events.
  | { type: 'Calendar'; title?: string; bind?: DataBind; dateField?: string; labelField?: string; events?: Array<{ date: string; label: string; tone?: Tone }> }
  // Radial gauge for a single metric.
  | { type: 'Gauge'; label?: string; value: Bindable; max?: number; tone?: Tone }
  // Workflow control plane (Agentic-Apps) â€” the App's OWN workflows with purpose,
  // order, trigger kind, last run, and a run/pause control per row. App-scoped: it
  // reads the current App from the runtime (no bind), so an agent just drops it in.
  | { type: 'WorkflowControl'; title?: string }
  // â”€â”€ Live operations plane (APP-INTERFACE-10X Â§2.2/Â§2.3) â€” app-scoped, no bind â”€â”€
  // Mission control for the App's workflows: live status, rules (order / schedule /
  // depends-on chains / concurrency), enable-pause, run + run-all. Supersedes
  // WorkflowControl (which stays as a thin alias).
  | { type: 'OrchestrationPanel'; title?: string; controls?: boolean }
  // The App's runs, live: status pulse, node progress, elapsed, cancel/pause/resume,
  // expandable per-run activity. `workflowIds` narrows; absent = all app workflows.
  | { type: 'RunMonitor'; title?: string; workflowIds?: string[]; limit?: number; controls?: boolean }
  // "Watch the agent think" â€” live reasoning/tool/node stream from the app's runs.
  | { type: 'AgentFeed'; title?: string; limit?: number }
  // Pending human-gate approvals for this App's workflows, approve/deny inline.
  | { type: 'ApprovalsInbox'; title?: string; limit?: number }
  // â”€â”€ Interactive archetype composites (APP-INTERFACE-10X Â§2.4) â”€â”€
  // A real kanban over a collection: drag a card across columns to write
  // `groupBy` back through the declared `update` data action (target "col.update").
  | { type: 'Kanban'; bind: DataBind; groupBy: string; columns?: string[]; titleField?: string; subtitleField?: string; badgeField?: string; valueField?: string; update?: ActionRef; cardActions?: ActionRef[] }
  // CRM/ERP master-detail: searchable record list + full record page with field
  // sections, related child collections, and per-record actions.
  | { type: 'RecordMaster'; bind: DataBind; titleField?: string; subtitleField?: string; statusField?: string; searchFields?: string[]; sections?: Array<{ title?: string; fields: string[] }>; related?: Array<{ collection: string; foreignKey: string; title?: string; titleField?: string }>; recordActions?: ActionRef[] }
  // Time lanes (roadmap / release plan / campaign calendar) from date fields.
  | { type: 'Roadmap'; title?: string; bind: DataBind; labelField: string; startField: string; endField?: string; laneField?: string; statusField?: string; scale?: 'weeks' | 'months' | 'quarters' }
  // Staged pipeline with counts/values + stage-to-stage conversion.
  | { type: 'PipelineFlow'; title?: string; bind?: DataBind; stageField?: string; valueField?: string; stages?: Array<{ key: string; label?: string; description?: string }> }
  /**
   * Escape hatch (Â§4.5/Â§4.6) â€” agent-written HTML/JS rendered in a hardened,
   * null-origin sandboxed iframe. NO network egress (CSP connect-src 'none');
   * data + actions flow only through the postMessage bridge, which the parent
   * authz-checks against app policy server-side. `html` is the agent's markup.
   */
  | { type: 'CustomView'; html: string; collections?: string[]; height?: number }
  /**
   * Code surface (GENUI-RENAISSANCE Pillar 4) â€” the full-power tier. The agent
   * writes plain JS (`code`) that runs in the SAME hardened, null-origin,
   * zero-egress sandbox as CustomView, but with the Agentis design tokens + a
   * component/chart kit (`ui`) and the data/action bridge (`agentis`) injected.
   * So the agent can build *anything* the typed grammar can't express â€” on-brand,
   * live, and safe. `collections` is the read allowlist (same as CustomView).
   */
  | { type: 'CodeSurface'; code: string; collections?: string[]; height?: number };

/** Any node, plus optional bounded visual intent. */
export type ViewNode = ViewNodeBase & { style?: StyleIntent };

// Spread into every object so `style` is accepted on any node without
// changing the discriminated-union shape the renderer switches on.
const styled = { style: styleIntentSchema.optional() } as const;

// IMPORTANT: a DISCRIMINATED union on `type`, not a plain `z.union`. A plain union
// validates a malformed node against EVERY member and aggregates `unionErrors`
// recursively â€” for a recursive tree that is O(members^depth), so one bad deep
// view tree produces a multi-hundred-MB ZodError and OOM-kills the process
// (observed: a 408-level-nested error blob â†’ "JavaScript heap out of memory").
// A discriminated union reads `type` and validates ONLY that branch â†’ linear, and
// an unknown/missing `type` yields a single bounded discriminator error.
export const viewNodeSchema: z.ZodType<ViewNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('Stack'), gap: z.number().optional(), children: z.array(viewNodeSchema), ...styled }),
    z.object({ type: z.enum(['Row', 'Grid']), gap: z.number().optional(), widths: z.array(z.number().positive()).optional(), columns: z.number().int().positive().max(12).optional(), children: z.array(viewNodeSchema), ...styled }),
    z.object({ type: z.enum(['Card', 'Section']), title: z.string().optional(), children: z.array(viewNodeSchema), ...styled }),
    z.object({ type: z.literal('Split'), left: viewNodeSchema, right: viewNodeSchema, ratio: z.number().positive().optional(), ...styled }),
    z.object({ type: z.literal('Tabs'), tabs: z.array(z.object({ label: z.string(), children: z.array(viewNodeSchema) })).min(1), ...styled }),
    z.object({ type: z.literal('Accordion'), sections: z.array(z.object({ title: z.string(), defaultOpen: z.boolean().optional(), children: z.array(viewNodeSchema) })).min(1), ...styled }),
    z.object({ type: z.literal('Toolbar'), title: z.string().optional(), children: z.array(viewNodeSchema), ...styled }),
    z.object({ type: z.literal('Hero'), title: z.string(), subtitle: z.string().optional(), eyebrow: z.string().optional(), media: bindableSchema.optional(), actions: z.array(actionRefSchema).optional(), ...styled }),
    z.object({ type: z.enum(['Text', 'Heading', 'Markdown']), value: z.string(), ...styled }),
    z.object({ type: z.literal('Metric'), label: z.string(), value: bindableSchema, delta: bindableSchema.optional(), ...styled }),
    z.object({ type: z.literal('KPIStrip'), items: z.array(z.object({ label: z.string(), value: bindableSchema, delta: bindableSchema.optional(), tone: toneSchema.optional(), spark: z.array(z.number()).optional() })).min(1), ...styled }),
    z.object({ type: z.literal('Image'), src: bindableSchema, alt: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Avatar'), name: bindableSchema.optional(), src: bindableSchema.optional(), size: z.enum(['sm', 'md', 'lg']).optional(), ...styled }),
    z.object({ type: z.literal('Callout'), title: z.string().optional(), value: z.string(), ...styled }),
    z.object({ type: z.literal('ProgressBar'), value: bindableSchema, max: z.number().positive().optional(), label: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Sparkline'), points: z.array(z.number()).optional(), bind: dataBindSchema.optional(), y: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Table'), bind: dataBindSchema, columns: z.array(columnSchema), rowActions: z.array(actionRefSchema).optional(), ...styled }),
    z.object({ type: z.literal('List'), bind: dataBindSchema, item: viewNodeSchema, ...styled }),
    z.object({
      type: z.literal('Chart'),
      bind: dataBindSchema,
      chartType: z.enum(['line', 'bar', 'pie', 'area', 'donut']),
      x: z.string(),
      y: z.string(),
      series: z.array(z.object({ y: z.string(), label: z.string().optional(), color: accentSchema.optional() })).optional(),
      stacked: z.boolean().optional(),
      area: z.boolean().optional(),
      height: z.number().int().positive().max(2000).optional(),
      legend: z.boolean().optional(),
      curve: z.enum(['linear', 'smooth']).optional(),
      ...styled,
    }),
    z.object({ type: z.literal('Form'), fields: z.array(fieldSchema), submit: actionRefSchema, submitLabel: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Button'), label: z.string(), action: actionRefSchema, variant: z.enum(['primary', 'secondary', 'danger']).optional(), ...styled }),
    z.object({ type: z.literal('Badge'), value: bindableSchema, tone: z.enum(['neutral', 'success', 'warning', 'danger']).optional(), ...styled }),
    z.object({ type: z.literal('Divider'), ...styled }),
    z.object({ type: z.literal('ActivityStream'), title: z.string().optional(), limit: z.number().int().positive().max(100).optional(), ...styled }),
    z.object({ type: z.literal('DataBoard'), bind: dataBindSchema, groupBy: z.string().min(1), titleField: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Timeline'), title: z.string().optional(), items: z.array(z.object({ title: z.string(), detail: z.string().optional(), at: z.string().optional(), tone: toneSchema.optional() })).optional(), bind: dataBindSchema.optional(), titleField: z.string().optional(), detailField: z.string().optional(), atField: z.string().optional(), ...styled }),
    z.object({ type: z.literal('DocumentViewer'), title: z.string().optional(), content: z.string(), format: z.enum(['markdown', 'plain', 'json']).optional(), downloadName: z.string().optional(), ...styled }),
    z.object({ type: z.literal('MapView'), title: z.string().optional(), region: z.string().optional(), pins: z.array(z.object({ label: z.string(), lat: z.number().optional(), lng: z.number().optional(), value: bindableSchema.optional() })).optional(), ...styled }),
    z.object({ type: z.literal('StatusBoard'), title: z.string().optional(), items: z.array(z.object({ label: z.string(), status: bindableSchema, detail: bindableSchema.optional() })), ...styled }),
    z.object({ type: z.literal('WebEmbed'), title: z.string().optional(), url: z.string().url().refine((url) => url.startsWith('https://'), 'Web embeds require an HTTPS URL'), height: z.number().int().positive().max(2000).optional(), ...styled }),
    z.object({ type: z.literal('Narrative'), title: z.string().optional(), value: z.string(), tone: z.enum(['brief', 'detailed', 'executive']).optional(), ...styled }),
    z.object({ type: z.literal('ConversationThread'), title: z.string().optional(), messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'agent', 'system']), content: z.string() })).optional(), ...styled }),
    z.object({ type: z.literal('CodeViewer'), title: z.string().optional(), code: z.string(), language: z.string().optional(), diff: z.boolean().optional(), ...styled }),
    z.object({ type: z.literal('MediaGallery'), title: z.string().optional(), items: z.array(z.object({ src: bindableSchema, alt: z.string().optional(), caption: z.string().optional(), kind: z.enum(['image', 'file', 'video']).optional() })), ...styled }),
    z.object({ type: z.literal('AgentRegion'), region: z.string().min(1), title: z.string().optional(), reason: z.string().optional(), pinned: z.boolean().optional(), placeholder: z.string().optional(), child: viewNodeSchema.optional(), ...styled }),
    z.object({ type: z.literal('ChatThread'), title: z.string().optional(), source: z.enum(['collection', 'conversations']).optional(), bind: dataBindSchema.optional(), roleField: z.string().optional(), contentField: z.string().optional(), atField: z.string().optional(), messages: z.array(z.object({ role: z.enum(['user', 'agent', 'system']), content: z.string(), at: z.string().optional() })).optional(), channel: z.string().optional(), send: actionRefSchema.optional(), placeholder: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Inbox'), source: z.enum(['collection', 'conversations']).optional(), bind: dataBindSchema.optional(), titleField: z.string().optional(), subtitleField: z.string().optional(), channelField: z.string().optional(), messagesBind: dataBindSchema.optional(), messageRoleField: z.string().optional(), messageContentField: z.string().optional(), matchField: z.string().optional(), send: actionRefSchema.optional(), ...styled }),
    z.object({ type: z.literal('MediaGen'), title: z.string().optional(), bind: dataBindSchema.optional(), srcField: z.string().optional(), captionField: z.string().optional(), generate: actionRefSchema.optional(), placeholder: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Funnel'), title: z.string().optional(), stages: z.array(z.object({ label: z.string(), value: z.number() })).optional(), bind: dataBindSchema.optional(), labelField: z.string().optional(), valueField: z.string().optional(), ...styled }),
    z.object({ type: z.literal('Calendar'), title: z.string().optional(), bind: dataBindSchema.optional(), dateField: z.string().optional(), labelField: z.string().optional(), events: z.array(z.object({ date: z.string(), label: z.string(), tone: toneSchema.optional() })).optional(), ...styled }),
    z.object({ type: z.literal('Gauge'), label: z.string().optional(), value: bindableSchema, max: z.number().positive().optional(), tone: toneSchema.optional(), ...styled }),
    z.object({ type: z.literal('WorkflowControl'), title: z.string().optional(), ...styled }),
    z.object({ type: z.literal('OrchestrationPanel'), title: z.string().optional(), controls: z.boolean().optional(), ...styled }),
    z.object({ type: z.literal('RunMonitor'), title: z.string().optional(), workflowIds: z.array(z.string()).optional(), limit: z.number().int().positive().max(50).optional(), controls: z.boolean().optional(), ...styled }),
    z.object({ type: z.literal('AgentFeed'), title: z.string().optional(), limit: z.number().int().positive().max(200).optional(), ...styled }),
    z.object({ type: z.literal('ApprovalsInbox'), title: z.string().optional(), limit: z.number().int().positive().max(50).optional(), ...styled }),
    z.object({
      type: z.literal('Kanban'),
      bind: dataBindSchema,
      groupBy: z.string().min(1),
      columns: z.array(z.string()).optional(),
      titleField: z.string().optional(),
      subtitleField: z.string().optional(),
      badgeField: z.string().optional(),
      valueField: z.string().optional(),
      update: actionRefSchema.optional(),
      cardActions: z.array(actionRefSchema).optional(),
      ...styled,
    }),
    z.object({
      type: z.literal('RecordMaster'),
      bind: dataBindSchema,
      titleField: z.string().optional(),
      subtitleField: z.string().optional(),
      statusField: z.string().optional(),
      searchFields: z.array(z.string()).optional(),
      sections: z.array(z.object({ title: z.string().optional(), fields: z.array(z.string()).min(1) })).optional(),
      related: z.array(z.object({ collection: z.string().min(1), foreignKey: z.string().min(1), title: z.string().optional(), titleField: z.string().optional() })).optional(),
      recordActions: z.array(actionRefSchema).optional(),
      ...styled,
    }),
    z.object({
      type: z.literal('Roadmap'),
      title: z.string().optional(),
      bind: dataBindSchema,
      labelField: z.string().min(1),
      startField: z.string().min(1),
      endField: z.string().optional(),
      laneField: z.string().optional(),
      statusField: z.string().optional(),
      scale: z.enum(['weeks', 'months', 'quarters']).optional(),
      ...styled,
    }),
    z.object({
      type: z.literal('PipelineFlow'),
      title: z.string().optional(),
      bind: dataBindSchema.optional(),
      stageField: z.string().optional(),
      valueField: z.string().optional(),
      stages: z.array(z.object({ key: z.string().min(1), label: z.string().optional(), description: z.string().optional() })).optional(),
      ...styled,
    }),
    z.object({ type: z.literal('CustomView'), html: z.string().max(200_000), collections: z.array(z.string()).optional(), height: z.number().int().positive().max(2000).optional(), ...styled }),
    z.object({ type: z.literal('CodeSurface'), code: z.string().max(200_000), collections: z.array(z.string()).optional(), height: z.number().int().positive().max(2000).optional(), ...styled }),
  ]) as z.ZodType<ViewNode>,
);

/**
 * Every datastore collection a surface's view tree legitimately reads, gathered
 * from data-bound nodes (`Table`/`List`/`Chart`/`DataBoard`/`Timeline`/`Sparkline`
 * `bind.collection`) and `CustomView` `collections`. This is the authorization
 * allowlist for reading a surface's data: a public/shared surface must only
 * expose the collections it actually displays â€” never sibling collections it
 * never binds.
 */
export function collectionsInView(view: ViewNode | null | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (n: ViewNode | null | undefined): void => {
    if (!n) return;
    switch (n.type) {
      case 'Table':
      case 'Chart':
      case 'DataBoard':
        out.add(n.bind.collection);
        return;
      case 'List':
        out.add(n.bind.collection);
        walk(n.item);
        return;
      case 'Timeline':
      case 'Sparkline':
      case 'ChatThread':
      case 'MediaGen':
      case 'Funnel':
      case 'Calendar':
      case 'PipelineFlow':
        if (n.bind) out.add(n.bind.collection);
        return;
      case 'Kanban':
      case 'Roadmap':
        out.add(n.bind.collection);
        return;
      case 'RecordMaster':
        out.add(n.bind.collection);
        for (const rel of n.related ?? []) out.add(rel.collection);
        return;
      case 'Inbox':
        if (n.bind) out.add(n.bind.collection);
        if (n.messagesBind) out.add(n.messagesBind.collection);
        return;
      case 'CustomView':
      case 'CodeSurface':
        for (const c of n.collections ?? []) out.add(c);
        return;
      case 'Stack':
      case 'Row':
      case 'Grid':
      case 'Card':
      case 'Section':
      case 'Toolbar':
        for (const child of n.children) walk(child);
        return;
      case 'Split':
        walk(n.left);
        walk(n.right);
        return;
      case 'AgentRegion':
        walk(n.child);
        return;
      case 'Tabs':
        for (const tab of n.tabs) for (const child of tab.children) walk(child);
        return;
      case 'Accordion':
        for (const section of n.sections) for (const child of section.children) walk(child);
        return;
      default:
        return;
    }
  };
  walk(view);
  return out;
}

// â”€â”€ Actions declared by a surface (ui_action_schema) â”€â”€â”€â”€â”€â”€â”€â”€

export const surfaceActionSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['workflow', 'tool', 'data', 'capability', 'navigate', 'setState']),
  /** workflow id / tool name / capability id / "collection.op" / surface name / state key. */
  target: z.string().min(1),
  inputSchema: z.record(z.unknown()).optional(),
});
export type SurfaceAction = z.infer<typeof surfaceActionSchema>;

// â”€â”€ Surface (persisted) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const surfaceKindSchema = z.enum(['page', 'dashboard', 'thread', 'embed', 'public']);
export type SurfaceKind = z.infer<typeof surfaceKindSchema>;

export interface AppSurface {
  id: string;
  appId: string;
  name: string;
  kind: SurfaceKind;
  view: ViewNode | null;
  actions: SurfaceAction[];
  shareable: boolean;
  revision: number;
  updatedAt: string;
}

/** The surface look preset, read from the root node's style (no DB column). */
export function surfaceThemeOf(view: ViewNode | null | undefined): SurfaceTheme | undefined {
  return view?.style?.theme;
}

// â”€â”€ ui_render / ui_patch tool payloads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const uiRenderSchema = z.object({
  surface: z.string().min(1),
  view: viewNodeSchema,
});

export const uiPatchOpSchema = z.union([
  z.object({ op: z.literal('set'), path: z.string(), value: z.unknown() }),
  z.object({ op: z.literal('insert'), path: z.string(), node: viewNodeSchema, index: z.number().int().optional() }),
  z.object({ op: z.literal('remove'), path: z.string() }),
]);
export type UiPatchOp = z.infer<typeof uiPatchOpSchema>;

export const uiPatchSchema = z.object({
  surface: z.string().min(1),
  ops: z.array(uiPatchOpSchema).min(1),
});

export const uiActionSchemaSchema = z.object({
  surface: z.string().min(1),
  actions: z.array(surfaceActionSchema),
});

// â”€â”€ Performed regions (Phase M3 / G12) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// An agent performs a transient ViewNode into a stable AgentRegion slot, live
// over the realtime bus. The child is ephemeral (never persisted) unless
// `pin:true` â€” then it freezes into the stored surface tree. `clear:true` (no
// view) dismisses the region. Every push carries an explainable `reason`.
export const uiPerformRegionSchema = z.object({
  surface: z.string().min(1),
  region: z.string().min(1),
  view: viewNodeSchema.optional(),
  reason: z.string().max(400).optional(),
  pin: z.boolean().optional(),
  clear: z.boolean().optional(),
});
export type UiPerformRegion = z.infer<typeof uiPerformRegionSchema>;

/** Realtime payload broadcast on SURFACE_RENDER when an agent performs a region. */
export interface SurfaceRegionPush {
  appId: string;
  surfaceId: string;
  surface: string;
  /** Marks this as a region push (vs a full-surface render) so the renderer routes it. */
  region: string;
  view: ViewNode | null;
  reason?: string;
  pinned: boolean;
  at: string;
}

export const upsertSurfaceSchema = z.object({
  name: z.string().min(1).max(120),
  kind: surfaceKindSchema.default('page'),
  view: viewNodeSchema.nullable().optional(),
  actions: z.array(surfaceActionSchema).optional(),
  shareable: z.boolean().optional(),
});


