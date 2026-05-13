/**
 * HttpAdapter — generic HTTP-based agent adapter.
 *
 * Dispatch: POST `${dispatchUrl}` with JSON body `{ task }`.
 * Callback: agent POSTs back to `/v1/adapters/http/callback/:agentId` with
 * HMAC-SHA256 signature in `x-agentis-signature: t=<unix>,v1=<hex>` header.
 * The callback is verified by HttpAdapterCallbackVerifier (in routes layer)
 * which then calls back into adapter.handleCallback().
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AgentAdapter,
  AdapterHealthStatus,
  NormalizedAgentEvent,
  NormalizedTask,
} from '@agentis/core';
import { CONSTANTS } from '@agentis/core';
import type { Logger } from '../logger.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { assertSafeUrl } from '../services/safeUrl.js';

export interface HttpAdapterOptions {
  agentId: string;
  dispatchUrl: string;
  cancelUrl?: string;
  healthUrl?: string;
  method?: 'POST' | 'GET' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  payloadTemplate?: Record<string, unknown>;
  dispatchTimeoutMs?: number;
  /** Shared secret used for both outbound auth header and inbound HMAC. */
  sharedSecret?: string;
  authToken?: string;
  logger: Logger;
}

export class HttpAdapter implements AgentAdapter {
  readonly adapterType = 'http' as const;
  readonly #handlers = new Set<(e: NormalizedAgentEvent) => void>();
  readonly #breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 });

  constructor(private readonly opts: HttpAdapterOptions) {}

  async connect(): Promise<void> {
    // Stateless adapter; nothing to do at connect.
  }

  async disconnect(): Promise<void> {
    // No persistent connection.
  }

  async healthCheck(): Promise<AdapterHealthStatus> {
    if (this.#breaker.state() === 'open') {
      return { isHealthy: false, checkedAt: new Date().toISOString(), error: 'circuit_breaker_open' };
    }
    if (!this.opts.healthUrl) return { isHealthy: true, checkedAt: new Date().toISOString() };
    try {
      const safe = await assertSafeUrl(this.opts.healthUrl, {
        allowPrivate: String(process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.opts.dispatchTimeoutMs ?? 30_000).unref?.();
      try {
        const res = await fetch(safe, { method: 'HEAD', headers: this.#headers(), signal: controller.signal });
        return { isHealthy: res.ok || res.status === 401, latencyMs: undefined, checkedAt: new Date().toISOString(), ...(res.ok || res.status === 401 ? {} : { error: `status=${res.status}` }) };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (err) {
      return { isHealthy: false, error: (err as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  onEvent(handler: (e: NormalizedAgentEvent) => void): void {
    this.#handlers.add(handler);
  }

  async dispatchTask(task: NormalizedTask): Promise<void> {
    const safe = await assertSafeUrl(this.opts.dispatchUrl, {
      allowPrivate: String(process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
    });
    await this.#breaker.exec(async () => {
      const method = this.opts.method ?? 'POST';
      const payload = { ...(this.opts.payloadTemplate ?? {}), task };
      const body = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000);
      const sig = this.opts.sharedSecret ? createHmac('sha256', this.opts.sharedSecret).update(`${ts}.${body}`).digest('hex') : null;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), this.opts.dispatchTimeoutMs ?? CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS).unref?.();
      try {
        const dispatchUrl = method === 'GET' ? appendQuery(safe, 'task', body) : safe.toString();
        const res = await fetch(dispatchUrl, {
          method,
          headers: this.#headers(sig ? { 'x-agentis-signature': `t=${ts},v1=${sig}` } : undefined),
          ...(method === 'GET' ? {} : { body }),
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`http_adapter_dispatch_failed status=${res.status}`);
        }
      } finally {
        if (t) clearTimeout(t);
      }
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    // Best-effort cancel.
    try {
      await this.#breaker.exec(async () => {
        const safe = await assertSafeUrl(this.opts.cancelUrl ?? this.opts.dispatchUrl, {
          allowPrivate: String(process.env.AGENTIS_SKILL_HTTP_ALLOW_PRIVATE ?? '').toLowerCase() === 'true',
        });
        const url = this.opts.cancelUrl ? safe.toString() : `${safe.toString().replace(/\/$/, '')}/cancel/${encodeURIComponent(taskId)}`;
        await fetch(url, { method: 'POST', headers: this.#headers() });
      });
    } catch {
      // ignore
    }
  }

  /**
   * Verify an inbound callback's HMAC signature, then emit the normalized event.
   * Call this from the route handler.
   */
  handleCallback(args: {
    rawBody: string;
    signatureHeader: string;
    payload: { eventType: NormalizedAgentEvent['eventType']; taskId: string; runId: string } & Record<string, unknown>;
  }): boolean {
    if (!this.opts.sharedSecret) {
      this.opts.logger.warn('http_adapter.callback_no_shared_secret', { agentId: this.opts.agentId });
      return false;
    }
    const ok = verifySignature(args.rawBody, args.signatureHeader, this.opts.sharedSecret);
    if (!ok) {
      this.opts.logger.warn('http_adapter.callback_bad_signature', { agentId: this.opts.agentId });
      return false;
    }
    const at = new Date().toISOString();
    const event = {
      ...args.payload,
      agentId: this.opts.agentId,
      at,
    } as unknown as NormalizedAgentEvent;
    for (const h of this.#handlers) {
      try {
        h(event);
      } catch (err) {
        this.opts.logger.error('http_adapter.handler_threw', { err: (err as Error).message });
      }
    }
    return true;
  }

  breakerState() {
    return this.#breaker.state();
  }

  #headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.opts.headers ?? {}),
      'content-type': 'application/json',
      ...(this.opts.authToken ? { authorization: `Bearer ${this.opts.authToken}` } : {}),
      ...(extra ?? {}),
      'user-agent': 'Agentis/1.0 (HttpAdapter)',
    };
  }
}

function appendQuery(url: URL, key: string, value: string): string {
  const next = new URL(url.toString());
  next.searchParams.set(key, value);
  return next.toString();
}

function verifySignature(rawBody: string, header: string, secret: string): boolean {
  // header format: "t=<unix>,v1=<hex>"
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim() ?? '', v?.trim() ?? ''];
    }),
  );
  const ts = Number(parts.t ?? 0);
  const sig = String(parts.v1 ?? '');
  if (!ts || !sig) return false;
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > CONSTANTS.WEBHOOK_TIMESTAMP_TOLERANCE_MS / 1000) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}
