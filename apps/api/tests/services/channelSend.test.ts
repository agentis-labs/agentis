/**
 * channelSend — the shared resolve→authorize→deliver flow behind both
 * agentis.channel.send AND the deterministic `channel` workflow node. Proves the
 * node can actually reach a channel (the gap: "deterministic first contact"
 * workflows could compute a message but never send it).
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveAndSend, type ChannelSendDeps } from '../../src/services/conversation/channelSend.js';

type Conn = { id: string; kind: string; name: string; status: string; agentId?: string | null; defaultChatId?: string | null; targetAliases?: unknown; isDefault?: boolean; health: { status: string } };

function fakeDeps(connections: Conn[], opts: { deliver?: () => Promise<void>; destChatId?: string | null; authorize?: (a: unknown) => { ok: boolean; reason?: string } } = {}): { deps: ChannelSendDeps; deliver: ReturnType<typeof vi.fn> } {
  const deliver = vi.fn(opts.deliver ?? (async () => {}));
  const deps = {
    channels: {
      list: () => connections as never,
      resolveDestination: () => ({ chatId: opts.destChatId === undefined ? 'chat-1' : opts.destChatId, source: 'default' as const }),
      deliverToConnection: deliver as never,
      // Mirror ChannelBridge.defaultConnectionFor: the flagged default, else the sole active.
      defaultConnectionFor: (_ws: string, kind: string) => {
        const active = connections.filter((c) => c.kind === kind && c.status === 'active');
        const flagged = active.find((c) => c.isDefault);
        return flagged ? flagged.id : active.length === 1 ? active[0]!.id : null;
      },
    },
    ...(opts.authorize ? { connectionGrants: { authorize: opts.authorize as never } } : {}),
  } as ChannelSendDeps;
  return { deps, deliver };
}

const wa = (over: Partial<Conn> = {}): Conn => ({ id: 'wa1', kind: 'whatsapp', name: 'WhatsApp', status: 'active', agentId: 'owner-agent', defaultChatId: '+551199', health: { status: 'ok' }, ...over });

describe('resolveAndSend', () => {
  it('resolves the single active WhatsApp connection by kind and delivers', async () => {
    const { deps, deliver } = fakeDeps([wa()]);
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', to: '+5511888' });
    expect(res.sent).toBe(true);
    if (res.sent) { expect(res.connectionId).toBe('wa1'); expect(res.kind).toBe('whatsapp'); }
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('fails (no send) when no connection of the kind exists — the exact "workflow claims a send with no connection" case', async () => {
    const { deps, deliver } = fakeDeps([]);
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', to: '+55' });
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.errorCode).toBe('CHANNEL_TARGET_AMBIGUOUS_OR_MISSING');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('is ambiguous when >1 active connection of the kind and NO default set', async () => {
    const { deps, deliver } = fakeDeps([wa({ id: 'a' }), wa({ id: 'b' })]);
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', to: '+55' });
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.error).toMatch(/default/i);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('resolves to the DEFAULT connection when >1 of the kind and one is flagged (the deterministic-send fix)', async () => {
    const { deps, deliver } = fakeDeps([wa({ id: 'a' }), wa({ id: 'b', isDefault: true }), wa({ id: 'c' })]);
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', to: '+55' });
    expect(res.sent).toBe(true);
    if (res.sent) expect(res.connectionId).toBe('b');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('blocks an agent without a grant on an OWNED connection (§3.3), but a system caller passes', async () => {
    const authorize = () => ({ ok: false, reason: 'no grant' });
    const blocked = await resolveAndSend(fakeDeps([wa()], { authorize }).deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', agentId: 'agent-x' });
    expect(blocked.sent).toBe(false);
    if (!blocked.sent) expect(blocked.errorCode).toBe('CONNECTION_SCOPE_MISSING');

    const system = fakeDeps([wa()], { authorize });
    const passed = await resolveAndSend(system.deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', agentId: null });
    expect(passed.sent).toBe(true);
    expect(system.deliver).toHaveBeenCalledOnce();
  });

  it('a WORKSPACE-owned connection (agentId null) is open when no grant service is wired', async () => {
    const { deps, deliver } = fakeDeps([wa({ agentId: null })]); // no `authorize` option → connectionGrants undefined
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', agentId: 'any-agent' });
    expect(res.sent).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('a WORKSPACE-owned connection IS gated once an operator issues grants on it (restrict the global instance)', async () => {
    const authorize = () => ({ ok: false, reason: 'no grant' });
    const { deps, deliver } = fakeDeps([wa({ agentId: null })], { authorize });
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi', agentId: 'any-agent' });
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.errorCode).toBe('CONNECTION_SCOPE_MISSING');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('fails when the connection has no destination', async () => {
    const { deps, deliver } = fakeDeps([wa()], { destChatId: null });
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: 'Oi' });
    expect(res.sent).toBe(false);
    if (!res.sent) expect(res.errorCode).toBe('CHANNEL_DEFAULT_TARGET_MISSING');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('requires a body or attachment', async () => {
    const { deps } = fakeDeps([wa()]);
    const res = await resolveAndSend(deps, { workspaceId: 'w', kind: 'whatsapp', body: '' });
    expect(res.sent).toBe(false);
  });
});
