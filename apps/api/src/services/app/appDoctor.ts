/**
 * Domain-neutral App conformance doctor.
 *
 * This module is deliberately pure: callers provide a normalized snapshot and
 * receive deterministic findings. It does not mutate the App, execute a run, or
 * mistake a UI label for an executable rule. The database adapter lives beside
 * it in appDoctorSnapshot.ts.
 */

import {
  appWorkflowBindingSchema,
  conversationScriptSchema,
  type ConversationScript,
  type SurfaceAction,
  type WorkflowGraph,
} from '@agentis/core';
import { graphContentHash } from '../workflow/workflowCompass.js';
import { readWorkflowSpec, validateWorkflowSpec } from '../workflow/workflowSpec.js';

export type AppDoctorSeverity = 'critical' | 'error' | 'warning' | 'info';
export type AppDoctorLayer = 'binding' | 'activation' | 'outcome' | 'event' | 'state' | 'connection' | 'surface';

export interface AppDoctorRemediation {
  /** Stable operation an agent can plan against; this doctor never applies it. */
  operation: string;
  description: string;
  args?: Record<string, unknown>;
}

export interface AppDoctorFinding {
  id: string;
  code: string;
  severity: AppDoctorSeverity;
  layer: AppDoctorLayer;
  summary: string;
  evidence: Record<string, unknown>;
  resources: Array<{ kind: string; id: string; title?: string }>;
  remediation: AppDoctorRemediation;
}

export interface AppDoctorWorkflowSnapshot {
  id: string;
  title: string;
  graph: WorkflowGraph;
  settings: unknown;
  contentHash?: string | null;
  triggers: Array<{ id: string; triggerType: string; status: string }>;
}

export interface AppDoctorSubscriptionSnapshot {
  id: string;
  sourceWorkflowId: string;
  targetWorkflowId: string;
  eventType: string;
  sourceNodeId?: string | null;
  enabled: boolean;
}

export interface AppDoctorConnectionSnapshot {
  id: string;
  name: string;
  kind: string;
  appId?: string | null;
  status: string;
}

export interface AppDoctorCollectionSnapshot {
  name: string;
  schema: { fields: Array<{ key: string; required?: boolean }>; strict?: boolean };
  /** Only control-plane records needed for conformance (currently conversation_script). */
  records?: Array<{ id: string; data: Record<string, unknown> }>;
}

export interface AppDoctorSurfaceSnapshot {
  id: string;
  name: string;
  view: unknown;
  actions: SurfaceAction[];
}

export interface AppDoctorSnapshot {
  app: { id: string; name: string; status: string };
  workflows: AppDoctorWorkflowSnapshot[];
  subscriptions: AppDoctorSubscriptionSnapshot[];
  connections: AppDoctorConnectionSnapshot[];
  collections: AppDoctorCollectionSnapshot[];
  surfaces: AppDoctorSurfaceSnapshot[];
}

export interface AppDoctorReport {
  appId: string;
  generatedAt: string;
  health: 'healthy' | 'degraded' | 'broken';
  readyForUnattended: boolean;
  summary: {
    critical: number;
    error: number;
    warning: number;
    info: number;
    workflows: number;
    executableRules: number;
  };
  topology: {
    roots: string[];
    dependencyEdges: number;
    activeEventSubscriptions: number;
    activeTriggers: number;
    conversationTransitions: number;
  };
  findings: AppDoctorFinding[];
}

const NON_MANUAL_TRIGGER_TYPES = new Set(['cron', 'webhook', 'persistent_listener', 'error_trigger', 'email_imap', 'rss_feed']);
const ORCHESTRATION_ACTION_RE = /(?:orchestrat|automat|pipeline|chain|run[_ -]?all)/iu;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;

