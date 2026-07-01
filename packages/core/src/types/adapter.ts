/**
 * Adapter contract — V1-SPEC §10.
 *
 * Adapters are how Agentis dispatches NormalizedTask payloads to V1 harnesses
 * and how those harnesses stream
 * NormalizedAgentEvent back into the engine.
 */

import type { ChatDelta, ChatMessage, ToolDefinition } from './chat.js';

export type AdapterType = 'openclaw' | 'claude_code' | 'http' | 'codex' | 'cursor' | 'hermes_agent' | 'antigravity' | 'local_llm';

export interface RuntimeContext {
  provider: string;
  models: {
    id: string;
    label: string;
    recommended?: boolean;
    legacy?: boolean;
    source?: RuntimeValueSource;
    verified?: boolean;
  }[];
  currentModel: string;
  currentModelSource?: RuntimeValueSource;
  currentModelVerified?: boolean;
  efforts?: { id: string; label: string }[];
  currentEffort?: string;
  fastModeSupported?: boolean;
  fastModeEnabled?: boolean;
  contextWindow?: {
    text: string;
    percentage: number;
  };
  usage?: {
    label: string;
    percentage: number;
    resetText?: string;
    valueText?: string;
    color?: 'red' | 'blue' | 'green' | 'default';
  }[];
}

/** Per-call options for {@link AgentAdapter.chat}. Optional + additive so every
 *  existing adapter implementation (which omits the 3rd arg) stays valid. */
export interface ChatInvocationOptions {
  /** Abort the in-flight model request when the caller's turn is canceled. */
  signal?: AbortSignal;
  /** Per-call model override, when the adapter supports model selection. */
  preferredModel?: string | null;
  /**
   * Interactive turns prioritize first-response latency over deep autonomous
   * reasoning. Deliberate calls retain the adapter's configured task profile.
   */
  latencyClass?: 'interactive' | 'structured' | 'deliberate';
  /** Per-call wall-clock deadline for one model round. */
  timeoutMs?: number;
  /**
   * Controls who owns the tool loop. `caller_loop` avoids cold-starting an
   * adapter-native agent loop and returns tool calls to Agentis for execution.
   */
  toolMode?: 'adapter_native' | 'caller_loop';
  /**
   * Per-call output-token ceiling. Overrides the adapter's configured default for
   * this one invocation — used by the turn loop to retry a starved/truncated turn
   * with more room. Adapters that don't support it simply ignore it.
   */
  maxTokens?: number;
  /**
   * Stable owner for runtime-native conversation state. Interactive chat passes
   * the Agentis conversation id; workflow/task callers use their run/task key.
   * Adapters must never keep one global resume id for unrelated conversations.
   */
  sessionKey?: string;
}

export type RuntimeValueSource =
  | 'runtime'
  | 'profile'
  | 'agent_config'
  | 'workspace_policy'
  | 'fallback';

export interface RuntimeValue<T> {
  value: T;
  source: RuntimeValueSource;
  observedAt: string;
  verified: boolean;
}

export type RuntimeResourceKind =
  | 'identity'
  | 'instructions'
  | 'config'
  | 'memory'
  | 'skill'
  | 'plugin'
  | 'session'
  | 'tool_config'
  | 'secret_reference'
  | 'generated_overlay';

export interface RuntimeResourceDescriptor {
  id: string;
  name: string;
  description?: string;
  kind: RuntimeResourceKind;
  path?: string;
  scope: 'runtime' | 'profile' | 'workspace' | 'project' | 'agent';
  origin: 'runtime' | 'user' | 'agentis';
  editable: boolean;
  sensitive: boolean;
  format: 'markdown' | 'yaml' | 'json' | 'toml' | 'text' | 'directory' | 'database' | 'opaque';
  loadPolicy: 'startup' | 'session' | 'turn' | 'on_demand';
  reloadPolicy: 'automatic' | 'new_session' | 'restart_required';
  checksum?: string;
  updatedAt?: string;
  sizeBytes?: number;
  effective: boolean;
}

