/**
 * Grounding Source Fabric — connections + restartable synchronization (RFC §7).
 *
 * Reuses the platform's proven resumable-ingestion mechanics (the same
 * cursor/checkpoint discipline as DatasetIngestion and listener cursors):
 * every batch commits its cursor + checkpoint to grounding_sync_runs before the
 * next batch is requested, so an interrupted sync resumes exactly where it
 * stopped and replays are idempotent through the evidence ledger.
 *
 * Default-deny: a connection syncs only the scopes the owner included
 * (RFC §7.2). KnowledgeSource implementations are registered here; workflow
 * connectors and harness adapters are different contracts and never sync.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { schema } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { CredentialVault } from '../services/credentialVault.js';
import type { EvidenceLedgerService } from './evidenceLedger.js';
import type { IdentityService } from './identityService.js';
import type { KnowledgeSource, SourceSyncContext } from './types.js';

export interface SourceFabricDeps {
  db: AgentisSqliteDb;
  logger: Logger;
  ledger: EvidenceLedgerService;
  /** Resolves connection credentials at sync time. Optional for credential-free sources. */
  vault?: CredentialVault;
  /** When present, sources that expose principal directories sync them after objects. */
  identity?: IdentityService;
}

export interface SyncOutcome {
  syncRunId: string;
  status: 'completed' | 'failed';
  objectsSeen: number;
  versionsCreated: number;
  deletions: number;
  error?: string;
}

export class GroundingSourceFabric {
  private readonly sources = new Map<string, KnowledgeSource>();

  constructor(private readonly deps: SourceFabricDeps) {}

  private get db() { return this.deps.db; }

  register(source: KnowledgeSource): void {
    this.sources.set(source.sourceType, source);
  }

  listRegisteredSources(): Array<{ sourceType: string; displayName: string; capabilities: KnowledgeSource['capabilities'] }> {
    return [...this.sources.values()].map((s) => ({
      sourceType: s.sourceType,
      displayName: s.displayName,
      capabilities: s.capabilities,
    }));
  }

  getSource(sourceType: string): KnowledgeSource | null {
    return this.sources.get(sourceType) ?? null;
  }

