/**
 * AppContactService — the relationship entity (LIVING-APPS-10X Phase 3).
 *
 * ⚠️ LEGACY NAME / PARALLEL PATH (Agent-Native Platform Plan §3.2). This is a
 * lead/contact-flavored precursor to the general **Subject** primitive on the Durable
 * Entity spine (`durable_entities` kind=`subject`, `SubjectRuntime`, `agentis.subject.*`).
 * New per-entity/lifecycle work should target the Subject spine, NOT extend contacts.
 * Folding this table's data + behavior into the spine (retiring the contact/follow-up
 * names) is a tracked post-soak migration — see the plan's implementation log. Do not
 * add generic per-entity features here.
 *
 * An App talks to many people across many channels. `app_contacts` is the
 * durable record of each — the thing that turns a pile of threads into a
 * pipeline. It carries the person's identity (handle + cross-channel peerId),
 * the pipeline state (stage/goal), the last-touch clock, and `nextTouchAt` — the
 * proactivity trigger the follow-up sweep reads to dispatch a timely turn.
 *
 * `touch` is called on every inbound App-bound turn (idempotent upsert keyed by
 * app+channel+handle), so the contact and its lastTouchAt stay current with zero
 * agent effort. Cross-channel merge is seeded by recording the ChannelIdentity
 * peerId; full merge of two handles into one relationship is a follow-up.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

export interface ContactTouch {
  workspaceId: string;
  appId: string;
  channelKind: string;
  handle: string;
  displayName?: string | null;
  peerId?: string | null;
}

export interface ContactPatch {
  stage?: string | null;
  goal?: string | null;
  displayName?: string | null;
  nextTouchAt?: string | null;
  data?: Record<string, unknown>;
}

export class AppContactService {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Upsert the contact for an inbound message and stamp lastTouchAt. Returns its id. */
  touch(input: ContactTouch): string {
    const now = new Date().toISOString();
    const existing = this.#findByHandle(input.appId, input.channelKind, input.handle);
    if (existing) {
      this.db.update(schema.appContacts).set({
        lastTouchAt: now,
        updatedAt: now,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.peerId ? { peerId: input.peerId } : {}),
      }).where(eq(schema.appContacts.id, existing.id)).run();
      return existing.id;
    }
    const id = randomUUID();
    this.db.insert(schema.appContacts).values({
      id,
      workspaceId: input.workspaceId,
      appId: input.appId,
      channelKind: input.channelKind,
      handle: input.handle,
      peerId: input.peerId ?? null,
      displayName: input.displayName ?? null,
      stage: 'new',
      lastTouchAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    return id;
  }

  list(workspaceId: string, appId: string) {
    return this.db
      .select()
      .from(schema.appContacts)
      .where(and(eq(schema.appContacts.workspaceId, workspaceId), eq(schema.appContacts.appId, appId)))
      .orderBy(asc(schema.appContacts.stage))
      .all();
  }

  get(workspaceId: string, contactId: string) {
    return this.db
      .select()
      .from(schema.appContacts)
      .where(and(eq(schema.appContacts.workspaceId, workspaceId), eq(schema.appContacts.id, contactId)))
      .get() ?? null;
  }

  update(workspaceId: string, contactId: string, patch: ContactPatch) {
    const existing = this.get(workspaceId, contactId);
    if (!existing) return null;
    const data = patch.data
      ? { ...((existing.dataJson && typeof existing.dataJson === 'object' ? existing.dataJson : {}) as Record<string, unknown>), ...patch.data }
      : undefined;
    this.db.update(schema.appContacts).set({
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.nextTouchAt !== undefined ? { nextTouchAt: patch.nextTouchAt } : {}),
      ...(data ? { dataJson: data } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.appContacts.id, contactId)).run();
    return this.get(workspaceId, contactId);
  }

  /** Contacts whose follow-up is due (nextTouchAt <= now). Drives the proactive sweep. */
  dueForFollowUp(now: string, limit = 50) {
    return this.db
      .select()
      .from(schema.appContacts)
      .where(and(isNotNull(schema.appContacts.nextTouchAt), lte(schema.appContacts.nextTouchAt, now)))
      .orderBy(asc(schema.appContacts.nextTouchAt))
      .limit(limit)
      .all();
  }

  /** Clear the follow-up clock once a proactive turn has fired. */
  clearNextTouch(contactId: string): void {
    this.db.update(schema.appContacts)
      .set({ nextTouchAt: null, lastTouchAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(schema.appContacts.id, contactId)).run();
  }

  #findByHandle(appId: string, channelKind: string, handle: string) {
    return this.db
      .select({ id: schema.appContacts.id })
      .from(schema.appContacts)
      .where(and(
        eq(schema.appContacts.appId, appId),
        eq(schema.appContacts.channelKind, channelKind),
        eq(schema.appContacts.handle, handle),
      ))
      .get() ?? null;
  }
}
