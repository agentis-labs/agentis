/**
 * Studio-compatible surface templates.
 *
 * These restore the old Workflow Studio block vocabulary while lowering every
 * block to the current AG-UI ViewNode protocol. No workflow-owned Studio schema
 * is reintroduced here.
 */
import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Code2,
  FileText,
  Gauge,
  Globe2,
  Image as ImageIcon,
  ListChecks,
  Map,
  MessageSquare,
  Newspaper,
  PanelTop,
  Table2,
} from 'lucide-react';
import type { CollectionInfo, SurfaceAction, ViewNode } from '@agentis/core';

export type StudioBlockKind =
  | 'message_feed'
  | 'metrics_grid'
  | 'approval_gate'
  | 'data_table'
  | 'chart'
  | 'document_viewer'
  | 'map'
  | 'agent_card'
  | 'status_board'
  | 'web_embed'
  | 'narrative'
  | 'conversation_thread'
  | 'code_viewer'
  | 'media_gallery';

export type PrimitiveBlockKind =
  | 'card'
  | 'row'
  | 'stack'
  | 'heading'
  | 'text'
  | 'button';

export type BlockKind = StudioBlockKind | PrimitiveBlockKind;
export type ElementKind = BlockKind;

export interface BuiltBlock {
  node: ViewNode;
  actions?: SurfaceAction[];
}

export interface PaletteItem {
  kind: BlockKind;
  label: string;
  hint: string;
  icon: ReactNode;
}

export const SURFACE_GROUPS: Array<{ title: string; hint: string; items: PaletteItem[] }> = [
  {
    title: 'Studio blocks',
    hint: 'The previous Workflow Studio block set',
    items: [
      { kind: 'message_feed', label: 'Message feed', hint: 'Live chat-style stream', icon: <MessageSquare size={15} /> },
      { kind: 'metrics_grid', label: 'Metrics grid', hint: 'KPI cards with deltas', icon: <Gauge size={15} /> },
      { kind: 'approval_gate', label: 'Approval gate', hint: 'Human review actions', icon: <ListChecks size={15} /> },
      { kind: 'data_table', label: 'Data table', hint: 'Sortable data view', icon: <Table2 size={15} /> },
      { kind: 'chart', label: 'Chart', hint: 'Bar, line, or pie chart', icon: <BarChart3 size={15} /> },
      { kind: 'document_viewer', label: 'Document', hint: 'Report or memo with download', icon: <FileText size={15} /> },
      { kind: 'map', label: 'Map', hint: 'Regions, pins, and values', icon: <Map size={15} /> },
      { kind: 'agent_card', label: 'Agent card', hint: 'Operator status and command line', icon: <Bot size={15} /> },
      { kind: 'status_board', label: 'Status board', hint: 'Multi-entity health panel', icon: <Activity size={15} /> },
      { kind: 'web_embed', label: 'Web embed', hint: 'Sandboxed HTTPS iframe', icon: <Globe2 size={15} /> },
      { kind: 'narrative', label: 'Narrative', hint: 'AI-written summary block', icon: <Newspaper size={15} /> },
      { kind: 'conversation_thread', label: 'Conversation', hint: 'Thread-first dialogue surface', icon: <MessageSquare size={15} /> },
      { kind: 'code_viewer', label: 'Code viewer', hint: 'Code or diff block', icon: <Code2 size={15} /> },
      { kind: 'media_gallery', label: 'Media gallery', hint: 'Images, files, and generated media', icon: <ImageIcon size={15} /> },
    ],
  },
  {
    title: 'Structure',
    hint: 'Low-level composition blocks',
    items: [
      { kind: 'card', label: 'Card', hint: 'Framed content group', icon: <PanelTop size={15} /> },
      { kind: 'row', label: 'Row', hint: 'Horizontal flex row', icon: <PanelTop size={15} /> },
      { kind: 'stack', label: 'Stack', hint: 'Vertical stack', icon: <PanelTop size={15} /> },
      { kind: 'heading', label: 'Heading', hint: 'Section heading', icon: <PanelTop size={15} /> },
      { kind: 'text', label: 'Text', hint: 'Paragraph copy', icon: <PanelTop size={15} /> },
      { kind: 'button', label: 'Button', hint: 'Action trigger', icon: <PanelTop size={15} /> },
    ],
  },
];

const ALL_KINDS = new Set<string>(SURFACE_GROUPS.flatMap((group) => group.items.map((item) => item.kind)));

export function isBlockKind(value: string): value is BlockKind {
  return ALL_KINDS.has(value);
}

export function blockLabel(kind: BlockKind): string {
  return SURFACE_GROUPS.flatMap((group) => group.items).find((item) => item.kind === kind)?.label ?? kind;
}

type ColumnFormat = 'text' | 'number' | 'date' | 'badge' | 'boolean';
type FieldType = 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date';

function humanize(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function pickCollection(collections: CollectionInfo[]): { name: string; fields: CollectionInfo['schema']['fields'] } {
  const collection = collections[0];
  if (!collection) return { name: 'records', fields: [{ key: 'name', type: 'string', required: false, indexed: false }] };
  return { name: collection.name, fields: collection.schema.fields };
}

function columnFormat(type: CollectionInfo['schema']['fields'][number]['type']): ColumnFormat {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'date') return 'date';
  return 'text';
}

function fieldType(type: CollectionInfo['schema']['fields'][number]['type']): FieldType {
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'checkbox';
  if (type === 'date') return 'date';
  if (type === 'json') return 'textarea';
  return 'text';
}

