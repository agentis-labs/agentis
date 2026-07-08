/**
 * Layer 2 — SpecialistAgentService.
 *
 * Verifies built-in specialist seeding is disabled and custom roles still
 * resolve to concrete agentIds carrying that role.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { SpecialistAgentService } from '../../src/services/specialist/specialistAgents.js';
import { AgentLibraryService } from '../../src/services/agent/agentLibrary.js';
import { WorkspaceVolumeService } from '../../src/services/workspace/workspaceVolume.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let specialists: SpecialistAgentService;
let library: AgentLibraryService;
let dataDir: string;

beforeEach(async () => {
  ctx = await createTestContext();
  dataDir = await mkdtemp(path.join(tmpdir(), 'agentis-spec-'));
  library = new AgentLibraryService(new WorkspaceVolumeService(dataDir));
  specialists = new SpecialistAgentService(ctx.db, library);
});

afterEach(async () => {
  ctx.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('SpecialistAgentService', () => {
  it('does not seed built-in specialists', () => {
    const first = specialists.ensureAll(ctx.workspace.id, ctx.user.id);
    expect(first).toHaveLength(0);

    const second = specialists.ensureAll(ctx.workspace.id, ctx.user.id);
    expect(second).toHaveLength(0);

    const rows = ctx.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, ctx.workspace.id)).all();
    expect(rows).toHaveLength(0);
  });

  it('ensureRole creates on demand and is stable across calls', () => {
    const a = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'writer');
    const b = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'writer');
    expect(a).toBe(b);
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, a)).get();
    expect(row?.role).toBe('writer');
    expect(row?.instructions).toMatch(/Writer/);
    expect((row?.config as { specialist?: boolean })?.specialist).toBe(true);
  });

  it('resolveRole returns null before seeding, id after', () => {
    expect(specialists.resolveRole(ctx.workspace.id, 'reviewer')).toBeNull();
    const id = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'reviewer');
    expect(specialists.resolveRole(ctx.workspace.id, 'reviewer')).toBe(id);
  });

  it('defForRole resolves every role through custom/library data or generic fallback', () => {
    expect(specialists.defForRole(ctx.workspace.id, 'coder').source).toBe('generated');
    expect(specialists.defForRole(ctx.workspace.id, 'coder').systemPrompt).toMatch(/specialist/i);

    // An unknown custom role never throws — it synthesizes a generic specialist.
    const generic = specialists.defForRole(ctx.workspace.id, 'frontend_architect');
    expect(generic.source).toBe('generated');
    expect(generic.name).toBe('Frontend Architect');
    expect(generic.systemPrompt).toMatch(/specialist/i);
  });

  it('ensureRole materializes a custom role without a hardcoded definition', () => {
    const id = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'tax_analyst');
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
    expect(row?.role).toBe('tax_analyst');
    expect(row?.name).toBe('Tax Analyst');
    expect((row?.config as { specialist?: boolean })?.specialist).toBe(true);
    // Stable across calls.
    expect(specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'tax_analyst')).toBe(id);
  });

  it('normalizes legacy "worker" role to "specialist"', () => {
    const id = specialists.ensureRole(ctx.workspace.id, ctx.user.id, 'worker');
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
    expect(row?.role).toBe('specialist');
    expect(specialists.resolveRole(ctx.workspace.id, 'worker')).toBe(id);
  });

  it('authorSpecialist persists a library def and upserts the agent row', async () => {
    const { agentId, role, created, def } = await specialists.authorSpecialist(ctx.workspace.id, ctx.user.id, {
      name: 'Frontend Architect',
      description: 'Owns the React design system and visual quality.',
      instructions: 'You are the Frontend Architect. Guard the design system.',
      capabilityTags: ['frontend', 'design-systems'],
      source: 'custom',
    });
    expect(role).toBe('frontend_architect');
    expect(created).toBe(true);
    expect(def.source).toBe('custom');

    // Library file persisted + cache warm so the engine resolves the rich def.
    expect(library.getByRoleSync(ctx.workspace.id, 'frontend_architect')?.name).toBe('Frontend Architect');
    const resolved = specialists.defForRole(ctx.workspace.id, 'frontend_architect');
    expect(resolved.systemPrompt).toMatch(/Guard the design system/);

    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    expect(row?.instructions).toMatch(/Guard the design system/);

    // Re-authoring updates the same row (idempotent upsert).
    const again = await specialists.authorSpecialist(ctx.workspace.id, ctx.user.id, {
      role: 'frontend_architect',
      instructions: 'Updated mandate: also own accessibility.',
      source: 'custom',
    });
    expect(again.agentId).toBe(agentId);
    expect(again.created).toBe(false);
    const updated = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    expect(updated?.instructions).toMatch(/accessibility/);
  });
});
