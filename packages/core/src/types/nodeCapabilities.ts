/**
 * Node Capability Manifests (NATIVE-ADVANCEMENT Proposal 6b).
 *
 * Every workflow node kind declares, statically, what it can reach and what it
 * sends out. This is a *transparency / audit* layer, not a sandbox: it lets a
 * user (or the canvas) see "this workflow contacts N external hosts, sends user
 * data to a model provider, and needs these credentials" BEFORE running —
 * answering the "the abstractions are pre-written, what do they actually do?"
 * concern with a machine-readable declaration instead of a code audit.
 *
 * Honesty rules followed here:
 *  - Agent / swarm / extension / browser nodes are marked `unrestricted`
 *    network because we cannot statically bound the tools they invoke. We do
 *    not pretend otherwise.
 *  - `transform` / `filter` evaluate a guarded expression mini-language
 *    (SafeConditionParser), NOT arbitrary code, so `codeExecution` is false.
 *  - `subflow` / `loop` / `parallel` delegate to other graphs; their real
 *    capability is the union of their children. At this node they declare no
 *    direct external access and carry a `delegates` note.
 *
 * This module is pure and browser-safe (no `node:` imports) so the web canvas
 * can render the same summary the API computes.
 */

import type { WorkflowGraph } from './workflow.js';

export type WorkflowRepairImpact = 'internal' | 'external_or_irreversible' | 'unknown';

export interface WorkflowRepairImpactAssessment {
  impact: WorkflowRepairImpact;
  changedNodeIds: string[];
  reason: string;
}

export type NetworkAccess = 'none' | 'declared' | 'unrestricted';
export type FilesystemAccess = 'none' | 'workspace-read' | 'workspace-write';
export type ExternalDataPolicy = 'none' | 'user-data' | 'declared';
export type CodeExecutionSandbox = 'none' | 'expression' | 'process' | 'container';

export interface NodeCapabilityManifest {
  nodeKind: string;
  /** What external hosts can this node reach? */
  networkAccess: NetworkAccess;
  /** Statically-known hosts when `networkAccess === 'declared'`. */
  declaredHosts?: string[];
  filesystemAccess: FilesystemAccess;
  /** Credential *categories* this node may require (not the secrets themselves). */
  credentialTypes: string[];
  /** What user/workspace data leaves the instance. */
  externalDataSent: ExternalDataPolicy;
  /** Whether this node executes code beyond the guarded expression language. */
  codeExecution: boolean;
  codeExecutionSandbox?: CodeExecutionSandbox;
  /** Human one-liner shown in the audit view. */
  summary: string;
}

const LLM_CRED = ['model_provider'];

/** A purely-local node: touches only the run/workspace state, nothing external. */
function local(nodeKind: string, summary: string, fs: FilesystemAccess = 'none'): NodeCapabilityManifest {
  return {
    nodeKind,
    networkAccess: 'none',
    filesystemAccess: fs,
    credentialTypes: [],
    externalDataSent: 'none',
    codeExecution: false,
    summary,
  };
}

/** An LLM-backed reasoning node: talks to the model provider with user data. */
function llm(nodeKind: string, summary: string, network: NetworkAccess): NodeCapabilityManifest {
  return {
    nodeKind,
    networkAccess: network,
    filesystemAccess: 'none',
    credentialTypes: LLM_CRED,
    externalDataSent: 'user-data',
    codeExecution: false,
    summary,
  };
}

/**
 * Static capability catalog for every supported node kind. Mirror this whenever
 * `SUPPORTED_NODE_KINDS` (engine/validateGraph.ts) changes.
 */
