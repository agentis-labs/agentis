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

export class ScratchpadService {
  readonly #pads = new Map<string, Map<string, unknown>>();
  readonly #sizeBytes = new Map<string, number>();

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

  dispose(runId: string): void {
    this.#pads.delete(runId);
  }
}