function columnsFor(fields: CollectionInfo['schema']['fields']) {
  const visible = fields.filter((field) => field.key !== 'id').slice(0, 5);
  return (visible.length ? visible : fields.slice(0, 5)).map((field) => ({
    key: field.key,
    label: humanize(field.key),
    format: columnFormat(field.type),
  }));
}

export function buildStarterSurface(collections: CollectionInfo[]): { view: ViewNode; actions: SurfaceAction[] } {
  const { name, fields } = pickCollection(collections);
  const statusField = fields.find((field) => ['status', 'stage', 'state'].includes(field.key))?.key ?? fields[0]?.key ?? 'status';
  return {
    view: {
      type: 'Stack',
      gap: 16,
      children: [
        { type: 'Row', gap: 12, widths: [1], children: [buildBlock('agent_card', collections).node] },
        {
          type: 'Row',
          gap: 12,
          widths: [2, 1],
          children: [
            { type: 'DataBoard', bind: { collection: name, live: true, limit: 100 }, groupBy: statusField, titleField: fields[0]?.key ?? 'name' },
            buildBlock('status_board', collections).node,
          ],
        },
      ],
    },
    actions: [],
  };
}

export function buildBlock(kind: BlockKind, collections: CollectionInfo[]): BuiltBlock {
  const { name, fields } = pickCollection(collections);
  const columns = columnsFor(fields);
  const firstString = fields.find((field) => field.type === 'string' && field.key !== 'id')?.key ?? fields[0]?.key ?? 'name';
  const firstNumber = fields.find((field) => field.type === 'number')?.key ?? 'value';

  switch (kind) {
    case 'message_feed':
      return { node: { type: 'ActivityStream', title: 'Message feed', limit: 20 } };
    case 'metrics_grid':
      return {
        node: {
          type: 'Row',
          gap: 12,
          widths: [1, 1, 1],
          children: [
            { type: 'Metric', label: 'Total', value: '0', delta: '+0%' },
            { type: 'Metric', label: 'Active', value: '0', delta: 'Live' },
            { type: 'Metric', label: 'Needs review', value: '0', delta: 'Queued' },
          ],
        },
      };
    case 'approval_gate': {
      const approve = `approve_${name}`;
      const reject = `reject_${name}`;
      return {
        node: {
          type: 'Card',
          title: 'Approval gate',
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
    case 'data_table':
      return { node: { type: 'Table', bind: { collection: name, live: true, limit: 25 }, columns } };
    case 'chart':
      return { node: { type: 'Chart', bind: { collection: name, live: true, limit: 50 }, chartType: 'bar', x: firstString, y: firstNumber } };
    case 'document_viewer':
      return { node: { type: 'DocumentViewer', title: 'Report', content: '# Report\n\nGenerated details appear here.', format: 'markdown', downloadName: 'report.md' } };
    case 'map':
      return { node: { type: 'MapView', title: 'Regional map', region: 'Global', pins: [{ label: 'North', value: 'Healthy' }, { label: 'South', value: 'Review' }] } };
    case 'agent_card':
      return { node: { type: 'AgentConsole', title: 'Agent card' } };
    case 'status_board':
      return {
        node: {
          type: 'StatusBoard',
          title: 'Status board',
          items: [
            { label: 'Pipeline', status: 'online', detail: 'Accepting work' },
            { label: 'Approvals', status: 'pending', detail: 'Waiting for review' },
            { label: 'Delivery', status: 'healthy', detail: 'On track' },
          ],
        },
      };
    case 'web_embed':
      return { node: { type: 'WebEmbed', title: 'Web embed', url: 'https://example.com', height: 320 } };
    case 'narrative':
      return { node: { type: 'Narrative', title: 'Narrative', value: 'The agent will summarize what changed, what needs attention, and what happens next.', tone: 'brief' } };
    case 'conversation_thread':
      return {
        node: {
          type: 'ConversationThread',
          title: 'Conversation thread',
          messages: [
            { role: 'agent', content: 'I am tracking this surface.' },
            { role: 'user', content: 'Show me the next decision.' },
          ],
        },
      };
    case 'code_viewer':
      return { node: { type: 'CodeViewer', title: 'Code viewer', language: 'ts', code: 'export async function run() {\n  return { ok: true };\n}', diff: false } };
    case 'media_gallery':
      return {
        node: {
          type: 'MediaGallery',
          title: 'Media gallery',
          items: [
            { src: 'https://placehold.co/640x360', alt: 'Generated artifact', caption: 'Generated artifact' },
          ],
        },
      };
    case 'card':
      return { node: { type: 'Card', title: 'Card', children: [{ type: 'Text', value: 'Card content' }] } };
    case 'row':
      return { node: { type: 'Row', gap: 12, widths: [1, 1], children: [{ type: 'Text', value: 'Column one' }, { type: 'Text', value: 'Column two' }] } };
    case 'stack':
      return { node: { type: 'Stack', gap: 12, children: [] } };
    case 'heading':
      return { node: { type: 'Heading', value: 'New heading' } };
    case 'text':
      return { node: { type: 'Text', value: 'Write helpful interface copy here.' } };
    case 'button':
      return { node: { type: 'Button', label: 'Button', action: { action: 'setState', args: { key: 'clicked', value: true } }, variant: 'primary' } };
    default: {
      const safeFields = fields.filter((field) => field.key !== 'id').map((field) => ({ key: field.key, label: humanize(field.key), type: fieldType(field.type) }));
      const action = `create_${name}`;
      return {
        node: { type: 'Form', fields: safeFields.length ? safeFields : [{ key: 'name', label: 'Name', type: 'text' }], submit: { action }, submitLabel: `Add to ${name}` },
        actions: [{ name: action, kind: 'data', target: `${name}.insert` }],
      };
    }
  }
}
