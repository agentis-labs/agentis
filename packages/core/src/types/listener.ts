/**
 * Listener Runtime contract â€” EXTENSIONS-AND-LISTENER-10X Â§1.
 *
 * A persistent_listener trigger is composed of three independent, swappable
 * layers:
 *
 *   SOURCE      â€” where events come from (websocket, sse, http_poll, extension,â€¦)
 *   PREDICATE   â€” should this event fire the workflow? (always, jsonpath, agent,â€¦)
 *   FIRE POLICY â€” how matching events become workflow runs (immediate, batch,â€¦)
 *
 * The shapes live in @agentis/core so the engine, the API validators, and the
 * dashboard wizard all agree on one schema. The runtime implementation
 * (SourceDriver instances, predicate evaluation, fire-policy controllers) lives
 * in apps/api/src/engine/listener.
 */

// â”€â”€ Layer 1: Source â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ListenerSourceKind =
  | 'websocket'
  | 'sse'
  | 'http_poll'
  | 'message_queue'
  | 'db_notify'
  | 'file_watch'
  | 'extension'
  | 'agent_event'
  | 'workflow_event'
  | 'rss'
  | 'email_imap';

export type ListenerSource =
  | {
      kind: 'websocket';
      url: string;
      authCredentialId?: string;
      reconnectBackoffMs?: number; // default 1000, max 60000
      maxReconnects?: number;
      messageFormat?: 'json' | 'text';
      headers?: Record<string, string>;
    }
  | {
      kind: 'sse';
      url: string;
      authCredentialId?: string;
      eventTypes?: string[]; // filter by event name; empty = all
      reconnectDelayMs?: number;
      headers?: Record<string, string>;
    }
  | {
      kind: 'http_poll';
      url: string;
      method?: 'GET' | 'POST';
      intervalMs: number; // min 5000
      authCredentialId?: string;
      cursor?: CursorConfig;
      adaptiveBackoff?: boolean;
      headers?: Record<string, string>;
      body?: unknown;
      /** JSONPath/JMESPath to an array in the response; each item becomes one event. */
      itemsPath?: string;
    }
  | {
      kind: 'message_queue';
      protocol: 'amqp' | 'kafka' | 'redis_pubsub' | 'sqs';
      credentialId: string;
      topic: string;
      consumerGroup?: string;
      batchSize?: number;
    }
  | {
      kind: 'db_notify';
      credentialId: string;
      channel: string;
    }
  | {
      kind: 'file_watch';
      path: string;
      events: Array<'add' | 'change' | 'unlink'>;
      glob?: string;
      debounceMs?: number;
    }
  | {
      // The power move: an Extension operation IS the source.
      kind: 'extension';
      extensionId?: string;
      extensionSlug?: string;
      operationName: string;
      config?: Record<string, unknown>;
      pollIntervalMs?: number; // if the operation is polling-style; default 60000
      cursor?: CursorConfig;
    }
  | {
      kind: 'agent_event';
      agentId: string;
      eventTypes: string[]; // e.g. ['run.completed', 'task.failed']
    }
  | {
      kind: 'workflow_event';
      /** A specific workflow id, or `'*'` to match any workflow in the workspace (error_trigger). */
      workflowId: string;
      onStatus: Array<'COMPLETED' | 'FAILED' | 'CANCELLED'>;
      sourceNodeId?: string;
    }
  | {
      kind: 'rss';
      feedUrl: string;
      intervalMs?: number; // min 5000; default 300000
      headers?: Record<string, string>;
    }
  | {
      kind: 'email_imap';
      host: string;
      port?: number;
      secure?: boolean;
      credentialId?: string;
      mailbox?: string;
      search?: string;
      pollIntervalMs?: number;
    };

export interface CursorConfig {
  /** Key the cursor is persisted under (workflow-scoped KV). */
  scratchpadKey: string;
  /** JSONPath/JMESPath to extract the cursor value from a received event. */
  extractPath: string;
  initialValue?: unknown;
  /** Inject the cursor into the poll request as a query param. */
  includeCursorInPayload?: boolean;
  cursorParamName?: string; // e.g. 'since', 'after', 'page_token'
}

