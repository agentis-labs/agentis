/**
 * Chat & tool-call structures — AGENT-FIRST-ARCHITECTURE.md Plane 2.
 *
 * The shared type surface between AgentisToolRegistry, ChatToolExecutor,
 * and external MCP transports. One registry, many transports.
 *
 * Spec: docs/CHAT-AGENT-LOOP.md.
 */

/** A single tool call requested by an agent (LLM or external client). */
export interface AgentisToolCallRequest {
  /** Caller-supplied id used to correlate the result. */
  id: string;
  toolId: string;
  /** Validated against tool's input JSON Schema before dispatch. */
  arguments: Record<string, unknown>;
}

/** Result of executing a tool. Errors come back as data, never as crashes. */
export interface AgentisToolCallResult {
  id: string;
  toolId: string;
  ok: boolean;
  /** When ok=true. */
  output?: unknown;
  /** When ok=false. Error code is taken from AgentisErrorCodes. */
  errorCode?: string;
  errorMessage?: string;
  /** Optional next-action hints for the LLM. */
  nextActions?: Array<{ toolId: string; rationale: string }>;
  /** Cost in cents incurred to execute this tool (mostly 0 for deterministic). */
  costCents?: number;
  /** Latency in ms. */
  durationMs?: number;
}

/** Tool family — used by the catalog to group tools for the agent. */
export type AgentisToolFamily =
  | 'build'
  | 'run'
  | 'inspect'
  | 'data'
  | 'environment';

/** Definition of a tool. Independent of transport (chat / workflow / MCP). */
export interface AgentisToolDefinition {
  id: string;
  family: AgentisToolFamily;
  /** Short imperative description. */
  description: string;
  /** Long description used by tool schemas / docs. */
  longDescription?: string;
  /** JSON Schema for arguments. Validated by registry before dispatch. */
  inputSchema: unknown;
  /** JSON Schema for output. Used to type-check results. */
  outputSchema?: unknown;
  /** Whether this tool mutates state. Used by policy gates. */
  mutating: boolean;
  /** When true, MCP exposes this tool to external clients. */
  mcpExposed?: boolean;
  /** Required policy capabilities (e.g. 'workflow.write'). */
  requires?: string[];
}

/** Execution context threaded through every tool call. */
export interface AgentisToolContext {
  workspaceId: string;
  userId: string;
  ambientId?: string | null;
  /** When the tool call originates inside a run, the runId is supplied. */
  runId?: string;
  /** When the call originates from a chat session, the conversation id. */
  conversationId?: string;
  /** Caller label for audit (chat | workflow | mcp). */
  caller: 'chat' | 'workflow' | 'mcp' | 'system';
}

/** Catalog snapshot returned to LLM clients. */
export interface AgentisToolCatalog {
  tools: AgentisToolDefinition[];
  /** Hash of the catalog so clients can cache. */
  hash: string;
  generatedAt: string;
}