export const NODE_CAPABILITY_CATALOG: Record<string, NodeCapabilityManifest> = {
  // --- entry / control flow: purely local -------------------------------
  trigger: local('trigger', 'Entry point; no external access.'),
  router: local('router', 'Routes the active branch; no external access.'),
  merge: local('merge', 'Joins branches; no external access.'),
  wait: local('wait', 'Sleeps for a delay; no external access.'),
  return_output: local('return_output', 'Marks final output; no external access.'),
  checkpoint: local('checkpoint', 'Human approval gate; no external network.'),
  scratchpad: local('scratchpad', 'Reads/writes run-local scratch state.'),
  workflow_store: local('workflow_store', 'Run-scoped key/value store (local DB).'),
  workspace_store: local('workspace_store', 'Workspace-scoped key/value store (local DB).'),
  transform: local('transform', 'Evaluates a guarded expression (no arbitrary code).'),
  filter: local('filter', 'Evaluates a guarded condition (no arbitrary code).'),
  artifact_collect: local('artifact_collect', 'Gathers run artifacts.', 'workspace-read'),
  artifact_save: local('artifact_save', 'Persists an artifact to the workspace.', 'workspace-write'),

  // --- LLM reasoning ----------------------------------------------------
  agent_task: llm('agent_task', 'Runs an agent; may use arbitrary tools (network unbounded).', 'unrestricted'),
  agent_session: llm('agent_session', 'Persistent agent session; may use arbitrary tools.', 'unrestricted'),
  agent_swarm: llm('agent_swarm', 'Runs multiple agents; may use arbitrary tools.', 'unrestricted'),
  dynamic_swarm: llm('dynamic_swarm', 'Spawns agents dynamically; may use arbitrary tools.', 'unrestricted'),
  planner: llm('planner', 'LLM planning call to the model provider.', 'declared'),
  evaluator: llm('evaluator', 'LLM-based evaluation against the model provider.', 'declared'),
  guardrails: llm('guardrails', 'Validates content; may call the model provider.', 'declared'),

  // --- external I/O -----------------------------------------------------
  knowledge: {
    nodeKind: 'knowledge',
    networkAccess: 'declared',
    declaredHosts: [],
    filesystemAccess: 'workspace-read',
    credentialTypes: ['embedding_provider'],
    externalDataSent: 'user-data',
    codeExecution: false,
    summary: 'Retrieves from the knowledge base; sends the query to the embedding provider.',
  },
  knowledge_ingest: {
    nodeKind: 'knowledge_ingest',
    networkAccess: 'declared',
    declaredHosts: [],
    filesystemAccess: 'workspace-read',
    credentialTypes: ['embedding_provider'],
    externalDataSent: 'user-data',
    codeExecution: false,
    summary: 'Writes upstream content into the workspace knowledge base; sends it to the embedding provider.',
  },
  http_request: {
    nodeKind: 'http_request',
    networkAccess: 'declared',
    declaredHosts: [],
    filesystemAccess: 'none',
    credentialTypes: ['http_auth'],
    externalDataSent: 'declared',
    codeExecution: false,
    summary: 'Makes an outbound HTTP request to the configured URL.',
  },
  integration: {
    nodeKind: 'integration',
    networkAccess: 'declared',
    declaredHosts: [],
    filesystemAccess: 'none',
    credentialTypes: ['integration'],
    externalDataSent: 'declared',
    codeExecution: false,
    summary: 'Calls an external integration operation.',
  },
  extension_task: {
    nodeKind: 'extension_task',
    networkAccess: 'unrestricted',
    filesystemAccess: 'workspace-write',
    credentialTypes: ['extension'],
    externalDataSent: 'declared',
    codeExecution: true,
    codeExecutionSandbox: 'process',
    summary: 'Runs an extension operation (executes extension code).',
  },
  browser: {
    nodeKind: 'browser',
    networkAccess: 'unrestricted',
    filesystemAccess: 'workspace-write',
    credentialTypes: [],
    externalDataSent: 'declared',
    codeExecution: true,
    codeExecutionSandbox: 'process',
    summary: 'Drives a headless browser (navigates and runs page scripts).',
  },

  // --- utility & data primitives (WORKFLOW-UPDATE) ---------------------
  // Deterministic, local-only transforms. No network, no credentials.
  error_trigger: local('error_trigger', 'Entry point fired on another workflow’s failure; no external access.'),
  stop_error: local('stop_error', 'Terminates the run with a custom error; no external access.'),
  datetime: local('datetime', 'Parses/formats/diffs dates locally; no external access.'),
  xml_parse: local('xml_parse', 'Converts XML ↔ JSON locally; no external access.'),
  markdown: local('markdown', 'Converts Markdown ↔ HTML locally; no external access.'),
  json_schema_validate: local('json_schema_validate', 'Validates data against a JSON Schema locally; no external access.'),
  sticky_note: local('sticky_note', 'Canvas annotation; no execution, no external access.'),
  html_extract: local('html_extract', 'Extracts values from an HTML string by selector; no external access.'),
  // Crypto primitives use local crypto APIs only — no network.
  crypto_util: {
    nodeKind: 'crypto_util',
    networkAccess: 'none',
    filesystemAccess: 'none',
    credentialTypes: [],
    externalDataSent: 'none',
    codeExecution: false,
    summary: 'Hashes/HMACs/encodes values with local crypto; no external access.',
  },
  // Parses/builds CSV/XLSX in-process; may read large workspace data.
  spreadsheet: local('spreadsheet', 'Parses/builds CSV or XLSX in-process; no external access.'),
  // Sandboxed code: JS in a guarded VM realm (expression sandbox), Python in a child process.
  code: {
    nodeKind: 'code',
    networkAccess: 'none',
    filesystemAccess: 'none',
    credentialTypes: [],
    externalDataSent: 'none',
    codeExecution: true,
    codeExecutionSandbox: 'expression',
    summary: 'Runs user-supplied JavaScript in a guarded VM realm (or Python in a child process).',
  },
  // GraphQL is an outbound HTTP request to a declared endpoint.
  graphql: {
    nodeKind: 'graphql',
    networkAccess: 'declared',
    declaredHosts: [],
    filesystemAccess: 'none',
    credentialTypes: ['http_auth'],
    externalDataSent: 'declared',
    codeExecution: false,
    summary: 'Sends a GraphQL query to the configured endpoint.',
  },

  // --- composite / delegating ------------------------------------------
  subflow: {
    nodeKind: 'subflow',
    networkAccess: 'none',
    filesystemAccess: 'none',
    credentialTypes: [],
    externalDataSent: 'none',
    codeExecution: false,
    summary: 'Delegates to a sub-workflow; its capabilities are the child workflow’s.',
  },
  loop: {
    nodeKind: 'loop',
    networkAccess: 'none',
    filesystemAccess: 'none',
    credentialTypes: [],
    externalDataSent: 'none',
    codeExecution: false,
    summary: 'Iterates a body workflow; its capabilities are the body’s.',
  },
  parallel: {
    nodeKind: 'parallel',
    networkAccess: 'none',
    filesystemAccess: 'none',
    credentialTypes: [],
    externalDataSent: 'none',
    codeExecution: false,
    summary: 'Fans out to branches; its capabilities are the branches’.',
  },
};

