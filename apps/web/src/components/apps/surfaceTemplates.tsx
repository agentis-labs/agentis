/**
 * Surface palette + starter — the GenUI Renaissance vocabulary.
 *
 * The Edit-mode palette offers the new node set (Hero, KPI strip, real charts,
 * Tabs, Split, Timeline, …) — not the old "Studio blocks". The default a new
 * interface gets comes from the shared archetype taste engine in `@agentis/core`
 * (`buildStarterSurface` → `buildArchetypeSurface`), so creating an interface
 * lands on a themed command center, never a stub.
 */
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Code2,
  FileText,
  Gauge,
  Globe2,
  Image as ImageIcon,
  LayoutGrid,
  ListChecks,
  Map,
  MessageSquare,
  PanelTop,
  Send,
  Sparkles,
  SquareStack,
  Table2,
} from 'lucide-react';
import { buildArchetypeSurface, type CollectionInfo, type SurfaceAction, type ViewNode } from '@agentis/core';

/** Palette kinds the Edit builder can add. Legacy kinds remain valid for node labelling. */
export type ElementKind =
  // headers & text
  | 'hero' | 'heading' | 'text' | 'callout'
  // metrics & charts
  | 'kpi_strip' | 'metric' | 'chart' | 'sparkline' | 'progress'
  // data
  | 'table' | 'board' | 'timeline' | 'form'
  // conversational & domain
  | 'chat_thread' | 'inbox' | 'media_gen' | 'funnel' | 'calendar' | 'gauge'
  // layout
  | 'split' | 'tabs' | 'accordion' | 'grid' | 'card' | 'section' | 'row' | 'stack' | 'divider'
  // agent & interactive
  | 'agent_console' | 'activity_stream' | 'button' | 'badge'
  // advanced / embeds
  | 'code_surface' | 'document_viewer' | 'map' | 'web_embed' | 'media_gallery' | 'status_board'
  // legacy kinds kept only for labelling existing nodes (not shown in the palette)
  | 'agent_card' | 'message_feed' | 'metrics_grid' | 'approval_gate' | 'data_table' | 'narrative' | 'conversation_thread' | 'code_viewer';

