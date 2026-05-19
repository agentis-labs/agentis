/**
 * UserProfileService — BRAIN-ABILITIES-REPLAN.md §BL8 (User Profile layer).
 *
 * The USER.md equivalent: what agents know about the operator — name, role,
 * communication preferences, working hours, pet peeves. Distinct from brain
 * atoms, which hold facts about the *world*. One row per (workspace, user),
 * operator-editable, injected as a frozen block at agent dispatch.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';

/** Max chars of profile injected into a prompt (Hermes USER.md is ~1,375). */
const MAX_INJECT_CHARS = 1_500;

export interface UserProfile {
  workspaceId: string;
  userId: string;
  content: string;
  updatedAt: string;
}

export class UserProfileService {
  constructor(private readonly db: AgentisSqliteDb) {}

  /** Get the profile for an operator (null when none written). */
  get(workspaceId: string, userId: string): UserProfile | null {
    const row = this.db.select().from(schema.workspaceUserProfiles)
      .where(and(
        eq(schema.workspaceUserProfiles.workspaceId, workspaceId),
        eq(schema.workspaceUserProfiles.userId, userId),
      ))
      .get();
    return row
      ? { workspaceId: row.workspaceId, userId: row.userId, content: row.content, updatedAt: row.updatedAt }
      : null;
  }

  /** Upsert the operator's profile content. */
  set(workspaceId: string, userId: string, content: string): UserProfile {
    const now = new Date().toISOString();
    const existing = this.get(workspaceId, userId);
    if (existing) {
      this.db.update(schema.workspaceUserProfiles)
        .set({ content, updatedAt: now })
        .where(and(
          eq(schema.workspaceUserProfiles.workspaceId, workspaceId),
          eq(schema.workspaceUserProfiles.userId, userId),
        ))
        .run();
    } else {
      this.db.insert(schema.workspaceUserProfiles).values({
        id: randomUUID(),
        workspaceId,
        userId,
        content,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    return { workspaceId, userId, content, updatedAt: now };
  }

  /**
   * Render the profile as a frozen prompt block, or '' when empty. The
   * workspace owner is the implicit operator for V1's single-operator model.
   */
  buildDispatchBlock(workspaceId: string): string {
    const owner = this.db.select({ userId: schema.workspaces.userId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .get();
    if (!owner?.userId) return '';
    const profile = this.get(workspaceId, owner.userId);
    const content = profile?.content?.trim();
    if (!content) return '';
    const clipped = content.length > MAX_INJECT_CHARS
      ? `${content.slice(0, MAX_INJECT_CHARS)}…`
      : content;
    return `OPERATOR PROFILE (what you know about the person you work for):\n${clipped}`;
  }
}
