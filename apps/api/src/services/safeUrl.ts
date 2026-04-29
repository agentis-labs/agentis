/**
 * SSRF guard for outbound HTTP from the builtin `http_fetch` skill and
 * outbound bridge calls.
 *
 * Default deny:
 *  - Non-http(s) protocols (file://, javascript:, data:, ftp://, etc.)
 *  - RFC 1918 / loopback / link-local / unique-local / multicast destinations
 *  - DNS names that resolve only to private addresses
 *
 * Operators who legitimately need to reach internal services explicitly
 * opt in with `AGENTIS_SKILL_HTTP_ALLOW_PRIVATE=true`. That env transfers
 * responsibility to the operator and is logged on use.
 *
 * The check happens AFTER DNS resolution so an attacker cannot bypass it by
 * pointing a public hostname at 127.0.0.1.
 */

import { promises as dns } from 'node:dns';
import net from 'node:net';
import { AgentisError } from '@agentis/core';

const PRIVATE_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  // 10.0.0.0/8
  [0x0a000000, 0x0affffff],
  // 172.16.0.0/12
  [0xac100000, 0xac1fffff],
  // 192.168.0.0/16
  [0xc0a80000, 0xc0a8ffff],
  // 127.0.0.0/8 — loopback
  [0x7f000000, 0x7fffffff],
  // 169.254.0.0/16 — link-local (also blocks AWS IMDS 169.254.169.254)
  [0xa9fe0000, 0xa9feffff],
  // 0.0.0.0/8
  [0x00000000, 0x00ffffff],
  // 100.64.0.0/10 — CGNAT
  [0x64400000, 0x647fffff],
  // 224.0.0.0/4 — multicast
  [0xe0000000, 0xefffffff],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256 + v) >>> 0;
  }
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n == null) return false;
  return PRIVATE_V4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped IPv6
  const m = lower.match(/^::ffff:([\d.]+)$/);
  if (m && isPrivateIPv4(m[1]!)) return true;
  return false;
}

export interface SafeUrlOptions {
  /** Allow loopback/private addresses. Defaults from env at call site. */
  allowPrivate?: boolean;
  /** Explicit hostname allowlist. When provided, only these are reachable. */
  allowedDomains?: string[];
}

/**
 * Validate a URL string and return the parsed `URL` if it is safe to fetch.
 * Throws `AgentisError(SKILL_SSRF_BLOCKED)` otherwise.
 */
export async function assertSafeUrl(raw: string, opts: SafeUrlOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AgentisError('VALIDATION_FAILED', `Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AgentisError(
      'SKILL_SSRF_BLOCKED',
      `Refusing protocol ${parsed.protocol} — only http(s) is allowed`,
    );
  }
  if (opts.allowedDomains && opts.allowedDomains.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const ok = opts.allowedDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
    if (!ok) {
      throw new AgentisError(
        'SKILL_NETWORK_VIOLATION',
        `Hostname ${host} is not in the skill's allowedDomains`,
      );
    }
  }
  if (opts.allowPrivate) return parsed;

  // Resolve the host and check every address. If the input is already a
  // literal IP, `family` is non-zero on the URL parse already.
  const host = parsed.hostname;
  const literal = net.isIP(host);
  let addresses: string[];
  if (literal === 4 || literal === 6) {
    addresses = [host];
  } else {
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      addresses = records.map((r) => r.address);
    } catch (err) {
      throw new AgentisError(
        'SKILL_SSRF_BLOCKED',
        `DNS resolution failed for ${host}: ${(err as Error).message}`,
      );
    }
  }
  for (const addr of addresses) {
    const fam = net.isIP(addr);
    if (fam === 4 && isPrivateIPv4(addr)) {
      throw new AgentisError(
        'SKILL_SSRF_BLOCKED',
        `Refusing to reach private/loopback IPv4 ${addr} (host=${host}). Set AGENTIS_SKILL_HTTP_ALLOW_PRIVATE=true to opt in.`,
      );
    }
    if (fam === 6 && isPrivateIPv6(addr)) {
      throw new AgentisError(
        'SKILL_SSRF_BLOCKED',
        `Refusing to reach private/loopback IPv6 ${addr} (host=${host}). Set AGENTIS_SKILL_HTTP_ALLOW_PRIVATE=true to opt in.`,
      );
    }
  }
  return parsed;
}
