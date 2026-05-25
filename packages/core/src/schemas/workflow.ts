import { z } from 'zod';

// ────────────────────────────────────────────────────────────
// Node configs
// ────────────────────────────────────────────────────────────

const outputConfigFields = {
  isOutput: z.boolean().optional(),
};

const triggerConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('trigger'),
  triggerType: z.enum(['manual', 'cron', 'webhook', 'persistent_listener']),
  triggerId: z.string().uuid().optional(),
});

const agentRoleSchema = z.enum([
  'planner', 'researcher', 'coder', 'reviewer', 'analyst',
  'writer', 'monitor', 'architect', 'debugger', 'deployer',
]);

const agentTaskConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('agent_task'),
  agentId: z.string().uuid().optional(),
  agentRole: agentRoleSchema.optional(),
  agentPackageRef: z.string().optional(),
  capabilityTags: z.array(z.string()).default([]),
  prompt: z.string().min(1),
  inputKeys: z.array(z.string()).default([]),
  outputKeys: z.array(z.string()).default([]),
  skills: z.array(z.string()).optional(),
  modelOverride: z.string().optional(),
  castingReason: z.string().optional(),
  useRoleTools: z.boolean().optional(),
  maxToolSteps: z.number().int().min(1).max(12).optional(),
});

const skillTaskConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('skill_task'),
  skillId: z.string().min(1),
  inputMapping: z.record(z.string(), z.string()).default({}),
  outputMapping: z.record(z.string(), z.string()).default({}),
});

const knowledgeConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('knowledge'),
  knowledgeBaseId: z.string().optional(),
  queryMode: z.enum(['static', 'dynamic']).default('static'),
  query: z.string().optional(),
  queryNodeId: z.string().optional(),
  queryPath: z.string().optional(),
  retrievalMode: z.enum(['contextual', 'strict', 'exploratory']).default('contextual'),
  topK: z.number().int().min(1).max(20).default(5),
});

const routerConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('router'),
  routingMode: z.enum(['first_match', 'all_matching', 'llm_route']),
  branches: z
    .array(
      z.object({
        branchId: z.string(),
        label: z.string(),
        condition: z.string(),
      }),
    )
    .min(1),
});

const mergeConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('merge'),
  requiredInputs: z.union([z.literal('all'), z.literal('any'), z.array(z.string())]),
});

const checkpointConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('checkpoint'),
  approvalMode: z.enum(['manual', 'auto_after_timeout']),
  timeoutMs: z.number().int().positive().optional(),
});

const subflowConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('subflow'),
  workflowId: z.string().uuid(),
  inputMapping: z.record(z.string(), z.string()).default({}),
  outputMapping: z.record(z.string(), z.string()).default({}),
});

const scratchpadConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('scratchpad'),
  operation: z.enum(['read', 'write', 'append', 'delete']),
  key: z.string().min(1),
  valuePath: z.string().optional(),
});

const workspaceStoreConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('workspace_store'),
  operations: z.array(z.object({
    op: z.enum(['get', 'set', 'delete', 'increment', 'append', 'get_all']),
    key: z.string().optional(),
    value: z.string().optional(),
    outputKey: z.string().optional(),
    incrementBy: z.number().optional(),
  })).default([]),
});

const returnOutputConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('return_output'),
  renderAs: z.enum(['html', 'markdown', 'table', 'json', 'text']).optional(),
  title: z.string().max(255).optional(),
  valuePath: z.string().optional(),
});

const artifactSaveConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('artifact_save'),
  name: z.string().min(1),
  artifactType: z.enum(['html', 'image', 'document', 'code', 'data']).optional(),
  contentPath: z.string().optional(),
  titlePath: z.string().optional(),
});

