/**
 * surfaceTemplates — the block palette for the WYSIWYG surface builder.
 *
 * Two tiers (AGENTIC-APPS-10X §4): **Sections** are Studio-grade composites that
 * render real, data-bound content in a single drop (a table over a collection, a
 * create form, a metrics row, a chart, a feed, an approval panel). **Elements**
 * are the primitive building blocks. Both lower to the same typed `ViewNode`
 * grammar the renderer already understands — no protocol change, fully portable.
 *
 * A template may also declare the `SurfaceAction`s its buttons/forms invoke; the
 * editor merges those into the surface so the click → datastore loop works the
 * moment you drop the block.
 */
import type { ReactNode } from 'react';
import {
  Activity,
  BadgeCheck,
  BarChart3,
  Bot,
  Columns3,
  GripHorizontal,
  Heading1,
  Image as ImageIcon,
  LayoutList,
  ListChecks,
  MousePointerClick,
  Rows3,
  SquareStack,
  Table2,
  TextCursorInput,
  Type,
} from 'lucide-react';
import type { CollectionInfo, SurfaceAction, ViewNode } from '@agentis/core';

export type SectionKind =
  // Agent-native composites
  | 'agent_console'
  | 'activity'
  | 'board'
  // Data composites
  | 'records_table'
  | 'create_form'
  | 'metrics_row'
  | 'chart'
  | 'feed'
  | 'approval'
  | 'header';

export type ElementKind =
  | 'heading'
  | 'text'
  | 'card'
  | 'row'
  | 'stack'
  | 'metric'
  | 'badge'
  | 'button'
  | 'image'
  | 'divider';

export type BlockKind = SectionKind | ElementKind;

export interface BuiltBlock {
  node: ViewNode;
  /** Surface actions this block needs declared (forms/row actions). */
  actions?: SurfaceAction[];
}

export interface PaletteItem {
  kind: BlockKind;
  label: string;
  hint: string;
  icon: ReactNode;
}

/**
 * The palette, grouped by intent. **Agent** composites come first — they are what
 * make a surface a living agentic app (an operator, its live work, the data it
 * drives) rather than a static dashboard. Data composites bind to collections;
 * layout/content are the low-level fallback.
 */
export const SURFACE_GROUPS: Array<{ title: string; hint: string; items: PaletteItem[] }> = [
  {
    title: 'Agent',
    hint: 'The agentic core',
    items: [
      { kind: 'agent_console', label: 'Operator', hint: 'The agent running this app + a command line to direct it', icon: <Bot size={15} /> },
      { kind: 'activity', label: 'Activity', hint: 'Live feed of the operator’s work', icon: <Activity size={15} /> },
      { kind: 'board', label: 'Board', hint: 'Kanban over a collection, by status', icon: <Columns3 size={15} /> },
    ],
  },
  {
    title: 'Data',
    hint: 'What the agent manages',
    items: [
      { kind: 'records_table', label: 'Records table', hint: 'Live table bound to a collection', icon: <Table2 size={15} /> },
      { kind: 'create_form', label: 'Create form', hint: 'Add records to a collection', icon: <TextCursorInput size={15} /> },
      { kind: 'feed', label: 'Feed', hint: 'Card list of records', icon: <LayoutList size={15} /> },
      { kind: 'chart', label: 'Chart', hint: 'Bar chart over a collection', icon: <BarChart3 size={15} /> },
      { kind: 'metrics_row', label: 'Metrics', hint: 'Row of headline numbers', icon: <Rows3 size={15} /> },
      { kind: 'approval', label: 'Approval panel', hint: 'Table with approve / reject', icon: <ListChecks size={15} /> },
    ],
  },
  {
    title: 'Layout & content',
    hint: 'Structure and copy',
    items: [
      { kind: 'header', label: 'Header', hint: 'Title + description', icon: <Heading1 size={15} /> },
      { kind: 'card', label: 'Card', hint: 'Bordered container', icon: <SquareStack size={15} /> },
      { kind: 'row', label: 'Row', hint: 'Horizontal layout', icon: <Columns3 size={15} /> },
      { kind: 'stack', label: 'Stack', hint: 'Vertical group', icon: <Rows3 size={15} /> },
      { kind: 'heading', label: 'Heading', hint: 'Section title', icon: <Heading1 size={15} /> },
      { kind: 'text', label: 'Text', hint: 'Paragraph copy', icon: <Type size={15} /> },
      { kind: 'metric', label: 'Metric', hint: 'Single number', icon: <BarChart3 size={15} /> },
      { kind: 'badge', label: 'Badge', hint: 'Status pill', icon: <BadgeCheck size={15} /> },
      { kind: 'button', label: 'Button', hint: 'Action trigger', icon: <MousePointerClick size={15} /> },
      { kind: 'image', label: 'Image', hint: 'Picture', icon: <ImageIcon size={15} /> },
      { kind: 'divider', label: 'Divider', hint: 'Horizontal rule', icon: <GripHorizontal size={15} /> },
    ],
  },
];

