/**
 * `safeFetch` — SSRF-safe HTTP client that PINS the connection to the IP address
 * validated by `resolveSafeTarget`, closing the DNS-rebinding hole that a plain
 * `fetch(assertSafeUrl(url))` leaves open.
 *
 * Why not global `fetch`: Node's global fetch re-resolves the hostname when it
 * opens the socket. An attacker domain can answer a public IP during the SSRF
 * check and 127.0.0.1 / 169.254.169.254 a millisecond later at connect time
 * (TOCTOU). It also auto-follows redirects WITHOUT re-checking the new target,
 * which is a second rebinding vector.
 *
 * This client, built on `node:http`/`node:https`:
 *   1. resolves + validates every candidate IP (via `resolveSafeTarget`),
 *   2. pins the socket to a validated IP with a custom `lookup` — the hostname is
 *      NEVER re-resolved, so rebinding cannot change the connect target,
 *   3. preserves the original hostname for the `Host` header and TLS SNI so
 *      HTTPS certificate validation still works,
 *   4. follows redirects MANUALLY, re-validating every hop through the same guard,
 *   5. enforces a byte cap and a wall-clock timeout.
 *
 * It returns a standard `Response`, so existing call sites that consumed a fetch
 * `Response` keep working unchanged.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AgentisError } from '@agentis/core';
import { resolveSafeTarget, isPrivateAddress, type SafeUrlOptions } from './safeUrl.js';

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Hard wall-clock deadline for the whole request (default 30s). */
  timeoutMs?: number;
  /** Max response body size in bytes (default 25 MiB). */
  maxBytes?: number;
  /** Max redirects to follow, each re-validated (default 5). */
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

/** A lookup that only ever hands back a pre-validated IP for the pinned host. */
function pinnedLookup(address: string) {
  const family = net.isIP(address);
  return (
    _hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ): void => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (all) {
      callback(null, [{ address, family: family || 4 }]);
    } else {
      callback(null, address, family || 4);
    }
  };
}

/**
 * Fetch `raw` through the SSRF guard with the connection pinned to a validated IP.
 * `ssrf` opts are forwarded to `resolveSafeTarget` (allowPrivate / allowedDomains).
 */
export async function safeFetch(
  raw: string,
  init: SafeFetchInit = {},
  ssrf: SafeUrlOptions = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + timeoutMs;

  let currentUrl = raw;
  let method = (init.method ?? 'GET').toUpperCase();
  let body: string | Uint8Array | undefined = init.body;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AgentisError('EXTENSION_TIMEOUT', `safeFetch timed out after ${timeoutMs}ms`);
    }

    // Re-validate EVERY hop (initial URL and each redirect Location).
    const target = await resolveSafeTarget(currentUrl, ssrf);
    const pinTo = target.addresses[0];

    const result = await requestOnce({
      url: target.url,
      // allowPrivate targets return no addresses — fall back to the URL host,
      // which the operator explicitly opted into via allowPrivate.
      pinTo: pinTo ?? null,
      method,
      headers: init.headers ?? {},
      body,
      timeoutMs: remaining,
      maxBytes,
    });

    if (result.kind === 'response') return result.response;

    // Redirect: re-validate the resolved Location on the next loop iteration.
    if (hop === maxRedirects) {
      throw new AgentisError('EXTENSION_SSRF_BLOCKED', `Too many redirects (>${maxRedirects}) from ${raw}`);
    }
    currentUrl = result.location;
    // Per RFC 7231, 303 (and commonly 301/302 for browsers) downgrade to GET and
    // drop the body. Preserve method only for 307/308.
    if (result.status === 303 || ((result.status === 301 || result.status === 302) && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new AgentisError('EXTENSION_SSRF_BLOCKED', `safeFetch exhausted redirect budget for ${raw}`);
}

type RequestOutcome =
  | { kind: 'response'; response: Response }
  | { kind: 'redirect'; status: number; location: string };

function requestOnce(args: {
  url: URL;
  pinTo: string | null;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
  timeoutMs: number;
  maxBytes: number;
}): Promise<RequestOutcome> {
  return new Promise<RequestOutcome>((resolve, reject) => {
    const isHttps = args.url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers: Record<string, string> = { ...args.headers };
    // Ensure the Host header reflects the original hostname even though we
    // connect to a pinned IP (so virtual hosts + TLS SNI stay correct).
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) {
      headers.Host = args.url.host;
    }

    const req = transport.request(
      {
        protocol: args.url.protocol,
        hostname: args.url.hostname,
        port: args.url.port || (isHttps ? 443 : 80),
        path: `${args.url.pathname}${args.url.search}`,
        method: args.method,
        headers,
        // Pin the socket to the validated IP; hostname is never re-resolved.
        ...(args.pinTo ? { lookup: pinnedLookup(args.pinTo) } : {}),
        // Keep SNI + cert hostname verification bound to the real hostname.
        servername: isHttps ? args.url.hostname : undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain
          let abs: string;
          try {
            abs = new URL(location, args.url).toString();
          } catch {
            reject(new AgentisError('EXTENSION_SSRF_BLOCKED', `Invalid redirect Location: ${location}`));
            return;
          }
          resolve({ kind: 'redirect', status, location: abs });
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > args.maxBytes) {
            req.destroy();
            reject(new AgentisError('EXTENSION_INTERNAL', `Response exceeded ${args.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const bodyBuf = Buffer.concat(chunks);
          const headerEntries: Array<[string, string]> = [];
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) headerEntries.push([k, v.join(', ')]);
            else if (typeof v === 'string') headerEntries.push([k, v]);
          }
          const response = new Response(bodyBuf.length ? bodyBuf : null, {
            status: status || 200,
            statusText: res.statusMessage ?? '',
            headers: headerEntries,
          });
          // `Response.url` is read-only + empty for manually-built responses;
          // expose the final URL for callers that read it.
          try {
            Object.defineProperty(response, 'url', { value: args.url.toString() });
          } catch {
            /* best effort */
          }
          resolve({ kind: 'response', response });
        });
        res.on('error', (err) => reject(err));
      },
    );

    req.on('error', (err) => reject(err));
    req.setTimeout(args.timeoutMs, () => {
      req.destroy(new AgentisError('EXTENSION_TIMEOUT', `Request timed out after ${args.timeoutMs}ms`));
    });

    // Defense in depth: if the pinned socket somehow connects to a private peer
    // (e.g. a proxy in the middle), abort before any bytes are exchanged.
    req.on('socket', (socket) => {
      socket.on('connect', () => {
        const peer = socket.remoteAddress;
        if (peer && isPrivateAddress(peer) && args.pinTo && !isPrivateAddress(args.pinTo)) {
          req.destroy(
            new AgentisError('EXTENSION_SSRF_BLOCKED', `Connection reached private peer ${peer}`),
          );
        }
      });
    });

    if (args.body !== undefined) req.write(args.body);
    req.end();
  });
}
