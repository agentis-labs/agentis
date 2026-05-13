import { describe, expect, it } from 'vitest';
import { buildRoomRoutes } from '../../src/routes/rooms.js';
import { createTestContext } from '../_helpers/createTestContext.js';

describe('/v1/rooms mentions', () => {
  it('lists explicit and text mentions for the current operator', async () => {
    const ctx = await createTestContext();
    const app = ctx.buildApp([
      { path: '/v1/rooms', app: buildRoomRoutes({ db: ctx.db, auth: ctx.auth, bus: ctx.bus }) },
    ]);
    try {
      const created = await app.request('/v1/rooms', {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({ name: 'Ops', kind: 'custom', visibility: 'workspace', agentIds: [] }),
      });
      expect(created.status).toBe(201);
      const { room } = (await created.json()) as { room: { id: string; name: string } };

      await app.request(`/v1/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          authorType: 'agent',
          contentType: 'text',
          content: { text: 'Explicit ping' },
          mentions: [ctx.user.id],
        }),
      });
      await app.request(`/v1/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          authorType: 'system',
          contentType: 'text',
          content: { text: '@operator please review this run' },
        }),
      });
      await app.request(`/v1/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: ctx.authHeaders,
        body: JSON.stringify({
          authorType: 'operator',
          contentType: 'text',
          content: { text: '@operator self ping' },
          mentions: [ctx.user.id],
        }),
      });

      const res = await app.request('/v1/rooms/mentions?limit=10', { headers: ctx.authHeaders });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mentions: Array<{ roomName: string; content: { text?: string } }> };
      expect(body.mentions.map((mention) => mention.roomName)).toEqual(['Ops', 'Ops']);
      expect(body.mentions.map((mention) => mention.content.text).sort()).toEqual([
        '@operator please review this run',
        'Explicit ping',
      ].sort());
    } finally {
      ctx.close();
    }
  });
});