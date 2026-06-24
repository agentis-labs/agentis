/**
 * Workflow validation — runs at every CREATE/UPDATE and before every patch
 * apply. Cycles, missing references, and trigger sanity must be caught at the
 * boundary; the engine assumes graph validity beyond this point.
 */

import type { WorkflowGraph } from '@agentis/core';
import { AgentisError, schemas } from '@agentis/core';
import { evalCondition } from './SafeConditionParser.js';
import { validateGraphReferences } from './validateGraphReferences.js';

export interface ValidationResult {
  ok: true;
  warnings: string[];
}

export interface ValidateWorkflowGraphOptions {
  currentWorkflowId?: string | null;
  strict?: boolean;
}

/** Valid persistent-KV ops for `workflow_store` / `workspace_store` nodes. Must
 *  stay in lockstep with the engine's #executeWorkflowStore/#executeWorkspaceStore
 *  switch — an op not listed here is rejected at the boundary so a graph that
 *  would die at run time with "unknown op X" can never be persisted or run. */
const STORE_OPS = new Set(['get', 'set', 'delete', 'increment', 'append', 'get_all']);

const SUPPORTED_NODE_KINDS = new Set([
  'trigger',
  'agent_task',
  'agent_session',
  'extension_task',
  'knowledge',
  'knowledge_ingest',
  'router',
  'merge',
  'checkpoint',
  'subflow',
  'scratchpad',
  'human_input',
  'agent_swarm',
  'dynamic_swarm',
  'planner',
  'artifact_collect',
  'wait',
  'transform',
  'filter',
  'integration',
  'http_request',
  'workflow_store',
  'workspace_store',
  'evaluator',
  'guardrails',
  'loop',
  'parallel',
  'return_output',
  'artifact_save',
  'browser',
  // WORKFLOW-UPDATE — n8n-inspired utility & data primitives
  'error_trigger',
  'stop_error',
  'code',
  'datetime',
  'crypto_util',
  'xml_parse',
  'markdown',
  'json_schema_validate',
  'sticky_note',
  'spreadsheet',
  'html_extract',
  'graphql',
]);