/** Inspect a normalized App snapshot without reading or changing external state. */
export function validateAppConformance(snapshot: AppDoctorSnapshot, now = new Date()): AppDoctorReport {
  const findings: AppDoctorFinding[] = [];
  const workflowById = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]));
  const memberIds = new Set(workflowById.keys());
  const bindings = new Map(snapshot.workflows.map((workflow) => {
    const raw = record(workflow.settings)?.appBinding;
    const parsed = appWorkflowBindingSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      add(findings, {
        code: 'BINDING_INVALID', severity: 'error', layer: 'binding', resourceId: workflow.id,
        summary: `Workflow “${workflow.title}” has an invalid App binding.`,
        evidence: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
        resources: [resource('workflow', workflow.id, workflow.title)],
        remediation: { operation: 'workflow.binding.patch', description: 'Replace the invalid binding with a schema-valid binding.', args: { workflowId: workflow.id } },
      });
    }
    return [workflow.id, parsed.success ? parsed.data : appWorkflowBindingSchema.parse({})] as const;
  }));

  const dependencyGraph = new Map<string, string[]>();
  let dependencyEdges = 0;
  let executableDependencyEdges = 0;
  for (const workflow of snapshot.workflows) {
    const binding = bindings.get(workflow.id)!;
    const validDependencies: string[] = [];
    for (const dependencyId of binding.dependsOn ?? []) {
      dependencyEdges += 1;
      if (dependencyId === workflow.id) {
        add(findings, {
          code: 'BINDING_SELF_DEPENDENCY', severity: 'critical', layer: 'binding', resourceId: workflow.id,
          summary: `Workflow “${workflow.title}” depends on itself.`, evidence: { dependencyId },
          resources: [resource('workflow', workflow.id, workflow.title)],
          remediation: { operation: 'workflow.binding.patch', description: 'Remove the self-dependency.', args: { workflowId: workflow.id, removeDependsOn: [dependencyId] } },
        });
      } else if (!memberIds.has(dependencyId)) {
        add(findings, {
          code: 'BINDING_DEPENDENCY_OUTSIDE_APP', severity: 'error', layer: 'binding', resourceId: `${workflow.id}:${dependencyId}`,
          summary: `Workflow “${workflow.title}” depends on a workflow that is not in this App.`, evidence: { dependencyId },
          resources: [resource('workflow', workflow.id, workflow.title)],
          remediation: { operation: 'workflow.binding.patch', description: 'Adopt the dependency into the App or remove the dangling dependency.', args: { workflowId: workflow.id, dependencyId } },
        });
      } else {
        validDependencies.push(dependencyId);
        const upstream = workflowById.get(dependencyId)!;
        if (binding.enabled !== false && bindings.get(dependencyId)?.enabled !== false) executableDependencyEdges += 1;
        if (bindings.get(dependencyId)?.enabled === false && binding.enabled !== false) {
          add(findings, {
            code: 'BINDING_DISABLED_UPSTREAM', severity: 'error', layer: 'binding', resourceId: `${workflow.id}:${dependencyId}`,
            summary: `Enabled workflow “${workflow.title}” waits on disabled workflow “${upstream.title}”.`, evidence: { dependencyId },
            resources: [resource('workflow', workflow.id, workflow.title), resource('workflow', upstream.id, upstream.title)],
            remediation: { operation: 'workflow.binding.patch', description: 'Enable the upstream workflow or remove/replace this dependency.', args: { workflowId: dependencyId, enabled: true } },
          });
        }
        if ((binding.chainOn ?? 'success') === 'success' && !readWorkflowSpec(upstream.settings)) {
          add(findings, {
            code: 'OUTCOME_CHAIN_USES_COMPLETION', severity: 'warning', layer: 'outcome', resourceId: `${workflow.id}:${dependencyId}`,
            summary: `The success chain from “${upstream.title}” to “${workflow.title}” has no verifiable definition of done.`,
            evidence: { chainOn: 'success', behavior: 'clean completion is treated as success because the upstream has no WorkflowSpec' },
            resources: [resource('workflow', upstream.id, upstream.title), resource('workflow', workflow.id, workflow.title)],
            remediation: { operation: 'workflow.spec.define', description: 'Define world-verifiable acceptance checks for the upstream workflow before using success chaining.', args: { workflowId: upstream.id } },
          });
        }
      }
    }
    dependencyGraph.set(workflow.id, validDependencies);
  }
  const cycle = firstCycle(dependencyGraph);
  if (cycle) {
    add(findings, {
      code: 'BINDING_DEPENDENCY_CYCLE', severity: 'critical', layer: 'binding', resourceId: cycle.join(':'),
      summary: 'Workflow dependencies contain a cycle.', evidence: { cycle },
      resources: cycle.slice(0, -1).map((id) => resource('workflow', id, workflowById.get(id)?.title)),
      remediation: { operation: 'workflow.binding.patch', description: 'Remove at least one dependency edge so the graph is acyclic.', args: { cycle } },
    });
  }

  let activeTriggers = 0;
  for (const workflow of snapshot.workflows) {
    const graphTriggers = workflow.graph.nodes.filter((node) => node.type === 'trigger');
    if (graphTriggers.length === 0) {
      add(findings, {
        code: 'ACTIVATION_NO_TRIGGER_NODE', severity: 'error', layer: 'activation', resourceId: workflow.id,
        summary: `Workflow “${workflow.title}” has no trigger node.`, evidence: {},
        resources: [resource('workflow', workflow.id, workflow.title)],
        remediation: { operation: 'workflow.graph.patch', description: 'Add an explicit trigger node.', args: { workflowId: workflow.id } },
      });
    }
    for (const node of graphTriggers) {
      const triggerType = String(record(node.config)?.triggerType ?? 'manual');
      if (!NON_MANUAL_TRIGGER_TYPES.has(triggerType)) continue;
      const triggerId = string(record(node.config)?.triggerId);
      const deployments = workflow.triggers.filter((trigger) => !triggerId || trigger.id === triggerId);
      const active = deployments.filter((trigger) => trigger.status === 'active');
      activeTriggers += active.length;
      if (deployments.length === 0) {
        add(findings, {
          code: 'ACTIVATION_TRIGGER_NOT_DEPLOYED', severity: 'error', layer: 'activation', resourceId: `${workflow.id}:${node.id}`,
          summary: `Unattended trigger “${triggerType}” in “${workflow.title}” has no deployed trigger record.`,
          evidence: { nodeId: node.id, triggerType, triggerId: triggerId ?? null },
          resources: [resource('workflow', workflow.id, workflow.title), resource('node', node.id, node.title)],
          remediation: { operation: 'workflow.trigger.arm', description: 'Deploy and arm the authored trigger.', args: { workflowId: workflow.id } },
        });
      } else if (active.length === 0) {
        add(findings, {
          code: 'ACTIVATION_TRIGGER_NOT_ACTIVE', severity: 'error', layer: 'activation', resourceId: `${workflow.id}:${node.id}`,
          summary: `Unattended trigger “${triggerType}” in “${workflow.title}” is not active.`,
          evidence: { nodeId: node.id, triggerType, deployments: deployments.map((trigger) => ({ id: trigger.id, status: trigger.status })) },
          resources: [resource('workflow', workflow.id, workflow.title), resource('node', node.id, node.title)],
          remediation: { operation: 'workflow.trigger.arm', description: 'Resolve trigger health errors and arm the trigger.', args: { workflowId: workflow.id } },
        });
      }
    }

    const spec = readWorkflowSpec(workflow.settings);
    if (spec) {
      const errors = validateWorkflowSpec(spec, { graph: workflow.graph });
      if (errors.length > 0) {
        add(findings, {
          code: 'OUTCOME_SPEC_INVALID', severity: 'error', layer: 'outcome', resourceId: workflow.id,
          summary: `Workflow “${workflow.title}” has an invalid definition of done.`, evidence: { errors },
          resources: [resource('workflow', workflow.id, workflow.title)],
          remediation: { operation: 'workflow.spec.define', description: 'Repair the WorkflowSpec so every acceptance check is executable.', args: { workflowId: workflow.id } },
        });
      }
      // Compute from the graph rather than trusting the persisted cache: detecting
      // a stale spec is most important when two persisted layers diverge.
      const currentHash = graphContentHash(workflow.graph);
      if (spec.reconciledHash && spec.reconciledHash !== currentHash) {
        add(findings, {
          code: 'OUTCOME_SPEC_STALE', severity: 'error', layer: 'outcome', resourceId: workflow.id,
          summary: `Workflow “${workflow.title}” changed after its definition of done was reconciled.`,
          evidence: { reconciledHash: spec.reconciledHash, currentHash },
          resources: [resource('workflow', workflow.id, workflow.title)],
          remediation: { operation: 'workflow.spec.reconcile', description: 'Review and reconcile acceptance checks against the current graph.', args: { workflowId: workflow.id, currentHash } },
        });
      }
    }
  }

  let activeEventSubscriptions = 0;
  for (const subscription of snapshot.subscriptions) {
    const sourceInApp = memberIds.has(subscription.sourceWorkflowId);
    const targetInApp = memberIds.has(subscription.targetWorkflowId);
    if (!sourceInApp && !targetInApp) continue;
    if (subscription.enabled && sourceInApp && targetInApp) activeEventSubscriptions += 1;
    if (subscription.enabled && /(?:run\.)?(?:completed|complete|completion)$/iu.test(subscription.eventType)) {
      add(findings, {
        code: 'OUTCOME_EVENT_USES_COMPLETION', severity: 'warning', layer: 'outcome', resourceId: subscription.id,
        summary: 'An enabled progression rule listens for run completion rather than an accomplished business outcome.',
        evidence: { eventType: subscription.eventType, accomplishedEvent: 'run.accomplished' },
        resources: [resource('subscription', subscription.id)],
        remediation: { operation: 'workflow.event_subscription.patch', description: 'Use run.accomplished when the target must wait for verified business success; keep run.completed only for explicit finally/cleanup behavior.', args: { subscriptionId: subscription.id, eventType: 'run.accomplished' } },
      });
    }
    if (!sourceInApp || !targetInApp) {
      add(findings, {
        code: 'EVENT_SUBSCRIPTION_CROSSES_APP_BOUNDARY', severity: 'warning', layer: 'event', resourceId: subscription.id,
        summary: 'An event subscription crosses the App boundary.',
        evidence: { sourceWorkflowId: subscription.sourceWorkflowId, targetWorkflowId: subscription.targetWorkflowId, enabled: subscription.enabled },
        resources: [resource('subscription', subscription.id)],
        remediation: { operation: 'workflow.event_subscription.review', description: 'Confirm and document the cross-App dependency, or move both workflows under one owner App.', args: { subscriptionId: subscription.id } },
      });
    }
    if (subscription.sourceNodeId && sourceInApp) {
      const source = workflowById.get(subscription.sourceWorkflowId)!;
      if (!source.graph.nodes.some((node) => node.id === subscription.sourceNodeId)) {
        add(findings, {
          code: 'EVENT_SUBSCRIPTION_SOURCE_NODE_MISSING', severity: 'error', layer: 'event', resourceId: subscription.id,
          summary: 'An event subscription references a source node that no longer exists.',
          evidence: { sourceWorkflowId: source.id, sourceNodeId: subscription.sourceNodeId, eventType: subscription.eventType },
          resources: [resource('subscription', subscription.id), resource('workflow', source.id, source.title)],
          remediation: { operation: 'workflow.event_subscription.patch', description: 'Point the subscription at an existing source node or remove its node filter.', args: { subscriptionId: subscription.id } },
        });
      }
    }
  }

  const scripts = conversationScripts(snapshot.collections);
  const scriptCollection = snapshot.collections.find((collection) => collection.name === 'conversation_script');
  if (scriptCollection && scripts.length === 0) {
    add(findings, {
      code: 'STATE_SCRIPT_COLLECTION_EMPTY', severity: 'warning', layer: 'state', resourceId: 'conversation_script',
      summary: 'The conversation-script collection exists but contains no executable state machine.',
      evidence: { collection: 'conversation_script' }, resources: [resource('collection', 'conversation_script')],
      remediation: { operation: 'conversation.define', description: 'Persist a valid state machine, or remove the unused control-plane collection.', args: { appId: snapshot.app.id } },
    });
  }
  let conversationTransitions = 0;
  for (const candidate of scripts) {
    const parsed = conversationScriptSchema.safeParse(candidate.raw);
    if (!parsed.success) {
      add(findings, {
        code: 'STATE_SCRIPT_INVALID', severity: 'critical', layer: 'state', resourceId: candidate.recordId,
        summary: 'A persisted conversation state machine is invalid.',
        evidence: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
        resources: [resource('record', candidate.recordId), resource('collection', 'conversation_script')],
        remediation: { operation: 'conversation.define', description: 'Replace the invalid script with a schema-valid state machine.', args: { appId: snapshot.app.id } },
      });
      continue;
    }
    conversationTransitions += validateConversationScript(parsed.data, candidate.recordId, snapshot, workflowById, findings);
  }

  if (scripts.length > 0) {
    const appConnections = snapshot.connections.filter((connection) => connection.appId === snapshot.app.id);
    if (appConnections.length === 0) {
      add(findings, {
        code: 'CONNECTION_STATE_MACHINE_UNBOUND', severity: 'critical', layer: 'connection', resourceId: snapshot.app.id,
        summary: 'The App has a conversation state machine but no channel connection is bound to the App.',
        evidence: { workspaceConnections: snapshot.connections.length }, resources: [resource('app', snapshot.app.id, snapshot.app.name)],
        remediation: { operation: 'connection.bind_app', description: 'Bind at least one inbound channel connection to this App.', args: { appId: snapshot.app.id } },
      });
    } else if (!appConnections.some((connection) => connection.status === 'active')) {
      add(findings, {
        code: 'CONNECTION_STATE_MACHINE_NO_ACTIVE_CHANNEL', severity: 'critical', layer: 'connection', resourceId: snapshot.app.id,
        summary: 'Every channel connection bound to the App is paused or unhealthy.',
        evidence: { connections: appConnections.map((connection) => ({ id: connection.id, status: connection.status })) },
        resources: appConnections.map((connection) => resource('connection', connection.id, connection.name)),
        remediation: { operation: 'connection.activate', description: 'Activate or repair at least one App-bound channel connection.', args: { appId: snapshot.app.id } },
      });
    }
  }

  const executableRules = executableDependencyEdges + activeEventSubscriptions + activeTriggers + conversationTransitions;
  const enabled = snapshot.workflows.filter((workflow) => bindings.get(workflow.id)?.enabled !== false);
  const roots = enabled.filter((workflow) => (bindings.get(workflow.id)?.dependsOn ?? []).length === 0).map((workflow) => workflow.id);
  const manualRoots = enabled.filter((workflow) => {
    if (!roots.includes(workflow.id)) return false;
    const triggerTypes = workflow.graph.nodes.filter((node) => node.type === 'trigger').map((node) => String(record(node.config)?.triggerType ?? 'manual'));
    return triggerTypes.length === 0 || triggerTypes.every((type) => type === 'manual');
  });
  if (manualRoots.length > 1 && dependencyEdges === 0 && activeEventSubscriptions === 0 && conversationTransitions === 0) {
    add(findings, {
      code: 'BINDING_MULTIPLE_STANDALONE_ROOTS', severity: 'warning', layer: 'binding', resourceId: snapshot.app.id,
      summary: 'Run All will start multiple standalone manual roots; no persisted rule orders their business progression.',
      evidence: { workflowIds: manualRoots.map((workflow) => workflow.id) },
      resources: manualRoots.map((workflow) => resource('workflow', workflow.id, workflow.title)),
      remediation: { operation: 'workflow.chain', description: 'Declare dependencies, event subscriptions, or a state machine if these jobs are intended to progress in order.', args: { appId: snapshot.app.id } },
    });
  }

  for (const surface of snapshot.surfaces) {
    const hasPanel = containsNodeType(surface.view, new Set(['OrchestrationPanel', 'WorkflowControl']));
    const orchestrationActions = surface.actions.filter((action) => ORCHESTRATION_ACTION_RE.test(action.name));
    if ((hasPanel || orchestrationActions.length > 0) && snapshot.workflows.length > 1 && executableRules === 0) {
      add(findings, {
        code: 'SURFACE_ORCHESTRATION_WITHOUT_RULES', severity: 'error', layer: 'surface', resourceId: surface.id,
        summary: `Surface “${surface.name}” presents orchestration controls, but the App has no executable cross-workflow rule.`,
        evidence: { hasOrchestrationPanel: hasPanel, orchestrationActions: orchestrationActions.map((action) => action.name) },
        resources: [resource('surface', surface.id, surface.name)],
        remediation: { operation: 'app.orchestration.define', description: 'Persist executable dependencies, subscriptions, schedules, or state transitions before presenting orchestration as configured.', args: { appId: snapshot.app.id } },
      });
    }
    for (const action of surface.actions.filter((action) => action.kind === 'workflow')) {
      if (!memberIds.has(action.target)) {
        add(findings, {
          code: 'SURFACE_WORKFLOW_ACTION_TARGET_INVALID', severity: 'error', layer: 'surface', resourceId: `${surface.id}:${action.name}`,
          summary: `Surface action “${action.name}” targets a workflow outside this App.`,
          evidence: { target: action.target }, resources: [resource('surface', surface.id, surface.name)],
          remediation: { operation: 'ui.action_schema.patch', description: 'Retarget the action to an App workflow or remove it.', args: { surface: surface.name, action: action.name } },
        });
      }
    }
  }

  findings.sort(compareFindings);
  const counts = countSeverities(findings);
  return {
    appId: snapshot.app.id,
    generatedAt: now.toISOString(),
    health: counts.critical + counts.error > 0 ? 'broken' : counts.warning > 0 ? 'degraded' : 'healthy',
    readyForUnattended: counts.critical + counts.error === 0,
    summary: { ...counts, workflows: snapshot.workflows.length, executableRules },
    topology: { roots, dependencyEdges, activeEventSubscriptions, activeTriggers, conversationTransitions },
    findings,
  };
}

