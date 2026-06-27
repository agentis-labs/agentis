/**
 * ConversationParticipantService — the multi-party thread layer (LIVING-APPS-10X
 * Phase 2 · G1, migration v98).
 *
 * `conversations.agentId` stays the singular PRIMARY participant (it has many
 * readers across the codebase). This service layers ADDITIONAL parties beside it
 * so a real desk — customer + resident agent + escalation specialist + human
 * operator — can live in ONE thread, with warm handoff between them.
 *
 * Warm handoff: bring an agent in as an active 'specialist' and inbound turns
 * route to THAT agent (see ChannelTurnDispatcher #resolveResponder), then set it
 * inactive (or leave) to hand back to the primary. Human-takeover is unchanged —
 * it rides conversations.handoffState='human' (the agent parks regardless).
 *
 * Every method is non-throwing-by-contract at the call sites that matter
 * (dispatcher / inbound): list/primaryAgent degrade to a safe default on error.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';

export type ParticipantType = 'agent' | 'human' | 'contact';
export type ParticipantRole = 'primary' | 'specialist' | 'operator' | 'customer' | (string & {});

export interface ParticipantRow {
  id: string;
  conversationId: string;
  participantType: ParticipantType;
  participantId: string | null;
  role: ParticipantRole;
  active: boolean;
  joinedAt: string;
  leftAt: string | null;
}

export interface AddParticipantInput {
  conversationId: string;
  participantType: ParticipantType;
  /** agentId / userId / app_contact id — null for an external contact by handle. */
  participantId?: string | null;
  role: ParticipantRole;
  active?: boolean;
}

export class ConversationParticipantService {
  constructor(
    private readonly db: AgentisSqliteDb,
    private readonly logger?: Logger,
  ) {}

  /**
   * Add (or re-activate) a participant. Idempotent on (conversation, type, id):
   * an existing match is re-activated and its role updated rather than duplicated.
   * Returns the participant id, or null if the write fails (non-throwing).
   */
  add(input: AddParticipantInput): string | null {
    const now = new Date().toISOString();
    const active = input.active ?? true;
    const participantId = input.participantId ?? null;
    try {
      const existing = this.#find(input.conversationId, input.participantType, participantId);
      if (existing) {
        this.db
          .update(schema.conversationParticipants)
          .set({
            role: input.role,
            active: active ? 1 : 0,
            ...(active ? { leftAt: null, joinedAt: now } : { leftAt: now }),
          })
          .where(eq(schema.conversationParticipants.id, existing.id))
          .run();
        return existing.id;
      }
      const id = randomUUID();
      this.db
        .insert(schema.conversationParticipants)
        .values({
          id,
          conversationId: input.conversationId,
          participantType: input.participantType,
          participantId,
          role: input.role,
          active: active ? 1 : 0,
          joinedAt: now,
          leftAt: active ? null : now,
        })
        .run();
      return id;
    } catch (err) {
      this.logger?.warn('conversation.participant.add_failed', {
        conversationId: input.conversationId,
        err: (err as Error).message,
      });
      return null;
    }
  }

  /** Mark a participant inactive (left the thread). Returns true if a row changed. */
  remove(conversationId: string, participantRowId: string): boolean {
    return this.setActive(conversationId, participantRowId, false);
  }

  /** Toggle a participant's active flag. Inactive specialists no longer drive inbound. */
  setActive(conversationId: string, participantRowId: string, active: boolean): boolean {
    const now = new Date().toISOString();
    try {
      const res = this.db
        .update(schema.conversationParticipants)
        .set({ active: active ? 1 : 0, ...(active ? { leftAt: null } : { leftAt: now }) })
        .where(and(
          eq(schema.conversationParticipants.id, participantRowId),
          eq(schema.conversationParticipants.conversationId, conversationId),
        ))
        .run();
      return res.changes > 0;
    } catch (err) {
      this.logger?.warn('conversation.participant.set_active_failed', {
        conversationId,
        err: (err as Error).message,
      });
      return false;
    }
  }

