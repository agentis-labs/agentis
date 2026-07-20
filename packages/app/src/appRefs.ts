/**
 * appRefs — the ONE table of "which node config fields point at another entity",
 * used by both directions of packaging.
 *
 * Export discovery and install rebinding used to be two hand-maintained lists
 * (`referencedWorkflowIds` / `rebindWorkflowRefs`), and they drifted: only
 * `subflow` and `loop` were covered, so `converge` / `pursue` / `error_trigger` /
 * listener body workflows silently never travelled, and `data_query.appId` was
 * never rebound — an App imported pointing at the EXPORTER's app id and quietly
 * read nothing. Both failure modes look like a successful import and only surface
 * at run time, because a stale id is still a syntactically valid UUID.
 *
 * So there is exactly one table here, and both `walkNodeRefs` (discovery) and
 * `rewriteNodeRefs` (rebinding) are generated from it. Adding a referencing node
 * kind means adding one row, and both directions get it.
 *
 * Sourced from the TS union in `@agentis/core` (`types/workflow.ts`,
 * `types/listener.ts`) — deliberately NOT from the zod schemas, which cover only a
 * subset of node kinds (no `integration`, `channel`, `mcp`, `loop`, `converge`,
 * `pursue`, `planner`, `http_request`, …) and would silently miss references.
 */

/** What an entity reference points at. */
export type RefKind =
  | 'workflow'
  | 'agent'
  | 'extension'
  | 'knowledgeBase'
  | 'app'
  | 'credential'
  | 'connection'
  /** Connector slug from the in-process registry — declared, never copied. */
  | 'connector'
  /** Referenced by NAME, not id (skills, agent roles). */
  | 'skillName'
  | 'agentRole';

interface RefField {
  /** Dotted path within `node.config`. */
  path: string;
  kind: RefKind;
  /** The App cannot run without this dependency — drives the untick warning. */
  required?: boolean;
  /** Field holds an array of values rather than one. */
  array?: boolean;
  /** Value is a slug/name resolved against the target workspace, never an id to copy. */
  byName?: boolean;
}

/**
 * nodeKind → referencing fields. `config.kind` is matched as a raw string so an
 * unknown/newer node kind simply contributes no refs instead of throwing.
 */
const REF_TABLE: Record<string, RefField[]> = {
  // ── Sub-workflows. All four invoke another workflow via SubflowExecutor. ──
  subflow: [{ path: 'workflowId', kind: 'workflow', required: true }],
  loop: [{ path: 'bodyWorkflowId', kind: 'workflow', required: true }],
  converge: [{ path: 'bodyWorkflowId', kind: 'workflow', required: true }],
  pursue: [{ path: 'bodyWorkflowId', kind: 'workflow', required: true }],
  error_trigger: [{ path: 'targetWorkflowId', kind: 'workflow' }],

  // ── Agents. `agentId` is the id; `agentPackageRef` is the name-based fallback
  //    that survives an id change (see resolvePackageGraphRefs). ──
  agent_task: [
    { path: 'agentId', kind: 'agent', required: true },
    { path: 'agentPackageRef', kind: 'agent', byName: true },
    { path: 'agentRole', kind: 'agentRole', byName: true },
    { path: 'skills', kind: 'skillName', array: true, byName: true },
  ],
  agent_session: [
    { path: 'agentId', kind: 'agent', required: true },
    { path: 'agentRole', kind: 'agentRole', byName: true },
  ],
  agent_swarm: [
    { path: 'agentId', kind: 'agent' },
    { path: 'agentRole', kind: 'agentRole', byName: true },
  ],
  planner: [
    { path: 'agentId', kind: 'agent' },
    { path: 'agentRole', kind: 'agentRole', byName: true },
    { path: 'workerRole', kind: 'agentRole', byName: true },
  ],
  dynamic_swarm: [
    { path: 'agentRole', kind: 'agentRole', byName: true },
    { path: 'plannerRole', kind: 'agentRole', byName: true },
  ],

  // ── Extensions / knowledge ──
  extension_task: [
    { path: 'extensionId', kind: 'extension', required: true },
    { path: 'extensionSlug', kind: 'extension', byName: true },
  ],
  knowledge: [{ path: 'knowledgeBaseId', kind: 'knowledgeBase', required: true }],
  knowledge_ingest: [{ path: 'knowledgeBaseId', kind: 'knowledgeBase' }],

  // ── The App's own datastore. These are SELF-references: on install they must be
  //    rebound to the newly minted app id or the App reads an empty collection. ──
  data_query: [{ path: 'appId', kind: 'app', required: true }],
  data_mutate: [{ path: 'appId', kind: 'app', required: true }],

  // ── External access. Credentials/connections are declared, never copied. ──
  integration: [
    { path: 'integrationId', kind: 'connector', required: true, byName: true },
    { path: 'credentialId', kind: 'credential' },
  ],
  channel: [{ path: 'connectionId', kind: 'connection' }],
  graphql: [{ path: 'credentialId', kind: 'credential' }],
  http_request: [{ path: 'auth.credentialId', kind: 'credential' }],

  // ── Triggers carry nested error-trigger + listener configs. Dotted paths read
  //    through cleanly: a path simply resolves to undefined for other source kinds. ──
  trigger: [
    { path: 'errorTrigger.targetWorkflowId', kind: 'workflow' },
    { path: 'emailImap.credentialId', kind: 'credential' },
    { path: 'listenerConfig.source.workflowId', kind: 'workflow' },
    { path: 'listenerConfig.source.agentId', kind: 'agent' },
    { path: 'listenerConfig.source.extensionId', kind: 'extension' },
    { path: 'listenerConfig.source.credentialId', kind: 'credential' },
    { path: 'listenerConfig.source.authCredentialId', kind: 'credential' },
  ],
};