function validateConversationScript(
  script: ConversationScript,
  recordId: string,
  snapshot: AppDoctorSnapshot,
  workflowById: Map<string, AppDoctorWorkflowSnapshot>,
  findings: AppDoctorFinding[],
): number {
  const collection = snapshot.collections.find((item) => item.name === script.contactCollection);
  if (!collection) {
    add(findings, {
      code: 'STATE_CONTACT_COLLECTION_MISSING', severity: 'critical', layer: 'state', resourceId: recordId,
      summary: `State machine contact collection “${script.contactCollection}” does not exist.`, evidence: { contactCollection: script.contactCollection },
      resources: [resource('record', recordId)],
      remediation: { operation: 'data.define_collection', description: 'Create the state collection using the conversation contact-state contract.', args: { appId: snapshot.app.id, name: script.contactCollection } },
    });
  }
  let transitions = 0;
  for (const stage of script.stages) {
    if (stage.onReply) transitions += stage.onReply.kind === 'goto' ? 1 : Object.keys(stage.onReply.branches).length;
    if (stage.onComplete) transitions += 1;
    if (stage.entry?.kind !== 'run_workflow') continue;
    const workflow = workflowById.get(stage.entry.workflowId);
    if (!workflow) {
      add(findings, {
        code: 'STATE_WORKFLOW_REFERENCE_INVALID', severity: 'critical', layer: 'state', resourceId: `${recordId}:${stage.id}`,
        summary: `State “${stage.id}” references a workflow outside this App.`, evidence: { workflowId: stage.entry.workflowId },
        resources: [resource('record', recordId), resource('stage', stage.id, stage.label)],
        remediation: { operation: 'conversation.define', description: 'Reference an App-owned workflow or adopt the referenced workflow.', args: { appId: snapshot.app.id, stageId: stage.id } },
      });
      continue;
    }
    const inputKeys = new Set(workflow.graph.inputContract?.fields.map((field) => field.key) ?? []);
    for (const [inputKey, sourcePath] of Object.entries(stage.entry.inputsFrom)) {
      if (!PATH_RE.test(sourcePath)) {
        add(findings, {
          code: 'STATE_INPUT_SOURCE_NOT_A_PATH', severity: 'error', layer: 'state', resourceId: `${recordId}:${stage.id}:${inputKey}`,
          summary: `State input mapping “${inputKey}” is an expression, but this runtime accepts only field paths.`,
          evidence: { stageId: stage.id, inputKey, sourcePath }, resources: [resource('workflow', workflow.id, workflow.title), resource('stage', stage.id, stage.label)],
          remediation: { operation: 'conversation.define', description: 'Replace the expression with a contact/facts field path, or compute the value inside the workflow.', args: { appId: snapshot.app.id, stageId: stage.id, inputKey } },
        });
      }
      if (inputKeys.size > 0 && !inputKeys.has(inputKey)) {
        add(findings, {
          code: 'STATE_INPUT_TARGET_UNDECLARED', severity: 'error', layer: 'state', resourceId: `${recordId}:${stage.id}:${inputKey}`,
          summary: `State input “${inputKey}” is not declared by workflow “${workflow.title}”.`,
          evidence: { stageId: stage.id, inputKey, declaredInputs: [...inputKeys] }, resources: [resource('workflow', workflow.id, workflow.title), resource('stage', stage.id, stage.label)],
          remediation: { operation: 'conversation.define', description: 'Map to a declared workflow input, or update the workflow input contract.', args: { appId: snapshot.app.id, stageId: stage.id, inputKey } },
        });
      }
    }
  }
  return transitions;
}