  /** List participants (newest active first). Non-throwing — returns [] on error. */
  list(conversationId: string, opts: { activeOnly?: boolean } = {}): ParticipantRow[] {
    try {
      const where = opts.activeOnly
        ? and(eq(schema.conversationParticipants.conversationId, conversationId), eq(schema.conversationParticipants.active, 1))
        : eq(schema.conversationParticipants.conversationId, conversationId);
      const rows = this.db
        .select()
        .from(schema.conversationParticipants)
        .where(where)
        .orderBy(desc(schema.conversationParticipants.active), desc(schema.conversationParticipants.joinedAt))
        .all();
      return rows.map(toParticipantRow);
    } catch (err) {
      this.logger?.warn('conversation.participant.list_failed', {
        conversationId,
        err: (err as Error).message,
      });
      return [];
    }
  }

  /** The primary agent participant's agentId (falls back to conversations.agentId). */
  primaryAgent(conversationId: string): string | null {
    try {
      const row = this.db
        .select({ participantId: schema.conversationParticipants.participantId })
        .from(schema.conversationParticipants)
        .where(and(
          eq(schema.conversationParticipants.conversationId, conversationId),
          eq(schema.conversationParticipants.participantType, 'agent'),
          eq(schema.conversationParticipants.role, 'primary'),
        ))
        .get();
      if (row?.participantId) return row.participantId;
    } catch (err) {
      this.logger?.warn('conversation.participant.primary_failed', {
        conversationId,
        err: (err as Error).message,
      });
    }
    return this.#conversationAgentId(conversationId);
  }

  /**
   * The agentId that should answer the next inbound turn:
   *   - the single active 'specialist' agent participant (warm handoff target), else
   *   - the primary agent participant, else
   *   - conversations.agentId (back-compat — threads with no participants row).
   * Human-takeover is handled separately (handoffState='human' parks all agents).
   */
  activeResponderAgent(conversationId: string, fallbackAgentId: string): string {
    try {
      const active = this.db
        .select({
          participantId: schema.conversationParticipants.participantId,
          role: schema.conversationParticipants.role,
        })
        .from(schema.conversationParticipants)
        .where(and(
          eq(schema.conversationParticipants.conversationId, conversationId),
          eq(schema.conversationParticipants.participantType, 'agent'),
          eq(schema.conversationParticipants.active, 1),
        ))
        .all();
      const specialist = active.find((r) => r.role === 'specialist' && r.participantId);
      if (specialist?.participantId) return specialist.participantId;
      const primary = active.find((r) => r.role === 'primary' && r.participantId);
      if (primary?.participantId) return primary.participantId;
    } catch (err) {
      this.logger?.warn('conversation.participant.responder_failed', {
        conversationId,
        err: (err as Error).message,
      });
    }
    return fallbackAgentId;
  }

  /**
   * Idempotently seed the primary agent participant from conversations.agentId.
   * Safe to call on every inbound — the unique index + active re-use make it a
   * no-op once seeded. Returns the primary participant id, or null.
   */
  ensurePrimary(conversationId: string, agentId?: string): string | null {
    const resolved = agentId ?? this.#conversationAgentId(conversationId);
    if (!resolved) return null;
    return this.add({
      conversationId,
      participantType: 'agent',
      participantId: resolved,
      role: 'primary',
      active: true,
    });
  }

  #conversationAgentId(conversationId: string): string | null {
    try {
      const row = this.db
        .select({ agentId: schema.conversations.agentId })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversationId))
        .get();
      return row?.agentId ?? null;
    } catch {
      return null;
    }
  }

  #find(conversationId: string, participantType: ParticipantType, participantId: string | null) {
    return this.db
      .select({ id: schema.conversationParticipants.id })
      .from(schema.conversationParticipants)
      .where(and(
        eq(schema.conversationParticipants.conversationId, conversationId),
        eq(schema.conversationParticipants.participantType, participantType),
        participantId === null
          ? isNull(schema.conversationParticipants.participantId)
          : eq(schema.conversationParticipants.participantId, participantId),
      ))
      .get() ?? null;
  }
}

function toParticipantRow(row: typeof schema.conversationParticipants.$inferSelect): ParticipantRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    participantType: row.participantType as ParticipantType,
    participantId: row.participantId ?? null,
    role: row.role as ParticipantRole,
    active: row.active === 1,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt ?? null,
  };
}