  /**
   * Decrypt a connection's credential into a raw bearer token, in memory, for
   * the life of one sync only — never logged or stored (RFC §16.4).
   *
   * Credentials reach the vault two ways:
   *   • OAuth-minted (one-click "Sign in with X") store a normalized JSON
   *     bundle: {"provider":"google","accessToken":"ya29…","refreshToken":…}.
   *   • Manually entered tokens store the raw string.
   * Both must yield the bearer token the KnowledgeSource sends as
   * `Authorization: Bearer …`, so we unwrap the bundle when present.
   */
  #resolveAccessToken(workspaceId: string, credentialId: string | null): string | null {
    if (!credentialId || !this.deps.vault) return null;
    const credential = this.db.select().from(schema.credentials)
      .where(and(
        eq(schema.credentials.workspaceId, workspaceId),
        eq(schema.credentials.id, credentialId),
      ))
      .get();
    if (!credential) return null;
    let decrypted: string;
    try {
      decrypted = this.deps.vault.decrypt(credential.encryptedValue);
    } catch {
      throw new Error('Stored credential could not be decrypted; reconnect the source.');
    }
    return extractBearerToken(decrypted);
  }

  // ── Connections ───────────────────────────────────────────

  createConnection(args: {
    workspaceId: string;
    sourceType: string;
    displayName?: string;
    credentialId?: string | null;
    includedScopes?: string[];
    excludedScopes?: string[];
    learningBrief?: Record<string, unknown>;
    informationDefaults?: Record<string, unknown>;
    reasoningMode?: 'core' | 'adaptive' | 'deep';
  }) {
    const source = this.sources.get(args.sourceType);
    const id = randomUUID();
    this.db.insert(schema.groundingSourceConnections).values({
      id,
      workspaceId: args.workspaceId,
      sourceType: args.sourceType,
      displayName: args.displayName ?? source?.displayName ?? args.sourceType,
      // A registered, credential-free source (agentis_native) is born ready;
      // anything needing authorization stays in 'connect' until validated.
      status: source && !args.credentialId && args.sourceType === 'agentis_native' ? 'ready' : 'connect',
      credentialId: args.credentialId ?? null,
      includedScopesJson: args.includedScopes ?? [],
      excludedScopesJson: args.excludedScopes ?? [],
      learningBriefJson: args.learningBrief ?? {},
      informationDefaultsJson: args.informationDefaults ?? {},
      reasoningMode: args.reasoningMode ?? 'adaptive',
    }).run();
    return this.getConnection(args.workspaceId, id)!;
  }

  getConnection(workspaceId: string, connectionId: string) {
    return this.db.select().from(schema.groundingSourceConnections)
      .where(and(
        eq(schema.groundingSourceConnections.workspaceId, workspaceId),
        eq(schema.groundingSourceConnections.id, connectionId),
      ))
      .get() ?? null;
  }

  listConnections(workspaceId: string) {
    return this.db.select().from(schema.groundingSourceConnections)
      .where(eq(schema.groundingSourceConnections.workspaceId, workspaceId))
      .orderBy(desc(schema.groundingSourceConnections.createdAt))
      .all();
  }

  updateConnection(workspaceId: string, connectionId: string, patch: Partial<{
    displayName: string;
    status: string;
    includedScopes: string[];
    excludedScopes: string[];
    learningBrief: Record<string, unknown>;
    reasoningMode: string;
  }>) {
    const sets: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.displayName !== undefined) sets.displayName = patch.displayName;
    if (patch.status !== undefined) sets.status = patch.status;
    if (patch.includedScopes !== undefined) sets.includedScopesJson = patch.includedScopes;
    if (patch.excludedScopes !== undefined) sets.excludedScopesJson = patch.excludedScopes;
    if (patch.learningBrief !== undefined) sets.learningBriefJson = patch.learningBrief;
    if (patch.reasoningMode !== undefined) sets.reasoningMode = patch.reasoningMode;
    this.db.update(schema.groundingSourceConnections)
      .set(sets)
      .where(and(
        eq(schema.groundingSourceConnections.workspaceId, workspaceId),
        eq(schema.groundingSourceConnections.id, connectionId),
      ))
      .run();
    return this.getConnection(workspaceId, connectionId);
  }

  // ── Synchronization ───────────────────────────────────────

  /**
   * Run one sync pass. Durable: cursor + checkpoint commit per batch.
   * Restart-safe: a new run resumes from the connection's last committed
   * cursor (incremental) or the last checkpoint (backfill).
   */
  async runSync(args: {
    workspaceId: string;
    connectionId: string;
    mode: 'backfill' | 'incremental' | 'sample';
    signal?: AbortSignal;
  }): Promise<SyncOutcome> {
    const connection = this.getConnection(args.workspaceId, args.connectionId);
    if (!connection) throw new Error(`Unknown Grounding source connection: ${args.connectionId}`);
    if (connection.status === 'revoked' || connection.status === 'paused') {
      throw new Error(`Connection is ${connection.status}; resume it before syncing.`);
    }
    const source = this.sources.get(connection.sourceType);
    if (!source) throw new Error(`No KnowledgeSource registered for type: ${connection.sourceType}`);

    const lastRun = this.latestRun(args.workspaceId, args.connectionId);
    const syncRunId = randomUUID();
    const startedAt = new Date().toISOString();
    this.db.insert(schema.groundingSyncRuns).values({
      id: syncRunId,
      workspaceId: args.workspaceId,
      connectionId: args.connectionId,
      mode: args.mode,
      status: 'running',
      cursor: lastRun?.cursor ?? null,
      startedAt,
    }).run();

    // Resolve the secret in memory for this sync only — never logged or stored.
    const accessToken = this.#resolveAccessToken(args.workspaceId, connection.credentialId);
    const ctx: SourceSyncContext = {
      workspaceId: args.workspaceId,
      connectionId: args.connectionId,
      credentialId: connection.credentialId,
      accessToken,
      includedScopes: (connection.includedScopesJson as string[]) ?? [],
      excludedScopes: (connection.excludedScopesJson as string[]) ?? [],
      signal: args.signal,
    };

    let objectsSeen = 0;
    let versionsCreated = 0;
    let deletions = 0;
    const sampleCap = args.mode === 'sample' ? 5 : Infinity;
    try {
      const iterable = args.mode === 'backfill'
        ? source.backfill({ ...ctx, checkpoint: (lastRun?.checkpointJson as Record<string, unknown>) ?? undefined })
        : source.synchronize({ ...ctx, cursor: lastRun?.cursor ?? null });
      for await (const batch of iterable) {
        if (args.signal?.aborted) throw new Error('Sync aborted');
        for (const object of batch.objects) {
          if (objectsSeen >= sampleCap) break;
          objectsSeen += 1;
          const result = this.deps.ledger.recordObject({
            workspaceId: args.workspaceId,
            connectionId: args.connectionId,
            sourceType: connection.sourceType,
            object,
          });
          if (result.created) versionsCreated += 1;
        }
        for (const tombstone of batch.deletions) {
          deletions += 1;
          this.deps.ledger.recordDeletion({
            workspaceId: args.workspaceId,
            connectionId: args.connectionId,
            externalId: tombstone.externalId,
            state: tombstone.state,
            at: tombstone.at,
          });
        }
        // Commit progress BEFORE pulling the next batch — the restart contract.
        this.db.update(schema.groundingSyncRuns)
          .set({
            cursor: batch.cursor ?? lastRun?.cursor ?? null,
            checkpointJson: batch.checkpoint ?? {},
            countsJson: { objectsSeen, versionsCreated, deletions },
          })
          .where(eq(schema.groundingSyncRuns.id, syncRunId))
          .run();
        if (objectsSeen >= sampleCap) break;
      }
      // ACL-fidelity pass (RFC §9.1) — permission changes propagate even when
      // content did not change. Unknown fidelity quarantines via the ledger.
      if (source.resolveAcl && args.mode !== 'sample') {
        try {
          for await (const entry of source.resolveAcl(ctx)) {
            const object = this.deps.ledger.getObjectByExternalId(args.workspaceId, args.connectionId, entry.externalId);
            if (object?.currentVersionId) {
              this.deps.ledger.applyAclChange(args.workspaceId, object.currentVersionId, entry.acl);
            }
          }
        } catch (error) {
          this.deps.logger.warn('grounding.sync.acl_failed', {
            connectionId: args.connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Identity directory pass (RFC §9.1) — principals upsert after objects so
      // deterministic identity links can resolve against fresh evidence.
      if (source.resolvePrincipals && this.deps.identity && args.mode !== 'sample') {
        try {
          for await (const principal of source.resolvePrincipals(ctx)) {
            this.deps.identity.upsertPrincipal({
              workspaceId: args.workspaceId,
              connectionId: args.connectionId,
              principal,
            });
          }
        } catch (error) {
          this.deps.logger.warn('grounding.sync.principals_failed', {
            connectionId: args.connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const finishedAt = new Date().toISOString();
      this.db.update(schema.groundingSyncRuns)
        .set({ status: 'completed', finishedAt })
        .where(eq(schema.groundingSyncRuns.id, syncRunId))
        .run();
      this.db.update(schema.groundingSourceConnections)
        .set({ lastSyncAt: finishedAt, status: 'ready', healthJson: { ok: true, lastOutcome: 'completed' }, updatedAt: finishedAt })
        .where(eq(schema.groundingSourceConnections.id, args.connectionId))
        .run();
      this.deps.logger.info('grounding.sync.completed', { workspaceId: args.workspaceId, connectionId: args.connectionId, mode: args.mode, objectsSeen, versionsCreated, deletions });
      return { syncRunId, status: 'completed', objectsSeen, versionsCreated, deletions };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.update(schema.groundingSyncRuns)
        .set({ status: 'failed', error: message, finishedAt: new Date().toISOString() })
        .where(eq(schema.groundingSyncRuns.id, syncRunId))
        .run();
      this.db.update(schema.groundingSourceConnections)
        .set({ status: 'needs_attention', healthJson: { ok: false, lastOutcome: message }, updatedAt: new Date().toISOString() })
        .where(eq(schema.groundingSourceConnections.id, args.connectionId))
        .run();
      this.deps.logger.warn('grounding.sync.failed', { workspaceId: args.workspaceId, connectionId: args.connectionId, error: message });
      return { syncRunId, status: 'failed', objectsSeen, versionsCreated, deletions, error: message };
    }
  }

  /** Discover a connection's available inclusion scopes (channels, folders, repos…). */
  async discoverConnectionScopes(workspaceId: string, connectionId: string) {
    const connection = this.getConnection(workspaceId, connectionId);
    if (!connection) throw new Error(`Unknown Grounding source connection: ${connectionId}`);
    const source = this.sources.get(connection.sourceType);
    if (!source) throw new Error(`No KnowledgeSource registered for type: ${connection.sourceType}`);
    const accessToken = this.#resolveAccessToken(workspaceId, connection.credentialId);
    const ctx: SourceSyncContext = {
      workspaceId,
      connectionId,
      credentialId: connection.credentialId,
      accessToken,
      includedScopes: [],
      excludedScopes: [],
    };
    const health = await source.validateConnection(ctx);
    if (!health.ok) return { health, scopes: [] };
    return { health, scopes: await source.discoverScopes(ctx) };
  }

  // ── Webhook mode (§7.4) ───────────────────────────────────

  #webhookDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Arm webhook ingress for a connection: generates (or returns) the shared
   * secret and the ingress path the owner registers with the source. The
   * webhook is a HINT, never trusted evidence — receipt triggers an
   * authoritative incremental sync from the committed cursor (§7.4).
   */
  armWebhook(workspaceId: string, connectionId: string): { path: string } {
    const connection = this.getConnection(workspaceId, connectionId);
    if (!connection) throw new Error(`Unknown Grounding source connection: ${connectionId}`);
    const schedule = (connection.scheduleJson ?? {}) as Record<string, unknown> & { webhookSecret?: string };
    let secret = schedule.webhookSecret;
    if (!secret) {
      secret = randomUUID().replace(/-/g, '');
      this.db.update(schema.groundingSourceConnections)
        .set({ scheduleJson: { ...schedule, webhookSecret: secret }, updatedAt: new Date().toISOString() })
        .where(eq(schema.groundingSourceConnections.id, connectionId))
        .run();
    }
    return { path: `/v1/grounding-webhooks/${connectionId}/${secret}` };
  }

  /**
   * Unauthenticated ingress (mounted like /v1/webhooks). Verifies the shared
   * secret, debounces bursts, then runs an incremental sync — the payload
   * body is deliberately IGNORED: hydration is always authoritative.
   */
  handleWebhookHint(connectionId: string, secret: string): { accepted: boolean } {
    const connection = this.db.select().from(schema.groundingSourceConnections)
      .where(eq(schema.groundingSourceConnections.id, connectionId))
      .get();
    if (!connection || connection.status === 'revoked' || connection.status === 'paused') return { accepted: false };
    const schedule = (connection.scheduleJson ?? {}) as { webhookSecret?: string };
    if (!schedule.webhookSecret || schedule.webhookSecret !== secret) return { accepted: false };
    const existing = this.#webhookDebounce.get(connectionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#webhookDebounce.delete(connectionId);
      void this.runSync({ workspaceId: connection.workspaceId, connectionId, mode: 'incremental' })
        .catch(() => {});
    }, 2000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.#webhookDebounce.set(connectionId, timer);
    return { accepted: true };
  }

  listSyncRuns(workspaceId: string, connectionId: string, limit = 20) {
    return this.db.select().from(schema.groundingSyncRuns)
      .where(and(
        eq(schema.groundingSyncRuns.workspaceId, workspaceId),
        eq(schema.groundingSyncRuns.connectionId, connectionId),
      ))
      .orderBy(desc(schema.groundingSyncRuns.createdAt))
      .limit(limit)
      .all();
  }

  private latestRun(workspaceId: string, connectionId: string) {
    return this.db.select().from(schema.groundingSyncRuns)
      .where(and(
        eq(schema.groundingSyncRuns.workspaceId, workspaceId),
        eq(schema.groundingSyncRuns.connectionId, connectionId),
        eq(schema.groundingSyncRuns.status, 'completed'),
      ))
      .orderBy(desc(schema.groundingSyncRuns.createdAt))
      .limit(1)
      .get() ?? null;
  }
}

/**
 * Unwrap a decrypted vault payload to its bearer token. OAuth-minted
 * credentials store a normalized JSON bundle ({accessToken,refreshToken,…});
 * manual tokens store the raw string. Returns the bearer either way.
 */
function extractBearerToken(decrypted: string): string {
  const trimmed = decrypted.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ['accessToken', 'access_token', 'token', 'apiKey', 'api_key']) {
        const value = parsed[key];
        if (typeof value === 'string' && value) return value;
      }
    } catch {
      // Not JSON after all — fall through to the raw string.
    }
  }
  return trimmed;
}
