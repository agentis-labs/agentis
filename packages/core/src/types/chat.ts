/**
 * Chat-agent loop types — CHAT-AGENT-LOOP.md §2.
 *
 * Shared between the API (HermesAdapter, chatToolCatalog, chatToolExecutor)
 * and the web app (ChatPanel SSE consumer, future streaming hooks).
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

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
  confirmLabel: string;
  cancelLabel: string;
  expiresAt: string;
}

/**
 * Discriminated union streamed by `AgentAdapter.chat()`.
 * Consumers accumulate `text` deltas, act on `tool_call` events,
 * and terminate on `done`.
 */
export type ChatDelta =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | ({ type: 'confirmation_required' } & ChatConfirmationRequest)
  | { type: 'tool_result'; id: string; name: string; result: unknown; error?: string }
  | { type: 'done'; finishReason: 'stop' | 'tool_calls' | 'max_turns' | 'error' };

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
  ambientId?: string | null;
  maxTurns?: number;
  viewport?: ViewportContext | null;
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
  resourceKind?: 'workflow' | 'run' | 'agent' | 'team' | 'artifact' | 'skill' | 'package' | 'ledger' | 'room' | 'space' | 'unknown';
  /** Optional active space id (UIUX §23) for any space-scoped view. */
  spaceId?: string | null;
  spaceName?: string | null;
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
  | 'workflows'
  | 'workflow_detail'
  | 'agents'
  | 'agent_detail'
  | 'teams'
  | 'team_detail'
  | 'canvas'
  | 'runs'
  | 'run_detail'
  | 'artifacts'
  | 'artifact_detail'
  | 'packages'
  | 'skills'
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

export type AgentisToolFamily = 'build' | 'run' | 'inspect' | 'data' | 'environment';

export interface AgentisToolDefinition {
  id: string;
  family: AgentisToolFamily;
  description: string;
  longDescription?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  mutating: boolean;
  mcpExposed?: boolean;
  requires?: string[];
}

export interface AgentisToolContext {
  workspaceId: string;
  userId: string;
  ambientId?: string | null;
  agentId?: string;
  runId?: string;
  conversationId?: string;
  viewport?: ViewportContext | null;
  caller: 'chat' | 'workflow' | 'mcp' | 'system';
}

export interface AgentisToolCatalog {
  tools: AgentisToolDefinition[];
  hash: string;
  generatedAt: string;
}
