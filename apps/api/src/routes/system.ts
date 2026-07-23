/**
 * /v1/system — host + release metadata.
 *
 *   GET  /version   → current CLI version, latest published npm version, and
 *                     whether an update is available.
 *
 * This backs the "update available" prompt in the profile menu. The npm
 * registry lookup is best-effort and cached in-memory (1h TTL) so a browser
 * that mounts the menu repeatedly never hammers registry.npmjs.org, and a
 * registry outage degrades to "no update known" rather than an error.
 */

import { Hono } from 'hono';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  disableAutostart,
  enableAutostart,
  getAutostartStatus,
  type AutostartTarget,
} from '../services/system/autostartService.js';

export interface SystemRoutesDeps {
  db: AgentisSqliteDb;
  auth: AuthService;
  /** Installed npm package version (from the CLI), or undefined when run from source. */
  currentVersion?: string;
  /** "Launch Agentis at login" target for this host, built once at boot. */
  autostartTarget: AutostartTarget;
}

/** The published npm package + GitHub home for the platform. */
export const NPM_PACKAGE_NAME = '@agentis-labs/cli';
export const GITHUB_URL = 'https://github.com/agentis-labs/agentis';
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

let cache: { version: string | null; fetchedAt: number } | null = null;

/** Fetch the latest published version, cached for CACHE_TTL_MS. Never throws. */
async function fetchLatestVersion(): Promise<string | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.version;
  let version: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
    try {
      const res = await fetch(REGISTRY_URL, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (res.ok) {
        const body = (await res.json()) as { version?: unknown };
        if (typeof body.version === 'string') version = body.version;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Offline / registry unreachable — degrade to "no update known".
  }
  cache = { version, fetchedAt: Date.now() };
  return version;
}

/**
 * Compare two dotted numeric versions. Returns true when `latest` is strictly
 * newer than `current`. Pre-release suffixes (`-beta.1`) are ignored on the
 * numeric core; a version without a suffix is treated as newer than the same
 * core with one (0.3.0 > 0.3.0-rc.1).
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, hasPre: pre !== undefined };
  };
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < len; i++) {
    const an = a.nums[i] ?? 0;
    const bn = b.nums[i] ?? 0;
    if (an !== bn) return an > bn;
  }
  // Same numeric core: a release (no pre) is newer than a pre-release.
  if (a.hasPre !== b.hasPre) return !a.hasPre && b.hasPre;
  return false;
}

export function buildSystemRoutes(deps: SystemRoutesDeps) {
  const app = new Hono();
  app.use('*', requireAuth(deps));

  app.get('/version', async (c) => {
    const current = deps.currentVersion ?? null;
    const latest = await fetchLatestVersion();
    const updateAvailable = Boolean(current && latest && isNewerVersion(latest, current));
    return c.json({
      name: NPM_PACKAGE_NAME,
      current,
      latest,
      updateAvailable,
      installCommand: `npm install -g ${NPM_PACKAGE_NAME}@latest`,
      github: GITHUB_URL,
      checkedAt: new Date(cache?.fetchedAt ?? Date.now()).toISOString(),
    });
  });

  app.get('/autostart', (c) => {
    const target = deps.autostartTarget;
    return c.json({
      supported: target.supported,
      enabled: getAutostartStatus(target),
      platform: target.platform,
      reason: target.reason,
    });
  });

  app.post('/autostart', async (c) => {
    const target = deps.autostartTarget;
    const body = await c.req.json().catch(() => ({}));
    const wantEnabled = (body as { enabled?: unknown }).enabled;
    if (typeof wantEnabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    if (wantEnabled && !target.supported) {
      return c.json({ error: target.reason ?? 'Autostart is not supported on this host.' }, 400);
    }
    if (wantEnabled) await enableAutostart(target);
    else await disableAutostart(target);
    return c.json({
      supported: target.supported,
      enabled: getAutostartStatus(target),
      platform: target.platform,
      reason: target.reason,
    });
  });

  return app;
}
