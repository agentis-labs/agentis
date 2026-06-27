/**
 * genui — the design-taste layer behind surface generation (shared).
 *
 * Classifies an App's data shape into an archetype and composes a distinct,
 * themed, data-bound `ViewNode` tree for it. This is the SINGLE source used by
 * both the API generator (`surfaceGenerator`) and the web "create interface"
 * default (`surfaceTemplates.buildStarterSurface`), so a new surface looks like
 * a designer built it everywhere — no two ways to make a starter surface.
 */
import type { CollectionInfo } from './types/datastore.js';
import type { SurfaceAction, ViewNode } from './types/view.js';

export type Archetype = 'analytics' | 'pipeline' | 'operations';

export interface BuiltSurface {
  view: ViewNode;
  actions: SurfaceAction[];
  archetype: Archetype;
}

const OPERATOR_RAIL: ViewNode = {
  type: 'Stack',
  gap: 12,
  children: [
    { type: 'AgentConsole' },
    { type: 'ActivityStream', title: 'Live activity' },
  ],
};

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

type FormFieldType = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date';

function formFieldType(type: CollectionInfo['schema']['fields'][number]['type']): FormFieldType {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'checkbox';
  if (type === 'date') return 'date';
  if (type === 'json') return 'textarea';
  return 'text';
}

interface Ctx {
  name: string;
  columns: Array<{ key: string; label: string }>;
  formFields: Array<{ key: string; label: string; type: FormFieldType; required?: boolean }>;
  createAction: string;
  statusField?: string;
  numberFields: string[];
  titleField?: string;
  xField: string;
}

function buildCtx(collection: CollectionInfo): Ctx {
  const all = collection.schema.fields;
  const fields = all.filter((f) => f.key !== 'id');
  const base = fields.length > 0 ? fields : all;
  const columns = base.slice(0, 5).map((f) => ({ key: f.key, label: humanize(f.key) }));
  const formSource = fields.length > 0 ? fields : [{ key: 'name', type: 'string' as const, required: false, indexed: false }];
  const formFields = formSource.map((f) => ({
    key: f.key,
    label: humanize(f.key),
    type: formFieldType(f.type),
    ...(f.required ? { required: true } : {}),
  }));
  const statusField = fields.find((f) => ['status', 'stage', 'state'].includes(f.key))?.key;
  const numberFields = fields.filter((f) => f.type === 'number').map((f) => f.key);
  const titleField = fields.find((f) => f.type === 'string')?.key;
  const xField = titleField ?? fields[0]?.key ?? 'name';
  return { name: collection.name, columns, formFields, createAction: `create_${collection.name}`, ...(statusField ? { statusField } : {}), numberFields, ...(titleField ? { titleField } : {}), xField };
}

function insertAction(ctx: Ctx): SurfaceAction[] {
  return [{ name: ctx.createAction, kind: 'data', target: `${ctx.name}.insert` }];
}

function addForm(ctx: Ctx): ViewNode {
  return { type: 'Form', fields: ctx.formFields, submit: { action: ctx.createAction }, submitLabel: 'Add' };
}

function recordsTable(ctx: Ctx): ViewNode {
  return { type: 'Table', bind: { collection: ctx.name, live: true, limit: 25 }, columns: ctx.columns };
}

/** Pick the archetype from the data shape — status → pipeline, numeric → analytics, else operations. */
export function classifyArchetype(collections: CollectionInfo[]): Archetype {
  const collection = collections[0];
  if (!collection) return 'operations';
  const fields = collection.schema.fields.filter((f) => f.key !== 'id');
  if (fields.some((f) => ['status', 'stage', 'state'].includes(f.key))) return 'pipeline';
  if (fields.some((f) => f.type === 'number')) return 'analytics';
  return 'operations';
}

// ── Templates ───────────────────────────────────────────────

function analyticsView(ctx: Ctx): BuiltSurface {
  const y0 = ctx.numberFields[0] ?? ctx.xField;
  const chartCard: ViewNode = {
    type: 'Card',
    title: 'Trend',
    style: { span: 2 },
    children: [{
      type: 'Chart',
      bind: { collection: ctx.name, live: true, limit: 50 },
      chartType: 'area',
      x: ctx.xField,
      y: y0,
      area: true,
      curve: 'smooth',
      legend: ctx.numberFields.length > 1,
      ...(ctx.numberFields.length > 1 ? { series: ctx.numberFields.slice(0, 3).map((y) => ({ y, label: humanize(y) })) } : {}),
    }],
  };
  const rail: ViewNode = { ...OPERATOR_RAIL, style: { span: 1 } };
  const records: ViewNode = {
    type: 'Tabs',
    tabs: [
      { label: 'Records', children: [recordsTable(ctx)] },
      { label: `Add ${humanize(ctx.name)}`, children: [addForm(ctx)] },
    ],
  };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'analytics' },
      children: [
        { type: 'Hero', title: humanize(ctx.name) },
        { type: 'Grid', columns: 3, gap: 16, children: [chartCard, rail] },
        records,
      ],
    },
    actions: insertAction(ctx),
    archetype: 'analytics',
  };
}

function pipelineView(ctx: Ctx): BuiltSurface {
  const board: ViewNode = { type: 'DataBoard', bind: { collection: ctx.name, live: true, limit: 100 }, groupBy: ctx.statusField ?? 'status', ...(ctx.titleField ? { titleField: ctx.titleField } : {}) };
  const main: ViewNode = {
    type: 'Tabs',
    tabs: [
      { label: 'Board', children: [board] },
      { label: `Add ${humanize(ctx.name)}`, children: [addForm(ctx)] },
    ],
  };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'product' },
      children: [
        { type: 'Hero', title: humanize(ctx.name) },
        { type: 'Split', ratio: 3, left: main, right: OPERATOR_RAIL },
      ],
    },
    actions: insertAction(ctx),
    archetype: 'pipeline',
  };
}

function operationsView(ctx: Ctx): BuiltSurface {
  const overview: ViewNode[] = [];
  if (ctx.numberFields[0]) {
    overview.push({
      type: 'Card',
      title: 'Trend',
      children: [{ type: 'Chart', bind: { collection: ctx.name, live: true, limit: 50 }, chartType: 'area', x: ctx.xField, y: ctx.numberFields[0], area: true, curve: 'smooth' }],
    });
  }
  overview.push(recordsTable(ctx));
  const main: ViewNode = {
    type: 'Tabs',
    tabs: [
      { label: 'Overview', children: overview },
      { label: `Add ${humanize(ctx.name)}`, children: [addForm(ctx)] },
    ],
  };
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'console' },
      children: [
        { type: 'Hero', title: humanize(ctx.name) },
        { type: 'Split', ratio: 2, left: main, right: OPERATOR_RAIL },
      ],
    },
    actions: insertAction(ctx),
    archetype: 'operations',
  };
}

function emptyView(): BuiltSurface {
  return {
    view: {
      type: 'Stack',
      gap: 16,
      style: { theme: 'console' },
      children: [
        { type: 'Hero', title: 'Your app' },
        OPERATOR_RAIL,
      ],
    },
    actions: [],
    archetype: 'operations',
  };
}

/** Build a complete, archetype-matched, themed surface for the App's first collection. */
export function buildArchetypeSurface(collections: CollectionInfo[]): BuiltSurface {
  const collection = collections[0];
  if (!collection) return emptyView();
  const ctx = buildCtx(collection);
  switch (classifyArchetype(collections)) {
    case 'pipeline':
      return pipelineView(ctx);
    case 'analytics':
      return analyticsView(ctx);
    default:
      return operationsView(ctx);
  }
}