const ALL_KINDS = new Set<string>(SURFACE_GROUPS.flatMap((group) => group.items.map((item) => item.kind)));

export function isBlockKind(value: string): value is BlockKind {
  return ALL_KINDS.has(value);
}

// ── Column / field derivation from a collection schema ──────────

type ColumnFormat = 'text' | 'number' | 'date' | 'badge' | 'boolean';
type FormFieldType = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date';

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function columnFormat(type: CollectionInfo['schema']['fields'][number]['type']): ColumnFormat {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'date') return 'date';
  return 'text';
}

function formFieldType(type: CollectionInfo['schema']['fields'][number]['type']): FormFieldType {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'checkbox';
  if (type === 'date') return 'date';
  if (type === 'json') return 'textarea';
  return 'text';
}

function pickCollection(collections: CollectionInfo[]): { name: string; fields: CollectionInfo['schema']['fields'] } {
  const collection = collections[0];
  if (!collection) return { name: 'records', fields: [{ key: 'name', type: 'string', required: false, indexed: false }] };
  return { name: collection.name, fields: collection.schema.fields };
}

function tableColumns(fields: CollectionInfo['schema']['fields']): Array<{ key: string; label: string; format: ColumnFormat }> {
  const visible = fields.filter((field) => field.key !== 'id').slice(0, 5);
  const source = visible.length > 0 ? visible : fields.slice(0, 5);
  return source.map((field) => ({ key: field.key, label: humanize(field.key), format: columnFormat(field.type) }));
}

// ── Builders ────────────────────────────────────────────────────

export function buildBlock(kind: BlockKind, collections: CollectionInfo[]): BuiltBlock {
  switch (kind) {
    case 'agent_console':
    case 'activity':
    case 'board':
    case 'records_table':
    case 'create_form':
    case 'metrics_row':
    case 'chart':
    case 'feed':
    case 'approval':
    case 'header':
      return buildSection(kind, collections);
    default:
      return { node: buildElement(kind, collections) };
  }
}

/**
 * The default surface for a new app: an operator-centric workspace — the agent's
 * presence + command line, its live activity, and (when data exists) a board of
 * what it manages. This is what "opening an app" should feel like.
 */
export function buildStarterSurface(collections: CollectionInfo[]): { view: ViewNode; actions: SurfaceAction[] } {
  const children: ViewNode[] = [
    { type: 'AgentConsole' },
    { type: 'ActivityStream', title: 'Live activity' },
  ];
  if (collections[0]) {
    children.push(buildBlock('board', collections).node);
  } else {
    children.push({ type: 'Text', value: 'Define a collection in the Data tab and the operator will manage its records right here.' });
  }
  return { view: { type: 'Stack', gap: 16, children }, actions: [] };
}

