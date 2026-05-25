/**
 * Adapter contract — V1-SPEC §10.
 *
 * Adapters are how Agentis dispatches NormalizedTask payloads to V1 harnesses
 * and how those harnesses stream
 * NormalizedAgentEvent back into the engine.
 */

import type { ChatDelta, ChatMessage, ToolDefinition } from './chat.js';

export type AdapterType = 'openclaw' | 'claude_code' | 'http' | 'codex' | 'cursor' | 'hermes_agent' | 'local_llm';

export interface AgentAdapter {
  readonly adapterType: AdapterType;
  connect(config: AgentAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<AdapterHealthStatus>;
  capabilities?(): AdapterCapabilities;
  dispatchTask(task: NormalizedTask): Promise<void>;
  chat?(history: ChatMessage[], tools: ToolDefinition[]): AsyncIterable<ChatDelta>;
  cancelTask(taskId: string): Promise<void>;
  createPersistentListener?(trigger: TriggerConfig): Promise<TriggerListenerHandle>;
  onEvent(handler: (event: NormalizedAgentEvent) => void): void;
}

export interface AdapterCapabilities {
  /** Can this runtime participate in the interactive chat loop? */
  interactiveChat: boolean;
  /** Can this runtime ask Agentis to execute tools from chat? */
  toolCalling: boolean;
  /** How tool calls are transported from the runtime back into Agentis. */
  toolForwarding: 'native' | 'marker_protocol' | 'http_contract' | 'session_event' | 'none';
  /** Human-readable caveats shown in settings/diagnostics. */
  limitations?: string[];
}

export type AgentAdapterConfig =
  | OpenClawAdapterConfig
  | ClaudeCodeAdapterConfig
  | CodexAdapterConfig
  | CursorAdapterConfig
  | HermesAgentAdapterConfig
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

export interface HermesAgentAdapterConfig {
  adapterType: 'hermes_agent';
  binaryPath?: string;
  cwd?: string;
  model?: string;
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
   * Awareness manifest of the Agentis platform tools available in this
   * workspace, injected by AdapterManager.dispatchTask so an agent running a
   * workflow node knows the platform surface exists (CHAT-10X-VISION §4.4.2).
   * Adapters format this for their LLM. Note: workflow-node dispatch is
   * fire-and-forget — this is awareness only; interactive tool execution
   * happens on the chat() path, not here.
   */
  toolManifest?: ToolManifestEntry[];
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
