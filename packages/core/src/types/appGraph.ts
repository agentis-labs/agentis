/**
 * App graph types — first-class system-composition graph.
 *
 * Spec: docs/app-canvas/APP-CANVAS-ARCHITECTURE.md §7.
 *
 * This is NOT a workflow DAG. It is a system-composition graph: it answers
 * "what is this app made of, how do its modules connect, what enters and what
 * exits". Workflow execution semantics live in `workflow.ts`.
 *
 * Design rules (from §7):
 *   - Strict, minimal node taxonomy (12 types).
 *   - Edges carry semantic meaning (`activates`, `feeds`, `reads_from`, ...),
 *     not generic arrows.
 *   - References (workflowId, agent group, datasetKey, integration key) are
 *     validated against the surrounding scope.
 *   - First zoom should show ≤1 core + 3-7 modules + 2-5 surfaces (§6.3).
 */

// ────────────────────────────────────────────────────────────
// Node taxonomy
// ────────────────────────────────────────────────────────────

export type AppGraphNodeType =
  | 'app_core'
  | 'entry_workflow'
  | 'workflow_module'
  | 'agent_group'
  | 'knowledge_source'
  | 'memory_surface'
  | 'integration_surface'
  | 'approval_surface'
  | 'output_surface'
  | 'scheduler'
  | 'channel_surface'
  | 'brain_surface';

export type AppGraphEdgeType =
  | 'activates'
  | 'feeds'
  | 'reads_from'
  | 'writes_to'
  | 'approves'
  | 'publishes_to'
  | 'observes'
  | 'depends_on';

// ────────────────────────────────────────────────────────────
// Node config (discriminated by `kind`)
// ────────────────────────────────────────────────────────────

/** Centerpiece — identity + entry. Exactly one per graph. */
export interface AppCoreConfig {
  kind: 'app_core';
  /** Optional pointer to the entry workflow. Resolved against package contents. */
  entryWorkflowId?: string;
  /** Short human-facing description shown in the inspector. */
  description?: string;
}

/** Main orchestrating workflow for the app. */
export interface EntryWorkflowConfig {
  kind: 'entry_workflow';
  workflowId: string;
}

/** A reusable / secondary workflow inside the app. */
export interface WorkflowModuleConfig {
  kind: 'workflow_module';
  workflowId: string;
}

/** A logical group of agents or a major role cluster. */
export interface AgentGroupConfig {
  kind: 'agent_group';
  /** Free-form group key — usually a role like `sdr`, `qa`, `triage`. */
  groupKey: string;
  /** Concrete agentIds that belong to the group (for binding/validation). */
  agentIds?: string[];
  /** Optional inline description. */
  role?: string;
}

/** Imported dataset or seed-based knowledge domain. */
export interface KnowledgeSourceConfig {
  kind: 'knowledge_source';
  /** `datasetSpecs[].key` from the package manifest. */
  datasetKey: string;
}

/**
 * Memory surface — represents the memory subsystem of the app as a module.
 * NOT the internal memory graph; that lives in The Brain UX.
 */
export interface MemorySurfaceConfig {
  kind: 'memory_surface';
  /** Optional scope hint shown in the inspector. */
  scope?: 'episodic' | 'app_knowledge' | 'evaluator' | 'all';
}

/** External operational system — HubSpot, Notion, Slack, GitHub, ERP, … */
export interface IntegrationSurfaceConfig {
  kind: 'integration_surface';
  /** Service identifier, e.g. `hubspot`, `slack`, `notion`. */
  service: string;
  /** Display label override. */
  label?: string;
}

/** A human checkpoint zone. */
export interface ApprovalSurfaceConfig {
  kind: 'approval_surface';
  /** Free-form policy key — bound to a checkpoint node in the workflow graph. */
  policyKey?: string;
}

/** A meaningful outcome — booked meetings, generated reports, updated CRM. */
export interface OutputSurfaceConfig {
  kind: 'output_surface';
  /** Output label key — references `outputLabels` in app manifest. */
  outputKey?: string;
  /**
   * Artifact-first kind (10.10): describes WHAT the operator will see, not
   * just a number format. Drives the rendering surface in the runtime.
   */
  artifactType?: 'document' | 'metric' | 'chart' | 'list' | 'file' | 'decision' | 'custom';
  /** Optional unit/format hint shown in the inspector (legacy). */
  format?: 'number' | 'currency' | 'percent' | 'text';
}

