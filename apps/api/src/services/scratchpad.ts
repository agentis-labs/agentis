/**
 * Run-scoped scratchpad.
 *
 * V1 embedded mode: in-memory Map per run. Cleared when the run finishes
 * (engine emits `dispose(runId)`).
 *
 * Standard mode (later): swap to Redis hash `agentis:scratchpad:{runId}`.
 * The interface stays the same, so the engine never branches on mode.
 *
 * Spec rule: scratchpad keys appear on the dashboard's "State Surfaces"
 * panel; we publish a `scratchpad.written` event on every write so the
 * surface is reactive.
 */

import { CONSTANTS, REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';

/** A single message on a run-scoped agent channel (the swarm "bus"). */
export interface ChannelMessage {
  from: string;
  message: string;
  at: string;
}

export class ScratchpadService {
  readonly #pads = new Map<string, Map<string, unknown>>();
  readonly #sizeBytes = new Map<string, number>();
  /** Run-scoped pub/sub channels — backs session `broadcast`/`read_channel` tools. */
  readonly #channels = new Map<string, Map<string, ChannelMessage[]>>();

  constructor(
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  read(runId: string, key: string): unknown {
    return this.#pads.get(runId)?.get(key);
  }

  write(runId: string, key: string, value: unknown): void {
    let pad = this.#pads.get(runId);
    if (!pad) {
      pad = new Map();
      this.#pads.set(runId, pad);
    }
    const serialized = JSON.stringify(value ?? null);
    const padSize = (this.#sizeBytes.get(runId) ?? 0) + serialized.length;
    this.#sizeBytes.set(runId, padSize);
    if (padSize > CONSTANTS.SCRATCHPAD_SIZE_WARNING_BYTES) {
      this.logger.warn('scratchpad.size.warning', {
        runId,
        bytes: padSize,
        threshold: CONSTANTS.SCRATCHPAD_SIZE_WARNING_BYTES,
      });
    }
    pad.set(key, value);
    this.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.SCRATCHPAD_WRITTEN, {
      runId,
      key,
      value,
    });
  }

  delete(runId: string, key: string): void {
    this.#pads.get(runId)?.delete(key);
    this.bus.publish(REALTIME_ROOMS.run(runId), REALTIME_EVENTS.SCRATCHPAD_WRITTEN, {
      runId,
      key,
      value: null,
      deleted: true,
    });
  }

  snapshotOf(runId: string): Record<string, unknown> {
    const pad = this.#pads.get(runId);
    if (!pad) return {};
    return Object.fromEntries(pad.entries());
  }

  // ──────────────────────────────────────────────────────────
  // Channels — run-scoped agent broadcast bus (SMARTER-AGENTS-10X §VIII).
  // Sessions in the same run gossip findings here without polluting the
  // scratchpad KV. Append-only, capped, and cleared with the run.
  // ──────────────────────────────────────────────────────────

  broadcast(runId: string, channel: string, from: string, message: string): void {
    let run = this.#channels.get(runId);
    if (!run) {
      run = new Map();
      this.#channels.set(runId, run);
    }
    let log = run.get(channel);
    if (!log) {
      log = [];
      run.set(channel, log);
    }
    log.push({ from, message, at: new Date().toISOString() });
    if (log.length > CONSTANTS.CHANNEL_MAX_MESSAGES) log.splice(0, log.length - CONSTANTS.CHANNEL_MAX_MESSAGES);
  }

  /** Read the last `limit` messages on a channel, oldest first. */
  readChannel(runId: string, channel: string, limit = 50): ChannelMessage[] {
    const log = this.#channels.get(runId)?.get(channel) ?? [];
    return limit >= log.length ? [...log] : log.slice(log.length - limit);
  }

  dispose(runId: string): void {
    this.#pads.delete(runId);
    this.#channels.delete(runId);
  }
}
