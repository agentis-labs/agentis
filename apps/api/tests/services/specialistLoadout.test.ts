/**
 * Phase 3 — SpecialistLoadoutService.
 *
 * Loadouts bind abilities to a specialist role as required/preferred/optional/
 * forbidden DNA. Verifies upsert semantics, role normalization, and the
 * resolved lookup the engine applies at dispatch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { SpecialistLoadoutService } from '../../src/services/specialistLoadoutService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let loadouts: SpecialistLoadoutService;
let abilityA: string;
let abilityB: string;

function seedAbility(name: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.abilities).values({
    id,
    workspaceId: ctx.workspace.id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '_'),
    compileStatus: 'ready',
  }).run();
  return id;
}

beforeEach(async () => {
  ctx = await createTestContext();
  loadouts = new SpecialistLoadoutService(ctx.db);
  abilityA = seedAbility('Design Taste');
  abilityB = seedAbility('Legacy jQuery');
});

afterEach(() => ctx.close());

describe('SpecialistLoadoutService', () => {
  it('upserts a loadout entry and lists it for the role', () => {
    const e = loadouts.setEntry(ctx.workspace.id, 'frontend_architect', abilityA, { mode: 'required', priority: 5 });
    expect(e.mode).toBe('required');
    expect(e.priority).toBe(5);

    const list = loadouts.listForRole(ctx.workspace.id, 'frontend_architect');
    expect(list).toHaveLength(1);
    expect(list[0]!.abilityId).toBe(abilityA);

    // Upsert (not duplicate) on repeat.
    loadouts.setEntry(ctx.workspace.id, 'frontend_architect', abilityA, { mode: 'preferred' });
    const after = loadouts.listForRole(ctx.workspace.id, 'frontend_architect');
    expect(after).toHaveLength(1);
    expect(after[0]!.mode).toBe('preferred');
  });

  it('resolveForRole groups required / forbidden / preferred', () => {
    loadouts.setEntry(ctx.workspace.id, 'frontend_architect', abilityA, { mode: 'required' });
    loadouts.setEntry(ctx.workspace.id, 'frontend_architect', abilityB, { mode: 'forbidden' });
    const resolved = loadouts.resolveForRole(ctx.workspace.id, 'frontend_architect');
    expect(resolved.isEmpty).toBe(false);
    expect(resolved.required.has(abilityA)).toBe(true);
    expect(resolved.forbidden.has(abilityB)).toBe(true);
    expect(resolved.required.has(abilityB)).toBe(false);
  });

  it('normalizes legacy worker role and respects enabled flag', () => {
    loadouts.setEntry(ctx.workspace.id, 'worker', abilityA, { mode: 'required', enabled: false });
    // Stored under normalized "specialist" role.
    expect(loadouts.listForRole(ctx.workspace.id, 'specialist')).toHaveLength(1);
    // Disabled entries are excluded from the resolved lookup.
    const resolved = loadouts.resolveForRole(ctx.workspace.id, 'worker');
    expect(resolved.required.has(abilityA)).toBe(false);
    expect(resolved.isEmpty).toBe(true);
  });

  it('removeEntry deletes the binding', () => {
    loadouts.setEntry(ctx.workspace.id, 'frontend_architect', abilityA, { mode: 'required' });
    loadouts.removeEntry(ctx.workspace.id, 'frontend_architect', abilityA);
    expect(loadouts.listForRole(ctx.workspace.id, 'frontend_architect')).toHaveLength(0);
  });
});
