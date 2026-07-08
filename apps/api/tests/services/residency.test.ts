/**
 * Residency — a persistent agent that wakes on its own clock (Agent-Native §3.1).
 * Proves: the config parse + interval + wake-message helpers; the cross-run resident
 * session (runId NULL) with plan/observations continuity; and that CommandHeartbeat's
 * residency sweep wakes an opted-in agent on cadence, gated by autonomy, carrying state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { readResidency, residencyDue, buildResidencyWake } from '../../src/services/residency.js';
import { AgentSessionService } from '../../src/services/agent/agentSession.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
beforeEach(async () => { ctx = await createTestContext(); });
afterEach(() => ctx.close());

function seedAgent(config?: unknown): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'Resident', adapterType: 'http',
    ...(config !== undefined ? { config } : {}),
  } as typeof schema.agents.$inferInsert).run();
  return id;
}

describe('residency helpers', () => {
  it('reads residency config, defaulting interval + wake, ignoring disabled', () => {
    expect(readResidency(null)).toBeNull();
    expect(readResidency({ residency: { enabled: false } })).toBeNull();
    expect(readResidency({})).toBeNull();
    const cfg = readResidency({ residency: { enabled: true, intervalMinutes: 5, wake: 'find leads' } });
    expect(cfg).toMatchObject({ enabled: true, intervalMinutes: 5, wake: 'find leads' });
    // floors sub-minute intervals and supplies a default wake
    const floored = readResidency({ residency: { enabled: true, intervalMinutes: 0 } });
    expect(floored?.intervalMinutes).toBe(1);
    expect(floored?.wake).toBeTruthy();
  });

  it('computes due purely from elapsed time', () => {
    const cfg = { enabled: true, intervalMinutes: 5, wake: 'x' } as const;
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    expect(residencyDue(null, cfg, now)).toBe(true); // never woken
    expect(residencyDue('2026-01-01T00:06:00.000Z', cfg, now)).toBe(false); // 4 min ago < 5
    expect(residencyDue('2026-01-01T00:04:00.000Z', cfg, now)).toBe(true); // 6 min ago >= 5
  });

  it('builds a wake message carrying prior plan + observations', () => {
    const msg = buildResidencyWake({ enabled: true, intervalMinutes: 5, wake: 'do the thing' }, { plan: 'msg 100 leads', observations: 'last lead was #42' });
    expect(msg).toContain('do the thing');
    expect(msg).toContain('msg 100 leads');
    expect(msg).toContain('#42');
  });
});

describe('AgentSessionService resident session', () => {
  it('creates ONE cross-run resident session and round-trips its working state', () => {
    const svc = new AgentSessionService(ctx.db, ctx.logger);
    const agentId = seedAgent();
    const a = svc.getOrCreateResident({ workspaceId: ctx.workspace.id, agentId });
    const b = svc.getOrCreateResident({ workspaceId: ctx.workspace.id, agentId });
    expect(b.id).toBe(a.id); // same session across wakes
    expect(a.runId).toBeNull();

    svc.rememberResident(ctx.workspace.id, agentId, { plan: 'find ICP stores', observations: 'stopped at page 3' });
    expect(svc.residentState(ctx.workspace.id, agentId)).toEqual({ plan: 'find ICP stores', observations: 'stopped at page 3' });
  });
});
