import type { ChatPlan, PlanLifecycleEvent } from './plan.js';

/**
 * Chat-agent loop types — CHAT-AGENT-LOOP.md §2.
 *
 * Shared between the API (HermesAdapter, chatToolCatalog, chatToolExecutor)
 * and the web app (ChatPanel SSE consumer, future streaming hooks).
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Per-conversation permission mode (Claude-Code style), sticky per thread.
 * - `ask`  — confirm before any mutating tool runs (default).
 * - `plan` — propose a plan and block mutations this turn (maps to
 *            executionMode 'plan', enforced at the tool registry).
 * - `auto` — run everything without confirmation (bypass).
 */
export type ChatPermissionMode = 'ask' | 'plan' | 'auto';

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentBlock[];
  /** Present when role === 'tool'. Must match the tool_call id from the preceding assistant turn. */
  toolCallId?: string;
  /** Present when role === 'assistant' and the model requested tool invocations. */
  toolCalls?: ChatToolCall[];
}

export interface ChatContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  content?: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ChatConfirmationRequest {
  turnId: string;
  toolCall: {
    id: string;
    name: string;
    args: unknown;
  };
  title: string;
  body: string;
  impact?: {
    summary: string;
    details?: string[];
    riskLevel?: 'low' | 'medium' | 'high' | 'danger';
    reversible?: boolean;
    externalSideEffects?: boolean;
  };
  confirmLabel: string;
  cancelLabel: string;
  expiresAt: string;
}

export type ChatFinishReason = 'stop' | 'tool_calls' | 'max_turns' | 'error' | 'length';

export interface ChatTurnTrace {
  clientTurnId?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  finishReason?: ChatFinishReason;
  status: 'running' | 'completed' | 'failed' | 'stopped';
}

/**
 * Discriminated union streamed by `AgentAdapter.chat()`.
 * Consumers accumulate `text` deltas, act on `tool_call` events,
 * and terminate on `done`.
 */
export type ChatDelta =
  | {
      type: 'activity';
      id: string;
      label: string;
      detail?: string;
      phase: 'received' | 'context' | 'runtime' | 'tool' | 'workflow' | 'waiting' | 'complete' | 'error';
      status: 'running' | 'success' | 'error';
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      workflowId?: string;
      runId?: string;
      nodeId?: string;
      agentId?: string;
      clientTurnId?: string;
    }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | ({ type: 'confirmation_required' } & ChatConfirmationRequest)
  | { type: 'tool_result'; id: string; name: string; result: unknown; error?: string }
  | { type: 'plan'; event: PlanLifecycleEvent; plan: ChatPlan }
  // `length` = the model hit its output-token ceiling (typically a reasoning
  // model that spent the budget thinking and never emitted a final answer). It
  // is surfaced distinctly so the turn loop can recover (retry with more room)
  // instead of treating a truncated turn as a clean, empty stop.
  | { type: 'done'; finishReason: ChatFinishReason };

export type JsonSchemaObject = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject;
  required?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
};

export interface ToolDefinition {
  name: string;
  description: string;
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    expectedOutput?: unknown;
  }>;
  parameters: {
    type: 'object';
    properties: Record<string, JsonSchemaObject>;
    required?: string[];
  };
}

/** Runtime context injected into every chat turn, threaded through the tool executor. */
export interface ChatTurnContext {
  workspaceId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  /**
   * When set, the turn runs in an Agentic App's context (Living Apps Phase 0):
   * datastore tools (`agentis.appData.*` / `data_insert`) resolve to this App, so
   * the agent persists what it learns where the App's surfaces read it.
   */
  appId?: string | null;
  clientTurnId?: string;
  executionMode?: 'chat' | 'plan';
  /** Optional operation/run correlation id for direct tool turns. */
  runId?: string;
  ambientId?: string | null;
  maxTurns?: number;
  /**
   * Per-conversation permission mode. Governs whether mutating tools confirm
   * (`ask`), are blocked behind a plan (`plan`), or run freely (`auto`).
   * Defaults to `ask` when unset.
   */
  permissionMode?: ChatPermissionMode;
  viewport?: ViewportContext | null;
  /**
   * Cancellation signal for the whole turn, wired from the HTTP request. When the
   * operator disconnects (closes the SSE stream / navigates away) it aborts, and
   * the chat loop + any model-backed tool work (notably workflow synthesis) stops
   * instead of spending model credits on a turn nobody is listening to.
   */
  signal?: AbortSignal;
}

/** Viewport metadata attached to each chat session for context-aware tool filtering. */
export interface ViewportContext {
  surface: AgentisSurface;
  route?: string;
  title?: string;
  workspaceId?: string;
  ambientId?: string | null;
  /** Active resource id on the current surface (e.g. workflowId, agentId, runId). */
  resourceId?: string;
  resourceKind?: 'workflow' | 'run' | 'agent' | 'artifact' | 'extension' | 'package' | 'ledger' | 'room' | 'app' | 'unknown';
  selection?: {
    ids?: string[];
    label?: string;
    kind?: string;
  } | null;
  activeRunId?: string | null;
  metadata?: Record<string, unknown>;
}

export type AgentisSurface =
  | 'home'
  | 'apps'
  | 'app_detail'
  | 'workflows'
  | 'workflow_detail'
  | 'agents'
  | 'agent_detail'
  | 'canvas'
  | 'runs'
  | 'run_detail'
  | 'run_modal'
  | 'artifacts'
  | 'artifact_detail'
  | 'packages'
  | 'extensions'
  | 'ledger'
  | 'history'
  | 'settings'
  | 'chat'
  | 'unknown';

export interface AgentisToolCallRequest {
  id: string;
  toolId: string;
  arguments: Record<string, unknown>;
}

export interface AgentisToolCallResult {
  id: string;
  toolId: string;
  ok: boolean;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  nextActions?: Array<{ toolId: string; rationale: string }>;
  costCents?: number;
  durationMs?: number;
}

export type AgentisToolFamily = 'build' | 'run' | 'inspect' | 'data' | 'environment' | 'app';

export interface AgentisToolDefinition {
  id: string;
  family: AgentisToolFamily;
  description: string;
  longDescription?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  mutating: boolean;
  /**
   * Mutating tools default to confirmation in chat. Set autoExecute for
   * reversible, operator-requested creation/build actions that should happen
   * immediately, with the result still visible in the execution feed.
   */
  autoExecute?: boolean;
  mcpExposed?: boolean;
  requires?: string[];
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    expectedOutput?: unknown;
  }>;
}

export interface AgentisToolContext {
  workspaceId: string;
  userId: string;
  ambientId?: string | null;
  agentId?: string;
  runId?: string;
  conversationId?: string;
  executionMode?: 'chat' | 'plan';
  viewport?: ViewportContext | null;
  /**
   * Ambient Agentic App for this turn (Living Apps Phase 0). When set, App-scoped
   * tools (`agentis.appData.*` / `data_insert`) resolve to it without an explicit
   * `appId` — so a resident channel agent persists to its App's datastore.
   */
  appId?: string | null;
  caller: 'chat' | 'workflow' | 'mcp' | 'system';
  /**
   * Cancellation signal propagated from the calling turn. A long, model-backed
   * tool (e.g. `agentis.build_workflow`) should honor it so an aborted turn stops
   * spending instead of running to completion in the background.
   */
  signal?: AbortSignal;
}

export interface AgentisToolCatalog {
  tools: AgentisToolDefinition[];
  hash: string;
  generatedAt: string;
}
