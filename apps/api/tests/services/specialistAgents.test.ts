/**
 * Layer 2 — SpecialistAgentService.
 *
 * Verifies the built-in specialist library seeds idempotently into a workspace
 * and resolves an AgentRole to a concrete agentId carrying that role.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SPECIALIST_AGENTS } from '@agentis/core';
import { schema } from '@agentis/db/sqlite';
import { SpecialistAgentService } from '../../src/services/specialistAgents.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let specialists: SpecialistAgentService;

beforeEach(async () => {
  ctx = await createTestContext();
  specialists = new SpecialistAgentService(ctx.db);
});

afterEach(() => ctx.close());

describe('SpecialistAgentService', () => {
  it('seeds every built-in specialist exactly once (idempotent)', () => {
    const first = specialists.ensureAll(ctx.workspace.id, ctx.user.id);
    expect(first).toHaveLength(SPECIALIST_AGENTS.length);

    const second = specialists.ensureAll(ctx.workspace.id, ctx.user.id);
    expect(second).toHaveLength(0); // already present

    const rows = ctx.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspace.id)).all();
    expect(rows.filter((r) => r.role && SPECIALIST_AGENTS.some((s) => s.role === r.role))).toHaveLength(SPECIALIST_AGENTS.length);
  });

  it('ensureRole creates on demand and is stable across calls', () => {
    const a = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'writer');
    const b = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'writer');
    expect(a).toBe(b);
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, a)).get();
    expect(row?.role).toBe('writer');
    expect(row?.instructions).toMatch(/Content Writer/);
    expect((row?.config as { specialist?: boolean })?.specialist).toBe(true);
  });

  it('resolveRole returns null before seeding, id after', () => {
    expect(specialists.resolveRole(ctx.workspace.id, 'reviewer')).toBeNull();
    const id = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'reviewer');
    expect(specialists.resolveRole(ctx.workspace.id, 'reviewer')).toBe(id);
  });
});
