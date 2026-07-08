/**
 * Telemetry abstraction (Batch 8 / D38).
 *
 * The engine and adapter manager need to emit spans for hot-path operations
 * (`engine.tick`, `adapter.dispatch`) so an operator can attach Tempo/Jaeger
 * when something looks slow. We deliberately keep a thin interface so
 * tests + the default install carry zero OpenTelemetry dependency.
 *
 * Usage:
 *   - Default: `noopTelemetry`. Calls run inline, return `fn()` directly.
 *   - Opt-in: set `AGENTIS_OTEL_ENDPOINT` to an OTLP/HTTP URL. The bootstrap
 *     calls `loadTelemetry({endpoint, ...})` which dynamically imports
 *     `@opentelemetry/sdk-node` + the OTLP HTTP exporter. If those packages
 *     are not installed (the default), we log a single warning and fall
 *     back to no-op tracing — the request stays green.
 *
 * This mirrors the established pattern for `isolated-vm` and `dockerode`:
 * peer-style opt-in via dynamic import, never a hard require.
 */

export type SpanAttrValue = string | number | boolean;
export type SpanAttrs = Record<string, SpanAttrValue | undefined>;
import type { LlmTraceSpan } from '@agentis/core';

export interface Telemetry {
  /**
   * Run `fn` inside a span called `name`. The span is ended when `fn`
   * resolves or rejects; exceptions are recorded on the span before being
   * re-thrown.
   */
  span<T>(name: string, fn: () => Promise<T> | T, attrs?: SpanAttrs): Promise<T>;
  emitLlmTrace?(span: LlmTraceSpan): void;
  /** Flush + shut down any background exporters. Safe to call on no-op. */
  shutdown(): Promise<void>;
}

export const noopTelemetry: Telemetry = {
  async span(_name, fn) {
    return await fn();
  },
  async shutdown() {
    /* nothing to flush */
  },
};

export interface OtelLoadOptions {
  endpoint: string;
  serviceName?: string;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Best-effort loader. Returns `noopTelemetry` if `opts` is null OR if the
 * OpenTelemetry packages are not installed in the current node_modules.
 */
export async function loadTelemetry(opts: OtelLoadOptions | null): Promise<Telemetry> {
  if (!opts) return noopTelemetry;

  // Dynamic-import via a string-typed identifier keeps the TypeScript
  // compiler from chasing the OTel typings into the app's dep graph.
  // (Same trick used for isolated-vm / dockerode.)
  const dyn = (id: string) => import(/* @vite-ignore */ id);
  let api: any;
  let sdkNode: any;
  let exporter: any;
  try {
    api = await dyn('@opentelemetry/api');
    sdkNode = await dyn('@opentelemetry/sdk-node');
    exporter = await dyn('@opentelemetry/exporter-trace-otlp-http');
  } catch (err) {
    opts.logger?.warn('telemetry.otel_unavailable', {
      err: (err as Error).message,
      hint: 'Install @opentelemetry/api, @opentelemetry/sdk-node and @opentelemetry/exporter-trace-otlp-http to enable tracing. Tracing is disabled until the packages are present.',
    });
    return noopTelemetry;
  }

  const serviceName = opts.serviceName ?? 'agentis-api';
  const traceExporter = new exporter.OTLPTraceExporter({ url: opts.endpoint });
  const NodeSDK = sdkNode.NodeSDK ?? sdkNode.default?.NodeSDK;
  if (!NodeSDK) {
    opts.logger?.warn('telemetry.otel_unavailable', {
      err: '@opentelemetry/sdk-node did not export NodeSDK',
    });
    return noopTelemetry;
  }
  const sdk = new NodeSDK({ serviceName, traceExporter });
  try {
    sdk.start();
  } catch (err) {
    opts.logger?.warn('telemetry.otel_start_failed', { err: (err as Error).message });
    return noopTelemetry;
  }
  opts.logger?.info('telemetry.otel_ready', { endpoint: opts.endpoint, serviceName });

  const tracer = api.trace.getTracer(serviceName);

  return {
    async span(name, fn, attrs) {
      return await tracer.startActiveSpan(name, async (span: any) => {
        try {
          if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
              if (v !== undefined) span.setAttribute(k, v);
            }
          }
          return await fn();
        } catch (err) {
          span.recordException(err as Error);
          // Status code 2 = ERROR per OTel spec.
          span.setStatus({ code: 2, message: (err as Error).message });
          throw err;
        } finally {
          span.end();
        }
      });
    },
    async shutdown() {
      try {
        await sdk.shutdown();
      } catch {
        /* ignore — nothing else can be done at shutdown */
      }
    },
  };
}