export function validateWorkflowGraph(
  graph: WorkflowGraph,
  options: ValidateWorkflowGraphOptions = {},
): ValidationResult {
  const warnings: string[] = [];
  const ids = new Set<string>();

  const isStrict = options.strict !== false;
  const fail = (msg: string) => {
    if (isStrict) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', msg);
    } else {
      warnings.push(msg);
    }
  };

  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
    if (!SUPPORTED_NODE_KINDS.has(node.config.kind)) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Node ${node.id} uses unsupported kind '${node.config.kind}'`);
    }
    if (
      options.currentWorkflowId &&
      node.config.kind === 'subflow' &&
      node.config.workflowId === options.currentWorkflowId
    ) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Subflow node ${node.id} cannot call its own workflow`,
      );
    }
    // Incomplete node configuration can be persisted while authoring. Strict
    // validation protects execution; lenient validation reports draft warnings.
    const kind = node.config.kind;
    switch (kind) {
      case 'trigger':
        if (node.config.triggerType === 'cron') {
          const hasRules = Array.isArray(node.config.scheduleRules) && node.config.scheduleRules.length > 0;
          if (!node.config.schedule?.trim() && !hasRules) {
            fail(`Node ${node.id} (cron trigger) missing schedule or scheduleRules`);
          }
          for (const rule of node.config.scheduleRules ?? []) {
            if (!rule?.expression?.trim()) {
              fail(`Node ${node.id} (cron trigger) has a scheduleRule with an empty expression`);
            }
          }
        }
        if (node.config.triggerType === 'persistent_listener') {
          const parsed = schemas.listenerConfigSchema.safeParse(node.config.listenerConfig);
          if (!parsed.success) {
            fail(`Node ${node.id} (persistent_listener) has incomplete listener config`);
          }
        }
        if (node.config.triggerType === 'error_trigger') {
          const et = node.config.errorTrigger;
          if (!et || !Array.isArray(et.onStatus) || et.onStatus.length === 0) {
            fail(`Node ${node.id} (error_trigger) requires errorTrigger.onStatus with at least one status`);
          }
        }
        if (node.config.triggerType === 'rss_feed' && !node.config.rssFeed?.feedUrl?.trim()) {
          fail(`Node ${node.id} (rss_feed trigger) missing rssFeed.feedUrl`);
        }
        if (node.config.triggerType === 'email_imap' && !node.config.emailImap?.host?.trim()) {
          fail(`Node ${node.id} (email_imap trigger) missing emailImap.host`);
        }
        break;
      case 'error_trigger':
        if (!Array.isArray(node.config.onStatus) || node.config.onStatus.length === 0) {
          fail(`Node ${node.id} (error_trigger) requires onStatus with at least one of FAILED/CANCELLED`);
        }
        break;
      case 'stop_error':
        if (!node.config.errorMessage || !node.config.errorMessage.trim()) {
          fail(`Node ${node.id} (stop_error) missing errorMessage`);
        }
        break;
      case 'code':
        if (!node.config.code || !node.config.code.trim()) {
          fail(`Node ${node.id} (code) missing code`);
        }
        if (node.config.language !== 'javascript' && node.config.language !== 'python') {
          fail(`Node ${node.id} (code) language must be 'javascript' or 'python'`);
        }
        break;
      case 'datetime':
        if (!node.config.operation) {
          fail(`Node ${node.id} (datetime) missing operation`);
        }
        break;
      case 'crypto_util':
        if (!node.config.operation) {
          fail(`Node ${node.id} (crypto_util) missing operation`);
        }
        if (node.config.operation === 'hmac' && !node.config.secretPath) {
          fail(`Node ${node.id} (crypto_util hmac) requires secretPath`);
        }
        break;
      case 'xml_parse':
        if (node.config.operation !== 'parse' && node.config.operation !== 'build') {
          fail(`Node ${node.id} (xml_parse) operation must be 'parse' or 'build'`);
        }
        break;
      case 'markdown':
        if (node.config.operation !== 'to_html' && node.config.operation !== 'from_html') {
          fail(`Node ${node.id} (markdown) operation must be 'to_html' or 'from_html'`);
        }
        break;
      case 'json_schema_validate':
        if (!node.config.schema || !node.config.schema.trim()) {
          fail(`Node ${node.id} (json_schema_validate) missing schema`);
        } else {
          try {
            JSON.parse(node.config.schema);
          } catch {
            fail(`Node ${node.id} (json_schema_validate) schema is not valid JSON`);
          }
        }
        if (node.config.onViolation !== 'block' && node.config.onViolation !== 'flag') {
          fail(`Node ${node.id} (json_schema_validate) onViolation must be 'block' or 'flag'`);
        }
        break;
      case 'html_extract':
        if (!node.config.selector || !node.config.selector.trim()) {
          fail(`Node ${node.id} (html_extract) missing selector`);
        }
        if (node.config.extractAs === 'attribute' && !node.config.attribute) {
          fail(`Node ${node.id} (html_extract) extractAs 'attribute' requires an attribute name`);
        }
        break;
      case 'spreadsheet':
        if (node.config.operation !== 'parse' && node.config.operation !== 'build') {
          fail(`Node ${node.id} (spreadsheet) operation must be 'parse' or 'build'`);
        }
        if (node.config.format !== 'csv' && node.config.format !== 'xlsx') {
          fail(`Node ${node.id} (spreadsheet) format must be 'csv' or 'xlsx'`);
        }
        break;
      case 'graphql':
        if (!node.config.endpoint || !node.config.endpoint.trim()) {
          fail(`Node ${node.id} (graphql) missing endpoint`);
        }
        if (!node.config.query || !node.config.query.trim()) {
          fail(`Node ${node.id} (graphql) missing query`);
        }
        break;
      case 'sticky_note':
        // Pure annotation — nothing to validate.
        break;
      case 'knowledge_ingest':
        if (
          !(node.config.content && node.config.content.trim())
          && !(node.config.contentPath && node.config.contentPath.trim())
        ) {
          fail(`Node ${node.id} (knowledge_ingest) needs a content source (content or contentPath)`);
        }
        break;
      case 'agent_task':
        if (!node.config.prompt || !node.config.prompt.trim()) {
          fail(`Node ${node.id} (agent_task) missing prompt`);
        }
        if (!node.config.agentId && !node.config.agentRole && !hasAgentRequirements(node.config.requires) && (!node.config.capabilityTags || node.config.capabilityTags.length === 0)) {
          warnings.push(`Node ${node.id} (${kind}): no agentId, agentRole, or capabilityTags — runs will fail until one is assigned`);
        }
        break;
      case 'agent_session':
        if (!node.config.prompt || !node.config.prompt.trim()) {
          fail(`Node ${node.id} (agent_session) missing prompt`);
        }
        if (!node.config.agentId && !node.config.agentRole && !hasAgentRequirements(node.config.requires) && (!node.config.capabilityTags || node.config.capabilityTags.length === 0)) {
          warnings.push(`Node ${node.id} (${kind}): no agentId, agentRole, or capabilityTags — runs will fail until one is assigned`);
        }
        break;
      case 'dynamic_swarm':
        if (!node.config.goal || !node.config.goal.trim()) {
          fail(`Node ${node.id} (dynamic_swarm) missing goal`);
        }
        if (!node.config.outputKey) {
          fail(`Node ${node.id} (dynamic_swarm) missing outputKey`);
        }
        if (typeof node.config.maxTasks !== 'number' || node.config.maxTasks < 1) {
          fail(`Node ${node.id} (dynamic_swarm) requires maxTasks >= 1`);
        }
        break;
      case 'planner':
        if (!node.config.goal || !node.config.goal.trim()) {
          fail(`Node ${node.id} (planner) missing goal`);
        }
        break;
      case 'extension_task':
        if (!node.config.extensionId && !node.config.extensionSlug) {
          fail(`Node ${node.id} (extension_task) missing extensionId or extensionSlug`);
        }
        if (!node.config.operationName) {
          fail(`Node ${node.id} (extension_task) missing operationName`);
        }
        break;
      case 'integration':
        if (!node.config.integrationId) {
          fail(`Node ${node.id} (integration) missing integrationId`);
        }
        if (!node.config.operationId) {
          fail(`Node ${node.id} (integration) missing operationId`);
        }
        break;
      case 'http_request':
        if (!node.config.url) {
          fail(`Node ${node.id} (http_request) missing url`);
        }
        if (!node.config.method) {
          fail(`Node ${node.id} (http_request) missing method`);
        }
        break;
      case 'transform':
        if (!node.config.expression) {
          fail(`Node ${node.id} (transform) missing expression`);
        }
        break;
      case 'filter':
        if (!node.config.condition) {
          fail(`Node ${node.id} (filter) missing condition`);
        }
        break;
      case 'router':
        if (!Array.isArray(node.config.branches) || node.config.branches.length === 0) {
          fail(`Node ${node.id} (router) must declare at least one branch`);
        } else {
          for (const branch of node.config.branches) {
            const condition = typeof branch.condition === 'string' ? branch.condition : '';
            assertConditionSyntax(
              condition,
              `Node ${node.id} (router branch ${branch.branchId || branch.label || 'unknown'})`,
              fail,
            );
          }
        }
        break;
      case 'scratchpad':
        if (!node.config.key || !node.config.key.trim()) {
          fail(`Node ${node.id} (scratchpad) missing key`);
        }
        break;
      case 'wait':
        if (typeof node.config.delayMs !== 'number' || node.config.delayMs < 0) {
          fail(`Node ${node.id} (wait) requires non-negative delayMs`);
        }
        break;
      case 'workflow_store':
        if (!Array.isArray(node.config.operations) || node.config.operations.length === 0) {
          fail(`Node ${node.id} (workflow_store) must declare at least one operation`);
        } else {
          for (const op of node.config.operations) {
            if (!STORE_OPS.has((op as { op?: string }).op as string)) {
              fail(`Node ${node.id} (workflow_store) uses unknown op '${(op as { op?: string }).op}' — valid ops: ${[...STORE_OPS].join(', ')}`);
            }
          }
        }
        break;
      case 'workspace_store':
        if (!Array.isArray(node.config.operations) || node.config.operations.length === 0) {
          fail(`Node ${node.id} (workspace_store) must declare at least one operation`);
        } else {
          for (const op of node.config.operations) {
            if (!STORE_OPS.has((op as { op?: string }).op as string)) {
              fail(`Node ${node.id} (workspace_store) uses unknown op '${(op as { op?: string }).op}' — valid ops: ${[...STORE_OPS].join(', ')}`);
            }
          }
        }
        break;
      case 'evaluator':
        if (!node.config.targetPath) {
          fail(`Node ${node.id} (evaluator) missing targetPath`);
        }
        if (!node.config.criteria) {
          fail(`Node ${node.id} (evaluator) missing criteria`);
        }
        break;
      case 'guardrails':
        if (!Array.isArray(node.config.rules) || node.config.rules.length === 0) {
          fail(`Node ${node.id} (guardrails) must declare at least one rule`);
        }
        break;
      case 'browser': {
        const op = node.config.operation;
        if (op !== 'serve_html') {
          if (!node.config.url && !node.config.html && !node.config.htmlPath) {
            fail(`Node ${node.id} (browser ${op}) requires url, html, or htmlPath`);
          }
        }
        break;
      }
      case 'merge': {
        // A subset join (`requiredInputs: string[]`) must reference real incoming
        // sources — otherwise the engine can never see those ids arrive and the
        // intended barrier silently degrades to "fire when all real inputs
        // settle". Catch the misconfiguration here rather than at run time.
        const req = node.config.requiredInputs;
        if (Array.isArray(req)) {
          if (req.length === 0) {
            fail(`Node ${node.id} (merge) has an empty requiredInputs list — use 'all' or 'any', or name the sources to wait for`);
          }
          const incomingSources = new Set(
            graph.edges.filter((e) => e.target === node.id).map((e) => e.source),
          );
          for (const src of req) {
            if (!incomingSources.has(src)) {
              fail(`Node ${node.id} (merge) requiredInputs lists '${src}', which is not an incoming source`);
            }
          }
        }
        break;
      }
      case 'loop':
        if (!node.config.bodyWorkflowId) {
          fail(`Node ${node.id} (loop) missing bodyWorkflowId`);
        }
        if (!node.config.itemsExpression) {
          fail(`Node ${node.id} (loop) missing itemsExpression`);
        }
        if (!node.config.outputArrayKey) {
          fail(`Node ${node.id} (loop) missing outputArrayKey`);
        }
        break;
      default:
        break;
    }
  }

  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Edge ${edge.id} references missing source node ${edge.source}`,
      );
    }
    if (!ids.has(edge.target)) {
      throw new AgentisError(
        'WORKFLOW_GRAPH_INVALID',
        `Edge ${edge.id} references missing target node ${edge.target}`,
      );
    }
    if (typeof edge.condition === 'string' && edge.condition.trim()) {
      assertConditionSyntax(edge.condition, `Edge ${edge.id}`, fail);
    }
  }

  const phaseIds = new Set<string>();
  const phaseByNode = new Map<string, string>();
  for (const phase of graph.phases ?? []) {
    if (phaseIds.has(phase.id)) {
      throw new AgentisError('WORKFLOW_GRAPH_INVALID', `Duplicate phase id: ${phase.id}`);
    }
    phaseIds.add(phase.id);
    for (const nodeId of phase.nodeIds) {
      if (!ids.has(nodeId)) {
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `Phase ${phase.id} references missing node ${nodeId}`,
        );
      }
      const existing = phaseByNode.get(nodeId);
      if (existing) {
        throw new AgentisError(
          'WORKFLOW_GRAPH_INVALID',
          `Node ${nodeId} belongs to more than one phase (${existing}, ${phase.id})`,
        );
      }
      phaseByNode.set(nodeId, phase.id);
    }
  }

  if (hasCycle(graph)) {
    throw new AgentisError('WORKFLOW_GRAPH_INVALID', 'Workflow graph contains a cycle');
  }

  for (const issue of validateGraphReferences(graph)) {
    const prefix = `Node ${issue.nodeId} reference ${issue.expression}`;
    if (issue.severity === 'error') {
      fail(`${prefix}: ${issue.message}`);
    } else {
      warnings.push(`${prefix}: ${issue.message}`);
    }
  }

  return { ok: true, warnings };
}

function hasAgentRequirements(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((flag) => flag === true);
}

function hasCycle(graph: WorkflowGraph): boolean {
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = adj.get(edge.source) ?? [];
    list.push(edge.target);
    adj.set(edge.source, list);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of graph.nodes) color.set(node.id, WHITE);

  function dfs(id: string): boolean {
    color.set(id, GRAY);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const node of graph.nodes) {
    if ((color.get(node.id) ?? WHITE) === WHITE && dfs(node.id)) return true;
  }
  return false;
}

function assertConditionSyntax(
  condition: string,
  label: string,
  fail: (message: string) => void,
): void {
  if (!condition.trim()) return;
  try {
    evalCondition(condition, {
      input: {},
      inputs: {},
      output: {},
      trigger: {},
      nodes: {},
      scratchpad: {},
      store: {},
      workspace: {},
      run: {},
      loop: {},
    });
  } catch (error) {
    fail(`${label} has invalid condition syntax: ${(error as Error).message}`);
  }
}
