import { z } from 'zod';

export const jsonSchemaLikeSchema = z.record(z.unknown()).default({ type: 'object' });
export type JsonSchemaLike = z.infer<typeof jsonSchemaLikeSchema>;

export const capabilitySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }),
  z.object({ kind: z.literal('app'), appId: z.string().min(1) }),
  z.object({ kind: z.literal('plugin'), service: z.string().min(1) }),
]);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

/** A capability the App exposes to other agents (app-as-tool, architecture section 3). */
export const capabilityDeclSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Resolves to a declared surface action, workflow, tool, or collection operation. */
  target: z.string().min(1),
  inputSchema: jsonSchemaLikeSchema.optional(),
  outputSchema: jsonSchemaLikeSchema.optional(),
  scopes: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type CapabilityDecl = z.infer<typeof capabilityDeclSchema>;

export const registeredCapabilitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: jsonSchemaLikeSchema.optional(),
  outputSchema: jsonSchemaLikeSchema.optional(),
  source: capabilitySourceSchema,
  scopes: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  auth: z.enum(['none', 'api-key', 'oauth2']).default('none'),
  latency: z.enum(['realtime', 'fast', 'batch']).optional(),
  mutating: z.boolean().default(false),
});
export type RegisteredCapability = z.infer<typeof registeredCapabilitySchema>;

export interface InvokeCtx {
  workspaceId: string;
  actingSeatId: string;
  callerAgentId?: string;
  appId?: string;
  runId?: string;
  ambientId?: string | null;
  executionMode?: 'chat' | 'plan';
  signal?: AbortSignal;
}

export interface CapabilityInvocationRecord {
  capabilityId: string;
  source: CapabilitySource;
  workspaceId: string;
  actingSeatId: string;
  callerAgentId?: string;
  callingAppId?: string;
  runId?: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
}
