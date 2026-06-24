/**
 * AppStore — persistence for the Agentic App entity (AGENTIC-APPS-10X-MASTERPLAN §3).
 *
 * An App is the first-class deployable unit that owns workflows, and (in later
 * phases) surfaces and datastore collections. This service is the single seam
 * for App identity + membership + workflow adoption. Follows the conventions of
 * the other *Store services (synchronous better-sqlite3 via drizzle).
 *
 * Back-compat invariant: a workflow with `app_id = NULL` is a valid bare
 * workflow (App-of-one). Adopting a workflow sets its `app_id`; nothing here
 * mutates graph or run state.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  AgentisError,
  appIdentitySchema,
  appPolicySchema,
  appSourceSchema,
  type AppRecord,
  type AppMember,
  type AppMemberRole,
  type AppIdentity,
  type AppPolicy,
  type AppStatus,
  type CreateAppInput,
  type UpdateAppInput,
} from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

type AppRow = typeof schema.apps.$inferSelect;

export class AppStore {
  constructor(private readonly db: AgentisSqliteDb) {}

  private toRecord(row: AppRow): AppRecord {
    const manifest = appIdentitySchema.parse(
      row.manifestJson && Object.keys(row.manifestJson as object).length > 0
        ? row.manifestJson
        : { slug: row.slug, name: row.name, version: row.version },
    );
    const policy = appPolicySchema.parse(row.policyJson ?? {});
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      status: row.status as AppStatus,
      entrySurfaceId: row.entrySurfaceId,
      icon: row.icon,
      domainId: row.spaceId ?? null,
      ownerAgentId: row.ownerAgentId ?? null,
      manifest,
      policy,
      source: row.sourceJson ? appSourceSchema.parse(row.sourceJson) : null,
      installedChecksum: row.installedChecksum ?? null,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Ensure a slug is unique within the workspace, suffixing -2, -3, … on collision. */
  private uniqueSlug(workspaceId: string, base: string): string {
    const root = slugify(base) || 'app';
    let candidate = root;
    let n = 1;
    while (
      this.db
        .select({ id: schema.apps.id })
        .from(schema.apps)
        .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.slug, candidate)))
        .get()
    ) {
      n += 1;
      candidate = `${root}-${n}`;
    }
    return candidate;
  }

  create(workspaceId: string, userId: string, input: CreateAppInput): AppRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const slug = this.uniqueSlug(workspaceId, input.slug ?? input.name);
    const version = '0.1.0';
    const manifest: AppIdentity = appIdentitySchema.parse({
      slug,
      name: input.name,
      version,
    });
    this.db
      .insert(schema.apps)
      .values({
        id,
        workspaceId,
        slug,
        name: input.name,
        description: input.description ?? '',
        version,
        status: 'draft',
        entrySurfaceId: null,
        icon: input.icon ?? null,
        spaceId: input.domainId ?? null,
        ownerAgentId: input.ownerAgentId ?? null,
        manifestJson: manifest,
        policyJson: appPolicySchema.parse({}),
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    if (input.entryWorkflowId) {
      this.adoptWorkflow(workspaceId, id, input.entryWorkflowId);
    }
    return this.get(workspaceId, id);
  }

  get(workspaceId: string, appId: string): AppRecord {
    const row = this.db
      .select()
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.id, appId)))
      .get();
    if (!row) throw new AgentisError('RESOURCE_NOT_FOUND', `app not found: ${appId}`);
    return this.toRecord(row);
  }

  getBySlug(workspaceId: string, slug: string): AppRecord | undefined {
    const row = this.db
      .select()
      .from(schema.apps)
      .where(and(eq(schema.apps.workspaceId, workspaceId), eq(schema.apps.slug, slug)))
      .get();
    return row ? this.toRecord(row) : undefined;
  }

  list(workspaceId: string, filters: { status?: AppStatus } = {}): AppRecord[] {
    const rows = this.db
      .select()
      .from(schema.apps)
      .where(
        and(
          eq(schema.apps.workspaceId, workspaceId),
          ...(filters.status ? [eq(schema.apps.status, filters.status)] : []),
        ),
      )
      .orderBy(desc(schema.apps.updatedAt))
      .all();
    return rows.map((r) => this.toRecord(r));
  }

  update(workspaceId: string, appId: string, patch: UpdateAppInput): AppRecord {
    const current = this.get(workspaceId, appId);
    const nextManifest: AppIdentity = patch.manifest
      ? appIdentitySchema.parse({ ...current.manifest, ...patch.manifest })
      : current.manifest;
    const nextPolicy: AppPolicy = patch.policy
      ? appPolicySchema.parse({ ...current.policy, ...patch.policy })
      : current.policy;
    // Keep manifest name/version in sync with the top-level columns.
    if (patch.name) nextManifest.name = patch.name;
    if (patch.version) nextManifest.version = patch.version;
    this.db
      .update(schema.apps)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.version !== undefined ? { version: patch.version } : {}),
        ...(patch.entrySurfaceId !== undefined ? { entrySurfaceId: patch.entrySurfaceId } : {}),
        ...(patch.domainId !== undefined ? { spaceId: patch.domainId } : {}),
        ...(patch.ownerAgentId !== undefined ? { ownerAgentId: patch.ownerAgentId } : {}),
        ...(patch.source !== undefined ? { sourceJson: patch.source } : {}),
        ...(patch.installedChecksum !== undefined ? { installedChecksum: patch.installedChecksum } : {}),
        manifestJson: nextManifest,
        policyJson: nextPolicy,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.apps.id, appId))
      .run();
    return this.get(workspaceId, appId);
  }

  delete(workspaceId: string, appId: string): void {
    this.get(workspaceId, appId); // throws NOT_FOUND if absent
    // workflows.app_id is ON DELETE SET NULL → adopted workflows survive as bare.
    this.db.delete(schema.apps).where(eq(schema.apps.id, appId)).run();
  }

  // ── Membership ──────────────────────────────────────────────

  addMember(workspaceId: string, appId: string, agentId: string, role: AppMemberRole = 'worker'): void {
    this.get(workspaceId, appId);
    this.db
      .insert(schema.appMembers)
      .values({ appId, agentId, role })
      .onConflictDoUpdate({ target: [schema.appMembers.appId, schema.appMembers.agentId], set: { role } })
      .run();
  }

  removeMember(workspaceId: string, appId: string, agentId: string): void {
    this.get(workspaceId, appId);
    this.db
      .delete(schema.appMembers)
      .where(and(eq(schema.appMembers.appId, appId), eq(schema.appMembers.agentId, agentId)))
      .run();
  }

  listMembers(workspaceId: string, appId: string): AppMember[] {
    this.get(workspaceId, appId);
    return this.db
      .select()
      .from(schema.appMembers)
      .where(eq(schema.appMembers.appId, appId))
      .all()
      .map((r) => ({ appId: r.appId, agentId: r.agentId, role: r.role as AppMemberRole }));
  }

  // ── Workflow adoption ───────────────────────────────────────

  /** Bind an existing workflow to this App. Validates both belong to the workspace. */
  adoptWorkflow(workspaceId: string, appId: string, workflowId: string): void {
    this.get(workspaceId, appId);
    const wf = this.db
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.id, workflowId)))
      .get();
    if (!wf) throw new AgentisError('RESOURCE_NOT_FOUND', `workflow not found: ${workflowId}`);
    this.db.update(schema.workflows).set({ appId }).where(eq(schema.workflows.id, workflowId)).run();
  }

  listWorkflowIds(workspaceId: string, appId: string): string[] {
    this.get(workspaceId, appId);
    return this.db
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, workspaceId), eq(schema.workflows.appId, appId)))
      .all()
      .map((r) => r.id);
  }
}