/** Cron or event-based recurring activation. */
export interface SchedulerConfig {
  kind: 'scheduler';
  /** Cron expression, RFC-5322 schedule string, or a free-form description. */
  schedule: string;
  /** Optional reference to a trigger row. */
  triggerId?: string;
}

/** External communication channel — email, chat, voice, SMS. */
export interface ChannelSurfaceConfig {
  kind: 'channel_surface';
  /** Channel kind, e.g. `email`, `slack`, `telegram`. */
  channel: string;
  direction?: 'inbound' | 'outbound' | 'both';
}

/** Bridge into the Memory layer (THE-BRAIN-UX-ARCHITECTURE). */
export interface BrainSurfaceConfig {
  kind: 'brain_surface';
  /** Pinned topic the brain surface highlights at first zoom. */
  topic?: string;
}

export type AppGraphNodeConfig =
  | AppCoreConfig
  | EntryWorkflowConfig
  | WorkflowModuleConfig
  | AgentGroupConfig
  | KnowledgeSourceConfig
  | MemorySurfaceConfig
  | IntegrationSurfaceConfig
  | ApprovalSurfaceConfig
  | OutputSurfaceConfig
  | SchedulerConfig
  | ChannelSurfaceConfig
  | BrainSurfaceConfig;

// ────────────────────────────────────────────────────────────
// Graph
// ────────────────────────────────────────────────────────────

export interface AppGraphNode {
  id: string;
  type: AppGraphNodeType;
  title: string;
  position: { x: number; y: number };
  config: AppGraphNodeConfig;
  /** Optional layout zone hint — used by auto-layout. */
  zone?: 'inputs' | 'core' | 'outputs';
}

export interface AppGraphEdge {
  id: string;
  source: string;
  target: string;
  type: AppGraphEdgeType;
  /** Free-form label shown on hover. */
  label?: string;
}

export interface AppGraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface AppGraph {
  version: 1;
  nodes: AppGraphNode[];
  edges: AppGraphEdge[];
  viewport: AppGraphViewport;
}

// ────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────

export interface AppGraphValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  nodeId?: string;
  edgeId?: string;
}

export interface AppGraphValidationResult {
  errors: AppGraphValidationIssue[];
  warnings: AppGraphValidationIssue[];
}

/** References needed to validate a graph against its surrounding app scope. */
export interface AppGraphReferenceScope {
  workflows: Array<{ id: string; title: string }>;
  collections?: Array<{ name: string; workflows: Array<{ id: string; title: string }> }>;
  agents: Array<{ id: string; name: string; role?: string | null }>;
  datasets: Array<{ key: string; label: string; status?: string }>;
  integrations: Array<{ service: string; name?: string }>;
  outputLabels?: Array<{ label: string; path: string }>;
}

// ────────────────────────────────────────────────────────────
// API contract
// ────────────────────────────────────────────────────────────

export interface AppCanvasResponse {
  app: {
    id: string;
    slug: string;
    name: string;
    status: string;
  };
  graph: AppGraph;
  references: AppGraphReferenceScope;
  validation: {
    warnings: Array<{ code: string; message: string; nodeId?: string }>;
    errors: Array<{ code: string; message: string; nodeId?: string }>;
  };
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

export const APP_GRAPH_NODE_TYPES = [
  'app_core',
  'entry_workflow',
  'workflow_module',
  'agent_group',
  'knowledge_source',
  'memory_surface',
  'integration_surface',
  'approval_surface',
  'output_surface',
  'scheduler',
  'channel_surface',
  'brain_surface',
] as const satisfies ReadonlyArray<AppGraphNodeType>;

export const APP_GRAPH_EDGE_TYPES = [
  'activates',
  'feeds',
  'reads_from',
  'writes_to',
  'approves',
  'publishes_to',
  'observes',
  'depends_on',
] as const satisfies ReadonlyArray<AppGraphEdgeType>;

/** Default empty graph used as the bootstrap shape. */
export function emptyAppGraph(): AppGraph {
  return {
    version: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}
