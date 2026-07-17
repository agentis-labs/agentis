/**
 * /v1/workspace/bundle — the `.agentis` whole-workspace bundle (backup / share / sell).
 *
 *   POST /export   { profile, name?, description?, license? }  → WorkspaceBundleEnvelope
 *   POST /preview  { envelope }                                → WorkspaceBundlePreview (non-mutating)
 *   POST /import   { envelope, permissionsAcknowledged }       → install summary
 *
 * Thin layer over {@link WorkspacePackager}; all workspace-scoping + the
 * secrets/PII boundary live in the service. Mounted at `/v1/workspace/bundle`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { AgentisError, bundleFidelitySchema, bundleSelectionSchema, exportProfileSchema, workspaceBundleEnvelopeSchema } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { AuthService } from '../services/auth.js';
import type { EventBus } from '../event-bus.js';
import type { Logger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace, getWorkspace } from '../middleware/workspace.js';
import { WorkspacePackager } from '../services/workspace/workspacePackager.js';
import type { EpisodicMemoryStore } from '../services/episodicMemoryStore.js';
import { createBackup, restoreBackup } from '../services/backup.js';
import { join } from 'node:path';

const exportSchema = z.object({
  profile: exportProfileSchema.default('share'),
  /** `full` carries learned intelligence (brains + rows); `shareable` (default) does not. */
  fidelity: bundleFidelitySchema.default('shareable'),
  /** Granular pick of what to include in the export. */
  selection: bundleSelectionSchema.partial().optional(),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).nullable().optional(),
  license: z.string().max(8000).nullable().optional(),
});

const previewSchema = z.object({ envelope: workspaceBundleEnvelopeSchema });

const importSchema = z.object({
  envelope: workspaceBundleEnvelopeSchema,
  /** Granular pick of what to actually install from the bundle. */
  selection: bundleSelectionSchema.partial().optional(),
  permissionsAcknowledged: z.literal(true, {
    errorMap: () => ({ message: 'permissionsAcknowledged must be true' }),
  }),
});

export function buildWorkspaceBundleRoutes(deps: {
  db: AgentisSqliteDb;
  auth: AuthService;
  bus?: EventBus;
  logger?: Logger;
  /** Data dir for the `backup` profile (whole-install snapshot). */
  dataDir?: string;
  /** RSA keypair (PEM) used to sign `sell` bundles. */
  signer?: { privateKeyPem: string; publicKeyPem: string };
  /** Brain store — enables carrying/rehydrating learned intelligence (full fidelity). */
  episodes?: EpisodicMemoryStore;
}) {
  const app = new Hono();
  const packager = new WorkspacePackager({
    db: deps.db,
    ...(deps.bus ? { bus: deps.bus } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.signer ? { signer: deps.signer } : {}),
    ...(deps.episodes ? { episodes: deps.episodes } : {}),
  });
  app.use('*', requireAuth(deps), requireWorkspace(deps));

  app.post('/export', async (c) => {
    const ws = getWorkspace(c);
    const body = exportSchema.parse(await c.req.json().catch(() => ({})));
    if (body.profile === 'backup') {
      throw new AgentisError('VALIDATION_FAILED', 'backup bundles are produced via the backup/restore path, not this manifest export');
    }
    const author = { id: ws.user.id, displayName: ws.user.displayName ?? ws.user.username };
    const envelope = packager.exportWorkspace(ws.workspaceId, body.profile, {
      fidelity: body.fidelity,
      ...(body.selection ? { selection: body.selection } : {}),
      ...(body.name ? { name: body.name } : {}),
      description: body.description ?? null,
      license: body.license ?? null,
      author,
    });
    return c.json(envelope);
  });

  app.post('/preview', async (c) => {
    getWorkspace(c);
    const body = previewSchema.parse(await c.req.json());
    return c.json(packager.preview(body.envelope));
  });

  app.post('/import', async (c) => {
    const ws = getWorkspace(c);
    const body = importSchema.parse(await c.req.json());
    const result = packager.installBundle(
      { workspaceId: ws.workspaceId, ambientId: ws.ambientId, userId: ws.user.id },
      body.envelope,
      { permissionsAcknowledged: body.permissionsAcknowledged, ...(body.selection ? { selection: body.selection } : {}) },
    );
    return c.json(result, 201);
  });

  // ── Backup profile — full-fidelity, whole-install snapshot ──────────────────
  // The `backup` profile carries secrets + all rows, so it does NOT travel as a
  // shareable manifest: it is a checkpointed copy of the data dir (DB + secrets).
  // Local/single-operator only; the snapshot lands on the server's filesystem.
  app.post('/backup', async (c) => {
    getWorkspace(c); // auth gate only — backup is whole-install, not workspace-sliced
    if (!deps.dataDir) throw new AgentisError('VALIDATION_FAILED', 'backup is not available on this deployment');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = join(deps.dataDir, 'backups', `backup-${stamp}`);
    const result = await createBackup({ dataDir: deps.dataDir, outDir });
    return c.json({
      outDir: result.outDir,
      files: result.files,
      note: 'Whole-install snapshot (DB + secrets). Archive the directory (e.g. tar -czf) to move it. Restoring requires a server restart.',
    }, 201);
  });

  app.post('/restore', async (c) => {
    getWorkspace(c);
    if (!deps.dataDir) throw new AgentisError('VALIDATION_FAILED', 'restore is not available on this deployment');
    const body = z.object({ backupDir: z.string().min(1), force: z.boolean().default(false) }).parse(await c.req.json());
    await restoreBackup({ backupDir: body.backupDir, dataDir: deps.dataDir, force: body.force });
    return c.json({ ok: true, note: 'Restored into the data dir. Restart the server for the restored database to take effect.' }, 201);
  });

  return app;
}
