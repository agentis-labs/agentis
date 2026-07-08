/**
 * In-memory token-bucket rate limiter (D32, OWASP A07).
 *
 * Designed for the single-process embedded deployment. NOT cluster-safe —
 * a multi-process or HA deployment must front this with a Redis-backed
 * limiter or Cloudflare-style edge throttle.
 *
 * Defaults are tuned for `/v1/auth/login`: 5 attempts per minute per
 * (IP, username) pair, with a hard ceiling of 20 attempts per minute per
 * IP regardless of username (so attackers can't enumerate users to dodge
 * the per-pair limit).
 *
 * Throws `OPERATION_RATE_LIMITED` (HTTP 429) when the bucket is empty.
 */

import { AgentisError } from '@agentis/core';
import type { MiddlewareHandler } from 'hono';

interface Bucket {
  tokens: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Tokens per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Build the throttle key for the current request. Return `null` to skip
   * limiting (e.g. when no client IP is available in test mode).
   */
  keyFn: (c: Parameters<MiddlewareHandler>[0]) => Promise<string | null> | string | null;
}

export function createRateLimiter(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  return async (c, next) => {
    const key = await opts.keyFn(c);
    if (!key) return next();
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { tokens: opts.limit - 1, resetAt: now + opts.windowMs });
      return next();
    }
    if (existing.tokens <= 0) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      throw new AgentisError(
        'OPERATION_RATE_LIMITED',
        'Too many attempts — try again shortly.',
        { details: { retryAfterSeconds: retryAfter } },
      );
    }
    existing.tokens -= 1;
    return next();
  };
}

/**
 * Best-effort client-IP extraction. Honors `x-forwarded-for` (first hop)
 * because production puts Hono behind nginx/Cloudflare. Falls back to the
 * raw socket address exposed by `@hono/node-server` via `c.env.incoming`,
 * then to `'unknown'` so the limiter still buckets test traffic together.
 */
export function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  if (String(process.env.AGENTIS_TRUST_PROXY ?? '').toLowerCase() === 'true') {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const real = c.req.header('x-real-ip');
    if (real) return real.trim();
  }
  // @hono/node-server stows the raw IncomingMessage on `c.env.incoming`.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  if (incoming?.socket?.remoteAddress) return incoming.socket.remoteAddress;
  return 'unknown';
}