/**
 * Classify a graph change for recovery approval. This deliberately derives from
 * the capability catalog so self-healing does not grow a second, drifting list
 * of dangerous node kinds. Agentic nodes are `unknown`: their tool behavior is
 * not statically provable, so guarded autonomy asks before their behavior is
 * changed while bypass remains fully autonomous.
 */
export function assessWorkflowRepairImpact(before: WorkflowGraph, after: WorkflowGraph): WorkflowRepairImpactAssessment {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node] as const));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node] as const));
  const changed = new Set<string>();
  for (const id of new Set([...beforeNodes.keys(), ...afterNodes.keys()])) {
    if (JSON.stringify(beforeNodes.get(id)) !== JSON.stringify(afterNodes.get(id))) changed.add(id);
  }
  const effect = (node: typeof before.nodes[number] | undefined): WorkflowRepairImpact => {
    if (!node) return 'internal';
    const kind = node.config?.kind ?? node.type;
    if (kind === 'agent_task' || kind === 'agent_session' || kind === 'agent_swarm' || kind === 'dynamic_swarm') return 'unknown';
    const manifest = NODE_CAPABILITY_CATALOG[kind];
    if (!manifest) return 'unknown';
    if (
      manifest.networkAccess !== 'none' ||
      manifest.externalDataSent !== 'none' ||
      manifest.codeExecution ||
      manifest.filesystemAccess === 'workspace-write'
    ) return 'external_or_irreversible';
    return 'internal';
  };
  let impact: WorkflowRepairImpact = 'internal';
  for (const id of changed) {
    const nodeImpact = effect(afterNodes.get(id) ?? beforeNodes.get(id));
    if (nodeImpact === 'unknown') { impact = 'unknown'; break; }
    if (nodeImpact === 'external_or_irreversible') impact = 'external_or_irreversible';
  }
  const changedNodeIds = [...changed];
  if (impact === 'unknown') {
    return { impact, changedNodeIds, reason: 'The repair changes an agentic or unclassified step whose outward effects cannot be proven statically.' };
  }
  if (impact === 'external_or_irreversible') {
    return { impact, changedNodeIds, reason: 'The repair changes a step that reaches an external system, executes code, or writes persistent workspace data.' };
  }
  return { impact, changedNodeIds, reason: 'The repair changes only local, deterministic workflow behavior.' };
}