function buildSection(kind: SectionKind, collections: CollectionInfo[]): BuiltBlock {
  const { name, fields } = pickCollection(collections);
  const columns = tableColumns(fields);
  const firstString = fields.find((field) => field.type === 'string' && field.key !== 'id')?.key ?? fields[0]?.key ?? 'name';
  const firstNumber = fields.find((field) => field.type === 'number')?.key ?? 'value';

  switch (kind) {
    case 'agent_console':
      return { node: { type: 'AgentConsole' } };

    case 'activity':
      return { node: { type: 'ActivityStream', title: 'Live activity' } };

    case 'board': {
      const statusField = fields.find((field) => ['status', 'stage', 'state'].includes(field.key))?.key ?? firstString;
      return { node: { type: 'DataBoard', bind: { collection: name, live: true, limit: 100 }, groupBy: statusField, titleField: firstString } };
    }

    case 'records_table':
      return {
        node: { type: 'Table', bind: { collection: name, live: true, limit: 25 }, columns },
      };

    case 'create_form': {
      const formFields = fields
        .filter((field) => field.key !== 'id')
        .map((field) => ({
          key: field.key,
          label: humanize(field.key),
          type: formFieldType(field.type),
          ...(field.required ? { required: true } : {}),
        }));
      const safeFields = formFields.length > 0 ? formFields : [{ key: 'name', label: 'Name', type: 'text' as FormFieldType }];
      const action = `create_${name}`;
      return {
        node: {
          type: 'Form',
          fields: safeFields,
          submit: { action },
          submitLabel: `Add to ${name}`,
        },
        actions: [{ name: action, kind: 'data', target: `${name}.insert` }],
      };
    }

    case 'metrics_row':
      return {
        node: {
          type: 'Row',
          gap: 12,
          children: [
            { type: 'Metric', label: 'Total', value: '0' },
            { type: 'Metric', label: 'Active', value: '0' },
            { type: 'Metric', label: 'This week', value: '0' },
          ],
        },
      };

    case 'chart':
      return {
        node: { type: 'Chart', bind: { collection: name, live: true, limit: 50 }, chartType: 'bar', x: firstString, y: firstNumber },
      };

    case 'feed': {
      const secondary = fields.find((field) => field.key !== firstString && field.key !== 'id')?.key;
      const itemChildren: ViewNode[] = [{ type: 'Metric', label: humanize(firstString), value: { $row: firstString } }];
      if (secondary) itemChildren.push({ type: 'Badge', value: { $row: secondary } });
      return {
        node: {
          type: 'List',
          bind: { collection: name, live: true, limit: 25 },
          item: { type: 'Card', children: itemChildren },
        },
      };
    }

    case 'approval': {
      const approve = `approve_${name}`;
      const reject = `reject_${name}`;
      return {
        node: {
          type: 'Card',
          title: 'Approvals',
          children: [
            {
              type: 'Table',
              bind: { collection: name, live: true, limit: 25 },
              columns,
              rowActions: [
                { action: approve, args: { id: { $row: 'id' }, patch: { status: 'approved' } } },
                { action: reject, args: { id: { $row: 'id' }, patch: { status: 'rejected' } } },
              ],
            },
          ],
        },
        actions: [
          { name: approve, kind: 'data', target: `${name}.update` },
          { name: reject, kind: 'data', target: `${name}.update` },
        ],
      };
    }

    case 'header':
    default:
      return {
        node: {
          type: 'Stack',
          gap: 8,
          children: [
            { type: 'Heading', value: 'Welcome' },
            { type: 'Text', value: 'Describe what this app does for the people using it.' },
          ],
        },
      };
  }
}

function buildElement(kind: ElementKind, collections: CollectionInfo[]): ViewNode {
  const { name, fields } = pickCollection(collections);
  switch (kind) {
    case 'heading':
      return { type: 'Heading', value: 'New heading' };
    case 'text':
      return { type: 'Text', value: 'Write helpful interface copy here.' };
    case 'card':
      return { type: 'Card', title: 'Card title', children: [{ type: 'Text', value: 'Card content' }] };
    case 'row':
      return { type: 'Row', gap: 12, children: [{ type: 'Text', value: 'Column one' }, { type: 'Text', value: 'Column two' }] };
    case 'stack':
      return { type: 'Stack', gap: 12, children: [] };
    case 'metric':
      return { type: 'Metric', label: 'Metric', value: '0' };
    case 'badge':
      return { type: 'Badge', value: 'New', tone: 'neutral' };
    case 'button':
      // Local UI state by default — no backend action needed until the maker
      // wires one in the inspector. The renderer handles `setState` client-side.
      return { type: 'Button', label: 'Button', action: { action: 'setState', args: { key: 'clicked', value: true } }, variant: 'primary' };
    case 'image':
      return { type: 'Image', src: 'https://placehold.co/960x420', alt: 'Image' };
    case 'divider':
      return { type: 'Divider' };
    default:
      return { type: 'Table', bind: { collection: name, live: true, limit: 25 }, columns: tableColumns(fields) };
  }
}
