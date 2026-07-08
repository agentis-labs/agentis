import { z } from 'zod';

export const llmContextBlockSourceSchema = z.enum([
  'system',
  'memory',
  'tools',
  'retrieval',
  'user',
  'input',
  'scratchpad',
  'unknown',
]);

export const llmContextBlockSchema = z.object({
  source: llmContextBlockSourceSchema,
  label: z.string().optional(),
  tokenCount: z.number().int().nonnegative(),
  wasTruncated: z.boolean().default(false),
  truncatedTokens: z.number().int().nonnegative().default(0),
});

export const llmContextStrategySchema = z.object({
  windowLimit: z.number().int().positive(),
  tokenizer: z.string().optional(),
  blocks: z.array(llmContextBlockSchema),
});

export const llmTokenReplaySchema = z.object({
  tokenizer: z.string(),
  tokens: z.array(z.object({
    text: z.string(),
    tokenCount: z.number().int().positive().default(1),
    logprob: z.number().optional(),
  })),
});

export const llmTraceSpanSchema = z.object({
  spanId: z.string().optional(),
  traceId: z.string().describe('Correlates to the overall workflow run'),
  runId: z.string().optional(),
  workflowId: z.string().optional(),
  workspaceId: z.string().optional(),
  nodeId: z.string().describe('The specific agent/tool node'),
  nodeTitle: z.string().optional(),
  nodeKind: z.string().optional(),
  timestampMs: z.number().int().positive().optional(),
  createdAt: z.string().optional(),

  // 1. Cost & Token Accounting
  metrics: z.object({
    promptTokens: z.number().default(0),
    completionTokens: z.number().default(0),
    cachedTokens: z.number().default(0),
    totalTokens: z.number().default(0),
    totalCostMicros: z.number().default(0).describe('For precise fraction-of-a-cent accounting'),
    latencyMs: z.number().default(0),
  }),

  // 2. The Context Packing Log
  contextStrategy: llmContextStrategySchema.optional(),

  // 3. The Raw Payloads
  payloads: z.object({
    rawPrompt: z.union([z.string(), z.record(z.unknown())]).optional(),
    rawCompletion: z.string().optional(),
    toolCalls: z.array(z.record(z.unknown())).default([]),
    tokenReplay: llmTokenReplaySchema.optional(),
    logprobs: z.array(z.record(z.unknown())).optional(),
  }).optional(),
});

export type LlmTraceSpan = z.infer<typeof llmTraceSpanSchema>;
export type LlmContextStrategy = z.infer<typeof llmContextStrategySchema>;
export type LlmContextBlock = z.infer<typeof llmContextBlockSchema>;
