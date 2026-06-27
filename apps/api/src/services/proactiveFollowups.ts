/**
 * ProactiveFollowupService — the App reaches out first (LIVING-APPS-10X Phase 3 / §4.5).
 *
 * A resident agent must initiate, not only react. Each contact carries a
 * `nextTouchAt` clock; when it falls due this sweep dispatches a turn into the
 * contact's conversation with a follow-up goal, the agent composes a message,
 * and the dispatcher delivers it to the channel — then the clock is cleared.
 *
 * Reuses the existing inbound `ChannelTurnDispatcher` (the follow-up prompt is
 * fed as the turn's text), so there is no second turn engine. Best-effort and
 * non-throwing: a contact with no resolvable conversation just has its clock
 * cleared so it never blocks the sweep.
 */

import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../logger.js';
import type { AppContactService } from './appContacts.js';
import type { ChannelTurnDispatcher } from './channelTurnDispatcher.js';

export interface ProactiveFollowupDeps {
  db: AgentisSqliteDb;
  contacts: AppContactService;
  dispatcher: Pick<ChannelTurnDispatcher, 'dispatch'>;
  logger: Logger;
}

export class ProactiveFollowupService {
  constructor(private readonly deps: ProactiveFollowupDeps) {}

  /** Fire all due follow-ups. Returns how many turns were dispatched. */
  async sweep(now: string = new Date().toISOString()): Promise<{ fired: number; cleared: number }> {
    const due = this.deps.contacts.dueForFollowUp(now);
    let fired = 0;
    let cleared = 0;
    for (const contact of due) {
      try {
        const dispatched = await this.#followUp(contact);
        if (dispatched) fired += 1;
      } catch (err) {
        this.deps.logger.warn('proactive.followup.failed', { contactId: contact.id, err: (err as Error).message });
      } finally {
        // Always clear the clock — a fired follow-up sets a fresh lastTouch; an
        // unresolvable one is dropped rather than retried forever.
        this.deps.contacts.clearNextTouch(contact.id);
        cleared += 1;
      }
    }
    return { fired, cleared };
  }

  async #followUp(contact: {
    id: string; workspaceId: string; appId: string | null; channelKind: string | null; handle: string | null; displayName: string | null; goal: string | null;
  }): Promise<boolean> {
    if (!contact.appId || !contact.channelKind || !contact.handle) return false;
    // Resolve the live thread for this contact (DM channels: handle == chat id).
    const conv = this.deps.db
      .select({ id: schema.conversations.id, agentId: schema.conversations.agentId, userId: schema.conversations.userId, connectionId: schema.conversations.channelConnectionId, handoffState: schema.conversations.handoffState })
      .from(schema.conversations)
      .where(and(
        eq(schema.conversations.appId, contact.appId),
        eq(schema.conversations.channelChatId, contact.handle),
      ))
      .get();
    if (!conv || !conv.connectionId) return false;
    // A human in the thread? Don't barge in.
    if (conv.handoffState === 'human') return false;

    const who = contact.displayName ?? 'this contact';
    const goal = contact.goal ?? 'continue the relationship and move it forward';
    await this.deps.dispatcher.dispatch({
      workspaceId: contact.workspaceId,
      ambientId: null,
      userId: conv.userId,
      agentId: conv.agentId,
      appId: contact.appId,
      conversationId: conv.id,
      connectionId: conv.connectionId,
      kind: contact.channelKind,
      chatId: contact.handle,
      text: `[Scheduled follow-up — you are reaching out first, this is not a reply to a new message] Follow up with ${who} as promised. Goal: ${goal}. Send a brief, warm, on-topic message; if there is nothing useful to say, stay quiet.`,
    });
    return true;
  }
}
