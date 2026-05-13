/**
 * Adapter contract — V1-SPEC §10.
 *
 * Adapters are how Agentis dispatches NormalizedTask payloads to OpenClaw,
 * Claude Code, or generic HTTP backends, and how they stream
 * NormalizedAgentEvent back into the engine.
 */

export type AdapterType = 'openclaw' | 'claude_code' | 'http';

export interface AgentAdapter {
  readonly adapterType: AdapterType;
  connect(config: AgentAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<AdapterHealthStatus>;
  dispatchTask(task: NormalizedTask): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  createPersistentListener?(trigger: TriggerConfig): Promise<TriggerListenerHandle>;
  onEvent(handler: (event: NormalizedAgentEvent) => void): void;
}

export type AgentAdapterConfig =
  | OpenClawAdapterConfig
  | ClaudeCodeAdapterConfig
  | HttpAdapterConfig;

export interface OpenClawAdapterConfig {
  adapterType: 'openclaw';
  gatewayId: string;
  gatewayUrl: string;
  deviceTokenCredentialId: string;
  agentName: string;
}

export interface ClaudeCodeAdapterConfig {
  adapterType: 'claude_code';
  claudeBinaryPath: string;
  workingDirectory: string;
  allowedTools: string[];
  modelOverride?: string;
  maxTurns?: number;
}

export interface HttpAdapterConfig {
  adapterType: 'http';
  baseUrl: string;
  authCredentialId?: string;
  dispatchPath: string;
  cancelPath?: string;
  healthPath?: string;
  dispatchTimeoutMs: number;
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