// â”€â”€ Layer 2: Predicate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ListenerPredicateKind = 'always' | 'jsonpath' | 'jmespath' | 'extension' | 'agent';

export type JsonPathOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'exists' | 'not_exists';

export type ListenerPredicate =
  | { kind: 'always' }
  | {
      kind: 'jsonpath';
      expression: string;
      operator: JsonPathOperator;
      expected?: unknown;
    }
  | {
      kind: 'jmespath';
      expression: string;
      truthy?: boolean; // default true
    }
  | {
      kind: 'extension';
      extensionId?: string;
      extensionSlug?: string;
      operationName: string; // returns { matched: boolean, reason?: string }
      config?: Record<string, unknown>;
      cacheWindowMs?: number;
    }
  | {
      // Semantic judgment â€” the Agentis-exclusive capability.
      kind: 'agent';
      agentId: string;
      prompt: string;
      outputField?: string; // default 'decision'
      passValues?: string[]; // default ['yes','true','1','fire']
      cacheWindowMs?: number;
      maxBudgetTokens?: number;
    };

export interface PredicateResult {
  matched: boolean;
  reason?: string;
}

// â”€â”€ Layer 3: Fire policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type FirePolicyMode = 'immediate' | 'batch' | 'debounce' | 'throttle' | 'leading_edge';

export type FirePolicy =
  | { mode: 'immediate' }
  | {
      mode: 'batch';
      size: number;
      maxWaitMs: number;
      coalesceKey?: string; // JSONPath to dedup key
    }
  | { mode: 'debounce'; windowMs: number }
  | { mode: 'throttle'; windowMs: number }
  | { mode: 'leading_edge'; cooldownMs: number };

// â”€â”€ The composed config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ListenerConfig {
  source: ListenerSource;
  predicate?: ListenerPredicate; // default { kind: 'always' }
  firePolicy?: FirePolicy; // default { mode: 'immediate' }
  /** Optional JMESPath/JSONPath to reshape the event before it becomes workflow inputs. */
  payloadTransform?: string;
  errorPolicy?: {
    onSourceError: 'pause' | 'continue' | 'deactivate';
    maxConsecutiveErrors?: number;
    alertOnError?: boolean;
  };
}

/**
 * Type guard distinguishing the new ListenerConfig shape from the legacy
 * adapter-coupled `{ agentId }` config. TriggerRuntime routes on this.
 */
export function isListenerConfigV2(config: unknown): config is ListenerConfig {
  return (
    !!config &&
    typeof config === 'object' &&
    'source' in config &&
    !!(config as { source?: unknown }).source &&
    typeof (config as { source?: { kind?: unknown } }).source === 'object' &&
    typeof (config as { source: { kind?: unknown } }).source.kind === 'string'
  );
}

// â”€â”€ Runtime-facing contracts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ListenerHealth {
  connected: boolean;
  status: 'active' | 'paused' | 'error' | 'connecting';
  sourceKind: ListenerSourceKind;
  lastEventAt?: string;
  lastFireAt?: string;
  eventCount: number;
  fireCount: number;
  skipCount: number;
  errorCount: number;
  lastError?: string;
  consecutiveErrors: number;
}

export interface ListenerEventLogEntry {
  id: string;
  receivedAt: string;
  payloadSummary: string;
  predicateResult?: PredicateResult;
  firedRunId?: string | null;
  suppressedBy?: FirePolicyMode;
}

/**
 * Every source type is a concrete implementation of this contract. The runtime
 * instantiates the right driver and connects it to the predicate + fire-policy
 * layers.
 */
export interface SourceDriver {
  readonly kind: ListenerSourceKind;
  /** Start the source. Call onEvent for each incoming event. */
  start(onEvent: (payload: Record<string, unknown>) => void): Promise<void>;
  /** Gracefully close the source connection. */
  close(): Promise<void>;
  /** True while the underlying transport is connected/healthy. */
  isConnected(): boolean;
}



