import { describe, expect, it } from 'vitest';
import { REALTIME_EVENTS, REALTIME_ROOMS, type AppPresenceUpdate } from '@agentis/core';
import type { BusListener, EventBus } from '../../src/event-bus.js';
import { AppPresenceService, PRESENCE_TTL_MS } from '../../src/services/app/appPresence.js';
import { publishAppAgentActivity } from '../../src/services/agent/agentWorkProgress.js';

interface Captured { room: string; event: string; payload: unknown }

function fakeBus(): { bus: EventBus; events: Captured[] } {
  const events: Captured[] = [];
  const bus: EventBus = {
    publish(room, event, payload) { events.push({ room, event, payload }); },
    subscribe(_listener: BusListener) { return () => {}; },
  };
  return { bus, events };
}

describe('AppPresenceService (G9 co-presence)', () => {
  it('broadcasts the roster to the App + workspace rooms on join', () => {
    const { bus, events } = fakeBus();
    const presence = new AppPresenceService({ bus });
    const roster = presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u1', name: 'Maria', conversationId: 'c1' });

    expect(roster).toEqual([{ userId: 'u1', name: 'Maria', conversationId: 'c1', at: expect.any(String) }]);
    const presenceEvents = events.filter((e) => e.event === REALTIME_EVENTS.APP_PRESENCE_UPDATED);
    expect(presenceEvents.map((e) => e.room)).toEqual([REALTIME_ROOMS.app('app1'), REALTIME_ROOMS.workspace('ws1')]);
    expect((presenceEvents[0]!.payload as AppPresenceUpdate).viewers).toHaveLength(1);
  });

  it('keeps one entry per viewer and merges multiple viewers, sorted by name', () => {
    const { bus } = fakeBus();
    const presence = new AppPresenceService({ bus });
    presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u1', name: 'Zara' });
    presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u1', name: 'Zara', conversationId: 'c2' }); // same viewer, updated focus
    const roster = presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u2', name: 'Ana' });

    expect(roster.map((v) => v.name)).toEqual(['Ana', 'Zara']);
    expect(roster.find((v) => v.userId === 'u1')!.conversationId).toBe('c2');
  });

  it('leave drops a viewer and re-broadcasts', () => {
    const { bus, events } = fakeBus();
    const presence = new AppPresenceService({ bus });
    presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u1', name: 'Maria' });
    presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u2', name: 'Ana' });
    events.length = 0;

    const roster = presence.leave('app1', 'u1');
    expect(roster.map((v) => v.userId)).toEqual(['u2']);
    expect(events.some((e) => e.event === REALTIME_EVENTS.APP_PRESENCE_UPDATED)).toBe(true);
  });

  it('expires viewers past the TTL (heartbeat timeout)', () => {
    let now = 1_000_000;
    const { bus } = fakeBus();
    const presence = new AppPresenceService({ bus, now: () => now });
    presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u1', name: 'Maria' });
    expect(presence.roster('app1')).toHaveLength(1);

    now += PRESENCE_TTL_MS + 1;
    expect(presence.roster('app1')).toHaveLength(0);
  });

  it('is non-throwing without a bus (degrades to an in-memory roster)', () => {
    const presence = new AppPresenceService({});
    expect(() => presence.join({ workspaceId: 'ws1', appId: 'app1', userId: 'u1', name: 'Maria' })).not.toThrow();
    expect(presence.roster('app1')).toHaveLength(1);
  });
});

describe('publishAppAgentActivity (G9 agent thinking/typing)', () => {
  it('dual-publishes an activity payload to the App + workspace rooms', () => {
    const { bus, events } = fakeBus();
    publishAppAgentActivity(bus, { workspaceId: 'ws1', appId: 'app1', conversationId: 'c1', agentId: 'a1', state: 'thinking', label: 'considering the discount' });

    expect(events.map((e) => e.room)).toEqual([REALTIME_ROOMS.app('app1'), REALTIME_ROOMS.workspace('ws1')]);
    expect(events[0]!.event).toBe(REALTIME_EVENTS.APP_AGENT_ACTIVITY);
    expect(events[0]!.payload).toMatchObject({ appId: 'app1', conversationId: 'c1', agentId: 'a1', state: 'thinking', label: 'considering the discount' });
  });

  it('omits agentId/label when not provided and carries idle state', () => {
    const { bus, events } = fakeBus();
    publishAppAgentActivity(bus, { workspaceId: 'ws1', appId: 'app1', conversationId: 'c1', state: 'idle' });
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.state).toBe('idle');
    expect(payload.agentId).toBeUndefined();
    expect(payload.label).toBeUndefined();
  });
});