const browserConfigSchema = z.object({
  ...outputConfigFields,
  kind: z.literal('browser'),
  operation: z.enum(['serve_html', 'screenshot', 'pdf', 'navigate', 'extract_text', 'fill_form', 'extract_table']),
  url: z.string().optional(),
  html: z.string().optional(),
  htmlPath: z.string().optional(),
  selector: z.string().optional(),
  formData: z.record(z.string(), z.string()).optional(),
  submitSelector: z.string().optional(),
  fullPage: z.boolean().optional(),
  headless: z.boolean().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  timeout: z.number().int().positive().optional(),
  artifactName: z.string().optional(),
});

// Permissive config: accepts any object with a `kind` string. Concrete kinds
// (triggerConfigSchema, etc.) are validated by the engine when a node actually
// runs — at edit-time we don't want to reject draft workflows that still have
// incomplete or non-canonical config (e.g., a freshly dragged "approval" node
// with no fields yet, or legacy `variables` nodes from older versions).
const fallbackConfigSchema = z
  .object({ kind: z.string().min(1), ...outputConfigFields })
  .passthrough()
  .superRefine((config, ctx) => {
    // If a draft config includes known strict fields, keep their validation
    // failures meaningful instead of letting malformed known configs pass as
    // arbitrary passthrough objects.
    if (config.kind === 'agent_task' && 'prompt' in config && !String(config.prompt ?? '').trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: 'Required' });
    }
    if (config.kind === 'router' && 'branches' in config && (!Array.isArray(config.branches) || config.branches.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['branches'], message: 'Expected at least one branch' });
    }
    if (config.kind === 'scratchpad' && 'key' in config && !String(config.key ?? '').trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key'], message: 'Required' });
    }
  });

export const workflowNodeConfigSchema = z.union([
  triggerConfigSchema,
  agentTaskConfigSchema,
  skillTaskConfigSchema,
  knowledgeConfigSchema,
  routerConfigSchema,
  mergeConfigSchema,
  checkpointConfigSchema,
  subflowConfigSchema,
  scratchpadConfigSchema,
  workspaceStoreConfigSchema,
  returnOutputConfigSchema,
  artifactSaveConfigSchema,
  browserConfigSchema,
  fallbackConfigSchema,
]);

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  // Permissive at edit-time. Engine validates execution-time semantics.
  type: z.string().min(1),
  title: z.string().min(1).max(255),
  position: z.object({ x: z.number(), y: z.number() }),
  config: workflowNodeConfigSchema,
});

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
  targetHandle: z.string().optional(),
  condition: z.string().optional(),
  type: z.enum(['default', 'error', 'condition']).optional(),
});

export const workflowGraphSchema = z.object({
  version: z.literal(1),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
});

// ────────────────────────────────────────────────────────────
// API request bodies
// ────────────────────────────────────────────────────────────

export const createWorkflowSchema = z.object({
  workspaceId: z.string().uuid(),
  ambientId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(255),
  summary: z.string().max(2000).optional(),
  intendedBehavior: z.string().max(8000).nullable().optional(),
  graph: workflowGraphSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const updateWorkflowSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  summary: z.string().max(2000).nullable().optional(),
  intendedBehavior: z.string().max(8000).nullable().optional(),
  graph: workflowGraphSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const runWorkflowSchema = z.object({
  triggerId: z.string().uuid().optional(),
  inputs: z.record(z.string(), z.unknown()).default({}),
});

export const replayFromNodeSchema = z.object({
  preserveCompletedUpstream: z.boolean().default(true),
  inputsOverride: z.record(z.string(), z.unknown()).optional(),
});

export const workflowGraphPatchSchema = z.object({
  patchId: z.string().min(1),
  reason: z.enum(['planner_replan', 'user_edit', 'hub_package_update']),
  baseGraphRevision: z.number().int().nonnegative(),
  addNodes: z.array(workflowNodeSchema).default([]),
  updateNodes: z.array(workflowNodeSchema).default([]),
  removeNodeIds: z.array(z.string().min(1)).default([]),
  addEdges: z.array(workflowEdgeSchema).default([]),
  removeEdgeIds: z.array(z.string().min(1)).default([]),
});
