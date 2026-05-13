import type { LlmTraceSpan } from '@agentis/core';
import {
  closeTelemetrySqlite,
  insertTelemetrySpan,
  listTelemetrySpans,
  openTelemetrySqlite,
  type ListTelemetrySpanOptions,
} from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export interface TelemetrySinkOptions {
  dataDir: string;
  logger: Logger;
  flushIntervalMs?: number;
  maxBufferSize?: number;
}

export interface TelemetrySink {
  start(): void;
  emit(span: LlmTraceSpan): void;
  flush(): Promise<void>;
  listSpans(options: ListTelemetrySpanOptions): Promise<LlmTraceSpan[]>;
  shutdown(): Promise<void>;
}

export function createTelemetrySink(options: TelemetrySinkOptions): TelemetrySink {
  return new SqliteTelemetrySink(options);
}

class SqliteTelemetrySink implements TelemetrySink {
  readonly #dataDir: string;
  readonly #logger: Logger;
  readonly #flushIntervalMs: number;
  readonly #maxBufferSize: number;
  #buffer: LlmTraceSpan[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #flushScheduled = false;
  #flushing = false;
  #dropped = 0;

  constructor(options: TelemetrySinkOptions) {
    this.#dataDir = options.dataDir;
    this.#logger = options.logger;
    this.#flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.#maxBufferSize = options.maxBufferSize ?? 1_000;
  }

  start(): void {
    if (this.#timer || this.#flushIntervalMs <= 0) return;
    this.#timer = setInterval(() => {
      void this.flush();
    }, this.#flushIntervalMs);
    this.#timer.unref?.();
  }

  emit(span: LlmTraceSpan): void {
    if (this.#buffer.length >= this.#maxBufferSize) {
      this.#buffer.shift();
      this.#dropped += 1;
    }
    this.#buffer.push(span);
    if (this.#buffer.length >= Math.max(1, Math.floor(this.#maxBufferSize * 0.8))) {
      this.#scheduleFlush();
    }
  }

  async flush(): Promise<void> {
    if (this.#flushing || this.#buffer.length === 0) return;
    this.#flushing = true;
    this.#flushScheduled = false;
    const spans = this.#buffer.splice(0, this.#buffer.length);
    try {
      const db = openTelemetrySqlite(this.#dataDir);
      const insertMany = db.transaction((batch: LlmTraceSpan[]) => {
        for (const span of batch) insertTelemetrySpan(db, span);
      });
      insertMany(spans);
      if (this.#dropped > 0) {
        this.#logger.warn('telemetry.sink_dropped_spans', { dropped: this.#dropped });
        this.#dropped = 0;
      }
    } catch (err) {
      this.#logger.warn('telemetry.sink_flush_failed', { err: (err as Error).message });
      const room = Math.max(0, this.#maxBufferSize - this.#buffer.length);
      if (room > 0) this.#buffer.unshift(...spans.slice(-room));
    } finally {
      this.#flushing = false;
    }
  }

  async listSpans(options: ListTelemetrySpanOptions): Promise<LlmTraceSpan[]> {
    await this.flush();
    const db = openTelemetrySqlite(this.#dataDir);
    return listTelemetrySpans(db, options);
  }

  async shutdown(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.flush();
    closeTelemetrySqlite(this.#dataDir);
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    setImmediate(() => {
      void this.flush();
    });
  }
}