export interface GraphCapabilitySummary {
  nodeCount: number;
  /** Count of nodes per kind, for a quick composition view. */
  perKind: Record<string, number>;
  /** Statically-known external hosts (declared + extracted from node config). */
  externalHosts: string[];
  /** True if any node has unbounded network access (agents, extensions, browser). */
  hasUnrestrictedNetwork: boolean;
  /** True if any node sends user/workspace data off the instance. */
  sendsDataExternally: boolean;
  /** Union of credential categories the workflow may require. */
  requiresCredentials: string[];
  /** True if any node executes code beyond the guarded expression language. */
  runsCode: boolean;
  /** True if any node writes to the workspace filesystem. */
  writesFilesystem: boolean;
  /** Node kinds present that have no manifest (catalog gap — should be empty). */
  unknownNodeKinds: string[];
  /** Human-readable one-paragraph summary for the audit view. */
  headline: string;
}

/** Best-effort host extraction from a templated URL. Returns null if unparseable. */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Skip obviously-templated URLs ({{...}}) — host is not statically known.
  if (url.includes('{{') || url.includes('${')) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Aggregate every node's manifest into a workflow-level security summary.
 * Pure: safe to call from the API or the web canvas.
 */
export function summarizeGraphCapabilities(graph: WorkflowGraph): GraphCapabilitySummary {
  const perKind: Record<string, number> = {};
  const hosts = new Set<string>();
  const creds = new Set<string>();
  const unknown = new Set<string>();
  let hasUnrestrictedNetwork = false;
  let sendsDataExternally = false;
  let runsCode = false;
  let writesFilesystem = false;

  for (const node of graph.nodes) {
    const kind = node.config?.kind ?? node.type;
    perKind[kind] = (perKind[kind] ?? 0) + 1;
    const manifest = NODE_CAPABILITY_CATALOG[kind];
    if (!manifest) {
      unknown.add(kind);
      continue;
    }
    if (manifest.networkAccess === 'unrestricted') hasUnrestrictedNetwork = true;
    for (const h of manifest.declaredHosts ?? []) hosts.add(h);
    for (const cat of manifest.credentialTypes) creds.add(cat);
    if (manifest.externalDataSent !== 'none') sendsDataExternally = true;
    if (manifest.codeExecution) runsCode = true;
    if (manifest.filesystemAccess === 'workspace-write') writesFilesystem = true;

    // Enrich with statically-known hosts from node config.
    const cfg = node.config as unknown as Record<string, unknown>;
    if (kind === 'http_request') {
      const h = hostOf(cfg.url);
      if (h) hosts.add(h);
    }
    if (kind === 'graphql') {
      const h = hostOf(cfg.endpoint);
      if (h) hosts.add(h);
    }
  }

  const externalHosts = [...hosts].sort();
  const requiresCredentials = [...creds].sort();
  const unknownNodeKinds = [...unknown].sort();

  const parts: string[] = [];
  if (externalHosts.length > 0) {
    parts.push(`contacts ${externalHosts.length} known external host(s): ${externalHosts.join(', ')}`);
  }
  if (hasUnrestrictedNetwork) {
    parts.push('includes agent/extension/browser nodes with unbounded network access');
  }
  if (sendsDataExternally) parts.push('sends data off the instance');
  if (requiresCredentials.length > 0) {
    parts.push(`requires credentials: ${requiresCredentials.join(', ')}`);
  }
  if (runsCode) parts.push('executes code');
  if (writesFilesystem) parts.push('writes to the workspace');
  if (parts.length === 0) parts.push('no external access — purely local');

  const headline = `This workflow ${parts.join('; ')}.`;

  return {
    nodeCount: graph.nodes.length,
    perKind,
    externalHosts,
    hasUnrestrictedNetwork,
    sendsDataExternally,
    requiresCredentials,
    runsCode,
    writesFilesystem,
    unknownNodeKinds,
    headline,
  };
}
