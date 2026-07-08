/**
 * ListenerRuntime — EXTENSIONS-AND-LISTENER-10X §1, §7.
 *
 * The coordinator for persistent_listener v2 triggers. For each active trigger
 * whose config is a ListenerConfig (source/predicate/firePolicy), it wires:
 *
 *     SourceDriver ──onEvent──▶ PredicateEvaluator ──matched──▶ FirePolicyController ──▶ fire()
 *
 * updating a ListenerHealthStore and emitting LISTENER_* realtime events along
 * the way. Legacy adapter-coupled listeners ({ agentId }) are NOT handled here
 * — TriggerRuntime routes those to the adapter path for backward compatibility.
 */

import {
  AgentisError,
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  isListenerConfigV2,
  type ListenerConfig,
  type FirePolicyMode,
  type PredicateResult,
  type SourceDriver,
} from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { EventBus } from '../event-bus.js';
import type { WorkflowStoreService } from '../services/workflow/workflowStore.js';
import type { ExtensionRuntime } from '../services/extensionRuntime.js';
import type { ActiveTrigger } from './ActiveWorkflowRegistry.js';
import { ListenerHealthStore } from './listener/health.js';
import { ListenerCursor } from './listener/cursor.js';
import { PredicateEvaluator, type AgentJudge } from './listener/predicate.js';
import { FirePolicyController } from './listener/firePolicy.js';
import { createSourceDriver } from './listener/sources.js';
import { evalJmesLite } from './listener/jsonpath.js';

export interface ListenerFireFn {
  (args: { trigger: ActiveTrigger; payload: Record<string, unknown> }): Promise<{ runId: string }>;
}

export interface ListenerRuntimeDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  bus: EventBus;
  workflowStore: WorkflowStoreService;
  health: ListenerHealthStore;
  extensionRuntime?: ExtensionRuntime;
  agentJudge?: AgentJudge;
  /** Bound to TriggerRuntime.fire — the single run-creation entrypoint. */
  fire: ListenerFireFn;
  allowPrivateNetwork: boolean;
}

interface ListenerInstance {
  trigger: ActiveTrigger;
  config: ListenerConfig;
  driver: SourceDriver;
  evaluator: PredicateEvaluator;
  firePolicy: FirePolicyController;
  paused: boolean;
  healthTimer: ReturnType<typeof setInterval> | null;
}

export class ListenerRuntime {
  readonly #instances = new Map<string, ListenerInstance>();

  constructor(private readonly deps: ListenerRuntimeDeps) {}

  /** Whether a trigger's config is a v2 ListenerConfig (vs legacy adapter shape). */
  static handles(config: unknown): config is ListenerConfig {
    return isListenerConfigV2(config);
  }

  health(triggerId: string) {
    return this.deps.health.get(triggerId);
  }

  events(triggerId: string, limit?: number) {
    return this.deps.health.events(triggerId, limit);
  }

  clearEvents(triggerId: string): void {
    this.deps.health.clearEvents(triggerId);
  }

  async activate(trigger: ActiveTrigger): Promise<void> {
    await this.deactivate(trigger.triggerId);
    const config = trigger.config as unknown;
    if (!isListenerConfigV2(config)) {
      throw new AgentisError('LISTENER_INVALID_CONFIG', 'listener config must declare a `source`');
    }
    const instance = this.#build(trigger, config);
    this.#instances.set(trigger.triggerId, instance);
    this.deps.health.register(trigger.triggerId, config.source.kind);

    try {
      await this.#startDriver(instance);
      if (instance.driver.isConnected()) {
        this.#emit(trigger, REALTIME_EVENTS.LISTENER_CONNECTED, { sourceKind: config.source.kind });
      }
    } catch (err) {
      this.deps.health.setStatus(trigger.triggerId, 'error');
      this.deps.health.recordError(trigger.triggerId, (err as Error).message);
      this.deps.logger.error('listener.activate_failed', { triggerId: trigger.triggerId, err: (err as Error).message });
      throw err;
    }
  }

