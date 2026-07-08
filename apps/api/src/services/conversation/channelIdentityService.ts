/**
 * ChannelIdentityService — cross-surface peer identity (OMNICHANNEL §5.2).
 *
 * Every inbound channel message is recorded against a (workspace, channelKind,
 * handle) identity. The operator can opt-in link a handle to a workspace user,
 * which assigns a stable `peerKey` (`user:<id>`) — so the same human is
 * recognized across WhatsApp, Telegram, and Slack. The orchestrator surfaces a
 * short "who is this" summary into the channel context on each turn.
 *
 * `handle` is the most stable per-channel sender address available to the
 * dispatcher: for 1:1 DMs (WhatsApp/Telegram) that is the chat address; for
 * Slack it is the thread address (the channel-side conversation key). Linking is
 * what makes the cross-channel unification precise.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import type { Logger } from '../../logger.js';

export interface PeerIdentity {
  id: string;
  workspaceId: string;
  channelKind: string;
  handle: string;
  displayName: string | null;
  userId: string | null;
  peerKey: string | null;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export class ChannelIdentityService {
  constructor(private readonly deps: { db: AgentisSqliteDb; logger?: Logger }) {}

  /** Record an inbound message against its peer identity (upsert). */
  record(args: { workspaceId: string; channelKind: string; handle: string; displayName?: string }): PeerIdentity {
    const now = new Date().toISOString();
    const existing = this.#find(args.workspaceId, args.channelKind, args.handle);
    if (existing) {
      this.deps.db
        .update(schema.channelPeerIdentities)
        .set({
          messageCount: existing.messageCount + 1,
          lastSeenAt: now,
          ...(args.displayName ? { displayName: args.displayName } : {}),
        })
        .where(eq(schema.channelPeerIdentities.id, existing.id))
        .run();
      return { ...existing, messageCount: existing.messageCount + 1, lastSeenAt: now, displayName: args.displayName ?? existing.displayName };
    }
    const row = {
      id: randomUUID(),
      workspaceId: args.workspaceId,
      channelKind: args.channelKind,
      handle: args.handle,
      displayName: args.displayName ?? null,
      userId: null,
      peerKey: null,
      messageCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.deps.db.insert(schema.channelPeerIdentities).values(row).run();
    return row;
  }

  resolve(workspaceId: string, channelKind: string, handle: string): PeerIdentity | null {
    return this.#find(workspaceId, channelKind, handle);
  }

  list(workspaceId: string): PeerIdentity[] {
    return this.deps.db
      .select()
      .from(schema.channelPeerIdentities)
      .where(eq(schema.channelPeerIdentities.workspaceId, workspaceId))
      .all();
  }

  /** Opt-in: link a handle to a workspace user, unifying it across channels. */
  link(args: { workspaceId: string; channelKind: string; handle: string; userId: string | null }): PeerIdentity | null {
    const existing = this.#find(args.workspaceId, args.channelKind, args.handle);
    if (!existing) return null;
    const peerKey = args.userId ? `user:${args.userId}` : null;
    this.deps.db
      .update(schema.channelPeerIdentities)
      .set({ userId: args.userId, peerKey })
      .where(eq(schema.channelPeerIdentities.id, existing.id))
      .run();
    return { ...existing, userId: args.userId, peerKey };
  }

  /** Other channel identities sharing this peer's key (cross-surface presence). */
  peerChannels(workspaceId: string, peerKey: string): PeerIdentity[] {
    return this.deps.db
      .select()
      .from(schema.channelPeerIdentities)
      .where(and(eq(schema.channelPeerIdentities.workspaceId, workspaceId), eq(schema.channelPeerIdentities.peerKey, peerKey)))
      .all();
  }

  /**
   * Record the inbound and return a one-line "who is this" summary for the
   * channel context, or null on a brand-new first contact.
   */
  recordAndSummarize(args: { workspaceId: string; channelKind: string; handle: string; displayName?: string }): {
    identity: PeerIdentity;
    summary: string | null;
  } {
    const identity = this.record(args);
    return { identity, summary: this.#summarize(identity) };
  }


  #summarize(identity: PeerIdentity): string | null {
    // First-ever message: nothing to recall yet.
    if (identity.messageCount <= 1 && !identity.userId) return null;
    const parts: string[] = [];
    const who = identity.displayName ?? identity.handle;
    parts.push(`Known sender: ${who} (${identity.messageCount} prior message${identity.messageCount === 1 ? '' : 's'} on ${identity.channelKind}).`);
    if (identity.peerKey) {
      const others = this.peerChannels(identity.workspaceId, identity.peerKey)
        .filter((p) => p.id !== identity.id)
        .map((p) => p.channelKind);
      const uniqueOthers = [...new Set(others)];
      if (uniqueOthers.length > 0) {
        parts.push(`Same person also reaches you on: ${uniqueOthers.join(', ')}.`);
      }
      parts.push('This handle is linked to a workspace user.');
    }
    return parts.join(' ');
  }

  #find(workspaceId: string, channelKind: string, handle: string): PeerIdentity | null {
    return (
      this.deps.db
        .select()
        .from(schema.channelPeerIdentities)
        .where(and(
          eq(schema.channelPeerIdentities.workspaceId, workspaceId),
          eq(schema.channelPeerIdentities.channelKind, channelKind),
          eq(schema.channelPeerIdentities.handle, handle),
        ))
        .get() ?? null
    );
  }
}
