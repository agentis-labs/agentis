import { z } from 'zod';

const cursorSchema = z.object({
  scratchpadKey: z.string().min(1),
  extractPath: z.string().min(1),
  initialValue: z.unknown().optional(),
  includeCursorInPayload: z.boolean().optional(),
  cursorParamName: z.string().min(1).optional(),
});

const intervalSourceSchema = z.object({
  kind: z.literal('interval'),
  intervalMs: z.number().int().min(1_000),
  fireOnStart: z.boolean().optional(),
  payload: z.record(z.unknown()).optional(),
});

const websocketSourceSchema = z.object({
  kind: z.literal('websocket'),
  url: z.string().url(),
  authCredentialId: z.string().optional(),
  reconnectBackoffMs: z.number().int().positive().max(60_000).optional(),
  maxReconnects: z.number().int().nonnegative().optional(),
  messageFormat: z.enum(['json', 'text']).optional(),
  headers: z.record(z.string()).optional(),
});

const sseSourceSchema = z.object({
  kind: z.literal('sse'),
  url: z.string().url(),
  authCredentialId: z.string().optional(),
  eventTypes: z.array(z.string()).optional(),
  reconnectDelayMs: z.number().int().positive().optional(),
  headers: z.record(z.string()).optional(),
});

const httpPollSourceSchema = z.object({
  kind: z.literal('http_poll'),
  url: z.string().url(),
  method: z.enum(['GET', 'POST']).optional(),
  intervalMs: z.number().int().min(5_000),
  authCredentialId: z.string().optional(),
  cursor: cursorSchema.optional(),
  adaptiveBackoff: z.boolean().optional(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  itemsPath: z.string().optional(),
});

const messageQueueSourceSchema = z.object({
  kind: z.literal('message_queue'),
  protocol: z.enum(['amqp', 'kafka', 'redis_pubsub', 'sqs']),
  credentialId: z.string().min(1),
  topic: z.string().min(1),
  consumerGroup: z.string().optional(),
  batchSize: z.number().int().positive().optional(),
});

const dbNotifySourceSchema = z.object({
  kind: z.literal('db_notify'),
  credentialId: z.string().min(1),
  channel: z.string().min(1),
});

const fileWatchSourceSchema = z.object({
  kind: z.literal('file_watch'),
  path: z.string().min(1),
  events: z.array(z.enum(['add', 'change', 'unlink'])).min(1),
  glob: z.string().optional(),
  debounceMs: z.number().int().nonnegative().optional(),
});

const extensionSourceSchema = z
  .object({
    kind: z.literal('extension'),
    extensionId: z.string().min(1).optional(),
    extensionSlug: z.string().min(1).optional(),
    operationName: z.string().min(1),
    config: z.record(z.unknown()).optional(),
    pollIntervalMs: z.number().int().min(5_000).optional(),
    cursor: cursorSchema.optional(),
  })
  .refine((source) => Boolean(source.extensionId || source.extensionSlug), {
    message: 'extension source requires extensionId or extensionSlug',
  });

const agentEventSourceSchema = z.object({
  kind: z.literal('agent_event'),
  agentId: z.string().min(1),
  eventTypes: z.array(z.string().min(1)).min(1),
});

const workflowEventSourceSchema = z.object({
  kind: z.literal('workflow_event'),
  workflowId: z.string().min(1),
  onStatus: z.array(z.enum(['COMPLETED', 'FAILED', 'CANCELLED'])).min(1),
  sourceNodeId: z.string().optional(),
});

const rssSourceSchema = z.object({
  kind: z.literal('rss'),
  feedUrl: z.string().url(),
  intervalMs: z.number().int().min(5_000).optional(),
  headers: z.record(z.string()).optional(),
});

const emailImapSourceSchema = z.object({
  kind: z.literal('email_imap'),
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  secure: z.boolean().optional(),
  credentialId: z.string().optional(),
  mailbox: z.string().optional(),
  search: z.string().optional(),
  pollIntervalMs: z.number().int().min(5_000).optional(),
});

export const listenerSourceSchema = z.union([
  intervalSourceSchema,
  websocketSourceSchema,
  sseSourceSchema,
  httpPollSourceSchema,
  messageQueueSourceSchema,
  dbNotifySourceSchema,
  fileWatchSourceSchema,
  extensionSourceSchema,
  agentEventSourceSchema,
  workflowEventSourceSchema,
  rssSourceSchema,
  emailImapSourceSchema,
]);

export const listenerPredicateSchema = z.union([
  z.object({ kind: z.literal('always') }),
  z.object({
    kind: z.literal('jsonpath'),
    expression: z.string().min(1),
    operator: z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'exists', 'not_exists']),
    expected: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('jmespath'),
    expression: z.string().min(1),
    truthy: z.boolean().optional(),
  }),
  z
    .object({
      kind: z.literal('extension'),
      extensionId: z.string().min(1).optional(),
      extensionSlug: z.string().min(1).optional(),
      operationName: z.string().min(1),
      config: z.record(z.unknown()).optional(),
      cacheWindowMs: z.number().int().nonnegative().optional(),
    })
    .refine((predicate) => Boolean(predicate.extensionId || predicate.extensionSlug), {
      message: 'extension predicate requires extensionId or extensionSlug',
    }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string().min(1),
    prompt: z.string().min(1),
    outputField: z.string().optional(),
    passValues: z.array(z.string()).optional(),
    cacheWindowMs: z.number().int().nonnegative().optional(),
    maxBudgetTokens: z.number().int().positive().optional(),
  }),
]);

export const firePolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('immediate') }),
  z.object({
    mode: z.literal('batch'),
    size: z.number().int().positive(),
    maxWaitMs: z.number().int().positive(),
    coalesceKey: z.string().optional(),
  }),
  z.object({ mode: z.literal('debounce'), windowMs: z.number().int().positive() }),
  z.object({ mode: z.literal('throttle'), windowMs: z.number().int().positive() }),
  z.object({ mode: z.literal('leading_edge'), cooldownMs: z.number().int().positive() }),
]);

export const listenerConfigSchema = z.object({
  source: listenerSourceSchema,
  predicate: listenerPredicateSchema.optional().default({ kind: 'always' }),
  firePolicy: firePolicySchema.optional().default({ mode: 'immediate' }),
  payloadTransform: z.string().optional(),
  errorPolicy: z
    .object({
      onSourceError: z.enum(['pause', 'continue', 'deactivate']),
      maxConsecutiveErrors: z.number().int().positive().optional(),
      alertOnError: z.boolean().optional(),
    })
    .optional(),
});