export interface RuntimeResourceContent {
  resource: RuntimeResourceDescriptor;
  content: string;
}

export interface RuntimeResourceWriteResult {
  resource: RuntimeResourceDescriptor;
  content: string;
}

export interface RuntimeSessionInfo {
  id: string;
  sessionKey: string;
  runtimeSessionId: string;
  status: 'active' | 'idle' | 'stale' | 'closed' | 'error';
  selectedModel?: string | null;
  processGeneration?: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

export interface RuntimeDescriptor {
  adapterType: AdapterType;
  displayName: string;
  version?: RuntimeValue<string> | null;
  binary?: RuntimeValue<string> | null;
  home?: RuntimeValue<string> | null;
  profile?: RuntimeValue<string> | null;
  provider?: RuntimeValue<string> | null;
  currentModel?: RuntimeValue<string> | null;
  models: Array<{
    id: string;
    label: string;
    recommended?: boolean;
    legacy?: boolean;
    source: RuntimeValueSource;
    verified: boolean;
  }>;
  health: AdapterHealthStatus;
  capabilities: AdapterCapabilities;
  process: {
    warm: boolean;
    generation?: number;
    activeSessions?: number;
  };
  resourceCount: number;
  probedAt: string;
  limitations?: string[];
}

export interface AgentAdapter {
  readonly adapterType: AdapterType;
  connect(config: AgentAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<AdapterHealthStatus>;
  capabilities?(): AdapterCapabilities;
  getRuntimeContext?(): Promise<RuntimeContext>;
  describeRuntime?(): Promise<Partial<RuntimeDescriptor>>;
  listRuntimeResources?(): Promise<RuntimeResourceDescriptor[]>;
  readRuntimeResource?(id: string): Promise<RuntimeResourceContent>;
  writeRuntimeResource?(
    id: string,
    content: string,
    expectedChecksum?: string,
  ): Promise<RuntimeResourceWriteResult>;
  listRuntimeSessions?(): Promise<RuntimeSessionInfo[]>;
  closeRuntimeSession?(sessionKey: string): Promise<void>;
  dispatchTask(task: NormalizedTask): Promise<void>;
  /**
   * The adapter's statically-configured working directory, if it spawns local
   * processes. The engine reads this as the BASE from which it derives an
   * isolated per-task `workdir` for parallel subtasks. Adapters that don't run
   * local processes (gateway/remote) omit it.
   */
  getWorkdir?(): string | undefined;
  chat?(history: ChatMessage[], tools: ToolDefinition[], options?: ChatInvocationOptions): AsyncIterable<ChatDelta>;
  cancelTask(taskId: string): Promise<void>;
  createPersistentListener?(trigger: TriggerConfig): Promise<TriggerListenerHandle>;
  onEvent(handler: (event: NormalizedAgentEvent) => void): void;
}

export const AGENT_AFFORDANCES = [
  'browser',
  'codebaseIndex',
  'fileSystem',
  'terminal',
  'computerUse',
  'nativeMcp',
] as const;

export type AgentAffordance = typeof AGENT_AFFORDANCES[number];

export interface AgentRequirements extends Partial<Record<AgentAffordance, boolean>> {}

export interface AdapterCapabilities {
  /** Can this runtime participate in the interactive chat loop? */
  interactiveChat: boolean;
  /** Can this runtime ask Agentis to execute tools from chat? */
  toolCalling: boolean;
  /**
   * How tool calls are transported from the runtime back into Agentis.
   * - `native`         — streaming function-calling in one connection (HTTP adapters).
   * - `marker_protocol`— CLI emits tool markers in text; the platform parses,
   *                      executes, and RE-SPAWNS the CLI per round (slow).
   * - `mcp_native`     — the harness reaches Agentis tools directly over MCP and
   *                      runs its OWN agentic loop in a single invocation. No
   *                      platform-driven re-spawn; the harness stays the brain.
   * - `http_contract` / `session_event` / `none` — see the respective adapters.
   */
  toolForwarding: 'native' | 'marker_protocol' | 'mcp_native' | 'http_contract' | 'session_event' | 'none';
  /** Human-readable caveats shown in settings/diagnostics. */
  limitations?: string[];
  /** Execution environment capabilities */
  execution?: {
    terminal?: boolean;
    fileSystem?: boolean;
    browser?: boolean;
    longRunning?: boolean;
    pausable?: boolean;
    sandbox?: 'none' | 'docker' | 'vm' | string;
    maxConcurrent?: number;
  };
  /** Granted runtime affordances for routing. */
  affordances?: Partial<Record<AgentAffordance, boolean>>;
  /** Memory injection support. */
  memory?: {
    injectable?: boolean;
    ingestible?: boolean;
  };
}

export type AgentAdapterConfig =
  | OpenClawAdapterConfig
  | ClaudeCodeAdapterConfig
  | CodexAdapterConfig
  | CursorAdapterConfig
  | HermesAgentAdapterConfig
  | AntigravityAdapterConfig
  | HttpAdapterConfig;

export interface OpenClawAdapterConfig {
  adapterType: 'openclaw';
  gatewayId?: string;
  gatewayUrl: string;
  deviceTokenCredentialId?: string;
  authCredentialId?: string;
  authToken?: string;
  headers?: Record<string, string>;
  password?: string;
  agentName?: string;
  sessionKeyStrategy?: 'issue' | 'fixed' | 'run';
  sessionKey?: string;
  disableDeviceAuth?: boolean;
  devicePrivateKeyCredentialId?: string;
  timeoutSec?: number;
  payloadTemplate?: Record<string, unknown>;
}

export interface ClaudeCodeAdapterConfig {
  adapterType: 'claude_code';
  binaryPath?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  dangerouslySkipPermissions?: boolean;
}

export interface CodexAdapterConfig {
  adapterType: 'codex';
  binaryPath?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  fastMode?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /**
   * Opt in to the harness's native browser / computer-use. Loads the user's Codex
   * config (browser plugin + node_repl backend) instead of isolating it. Heavier
   * boot; real web browsing. Off by default.
   */
  browser?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface CursorAdapterConfig {
  adapterType: 'cursor';
  binaryPath?: string;
  cwd?: string;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface AntigravityAdapterConfig {
  adapterType: 'antigravity';
  binaryPath?: string;
  cwd?: string;
  model?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  /** Auto-approve all tool calls (`--yolo`). On by default — Agentis drives the
   *  CLI headlessly, so there is never a human to answer an approval prompt. */
  yolo?: boolean;
}

export interface HermesAgentAdapterConfig {
  adapterType: 'hermes_agent';
  binaryPath?: string;
  cwd?: string;
  model?: string;
  /**
   * `cli` is the default stable chat transport. `acp` forces the persistent
   * streaming transport; `auto` tries ACP first and falls back to CLI if it stalls.
   */
  chatTransport?: 'cli' | 'acp' | 'auto';
  maxTurns?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
  graceSec?: number;
}

export interface HttpAdapterConfig {
  adapterType: 'http';
  baseUrl: string;
  authCredentialId?: string;
  dispatchPath: string;
  cancelPath?: string;
  healthPath?: string;
  chatPath?: string;
  chatUrl?: string;
  supportsTools?: boolean;
  model?: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  payloadTemplate?: Record<string, unknown>;
  dispatchTimeoutMs: number;
  chatTimeoutMs?: number;
}

export interface AdapterHealthStatus {
  isHealthy: boolean;
  latencyMs?: number;
  error?: string;
  /**
   * True when the probe could NOT reach a verdict in time (the binary spawned but
   * did not respond within the deadline) — as opposed to a definitive failure
   * (spawn error, non-zero exit). Callers should treat this as "unknown", not
   * "down": a slow-to-probe runtime (e.g. a Python harness cold-starting under
   * load) is often fully able to serve a turn.
   */
  timedOut?: boolean;
  checkedAt: string;
}

export interface TriggerConfig {
  triggerId: string;
  workflowId: string;
  triggerType: 'manual' | 'cron' | 'webhook' | 'persistent_listener';
  /** Trigger-specific config validated by the trigger schema before use. */
  config: Record<string, unknown>;
}

export interface TriggerListenerHandle {
  triggerId: string;
  startedAt: string;
  close: () => Promise<void>;
}

export interface NormalizedTask {
  taskId: string;
  runId: string;
  workflowId: string;
  nodeId: string;
  title: string;
  description: string;
  inputData: Record<string, unknown>;
  scratchpadSnapshot: Record<string, unknown>;
  capabilityTags: string[];
  timeoutMs: number;
  callbackUrl?: string;
  /**
   * Run-scoped cancellation signal. When the operator stops the run, the engine
   * aborts this so the adapter's in-flight model call is cancelled instead of
   * running to completion after Stop. Adapters fold it into their per-task
   * controller; omitted = no external cancellation (timeout still applies).
   */
  signal?: AbortSignal;
  /**
   * Isolated working directory for THIS task, allocated by the engine for
   * parallel work (swarm/worker/delegate subtasks) so concurrent agents never
   * share one checkout and clobber each other's files. When set, the adapter
   * spawns its child process here instead of its statically-configured `cwd`.
   * Omitted = use the adapter's configured `cwd` (the single-agent default).
   */
  workdir?: string;
  /**
   * Awareness manifest of the Agentis platform tools available in this
   * workspace, injected by AdapterManager.dispatchTask so an agent running a
   * workflow node knows the platform surface exists (CHAT-10X-VISION §4.4.2).
   * Adapters format this for their LLM. Note: workflow-node dispatch is
   * fire-and-forget — this is awareness only; interactive tool execution
   * happens on the chat() path, not here.
   */
  toolManifest?: ToolManifestEntry[];

  // -- V2 Features --
  abilities?: { id: string; name: string; version: string; mode: 'compiled' | 'static' }[];
  abilityEnv?: Record<string, string>;
  preferredModel?: string | null;
}

export interface ToolManifestEntry {
  name: string;
  description: string;
}

export type NormalizedAgentEvent =
  | {
      eventType: 'task.started';
      agentId: string;
      taskId: string;
      runId: string;
      workflowId: string;
      timestamp: string;
    }
  | {
      eventType: 'task.progress';
      agentId: string;
      taskId: string;
      runId: string;
      workflowId: string;
      message: string;
      timestamp: string;
    }
  | {
      eventType: 'task.completed';
      agentId: string;
      taskId: string;
      runId: string;
      workflowId: string;
      output: Record<string, unknown>;
      timestamp: string;
    }
  | {
      eventType: 'task.failed';
      agentId: string;
      taskId: string;
      runId: string;
      workflowId: string;
      error: string;
      timestamp: string;
    }
  | {
      eventType: 'agent.thinking';
      agentId: string;
      runId: string;
      workflowId: string;
      taskId?: string;
      text?: string;
      timestamp: string;
    }
  | {
      eventType: 'agent.tool_call';
      agentId: string;
      taskId: string;
      runId: string;
      workflowId: string;
      tool: string;
      input: unknown;
      result?: unknown;
      timestamp: string;
    }
  | {
      eventType: 'agent.session_message';
      agentId: string;
      sessionId: string;
      sessionMessageId: string;
      authorType: 'agent' | 'operator' | 'system';
      body: string;
      timestamp: string;
    }
  | {
      eventType: 'agent.approval_requested';
      agentId: string;
      runId?: string;
      taskId?: string;
      title: string;
      summary: string;
      command?: unknown;
      timestamp: string;
    }
  | {
      eventType: 'agent.status';
      agentId: string;
      status: 'online' | 'busy' | 'offline' | 'error';
      timestamp: string;
    }
  | { eventType: 'agent.heartbeat'; agentId: string; connected: boolean; timestamp: string };
