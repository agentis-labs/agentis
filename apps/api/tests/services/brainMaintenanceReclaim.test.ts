import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { BrainCompressionService } from '../../src/services/brain/brainCompressionService.js';
import { BrainMaintenanceService } from '../../src/services/brain/brainMaintenanceService.js';
import { SessionMomentService } from '../../src/services/sessionMomentService.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let maintenance: BrainMaintenanceService;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  ctx = await createTestContext();
  const compression = new BrainCompressionService(ctx.db, ctx.logger);
  const sessionAtoms = new SessionMomentService(ctx.db, ctx.bus, ctx.logger);
  maintenance = new BrainMaintenanceService(ctx.db, ctx.bus, ctx.logger, compression, sessionAtoms);
});

afterEach(() => ctx.close());

/** Insert an episode already in an archived state `ageDays` in the past. */
function seedArchived(source: string, title: string, opts: { pinned?: boolean; ageDays?: number } = {}): string {
  const id = randomUUID();
  const when = new Date(Date.now() - (opts.ageDays ?? 400) * DAY).toISOString();
  ctx.db.insert(schema.memoryEpisodes).values({
    id,
    workspaceId: ctx.workspace.id,
    type: 'distilled_lesson',
    title,
    summary: `${title} — body text for the lesson.`,
    source,
    confidence: '0.6',
    importance: '0.5',
    trust: '0.6',
    status: 'archived',
    archivedAt: when,
    // mirror EpisodicMemoryStore.write's managed derivation
    managed: !['operator_write', 'seed', 'system_write'].includes(source),
    pinnedAt: opts.pinned ? when : null,
    createdAt: when,
    updatedAt: when,
  }).run();
  return id;
}

describe('§0.2 BrainMaintenanceService — disk reclamation', () => {
  it('hard-deletes long-archived managed atoms but spares operator-authored, pinned, and recent ones', () => {
    const managed = seedArchived('run_promotion', 'Auto-formed lesson'); // managed=true → reclaimable
    const operator = seedArchived('operator_write', 'Operator rule');     // managed=false → protected
    const pinned = seedArchived('run_promotion', 'Pinned lesson', { pinned: true }); // pinned → protected

    // A managed atom archived only recently (inside the grace window) must survive.
    const recent = seedArchived('run_promotion', 'Fresh archive', { ageDays: 1 });

    // Quality events: one beyond the retention window, one fresh.
    const oldEvent = randomUUID();
    ctx.db.insert(schema.brainQualityEvents).values({
      id: oldEvent, workspaceId: ctx.workspace.id, scopeId: null, agentId: null,
      eventType: 'atom_injected', atomId: null, abilityId: null, runId: null, delta: null, metadata: {},
      createdAt: new Date(Date.now() - 300 * DAY).toISOString(),
    }).run();

    const result = maintenance.runWorkspace(ctx.workspace.id);

    const exists = (id: string) => ctx.db.select({ id: schema.memoryEpisodes.id }).from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, id)).get();
    expect(exists(managed)).toBeUndefined();   // reclaimed
    expect(exists(operator)).toBeTruthy();      // operator-authored: never reclaimed
    expect(exists(pinned)).toBeTruthy();        // pinned: never reclaimed
    expect(exists(recent)).toBeTruthy();        // inside grace window
    expect(result.reclaimed.episodesDeleted).toBe(1);

    // The stale quality event is pruned; the maintenance run's own event remains.
    expect(ctx.db.select({ id: schema.brainQualityEvents.id }).from(schema.brainQualityEvents).where(eq(schema.brainQualityEvents.id, oldEvent)).get()).toBeUndefined();
    expect(result.reclaimed.eventsPruned).toBeGreaterThanOrEqual(1);
  });

  it('quarantines obvious managed import residue while protecting accessed, pinned, and operator memory', () => {
    const old = new Date(Date.now() - 45 * DAY).toISOString();
    const seed = (title: string, source: string, options: { managed?: boolean; pinned?: boolean; accessed?: boolean } = {}) => {
      const id = randomUUID();
      ctx.db.insert(schema.memoryEpisodes).values({
        id, workspaceId: ctx.workspace.id, type: 'distilled_lesson', title,
        summary: '`transform`/`filter` nodes, `browser` node (`browserPool`), evaluator…', source,
        confidence: '0.5', importance: '0.3', trust: '0.4', managed: options.managed ?? true,
        pinnedAt: options.pinned ? old : null, lastAccessedAt: options.accessed ? old : null,
        createdAt: old, updatedAt: old,
      }).run();
      return id;
    };
    const residue = seed('SCOPE/CAPTURE CORRECTNESS (B7, added after feedback…', 'harness_ingest');
    const accessed = seed('Accessed residue…', 'harness_ingest', { accessed: true });
    const pinned = seed('Pinned residue…', 'harness_ingest', { pinned: true });
    const operator = seed('Operator-authored residue…', 'operator_write', { managed: false });

    const preview = maintenance.previewHygiene(ctx.workspace.id);
    expect(preview.find((item) => item.id === residue)?.recommendation).toBe('archive');
    const result = maintenance.runWorkspace(ctx.workspace.id);
    expect(result.lowQualityArchived).toBeGreaterThanOrEqual(1);
    const state = (id: string) => ctx.db.select({ status: schema.memoryEpisodes.status }).from(schema.memoryEpisodes).where(eq(schema.memoryEpisodes.id, id)).get()?.status;
    expect(state(residue)).toBe('archived');
    expect(state(accessed)).toBe('active');
    expect(state(pinned)).toBe('active');
    expect(state(operator)).toBe('active');
  });
});
