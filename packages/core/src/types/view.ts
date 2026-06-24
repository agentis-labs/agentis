/**
 * AG-UI — the agent-authored UI protocol (AGENTIC-APPS-10X-MASTERPLAN §4).
 *
 * An agent authors a typed `ViewNode` tree (the "cards" tier) instead of pushing
 * data into fixed blocks. Nodes can bind to App Datastore queries (`bind`) and
 * declare user actions (`action`) that resolve to a workflow, tool, or data op.
 * The renderer (`AppRuntime`) maps nodes to the Agentis Design System, so agents
 * emit *intent*, not pixels.
 *
 * Shared by the backend (persistence + validation) and the web renderer. Kept
 * dependency-light: zod schemas validate agent output; the TS types drive the
 * renderer.
 */

import { z } from 'zod';

// ── Bindings & actions ──────────────────────────────────────

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

// ── Field / column descriptors ──────────────────────────────

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

// ── ViewNode (recursive) ────────────────────────────────────

export type ViewNode =
  | { type: 'Stack' | 'Row' | 'Grid'; gap?: number; children: ViewNode[] }
  | { type: 'Card' | 'Section'; title?: string; children: ViewNode[] }
  | { type: 'Text' | 'Heading' | 'Markdown'; value: string }
  | { type: 'Metric'; label: string; value: Bindable; delta?: Bindable }
  | { type: 'Image'; src: Bindable; alt?: string }
  | { type: 'Table'; bind: DataBind; columns: z.infer<typeof columnSchema>[]; rowActions?: ActionRef[] }
  | { type: 'List'; bind: DataBind; item: ViewNode }
  | { type: 'Chart'; bind: DataBind; chartType: 'line' | 'bar' | 'pie'; x: string; y: string }
  | { type: 'Form'; fields: z.infer<typeof fieldSchema>[]; submit: ActionRef; submitLabel?: string }
  | { type: 'Button'; label: string; action: ActionRef; variant?: 'primary' | 'secondary' | 'danger' }
  | { type: 'Badge'; value: Bindable; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  | { type: 'Divider' }
  // ── Agent-native composites — what makes a surface an *Agentic* App ──
  // The operator agent's presence + a command line to direct it.
  | { type: 'AgentConsole'; title?: string; prompt?: string }
  // A live feed of the operator's work (runs, tool calls, decisions), streamed over realtime.
  | { type: 'ActivityStream'; title?: string; limit?: number }
  // A kanban board over a collection, grouped by a status/stage field — apps, not dashboards.
  | { type: 'DataBoard'; bind: DataBind; groupBy: string; titleField?: string }
  /**
   * Escape hatch (§4.5/§4.6) — agent-written HTML/JS rendered in a hardened,
   * null-origin sandboxed iframe. NO network egress (CSP connect-src 'none');
   * data + actions flow only through the postMessage bridge, which the parent
   * authz-checks against app policy server-side. `html` is the agent's markup.
   */
  | { type: 'CustomView'; html: string; collections?: string[]; height?: number };

export const viewNodeSchema: z.ZodType<ViewNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.enum(['Stack', 'Row', 'Grid']), gap: z.number().optional(), children: z.array(viewNodeSchema) }),
    z.object({ type: z.enum(['Card', 'Section']), title: z.string().optional(), children: z.array(viewNodeSchema) }),
    z.object({ type: z.enum(['Text', 'Heading', 'Markdown']), value: z.string() }),
    z.object({ type: z.literal('Metric'), label: z.string(), value: bindableSchema, delta: bindableSchema.optional() }),
    z.object({ type: z.literal('Image'), src: bindableSchema, alt: z.string().optional() }),
    z.object({ type: z.literal('Table'), bind: dataBindSchema, columns: z.array(columnSchema), rowActions: z.array(actionRefSchema).optional() }),
    z.object({ type: z.literal('List'), bind: dataBindSchema, item: viewNodeSchema }),
    z.object({ type: z.literal('Chart'), bind: dataBindSchema, chartType: z.enum(['line', 'bar', 'pie']), x: z.string(), y: z.string() }),
    z.object({ type: z.literal('Form'), fields: z.array(fieldSchema), submit: actionRefSchema, submitLabel: z.string().optional() }),
    z.object({ type: z.literal('Button'), label: z.string(), action: actionRefSchema, variant: z.enum(['primary', 'secondary', 'danger']).optional() }),
    z.object({ type: z.literal('Badge'), value: bindableSchema, tone: z.enum(['neutral', 'success', 'warning', 'danger']).optional() }),
    z.object({ type: z.literal('Divider') }),
    z.object({ type: z.literal('AgentConsole'), title: z.string().optional(), prompt: z.string().optional() }),
    z.object({ type: z.literal('ActivityStream'), title: z.string().optional(), limit: z.number().int().positive().max(100).optional() }),
    z.object({ type: z.literal('DataBoard'), bind: dataBindSchema, groupBy: z.string().min(1), titleField: z.string().optional() }),
    z.object({ type: z.literal('CustomView'), html: z.string().max(200_000), collections: z.array(z.string()).optional(), height: z.number().int().positive().max(2000).optional() }),
  ]) as z.ZodType<ViewNode>,
);

/**
 * Every datastore collection a surface's view tree legitimately reads, gathered
 * from data-bound nodes (`Table`/`List`/`Chart`/`DataBoard` `bind.collection`)
 * and `CustomView` `collections`. This is the authorization allowlist for
 * reading a surface's data: a public/shared surface must only expose the
 * collections it actually displays — never sibling collections it never binds.
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
      case 'CustomView':
        for (const c of n.collections ?? []) out.add(c);
        return;
      case 'Stack':
      case 'Row':
      case 'Grid':
      case 'Card':
      case 'Section':
        for (const child of n.children) walk(child);
        return;
      default:
        return;
    }
  };
  walk(view);
  return out;
}

// ── Actions declared by a surface (ui_action_schema) ────────

export const surfaceActionSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['workflow', 'tool', 'data', 'capability', 'navigate', 'setState']),
  /** workflow id / tool name / capability id / "collection.op" / surface name / state key. */
  target: z.string().min(1),
  inputSchema: z.record(z.unknown()).optional(),
});
export type SurfaceAction = z.infer<typeof surfaceActionSchema>;

// ── Surface (persisted) ─────────────────────────────────────

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

// ── ui_render / ui_patch tool payloads ──────────────────────

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

export const upsertSurfaceSchema = z.object({
  name: z.string().min(1).max(120),
  kind: surfaceKindSchema.default('page'),
  view: viewNodeSchema.nullable().optional(),
  actions: z.array(surfaceActionSchema).optional(),
  shareable: z.boolean().optional(),
});