function conversationScripts(collections: AppDoctorCollectionSnapshot[]): Array<{ recordId: string; raw: unknown }> {
  const collection = collections.find((item) => item.name === 'conversation_script');
  if (!collection) return [];
  return (collection.records ?? [])
    .filter((item) => item.data.script !== undefined)
    .map((item) => ({ recordId: item.id, raw: item.data.script }));
}

function containsNodeType(value: unknown, types: Set<string>, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (!Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string' && types.has((value as { type: string }).type)) return true;
  return Object.values(value as Record<string, unknown>).some((child) => containsNodeType(child, types, seen));
}

function firstCycle(graph: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id); stack.push(id);
    for (const dependency of graph.get(id) ?? []) { const cycle = visit(dependency); if (cycle) return cycle; }
    stack.pop(); visiting.delete(id); visited.add(id);
    return null;
  };
  for (const id of graph.keys()) { const cycle = visit(id); if (cycle) return cycle; }
  return null;
}

function add(findings: AppDoctorFinding[], input: Omit<AppDoctorFinding, 'id'> & { resourceId: string }): void {
  const { resourceId, ...finding } = input;
  findings.push({ id: `${finding.code}:${resourceId}`, ...finding });
}

function resource(kind: string, id: string, title?: string): { kind: string; id: string; title?: string } {
  return title ? { kind, id, title } : { kind, id };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function countSeverities(findings: AppDoctorFinding[]): Record<AppDoctorSeverity, number> {
  const result: Record<AppDoctorSeverity, number> = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const finding of findings) result[finding.severity] += 1;
  return result;
}

function compareFindings(a: AppDoctorFinding, b: AppDoctorFinding): number {
  const rank: Record<AppDoctorSeverity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
  return rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) || a.id.localeCompare(b.id);
}
