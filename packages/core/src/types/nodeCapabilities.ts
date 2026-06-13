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