export type BlockKind = ElementKind;

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
    title: 'Headers',
    hint: 'Set the tone of the surface',
    items: [
      { kind: 'hero', label: 'Hero', hint: 'Prominent header band', icon: <Sparkles size={15} /> },
      { kind: 'heading', label: 'Heading', hint: 'Section heading', icon: <PanelTop size={15} /> },
      { kind: 'text', label: 'Text', hint: 'Paragraph copy', icon: <FileText size={15} /> },
      { kind: 'callout', label: 'Callout', hint: 'Inline alert / note', icon: <AlertTriangle size={15} /> },
    ],
  },
  {
    title: 'Metrics & charts',
    hint: 'Visualize, don’t narrate',
    items: [
      { kind: 'kpi_strip', label: 'KPI strip', hint: 'Row of metric cards + sparklines', icon: <Gauge size={15} /> },
      { kind: 'chart', label: 'Chart', hint: 'Line / area / bar / pie / donut', icon: <BarChart3 size={15} /> },
      { kind: 'sparkline', label: 'Sparkline', hint: 'Tiny inline trend', icon: <Activity size={15} /> },
      { kind: 'progress', label: 'Progress', hint: 'Value / max bar', icon: <Activity size={15} /> },
    ],
  },
  {
    title: 'Data',
    hint: 'Bound to your collections',
    items: [
      { kind: 'table', label: 'Table', hint: 'Sortable record table', icon: <Table2 size={15} /> },
      { kind: 'board', label: 'Board', hint: 'Kanban by a status field', icon: <ListChecks size={15} /> },
      { kind: 'timeline', label: 'Timeline', hint: 'Chronological events', icon: <Activity size={15} /> },
      { kind: 'form', label: 'Form', hint: 'Create / submit records', icon: <ListChecks size={15} /> },
    ],
  },
  {
    title: 'Conversational & domain',
    hint: 'Inbox, chat, media, funnels, scheduling',
    items: [
      { kind: 'chat_thread', label: 'Chat thread', hint: 'Interactive conversation', icon: <MessageSquare size={15} /> },
      { kind: 'inbox', label: 'Inbox', hint: 'Conversations across channels', icon: <MessageSquare size={15} /> },
      { kind: 'media_gen', label: 'Media generator', hint: 'Prompt → image gallery', icon: <ImageIcon size={15} /> },
      { kind: 'funnel', label: 'Funnel', hint: 'Conversion stages', icon: <BarChart3 size={15} /> },
      { kind: 'calendar', label: 'Calendar', hint: 'Schedule of events', icon: <Activity size={15} /> },
      { kind: 'gauge', label: 'Gauge', hint: 'Radial metric', icon: <Gauge size={15} /> },
    ],
  },
  {
    title: 'Layout',
    hint: 'Compose — not one giant scroll',
    items: [
      { kind: 'split', label: 'Split', hint: 'Main + side rail', icon: <LayoutGrid size={15} /> },
      { kind: 'tabs', label: 'Tabs', hint: 'Progressive disclosure', icon: <SquareStack size={15} /> },
      { kind: 'accordion', label: 'Accordion', hint: 'Collapsible sections', icon: <SquareStack size={15} /> },
      { kind: 'grid', label: 'Grid', hint: 'Responsive columns', icon: <LayoutGrid size={15} /> },
      { kind: 'card', label: 'Card', hint: 'Framed group', icon: <PanelTop size={15} /> },
      { kind: 'section', label: 'Section', hint: 'Titled open group', icon: <PanelTop size={15} /> },
      { kind: 'divider', label: 'Divider', hint: 'Horizontal rule', icon: <PanelTop size={15} /> },
    ],
  },
  {
    title: 'Agent & interactive',
    hint: 'The operator and its work',
    items: [
      { kind: 'agent_console', label: 'Agent console', hint: 'Operator presence + command line', icon: <Bot size={15} /> },
      { kind: 'activity_stream', label: 'Activity', hint: 'Live feed of the agent’s work', icon: <Activity size={15} /> },
      { kind: 'button', label: 'Button', hint: 'Action trigger', icon: <Send size={15} /> },
      { kind: 'badge', label: 'Badge', hint: 'Status pill', icon: <Gauge size={15} /> },
    ],
  },
  {
    title: 'Advanced',
    hint: 'Embeds and full-power code',
    items: [
      { kind: 'code_surface', label: 'Code surface', hint: 'Agent JS in a hardened sandbox', icon: <Code2 size={15} /> },
      { kind: 'document_viewer', label: 'Document', hint: 'Report or memo with download', icon: <FileText size={15} /> },
      { kind: 'map', label: 'Map', hint: 'Regions, pins, and values', icon: <Map size={15} /> },
      { kind: 'web_embed', label: 'Web embed', hint: 'Sandboxed HTTPS iframe', icon: <Globe2 size={15} /> },
      { kind: 'media_gallery', label: 'Media', hint: 'Images, files, generated media', icon: <ImageIcon size={15} /> },
      { kind: 'status_board', label: 'Status board', hint: 'Multi-entity health panel', icon: <MessageSquare size={15} /> },
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

/**
 * The default surface a new interface gets — the SAME archetype taste engine the
 * agent uses (`@agentis/core` buildArchetypeSurface). So "create interface" lands
 * on a themed, data-bound command center, never the old agent-card + board stub.
 */
export function buildStarterSurface(collections: CollectionInfo[]): { view: ViewNode; actions: SurfaceAction[] } {
  const built = buildArchetypeSurface(collections);
  return { view: built.view, actions: built.actions };
}

export function buildBlock(kind: BlockKind, collections: CollectionInfo[]): BuiltBlock {
  const { name, fields } = pickCollection(collections);
  const columns = columnsFor(fields);
  const firstString = fields.find((field) => field.type === 'string' && field.key !== 'id')?.key ?? fields[0]?.key ?? 'name';
  const firstNumber = fields.find((field) => field.type === 'number')?.key ?? 'value';
  const numberField = fields.find((field) => field.type === 'number')?.key;
  const dateField = fields.find((field) => field.type === 'date')?.key;
  const statusField = fields.find((field) => ['status', 'stage', 'state'].includes(field.key))?.key ?? firstString;

  switch (kind) {
    // ── headers & text ──
    case 'hero':
      return { node: { type: 'Hero', eyebrow: 'SECTION', title: 'Headline', subtitle: 'Supporting copy goes here.' } };
    case 'heading':
      return { node: { type: 'Heading', value: 'New heading' } };
    case 'text':
      return { node: { type: 'Text', value: 'Write helpful interface copy here.' } };
    case 'callout':
      return { node: { type: 'Callout', title: 'Heads up', value: 'Something the operator should know.', style: { tone: 'info' } } };

    // ── metrics & charts ──
    case 'kpi_strip': {
      // Labels derived from the collection's numeric fields; values stay neutral until bound.
      const numericFields = fields.filter((field) => field.type === 'number' && field.key !== 'id').slice(0, 4);
      const items = numericFields.length
        ? numericFields.map((field) => ({ label: humanize(field.key), value: '—' }))
        : [{ label: 'Metric', value: '—' }];
      return { node: { type: 'KPIStrip', items } };
    }
    case 'metric':
      return { node: { type: 'Metric', label: 'Metric', value: '—' } };
    case 'chart':
      return { node: { type: 'Chart', bind: { collection: name, live: true, limit: 50 }, chartType: 'area', x: firstString, y: firstNumber, area: true, curve: 'smooth' } };
    case 'sparkline':
      return { node: numberField ? { type: 'Sparkline', bind: { collection: name, live: true, limit: 30 }, y: numberField } : { type: 'Sparkline', points: [] } };
    case 'progress':
      return { node: { type: 'ProgressBar', label: 'Progress', value: 0 } };

    // ── data ──
    case 'table':
    case 'data_table':
      return { node: { type: 'Table', bind: { collection: name, live: true, limit: 25 }, columns } };
    case 'board':
      return { node: { type: 'DataBoard', bind: { collection: name, live: true, limit: 100 }, groupBy: statusField, titleField: firstString } };
    case 'timeline':
      return { node: { type: 'Timeline', title: 'Timeline', bind: { collection: name, live: true, limit: 20 }, titleField: firstString } };

    // ── conversational & domain (schema-driven or empty — no fabricated data) ──
    case 'chat_thread':
      // Empty by default; bind it to a messages collection (or let the agent wire `send`).
      return { node: { type: 'ChatThread', title: 'Conversation' } };
    case 'inbox':
      return {
        node: {
          type: 'Inbox',
          bind: { collection: name, live: true, limit: 50 },
          titleField: firstString,
          channelField: fields.find((f) => f.key === 'channel')?.key,
          subtitleField: fields.find((f) => ['preview', 'last_message', 'subject'].includes(f.key))?.key,
        },
      };
    case 'media_gen':
      return { node: { type: 'MediaGen', title: 'Media generator', placeholder: 'Describe what to generate…' } };
    case 'funnel':
      // Bound to your data when there's a numeric field to measure; otherwise empty.
      return {
        node: numberField
          ? { type: 'Funnel', title: 'Funnel', bind: { collection: name, live: true, limit: 50 }, labelField: firstString, valueField: numberField }
          : { type: 'Funnel', title: 'Funnel', stages: [] },
      };
    case 'calendar':
      return {
        node: dateField
          ? { type: 'Calendar', bind: { collection: name, live: true, limit: 100 }, dateField, labelField: firstString }
          : { type: 'Calendar', events: [] },
      };
    case 'gauge':
      return { node: { type: 'Gauge', label: 'Metric', value: 0 } };

    // ── layout ──
    case 'split':
      return {
        node: {
          type: 'Split',
          ratio: 2,
          left: { type: 'Card', title: 'Main', children: [{ type: 'Text', value: 'Primary content' }] },
          right: { type: 'Card', title: 'Side', children: [{ type: 'Text', value: 'Secondary content' }] },
        },
      };
    case 'tabs':
      return {
        node: {
          type: 'Tabs',
          tabs: [
            { label: 'Overview', children: [{ type: 'Text', value: 'First tab content' }] },
            { label: 'Details', children: [{ type: 'Text', value: 'Second tab content' }] },
          ],
        },
      };
    case 'accordion':
      return {
        node: {
          type: 'Accordion',
          sections: [
            { title: 'Section one', defaultOpen: true, children: [{ type: 'Text', value: 'Content' }] },
            { title: 'Section two', children: [{ type: 'Text', value: 'More content' }] },
          ],
        },
      };
    case 'grid':
      return { node: { type: 'Grid', columns: 3, children: [] } };
    case 'card':
      return { node: { type: 'Card', title: 'Card', children: [{ type: 'Text', value: 'Card content' }] } };
    case 'section':
      return { node: { type: 'Section', title: 'Section', children: [{ type: 'Text', value: 'Grouped content' }] } };
    case 'row':
      return { node: { type: 'Row', gap: 12, widths: [1, 1], children: [{ type: 'Text', value: 'Column one' }, { type: 'Text', value: 'Column two' }] } };
    case 'stack':
      return { node: { type: 'Stack', gap: 12, children: [] } };
    case 'divider':
      return { node: { type: 'Divider' } };

    // ── agent & interactive ──
    case 'agent_console':
    case 'agent_card':
      return { node: { type: 'AgentConsole' } };
    case 'activity_stream':
    case 'message_feed':
      return { node: { type: 'ActivityStream', title: 'Live activity', limit: 20 } };
    case 'button':
      return { node: { type: 'Button', label: 'Button', action: { action: 'setState', args: { key: 'clicked', value: true } }, variant: 'primary' } };
    case 'badge':
      return { node: { type: 'Badge', value: 'Status', tone: 'success' } };

    // ── advanced / embeds ──
    case 'code_surface':
      return { node: { type: 'CodeSurface', collections: [], code: 'root.appendChild(ui.card("Custom", ui.text("Agent-coded UI — full power, sandboxed.")));' } };
    case 'document_viewer':
      return { node: { type: 'DocumentViewer', title: 'Report', content: '# Report\n\nGenerated details appear here.', format: 'markdown', downloadName: 'report.md' } };
    case 'map':
      return { node: { type: 'MapView', title: 'Map', region: 'Global', pins: [] } };
    case 'web_embed':
      return { node: { type: 'WebEmbed', title: 'Web embed', url: 'https://example.com', height: 320 } };
    case 'media_gallery':
      return { node: { type: 'MediaGallery', title: 'Media', items: [] } };
    case 'status_board':
      return { node: { type: 'StatusBoard', title: 'Status board', items: [] } };

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
