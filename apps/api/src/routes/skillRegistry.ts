/**
 * /v1/skills/registry — anonymous third-party skill registry endpoints
 * (V1-SPEC §8).
 *
 * Read-only browser + install pipeline backed by an anonymous third-party
 * registry through `RegistryClient`. Local-side guarantees:
 *
 *   - SKILL_REGISTRY_UNAVAILABLE (503) when the client isn't configured
 *     or upstream is unreachable.
 *   - SHA-256 hash verification before any installed artifact touches
 *     local state.
 *   - Static security scanner (registryScanner.ts) gates install — a
 *     `block`-severity finding throws SKILL_REGISTRY_SCAN_BLOCKED.
 *   - Explicit operator acknowledgement of the permission summary
 *     (`permissionsAcknowledged: true`); recorded in
 *     `installed_registry_artifacts.permissionsAcknowledgedAt`.
 *   - Every install writes an `activity_events` row.
 *   - Ownership: every route is gated by requireWorkspace.
 *
 * Endpoint surface (mounted at /v1/skills/registry):
 *   GET    /status                — client config + breaker
 *   GET    /                      — browse / search
 *   GET    /:slug                 — single entry
 *   POST   /install/:slug         — verify + scan + install
 */

import { randomUUID, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError, type RegistryEntry } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { RegistryClient } from '../services/registryClient.js';
import type { ActivityFeedService } from '../services/activityFeed.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import {
  scanArtifactBytes,
  assertNoBlockingFindings,
  type ScanFinding,
} from '../services/registryScanner.js';

const installSchema = z.object({
  permissionsAcknowledged: z.literal(true, {
    errorMap: () => ({ message: 'permissionsAcknowledged must be true' }),
  }),
});

export function buildSkillRegistryRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  registry: RegistryClient;
  activity: ActivityFeedService;
}) {
  const app = new Hono();
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  // ── Status (always works, even when registry is offline) ──────────────
  app.get('/status', (c) => {
    return c.json({
      configured: deps.registry.isConfigured(),
      breaker: deps.registry.breakerState(),
    });
  });

  // ── Registry browse ───────────────────────────────────────────────────
  app.get('/', async (c) => {
    const page = await deps.registry.search({
      ...(c.req.query('q') ? { q: c.req.query('q')! } : {}),
      ...(c.req.query('cursor') ? { cursor: c.req.query('cursor')! } : {}),
      ...(c.req.query('pageSize') ? { pageSize: Number(c.req.query('pageSize')) } : {}),
    });
    return c.json(page);
  });

  app.get('/:slug', async (c) => {
    const entry = await deps.registry.getEntry({ slug: c.req.param('slug') });
    return c.json({ entry });
  });

  // ── Install with hash verification + scan ─────────────────────────────
  app.post('/install/:slug', async (c) => {
    const ws = getWorkspace(c);
    const slug = c.req.param('slug');
    installSchema.parse(await c.req.json().catch(() => ({})));

    const entry = await deps.registry.getEntry({ slug });
    const { warnings, sha256 } = await verifyAndScanArtifact(deps.registry, entry);

    const id = randomUUID();
    deps.db
      .insert(schema.installedRegistryArtifacts)
      .values({
        id,
        workspaceId: ws.workspaceId,
        ambientId: ws.ambientId,
        userId: ws.user.id,
        entryId: entry.entryId,
        entryType: entry.entryType,
        version: entry.version,
        sha256,
        // localResourceId is filled by the dashboard's resource creation
        // step (e.g. when a registry workflow becomes a row in `workflows`).
        localResourceId: '',
        permissionsAcknowledgedAt: new Date().toISOString(),
      })
      .run();

    deps.activity.record({
      workspaceId: ws.workspaceId,
      ambientId: ws.ambientId,
      userId: ws.user.id,
      eventType: 'skill_registry.installed',
      actorType: 'user',
      actorId: ws.user.id,
      entityType: entry.entryType,
      entityId: entry.entryId,
      summary: `Installed ${entry.title} v${entry.version} from registry`,
      metadata: {
        entry: { entryId: entry.entryId, title: entry.title, version: entry.version },
        scanWarnings: warnings.length > 0 ? warnings : undefined,
      },
    });
    return c.json({ id, entry, scanWarnings: warnings }, 201);
  });

  return app;
}

/**
 * Verify the artifact's declared SHA-256 against the bytes the client
 * fetches, then run the static security scanner. Returns scanner warnings
 * for the caller to surface in the install response.
 */
async function verifyAndScanArtifact(
  client: RegistryClient,
  entry: RegistryEntry,
): Promise<{ warnings: ScanFinding[]; sha256: string }> {
  const declared = entry.artifacts[0]?.sha256;
  const { bytes, declaredSha256 } = await client.fetchArtifactBytes({ slug: entry.slug });
  const actual = createHash('sha256').update(bytes).digest('hex');
  const expected = (declared || declaredSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new AgentisError(
      'SKILL_REGISTRY_HASH_MISMATCH',
      `entry ${entry.slug}: registry did not provide a sha256`,
    );
  }
  if (actual !== expected) {
    throw new AgentisError(
      'SKILL_REGISTRY_HASH_MISMATCH',
      `entry ${entry.slug}: expected ${expected}, got ${actual}`,
    );
  }
  const scan = scanArtifactBytes(bytes, entry.slug);
  const warnings = assertNoBlockingFindings(scan);
  return { warnings, sha256: actual };
}
