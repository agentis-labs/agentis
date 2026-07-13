/**
 * ChannelIdentityService — cross-surface peer identity (OMNICHANNEL §5.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { ChannelIdentityService } from '../../src/services/conversation/channelIdentityService.js';

describe('ChannelIdentityService', () => {
  let ctx: TestContext;
  let svc: ChannelIdentityService;
  beforeEach(async () => {
    ctx = await createTestContext();
    svc = new ChannelIdentityService({ db: ctx.db, logger: ctx.logger });
  });
  afterEach(() => ctx.close());

  it('records then increments a sender, and resolve returns it', () => {
    const first = svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: '555@s.whatsapp.net', displayName: 'Bob' });
    expect(first.messageCount).toBe(1);
    const second = svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: '555@s.whatsapp.net', displayName: 'Bob' });
    expect(second.messageCount).toBe(2);
    const resolved = svc.resolve(ctx.workspace.id, 'whatsapp', '555@s.whatsapp.net');
    expect(resolved?.messageCount).toBe(2);
    expect(resolved?.displayName).toBe('Bob');
  });

  it('first contact has no recall summary; a repeat does', () => {
    const first = svc.recordAndSummarize({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: '42', displayName: 'Ann' });
    expect(first.summary).toBeNull();
    const repeat = svc.recordAndSummarize({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: '42', displayName: 'Ann' });
    expect(repeat.summary).toContain('Known sender: Ann');
    expect(repeat.summary).toContain('2 prior messages');
  });

  it('blocks and unblocks a sender (gate reads isBlocked; list surfaces it)', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'spammer', displayName: 'X' });
    expect(svc.isBlocked(ctx.workspace.id, 'whatsapp', 'spammer')).toBe(false);
    const blocked = svc.setBlocked({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'spammer', blocked: true });
    expect(blocked.blocked).toBe(true);
    expect(svc.isBlocked(ctx.workspace.id, 'whatsapp', 'spammer')).toBe(true);
    expect(svc.list(ctx.workspace.id).find((i) => i.handle === 'spammer')?.blocked).toBe(true);
    svc.setBlocked({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'spammer', blocked: false });
    expect(svc.isBlocked(ctx.workspace.id, 'whatsapp', 'spammer')).toBe(false);
  });

  it('can pre-block a sender never seen before (creates the row)', () => {
    svc.setBlocked({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: 'never-seen', blocked: true });
    expect(svc.isBlocked(ctx.workspace.id, 'telegram', 'never-seen')).toBe(true);
  });

  it('linking a handle to a user unifies it across channels', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'wa-1', displayName: 'Sam' });
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'slack', handle: 'U123', displayName: 'Sam' });
    svc.link({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'wa-1', userId: ctx.user.id });
    svc.link({ workspaceId: ctx.workspace.id, channelKind: 'slack', handle: 'U123', userId: ctx.user.id });

    const peers = svc.peerChannels(ctx.workspace.id, `user:${ctx.user.id}`);
    expect(peers.map((p) => p.channelKind).sort()).toEqual(['slack', 'whatsapp']);

    // The summary now mentions the other surface.
    const { summary } = svc.recordAndSummarize({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'wa-1', displayName: 'Sam' });
    expect(summary).toContain('linked to a workspace user');
    expect(summary).toContain('also reaches you on: slack');
  });

  it('a linked handle yields a summary even on its first counted message', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'discord', handle: 'd-9' });
    svc.link({ workspaceId: ctx.workspace.id, channelKind: 'discord', handle: 'd-9', userId: ctx.user.id });
    const linked = svc.resolve(ctx.workspace.id, 'discord', 'd-9');
    expect(linked?.peerKey).toBe(`user:${ctx.user.id}`);
  });

  it('list returns all identities for the workspace', () => {
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'whatsapp', handle: 'a' });
    svc.record({ workspaceId: ctx.workspace.id, channelKind: 'telegram', handle: 'b' });
    expect(svc.list(ctx.workspace.id)).toHaveLength(2);
  });
});