/**
 * The `knowledge` node's sentinel meaning "use the knowledge bundled with this
 * package". It is not a real knowledge-base id: never export it as a dependency,
 * but DO rewrite it when the installer creates the seeded base.
 */
export const SEED_KNOWLEDGE_SENTINEL = '__seeds';

/** One discovered reference from a node. */
export interface NodeRef {
  kind: RefKind;
  value: string;
  nodeId: string;
  nodeKind: string;
  field: string;
  required: boolean;
  byName: boolean;
}

function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Immutably set a dotted path, cloning only the objects along the way. */
function writePath(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (!head) return source;
  if (rest.length === 0) return { ...source, [head]: value };
  const child = source[head];
  if (child == null || typeof child !== 'object') return source;
  return { ...source, [head]: writePath(child as Record<string, unknown>, rest.join('.'), value) };
}

function graphNodes(graph: unknown): Array<Record<string, unknown>> {
  const nodes = (graph as { nodes?: unknown } | null)?.nodes;
  return Array.isArray(nodes) ? (nodes as Array<Record<string, unknown>>) : [];
}

/** Every entity reference a graph makes. Unknown node kinds contribute nothing. */
export function walkNodeRefs(graph: unknown): NodeRef[] {
  const out: NodeRef[] = [];
  for (const node of graphNodes(graph)) {
    const config = node.config as Record<string, unknown> | undefined;
    const nodeKind = typeof config?.kind === 'string' ? config.kind : '';
    const fields = REF_TABLE[nodeKind];
    if (!config || !fields) continue;
    const nodeId = typeof node.id === 'string' ? node.id : '';
    for (const field of fields) {
      const raw = readPath(config, field.path);
      const values = field.array ? (Array.isArray(raw) ? raw : []) : [raw];
      for (const value of values) {
        if (typeof value !== 'string' || value === '') continue;
        // The seeds sentinel is a marker, not a dependency to collect.
        if (field.kind === 'knowledgeBase' && value === SEED_KNOWLEDGE_SENTINEL) continue;
        out.push({
          kind: field.kind,
          value,
          nodeId,
          nodeKind,
          field: field.path,
          required: field.required ?? false,
          byName: field.byName ?? false,
        });
      }
    }
  }
  return out;
}

/** Just the ids a graph points at, for one kind. Convenience over `walkNodeRefs`. */
export function referencedIds(graph: unknown, kind: RefKind): string[] {
  return [...new Set(walkNodeRefs(graph).filter((ref) => ref.kind === kind && !ref.byName).map((ref) => ref.value))];
}

/** old id → new id, per reference kind. */
export type RefIdMap = Partial<Record<RefKind, Map<string, string>>>;

/**
 * Rewrite every reference through `idMap`, returning a new graph.
 *
 * Unmapped values are left untouched (the dependency genuinely wasn't part of this
 * package), which keeps the rewrite lossless rather than nulling unknown refs. The
 * seeds sentinel IS rewritten when the installer supplies a seeded base.
 */
export function rewriteNodeRefs(graph: unknown, idMap: RefIdMap): unknown {
  const nodes = graphNodes(graph);
  if (nodes.length === 0) return graph;
  const g = graph as Record<string, unknown>;
  let changed = false;

  const nextNodes = nodes.map((node) => {
    const config = node.config as Record<string, unknown> | undefined;
    const nodeKind = typeof config?.kind === 'string' ? config.kind : '';
    const fields = REF_TABLE[nodeKind];
    if (!config || !fields) return node;
    let nextConfig = config;
    for (const field of fields) {
      const map = idMap[field.kind];
      if (!map || map.size === 0) continue;
      const raw = readPath(nextConfig, field.path);
      if (field.array) {
        if (!Array.isArray(raw)) continue;
        const mapped = raw.map((v) => (typeof v === 'string' ? map.get(v) ?? v : v));
        if (mapped.some((v, i) => v !== raw[i])) {
          nextConfig = writePath(nextConfig, field.path, mapped);
          changed = true;
        }
        continue;
      }
      if (typeof raw !== 'string' || raw === '') continue;
      const mapped = map.get(raw);
      if (mapped && mapped !== raw) {
        nextConfig = writePath(nextConfig, field.path, mapped);
        changed = true;
      }
    }
    return nextConfig === config ? node : { ...node, config: nextConfig };
  });

  return changed ? { ...g, nodes: nextNodes } : graph;
}
