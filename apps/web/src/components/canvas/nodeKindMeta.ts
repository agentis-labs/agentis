/**
 * NODE_KIND_META — the single source of truth for how every workflow node kind
 * is presented on the canvas: its glyph, its human label, and the category it
 * belongs to (which drives the left color rail and the minimap color).
 *
 * Before this, the node subtitle read `data.type` (often "default") and the
 * glyph map was missing half the kinds, so e.g. a `parallel` node showed a bare
 * "•" and no label. Everything visual now derives from `config.kind` through
 * this table, so the taxonomy is consistent across the node, the palette, and
 * the minimap. Covers the full `WorkflowNodeType` union in
 * packages/core/src/types/workflow.ts.
 */

export type NodeCategory =
  | 'trigger'
  | 'control'
  | 'data'
  | 'intelligence'
  | 'knowledge'
  | 'output'
  | 'browser'
  | 'human';

export interface NodeCategoryMeta {
  label: string;
  /** Hex used for the node's left color rail and the minimap dot. */
  color: string;
}

export const NODE_CATEGORY_META: Record<NodeCategory, NodeCategoryMeta> = {
  trigger: { label: 'Trigger', color: '#7c83ff' },
  control: { label: 'Control flow', color: '#38bdf8' },
  data: { label: 'Data & logic', color: '#34d399' },
  intelligence: { label: 'Intelligence', color: '#c084fc' },
  knowledge: { label: 'Knowledge', color: '#fbbf24' },
  output: { label: 'Output', color: '#f472b6' },
  browser: { label: 'Browser', color: '#22d3ee' },
  human: { label: 'Human', color: '#fb923c' },
};

export interface NodeKindMeta {
  /** Short, plain-language name shown as the node subtitle and in the palette. */
  label: string;
  glyph: string;
  category: NodeCategory;
}

export const NODE_KIND_META: Record<string, NodeKindMeta> = {
  // Control flow
  trigger: { label: 'Trigger', glyph: '◉', category: 'trigger' },
  router: { label: 'Router', glyph: '⤳', category: 'control' },
  merge: { label: 'Merge', glyph: '⟴', category: 'control' },
  subflow: { label: 'Subflow', glyph: '⊞', category: 'control' },
  wait: { label: 'Wait', glyph: '◷', category: 'control' },
  loop: { label: 'Loop', glyph: '↻', category: 'control' },
  pursue: { label: 'Pursue', glyph: '◎', category: 'control' },
  converge: { label: 'Converge', glyph: '⟳', category: 'control' },
  parallel: { label: 'Parallel', glyph: '⇉', category: 'control' },
  stop_error: { label: 'Stop & error', glyph: '⛔', category: 'control' },
  // Data & logic — deterministic, zero LLM tokens
  transform: { label: 'Transform', glyph: 'Æ’', category: 'data' },
  filter: { label: 'Filter', glyph: '▽', category: 'data' },
  integration: { label: 'Integration', glyph: '⧉', category: 'data' },
  http_request: { label: 'HTTP request', glyph: '↯', category: 'data' },
  // MCP capability plane: one deterministic tool call on a mounted MCP server
  // (Supabase, Linear, …) — the workflow-side twin of agentis.mcp.call.
  mcp: { label: 'MCP tool', glyph: '⌬', category: 'data' },
  // Deterministic send on a native channel (WhatsApp/Telegram/…) — the zero-token
  // "actually reach the world" step, twin of agentis.channel.send.
  channel: { label: 'Channel', glyph: '💬', category: 'data' },
  data_query: { label: 'Data query', glyph: '⌕', category: 'data' },
  data_mutate: { label: 'Data mutate', glyph: '✎', category: 'data' },
  aggregate_window: { label: 'Aggregate', glyph: '∑', category: 'data' },
  workflow_store: { label: 'Workflow memory', glyph: '▤', category: 'data' },
  workspace_store: { label: 'Workspace memory', glyph: '▦', category: 'data' },
  scratchpad: { label: 'Scratchpad', glyph: '◈', category: 'data' },
  code: { label: 'Code', glyph: '⌗', category: 'data' },
  datetime: { label: 'Date & time', glyph: '◷', category: 'data' },
  crypto_util: { label: 'Crypto', glyph: '⚿', category: 'data' },
  markdown: { label: 'Markdown', glyph: '⓶', category: 'data' },
  xml_parse: { label: 'XML', glyph: '‹›', category: 'data' },
  html_extract: { label: 'HTML extract', glyph: '⧉', category: 'data' },
  json_schema_validate: { label: 'Validate schema', glyph: '✔', category: 'data' },
  spreadsheet: { label: 'Spreadsheet', glyph: '▦', category: 'data' },
  graphql: { label: 'GraphQL', glyph: '◭', category: 'data' },
  // Intelligence — LLM-powered
  agent_task: { label: 'Agent task', glyph: '◎', category: 'intelligence' },
  agent_session: { label: 'Agent session', glyph: '?', category: 'intelligence' },
  extension_task: { label: 'Extension', glyph: '⬡', category: 'intelligence' },
  agent_swarm: { label: 'Swarm', glyph: '?', category: 'intelligence' },
  dynamic_swarm: { label: 'Dynamic swarm', glyph: '✸', category: 'intelligence' },
  planner: { label: 'Planner', glyph: '⊹', category: 'intelligence' },
  evaluator: { label: 'Evaluator', glyph: '⊨', category: 'intelligence' },
  guardrails: { label: 'Guardrails', glyph: '⊘', category: 'intelligence' },
  // Knowledge Base (RAG over uploaded docs) — distinct from the Brain (memory).
  knowledge: { label: 'Knowledge search', glyph: '◇', category: 'knowledge' },
  knowledge_ingest: { label: 'Knowledge ingest', glyph: '⇪', category: 'knowledge' },
  artifact_collect: { label: 'Collect artifacts', glyph: '⊡', category: 'knowledge' },
  // Output surface
  return_output: { label: 'Return output', glyph: '▣', category: 'output' },
  artifact_save: { label: 'Save artifact', glyph: '⭳', category: 'output' },
  notify: { label: 'Notify me', glyph: '✉', category: 'output' },
  sticky_note: { label: 'Sticky note', glyph: '✎', category: 'output' },
  // Native browser control
  browser: { label: 'Browser', glyph: '?', category: 'browser' },
  // Human interaction
  checkpoint: { label: 'Checkpoint', glyph: '✓', category: 'human' },
  human_input: { label: 'Human input', glyph: '?', category: 'human' },
  // Fires a workflow when another workflow's run fails.
  error_trigger: { label: 'Error trigger', glyph: '⚠', category: 'trigger' },
};

const FALLBACK: NodeKindMeta = { label: 'Step', glyph: '•', category: 'data' };

/** Presentation metadata for a node kind, with a safe fallback for unknowns. */
export function nodeKindMeta(kind: string | undefined | null): NodeKindMeta {
  if (!kind) return FALLBACK;
  return NODE_KIND_META[kind] ?? { ...FALLBACK, label: humanizeKind(kind) };
}

/** The color for a node kind's category — used by the rail and the minimap. */
export function nodeKindColor(kind: string | undefined | null): string {
  return NODE_CATEGORY_META[nodeKindMeta(kind).category].color;
}

function humanizeKind(kind: string): string {
  return kind
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}



