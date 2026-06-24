/**
 * AdapterManager.
 *
 * Owns the lifecycle of agent adapters: registration, dispatch, cancel,
 * inbound event bridging, and per-adapter health introspection.
 *
 * V1 ships with six concrete harness adapters: OpenClawAdapter,
 * HermesAgentAdapter, ClaudeCodeAdapter, CodexAdapter, CursorAdapter, and
 * HttpAdapter. Operators register them through the
 * `/v1/agents` routes; the engine knows nothing about which type backs an
 * agent — it just calls `dispatchTask(task, agentId)`.
 *
 * The manager also fans out non-task adapter events (session messages,
 * approval requests, status changes, heartbeats) to side-channel handlers
 * so SessionMirror and ApprovalBridge can react without coupling to any
 * specific adapter implementation.
 */

import { AgentisError } from '@agentis/core';
import type {
  AgentAdapter,
  AdapterCapabilities,
  AdapterType,
  NormalizedAgentEvent,
  NormalizedTask,
  ToolManifestEntry,
} from '@agentis/core';
import type { Logger } from '../logger.js';
import { noopTelemetry, type Telemetry } from '../telemetry/index.js';

export type AdapterEventHandler = (event: NormalizedAgentEvent, agentId: string) => void;

export interface AdapterRegistration {
  agentId: string;
  adapterType: AdapterType;
  adapter: AgentAdapter;
}

export type ToolManifestProvider = (agentId: string, adapterType: AdapterType) => ToolManifestEntry[];

export class AdapterManager {
  readonly #adapters = new Map<string, AdapterRegistration>();
  readonly #handlers = new Set<AdapterEventHandler>();
  readonly #telemetry: Telemetry;
  #toolManifestProvider: ToolManifestProvider | null = null;

  constructor(
    private readonly logger: Logger,
    telemetry: Telemetry = noopTelemetry,
  ) {
    this.#telemetry = telemetry;
  }

  /**
   * Register a provider that supplies the platform tool-awareness manifest for
   * workflow-dispatched tasks. Wired in bootstrap from the tool registry so the
   * manager stays decoupled from it. (CHAT-10X-VISION §4.4.2.)
   */
  setToolManifestProvider(provider: ToolManifestProvider | null): void {
    this.#toolManifestProvider = provider;
  }

  register(agentId: string, adapter: AgentAdapter): void {
    this.#adapters.set(agentId, {
      agentId,
      adapterType: adapter.adapterType,
      adapter,
    });
    adapter.onEvent((event) => {
      for (const h of this.#handlers) {
        try {
          h(event, agentId);
        } catch (err) {
          this.logger.error('adapter.handler.threw', {
            agentId,
            err: (err as Error).message,
          });
        }
      }
    });
  }

  async unregister(agentId: string): Promise<void> {
    const reg = this.#adapters.get(agentId);
    if (!reg) return;
    try {
      await reg.adapter.disconnect();
    } catch (err) {
      this.logger.warn('adapter.disconnect_failed', { agentId, err: (err as Error).message });
    }
    this.#adapters.delete(agentId);
  }

  onEvent(handler: AdapterEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  get(agentId: string): AdapterRegistration | undefined {
    return this.#adapters.get(agentId);
  }

  capabilities(agentId: string): AdapterCapabilities | null {
    const reg = this.#adapters.get(agentId);
    return reg?.adapter.capabilities?.() ?? null;
  }

  /**
   * The agent adapter's configured working directory, if it spawns local
   * processes. The engine uses this as the BASE from which it derives an
   * isolated per-task `workdir` for parallel subtasks. Returns undefined for
   * gateway/remote adapters (no local cwd) or unregistered agents.
   */
  workdirOf(agentId: string): string | undefined {
    return this.#adapters.get(agentId)?.adapter.getWorkdir?.();
  }

  async dispatchTask(task: NormalizedTask, agentId: string): Promise<void> {
    const reg = this.#adapters.get(agentId);
    if (!reg) {
      throw new AgentisError(
        'ADAPTER_UNAVAILABLE',
        `No adapter registered for agent ${agentId}.`,
      );
    }
    // Inject the platform tool-awareness manifest unless the caller already set
    // one. Best-effort: a provider failure must never block dispatch.
    let effectiveTask = task;
    if (!task.toolManifest && this.#toolManifestProvider) {
      try {
        const manifest = this.#toolManifestProvider(agentId, reg.adapterType);
        if (manifest.length > 0) effectiveTask = { ...task, toolManifest: manifest };
      } catch (err) {
        this.logger.warn('adapter.tool_manifest_failed', { agentId, err: (err as Error).message });
      }
    }
    await this.#telemetry.span(
      'adapter.dispatch',
      () => reg.adapter.dispatchTask(effectiveTask),
      {
        'agentis.agent_id': agentId,
        'agentis.adapter_type': reg.adapterType,
        'agentis.task_id': task.taskId,
      },
    );
  }

  async cancelTask(agentId: string, taskId: string): Promise<void> {
    const reg = this.#adapters.get(agentId);
    if (!reg) return;
    await reg.adapter.cancelTask(taskId);
  }

  async healthCheck(agentId: string) {
    const reg = this.#adapters.get(agentId);
    if (!reg) return undefined;
    try {
      return await reg.adapter.healthCheck();
    } catch (err) {
      return {
        isHealthy: false,
        error: (err as Error).message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  list(): AdapterRegistration[] {
    return Array.from(this.#adapters.values());
  }
}