  async deactivate(triggerId: string): Promise<void> {
    const instance = this.#instances.get(triggerId);
    if (!instance) return;
    if (instance.healthTimer) clearInterval(instance.healthTimer);
    instance.firePolicy.close();
    try {
      await instance.driver.close();
    } catch (err) {
      this.deps.logger.warn('listener.deactivate_close_failed', { triggerId, err: (err as Error).message });
    }
    this.#instances.delete(triggerId);
    this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_DISCONNECTED, { reason: 'deactivated' });
    this.deps.health.setStatus(triggerId, 'paused');
  }

  async pause(triggerId: string): Promise<void> {
    const instance = this.#instances.get(triggerId);
    if (!instance || instance.paused) return;
    instance.paused = true;
    if (instance.healthTimer) clearInterval(instance.healthTimer);
    instance.firePolicy.close();
    await instance.driver.close().catch(() => {});
    this.deps.health.setStatus(triggerId, 'paused');
    this.deps.health.markConnected(triggerId, false);
  }

  async resume(triggerId: string): Promise<void> {
    const instance = this.#instances.get(triggerId);
    if (!instance) throw new AgentisError('LISTENER_NOT_FOUND', `listener ${triggerId} is not active`);
    if (!instance.paused) return;
    // rebuild the driver + fire policy (closed instances cannot restart)
    const rebuilt = this.#build(instance.trigger, instance.config);
    this.#instances.set(triggerId, rebuilt);
    await this.#startDriver(rebuilt);
  }

  /** Manually fire the workflow, bypassing predicate + fire policy (§6.1 fire-now). */
  async fireNow(triggerId: string, payload?: Record<string, unknown>): Promise<{ runId: string }> {
    const instance = this.#instances.get(triggerId);
    if (!instance) throw new AgentisError('LISTENER_NOT_FOUND', `listener ${triggerId} is not active`);
    const eventId = this.deps.health.recordEvent(triggerId, payload ?? { manual: true });
    const result = await this.deps.fire({
      trigger: instance.trigger,
      payload: this.#buildInputs(instance, [payload ?? { manual: true, firedAt: new Date().toISOString() }]),
    });
    this.deps.health.recordFire(triggerId, eventId, result.runId);
    this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_FIRED, { eventId, runId: result.runId, manual: true });
    return result;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.#instances.keys()]) {
      await this.deactivate(id).catch(() => {});
    }
  }


  #build(trigger: ActiveTrigger, config: ListenerConfig): ListenerInstance {
    const cursorConfig = ('cursor' in config.source ? config.source.cursor : undefined) ?? undefined;
    const cursor = cursorConfig
      ? new ListenerCursor(this.deps.workflowStore, {
          workspaceId: trigger.workspaceId,
          workflowId: trigger.workflowId,
          triggerId: trigger.triggerId,
          config: cursorConfig,
        })
      : undefined;

    const evaluator = new PredicateEvaluator({
      workspaceId: trigger.workspaceId,
      extensionRuntime: this.deps.extensionRuntime,
      agentJudge: this.deps.agentJudge,
      logger: this.deps.logger,
    });

    const firePolicy = new FirePolicyController(config.firePolicy, {
      onFire: (events, eventId) => this.#doFire(trigger.triggerId, events, eventId),
      onSuppress: (eventId, mode) => this.#onSuppress(trigger.triggerId, eventId, mode),
    });

    const driver = createSourceDriver(config.source, {
      workspaceId: trigger.workspaceId,
      workflowId: trigger.workflowId,
      triggerId: trigger.triggerId,
      logger: this.deps.logger,
      bus: this.deps.bus,
      db: this.deps.db,
      extensionRuntime: this.deps.extensionRuntime,
      cursor,
      allowPrivateNetwork: this.deps.allowPrivateNetwork,
      onConnectionChange: (connected) => this.#onConnectionChange(trigger, connected),
      onError: (error) => this.#onSourceError(trigger, error),
    });

    return { trigger, config, driver, evaluator, firePolicy, paused: false, healthTimer: null };
  }

  async #startDriver(instance: ListenerInstance): Promise<void> {
    instance.paused = false;
    this.deps.health.setStatus(instance.trigger.triggerId, 'connecting');
    await instance.driver.start((payload) => this.#onEvent(instance, payload));
    // poll connection state into health (drivers reconnect internally)
    instance.healthTimer = setInterval(() => {
      this.deps.health.markConnected(instance.trigger.triggerId, instance.driver.isConnected());
    }, 5_000);
    instance.healthTimer.unref?.();
    this.deps.health.markConnected(instance.trigger.triggerId, instance.driver.isConnected());
  }

  #onConnectionChange(trigger: ActiveTrigger, connected: boolean): void {
    const wasConnected = this.deps.health.get(trigger.triggerId)?.connected ?? false;
    this.deps.health.markConnected(trigger.triggerId, connected);
    if (connected && !wasConnected) {
      this.deps.logger.info('listener.connected', {
        triggerId: trigger.triggerId,
        sourceKind: this.deps.health.get(trigger.triggerId)?.sourceKind,
      });
      this.#emit(trigger, REALTIME_EVENTS.LISTENER_CONNECTED, {
        sourceKind: this.deps.health.get(trigger.triggerId)?.sourceKind,
      });
    } else if (!connected && wasConnected) {
      this.deps.logger.info('listener.disconnected', {
        triggerId: trigger.triggerId,
        reason: 'source_disconnected',
      });
      this.#emit(trigger, REALTIME_EVENTS.LISTENER_DISCONNECTED, { reason: 'source_disconnected' });
    }
  }

  #onSourceError(trigger: ActiveTrigger, error: Error): void {
    this.deps.health.setStatus(trigger.triggerId, 'error');
    this.deps.health.recordError(trigger.triggerId, error.message);
    this.#emit(trigger, REALTIME_EVENTS.LISTENER_ERROR, { message: error.message });
  }

  #onEvent(instance: ListenerInstance, payload: Record<string, unknown>): void {
    const triggerId = instance.trigger.triggerId;
    const eventId = this.deps.health.recordEvent(triggerId, payload);
    this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_EVENT_RECEIVED, { eventId });
    void instance.evaluator
      .evaluate(instance.config.predicate, payload)
      .then((result: PredicateResult) => {
        this.deps.health.recordPredicate(triggerId, eventId, result);
        if (!result.matched) {
          this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_PREDICATE_FAIL, { eventId, reason: result.reason });
          return;
        }
        this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_PREDICATE_PASS, { eventId });
        // Stash eventId on the payload so the fire path can credit health.
        instance.firePolicy.submit({ ...payload, __eventId: eventId }, eventId);
      })
      .catch((err: unknown) => {
        this.deps.health.recordError(triggerId, (err as Error).message);
        this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_ERROR, { message: (err as Error).message });
      });
  }

  #doFire(triggerId: string, events: Record<string, unknown>[], eventId: string): void {
    const instance = this.#instances.get(triggerId);
    if (!instance) return;
    const inputs = this.#buildInputs(instance, events);
    void this.deps
      .fire({ trigger: instance.trigger, payload: inputs })
      .then((result) => {
        this.deps.health.recordFire(triggerId, eventId, result.runId);
        this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_FIRED, { eventId, runId: result.runId });
      })
      .catch((err: unknown) => {
        const message = (err as Error).message;
        this.deps.health.recordError(triggerId, message);
        this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_ERROR, { message });
        this.#applyErrorPolicy(instance, message);
      });
  }

  #onSuppress(triggerId: string, eventId: string, mode: FirePolicyMode): void {
    const instance = this.#instances.get(triggerId);
    this.deps.health.recordSuppressed(triggerId, eventId, mode);
    if (instance) this.#emit(instance.trigger, REALTIME_EVENTS.LISTENER_FIRE_SUPPRESSED, { eventId, policy: mode });
  }

  #buildInputs(instance: ListenerInstance, events: Record<string, unknown>[]): Record<string, unknown> {
    const transform = instance.config.payloadTransform;
    const shape = (event: Record<string, unknown>): Record<string, unknown> => {
      const clean = { ...event };
      delete (clean as { __eventId?: unknown }).__eventId;
      if (!transform) return clean;
      const transformed = evalJmesLite(clean, transform);
      return transformed && typeof transformed === 'object' && !Array.isArray(transformed)
        ? (transformed as Record<string, unknown>)
        : { value: transformed };
    };
    const meta = { triggerId: instance.trigger.triggerId, sourceKind: instance.config.source.kind, firedAt: new Date().toISOString() };
    if (events.length === 1) {
      const event = shape(events[0] ?? {});
      return {
        ...event,
        event,
        item: event,
        events: [event],
        count: 1,
        _listener: meta,
      };
    }
    return { events: events.map(shape), count: events.length, _listener: meta };
  }

  #applyErrorPolicy(instance: ListenerInstance, _message: string): void {
    const policy = instance.config.errorPolicy;
    if (!policy) return;
    const health = this.deps.health.get(instance.trigger.triggerId);
    if (!health) return;
    if (policy.onSourceError === 'deactivate') {
      const max = policy.maxConsecutiveErrors ?? 5;
      if (health.consecutiveErrors >= max) {
        this.deps.logger.warn('listener.error_policy.deactivate', { triggerId: instance.trigger.triggerId, consecutiveErrors: health.consecutiveErrors });
        void this.pause(instance.trigger.triggerId);
      }
    }
  }

  #emit(trigger: ActiveTrigger, event: (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS], payload: Record<string, unknown>): void {
    const body = { triggerId: trigger.triggerId, workflowId: trigger.workflowId, ...payload };
    this.deps.bus.publish(REALTIME_ROOMS.workflow(trigger.workflowId), event, body);
    this.deps.bus.publish(REALTIME_ROOMS.workspace(trigger.workspaceId), event, body);
  }
}
