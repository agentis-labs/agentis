import { z } from 'zod';

// ────────────────────────────────────────────────────────────
// Node configs
// ────────────────────────────────────────────────────────────

const triggerConfigSchema = z.object({
  kind: z.literal('trigger'),
  triggerType: z.enum(['manual', 'cron', 'webhook', 'persistent_listener']),
  triggerId: z.string().uuid().optional(),
});

const agentTaskConfigSchema = z.object({
  kind: z.literal('agent_task'),
  agentId: z.string().uuid().optional(),
  agentPackageRef: z.string().optional(),
  capabilityTags: z.array(z.string()).default([]),
  prompt: z.string().min(1),
  inputKeys: z.array(z.string()).default([]),
  outputKeys: z.array(z.string()).default([]),
});

const skillTaskConfigSchema = z.object({
  kind: z.literal('skill_task'),
  skillId: z.string().min(1),
  inputMapping: z.record(z.string(), z.string()).default({}),
  outputMapping: z.record(z.string(), z.string()).default({}),
});

const routerConfigSchema = z.object({
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
  kind: z.literal('merge'),
  requiredInputs: z.union([z.literal('all'), z.literal('any'), z.array(z.string())]),
});

const checkpointConfigSchema = z.object({
  kind: z.literal('checkpoint'),
  approvalMode: z.enum(['manual', 'auto_after_timeout']),
  timeoutMs: z.number().int().positive().optional(),
});

const subflowConfigSchema = z.object({
  kind: z.literal('subflow'),
  workflowId: z.string().uuid(),
  inputMapping: z.record(z.string(), z.string()).default({}),
  outputMapping: z.record(z.string(), z.string()).default({}),
});

const scratchpadConfigSchema = z.object({
  kind: z.literal('scratchpad'),
  operation: z.enum(['read', 'write', 'append', 'delete']),
  key: z.string().min(1),
  valuePath: z.string().optional(),
});

export const workflowNodeConfigSchema = z.discriminatedUnion('kind', [
  triggerConfigSchema,
  agentTaskConfigSchema,
  skillTaskConfigSchema,
  routerConfigSchema,
  mergeConfigSchema,
  checkpointConfigSchema,
  subflowConfigSchema,
  scratchpadConfigSchema,
]);

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'trigger',
    'agent_task',
    'skill_task',
    'router',
    'merge',
    'checkpoint',
    'subflow',
    'scratchpad',
  ]),
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
  graph: workflowGraphSchema.optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const updateWorkflowSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  summary: z.string().max(2000).nullable().optional(),
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
