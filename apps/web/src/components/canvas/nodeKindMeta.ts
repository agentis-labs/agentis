/**
 * NODE_KIND_META â€” the single source of truth for how every workflow node kind
 * is presented on the canvas: its glyph, its human label, and the category it
 * belongs to (which drives the left color rail and the minimap color).
 *
 * Before this, the node subtitle read `data.type` (often "default") and the
 * glyph map was missing half the kinds, so e.g. a `parallel` node showed a bare
 * "â€¢" and no label. Everything visual now derives from `config.kind` through
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
  trigger: { label: 'Trigger', glyph: 'â—‰', category: 'trigger' },
  router: { label: 'Router', glyph: 'â¤³', category: 'control' },
  merge: { label: 'Merge', glyph: 'âŸ´', category: 'control' },
  subflow: { label: 'Subflow', glyph: 'âŠž', category: 'control' },
  wait: { label: 'Wait', glyph: 'â—·', category: 'control' },
  loop: { label: 'Loop', glyph: 'â†»', category: 'control' },
  pursue: { label: 'Pursue', glyph: 'â—Ž', category: 'control' },
  converge: { label: 'Converge', glyph: 'âŸ³', category: 'control' },
  parallel: { label: 'Parallel', glyph: 'â‡‰', category: 'control' },
  stop_error: { label: 'Stop & error', glyph: 'â›”', category: 'control' },
  // Data & logic â€” deterministic, zero LLM tokens
  transform: { label: 'Transform', glyph: 'Æ’', category: 'data' },
  filter: { label: 'Filter', glyph: 'â–½', category: 'data' },
  integration: { label: 'Integration', glyph: 'â§‰', category: 'data' },
  http_request: { label: 'HTTP request', glyph: 'â†¯', category: 'data' },
  // MCP capability plane: one deterministic tool call on a mounted MCP server
  // (Supabase, Linear, â€¦) â€” the workflow-side twin of agentis.mcp.call.
  mcp: { label: 'MCP tool', glyph: 'âŒ¬', category: 'data' },
  data_query: { label: 'Data query', glyph: 'âŒ•', category: 'data' },
  data_mutate: { label: 'Data mutate', glyph: 'âœŽ', category: 'data' },
  aggregate_window: { label: 'Aggregate', glyph: 'âˆ‘', category: 'data' },
  workflow_store: { label: 'Workflow memory', glyph: 'â–¤', category: 'data' },
  workspace_store: { label: 'Workspace memory', glyph: 'â–¦', category: 'data' },
  scratchpad: { label: 'Scratchpad', glyph: 'â—ˆ', category: 'data' },
  code: { label: 'Code', glyph: 'âŒ—', category: 'data' },
  datetime: { label: 'Date & time', glyph: 'â—·', category: 'data' },
  crypto_util: { label: 'Crypto', glyph: 'âš¿', category: 'data' },
  markdown: { label: 'Markdown', glyph: 'â“¶', category: 'data' },
  xml_parse: { label: 'XML', glyph: 'â€¹â€º', category: 'data' },
  html_extract: { label: 'HTML extract', glyph: 'â§‰', category: 'data' },
  json_schema_validate: { label: 'Validate schema', glyph: 'âœ”', category: 'data' },
  spreadsheet: { label: 'Spreadsheet', glyph: 'â–¦', category: 'data' },
  graphql: { label: 'GraphQL', glyph: 'â—­', category: 'data' },
  // Intelligence â€” LLM-powered
  agent_task: { label: 'Agent task', glyph: 'â—Ž', category: 'intelligence' },
  agent_session: { label: 'Agent session', glyph: 'â—', category: 'intelligence' },
  extension_task: { label: 'Extension', glyph: 'â¬¡', category: 'intelligence' },
  agent_swarm: { label: 'Swarm', glyph: 'â‚', category: 'intelligence' },
  dynamic_swarm: { label: 'Dynamic swarm', glyph: 'âœ¸', category: 'intelligence' },
  planner: { label: 'Planner', glyph: 'âŠ¹', category: 'intelligence' },
  evaluator: { label: 'Evaluator', glyph: 'âŠ¨', category: 'intelligence' },
  guardrails: { label: 'Guardrails', glyph: 'âŠ˜', category: 'intelligence' },
  // Knowledge Base (RAG over uploaded docs) â€” distinct from the Brain (memory).
  knowledge: { label: 'Knowledge search', glyph: 'â—‡', category: 'knowledge' },
  knowledge_ingest: { label: 'Knowledge ingest', glyph: 'â‡ª', category: 'knowledge' },
  artifact_collect: { label: 'Collect artifacts', glyph: 'âŠ¡', category: 'knowledge' },
  // Output surface
  return_output: { label: 'Return output', glyph: 'â–£', category: 'output' },
  artifact_save: { label: 'Save artifact', glyph: 'â­³', category: 'output' },
  notify: { label: 'Notify me', glyph: 'âœ‰', category: 'output' },
  sticky_note: { label: 'Sticky note', glyph: 'âœŽ', category: 'output' },
  // Native browser control
  browser: { label: 'Browser', glyph: 'â—', category: 'browser' },
  // Human interaction
  checkpoint: { label: 'Checkpoint', glyph: 'âœ“', category: 'human' },
  human_input: { label: 'Human input', glyph: 'âœ', category: 'human' },
  // Fires a workflow when another workflow's run fails.
  error_trigger: { label: 'Error trigger', glyph: 'âš ', category: 'trigger' },
};

const FALLBACK: NodeKindMeta = { label: 'Step', glyph: 'â€¢', category: 'data' };

/** Presentation metadata for a node kind, with a safe fallback for unknowns. */
export function nodeKindMeta(kind: string | undefined | null): NodeKindMeta {
  if (!kind) return FALLBACK;
  return NODE_KIND_META[kind] ?? { ...FALLBACK, label: humanizeKind(kind) };
}

/** The color for a node kind's category â€” used by the rail and the minimap. */
export function nodeKindColor(kind: string | undefined | null): string {
  return NODE_CATEGORY_META[nodeKindMeta(kind).category].color;
}

function humanizeKind(kind: string): string {
  return kind
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}



