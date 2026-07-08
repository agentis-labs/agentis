/**
 * The `<proposed_plan>` / `<architecture_canvas>` plan-mode protocol.
 *
 * A plan-mode turn's raw text may embed a readable plan and, for design-shaped
 * requests, a compact JSON architecture preview. Shared between the web chat
 * UI (renders `ChatPlanCanvas`) and the API (repairs a turn that emitted a
 * plan but skipped or malformed the architecture JSON) so both sides agree on
 * exactly one grammar.
 */

export type ArchitectureCanvasKind = 'workflow' | 'extension' | 'app' | 'system';

export interface ArchitectureCanvasNode {
  id: string;
  title: string;
  role: string;
  kind?: string;
  summary?: string;
  group?: string;
}

export interface ArchitectureCanvasEdge {
  source: string;
  target: string;
  label?: string;
}

export interface ArchitectureCanvasGroup {
  id: string;
  title: string;
}

export interface ArchitectureCanvasPayload {
  kind: ArchitectureCanvasKind;
  nodes: ArchitectureCanvasNode[];
  edges: ArchitectureCanvasEdge[];
  groups?: ArchitectureCanvasGroup[];
}

export interface ParsedAgentPlan {
  before: string;
  planText: string;
  after: string;
  architecture: ArchitectureCanvasPayload | null;
}

const ARCHITECTURE_KINDS = new Set<ArchitectureCanvasKind>(['workflow', 'extension', 'app', 'system']);

export function extractAgentPlan(text: string): ParsedAgentPlan | null {
  const planMatch = findTaggedBlock(text, 'proposed_plan');
  if (!planMatch) return null;
  const planText = planMatch.inner.trim();
  if (!planText) return null;

  const architectureMatch = findTaggedBlock(text, 'architecture_canvas');
  const architecture = parseArchitectureCanvas(architectureMatch?.inner ?? null);
  const before = removeTaggedBlock(text.slice(0, planMatch.start), 'architecture_canvas').trim();
  const after = removeTaggedBlock(text.slice(planMatch.end), 'architecture_canvas').trim();

  return {
    before,
    planText,
    after,
    architecture,
  };
}

/**
 * Does `text` contain a `<proposed_plan>` but no *valid* `<architecture_canvas>`?
 * Used by the API's repair pass to decide whether a follow-up structured
 * completion is worth issuing (only for design-shaped requests, judged by the
 * caller — this just answers the parse question).
 */
export function planMissingArchitectureCanvas(text: string): boolean {
  const planMatch = findTaggedBlock(text, 'proposed_plan');
  if (!planMatch) return false;
  const architectureMatch = findTaggedBlock(text, 'architecture_canvas');
  return parseArchitectureCanvas(architectureMatch?.inner ?? null) === null;
}

interface TaggedBlock {
  start: number;
  end: number;
  inner: string;
}

function findTaggedBlock(text: string, tag: 'proposed_plan' | 'architecture_canvas'): TaggedBlock | null {
  const lower = text.toLowerCase();
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = lower.indexOf(open);
  if (start < 0) return null;
  const innerStart = start + open.length;
  const closeStart = lower.indexOf(close, innerStart);
  if (closeStart < 0) return null;
  return {
    start,
    end: closeStart + close.length,
    inner: text.slice(innerStart, closeStart),
  };
}

function removeTaggedBlock(text: string, tag: 'proposed_plan' | 'architecture_canvas'): string {
  const block = findTaggedBlock(text, tag);
  return block ? `${text.slice(0, block.start)}${text.slice(block.end)}` : text;
}

export function parseArchitectureCanvas(raw: string | null): ArchitectureCanvasPayload | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!ARCHITECTURE_KINDS.has(record.kind as ArchitectureCanvasKind)) return null;
    const nodes = normalizeNodes(record.nodes);
    if (nodes.length === 0) return null;
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      kind: record.kind as ArchitectureCanvasKind,
      nodes,
      edges: normalizeEdges(record.edges, nodeIds),
      groups: normalizeGroups(record.groups),
    };
  } catch {
    return null;
  }
}

function normalizeNodes(value: unknown): ArchitectureCanvasNode[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const nodes: ArchitectureCanvasNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    const title = stringValue(record.title);
    const role = stringValue(record.role);
    if (!id || !title || !role || seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      title,
      role,
      ...(stringValue(record.kind) ? { kind: stringValue(record.kind) } : {}),
      ...(stringValue(record.summary) ? { summary: stringValue(record.summary) } : {}),
      ...(stringValue(record.group) ? { group: stringValue(record.group) } : {}),
    });
  }
  return nodes.slice(0, 18);
}

function normalizeEdges(value: unknown, nodeIds: Set<string>): ArchitectureCanvasEdge[] {
  if (!Array.isArray(value)) return [];
  const edges: ArchitectureCanvasEdge[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const source = stringValue(record.source);
    const target = stringValue(record.target);
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) continue;
    edges.push({
      source,
      target,
      ...(stringValue(record.label) ? { label: stringValue(record.label) } : {}),
    });
  }
  return edges.slice(0, 32);
}

function normalizeGroups(value: unknown): ArchitectureCanvasGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = stringValue(record.id);
    const title = stringValue(record.title);
    return id && title ? [{ id, title }] : [];
  });
  return groups.length > 0 ? groups.slice(0, 8) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
