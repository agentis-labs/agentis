/**
 * Intelligence-carrying export/import — the "share intelligence" feature.
 *
 * Proves that a `full`-fidelity bundle carries LEARNED STATE the legacy bundle
 * dropped: Brain atoms (agent + App + workspace scope) and collection ROW data,
 * plus the owning agent relinked WITHOUT detaching it from the org chart; that
 * `shareable` structurally carries none of it even when the selection asks; that
 * no embeddings or secret values ever travel; and that legacy bundles still
 * install unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore, AppDatastore, AppPackager } from '@agentis/app';
import { WorkspacePackager } from '../../src/services/workspace/workspacePackager.js';
import { EpisodicMemoryStore } from '../../src/services/episodicMemoryStore.js';
import { EpisodicBrainPort, exportBrainForScope } from '../../src/services/brain/brainExport.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

let ctx: TestContext;
let episodes: EpisodicMemoryStore;
let packager: WorkspacePackager;

beforeEach(async () => {
  ctx = await createTestContext();
  episodes = new EpisodicMemoryStore(ctx.db, ctx.logger);
  packager = new WorkspacePackager({ db: ctx.db, logger: ctx.logger, episodes });
});
afterEach(() => ctx.close());

function makeWorkspace(slug: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workspaces).values({ id, userId: ctx.user.id, name: `WS ${slug}`, slug }).run();
  return id;
}

function seedAgent(workspaceId: string, name: string, extra: Partial<typeof schema.agents.$inferInsert> = {}): string {
  const id = randomUUID();
  ctx.db.insert(schema.agents).values({
    id, workspaceId, userId: ctx.user.id, name, adapterType: 'codex',
    capabilityTags: ['sales'], config: {}, status: 'offline', role: 'specialist', ...extra,
  }).run();
  return id;
}

/** A workspace with an App owned by an agent, both carrying learned memory + rows. */
function seedIntelligentWorkspace(workspaceId: string): { appId: string; ownerId: string } {
  const ownerId = seedAgent(workspaceId, 'Sales Bot');
  const store = new AppStore(ctx.db);
  const app = store.create(workspaceId, ctx.user.id, { name: 'Store', description: 'Shop' });
  store.update(workspaceId, app.id, { ownerAgentId: ownerId });
  store.addMember(workspaceId, app.id, ownerId, 'operator');

  const data = new AppDatastore(ctx.db);
  data.defineCollection(workspaceId, app.id, { name: 'orders', schema: { fields: [{ key: 'total', type: 'number', required: true }] } });
  data.insert(workspaceId, app.id, 'orders', { total: 42 });
  data.insert(workspaceId, app.id, 'orders', { total: 99 });

  // Learned memory at three scopes.
  episodes.write({ workspaceId, scopeId: ownerId, agentId: ownerId, type: 'distilled_lesson', title: 'Agent lesson', summary: 'Always greet the customer by name.', source: 'agent_write', tags: ['agent_private'] });
  episodes.write({ workspaceId, scopeId: app.id, type: 'success_pattern', title: 'App pattern', summary: 'Orders over $50 convert best on Fridays.', source: 'run_promotion', tags: ['app'] });
  episodes.write({ workspaceId, scopeId: null, type: 'observation', title: 'WS memory', summary: 'The brand voice is warm and concise.', source: 'operator_write', tags: ['plane:workspace_memory'] });
  return { appId: app.id, ownerId };
}

describe('Intelligence bundle — full fidelity', () => {
  it('carries agent + App + workspace brains and collection rows, and re-imports them', () => {
    seedIntelligentWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share', { fidelity: 'full' });

    // Manifest carries the learned state.
    expect(envelope.fidelity).toBe('full');
    expect(envelope.manifest.agents[0]?.brain?.atoms).toHaveLength(1);
    expect(envelope.manifest.workspaceBrain?.atoms).toHaveLength(1);
    const appManifest = envelope.manifest.apps[0]!;
    expect(appManifest.brain?.atoms).toHaveLength(1);
    expect(appManifest.collections[0]?.seed).toHaveLength(2);
    // The App carries its owner as a linked agent.
    expect(appManifest.agents.some((a) => a.owner && a.name === 'Sales Bot')).toBe(true);

    // Re-import into a fresh workspace.
    const target = makeWorkspace('imported');
    const result = packager.installBundle(
      { workspaceId: target, ambientId: null, userId: ctx.user.id },
      envelope,
      { permissionsAcknowledged: true },
    );
    expect(result.collectionRows).toBe(2);
    expect(result.brainAtoms).toBe(3); // agent + app + workspace

    // Rows really landed.
    const apps = new AppStore(ctx.db).list(target);
    const store = new AppStore(ctx.db);
    const importedApp = apps.find((a) => a.name === 'Store')!;
    const rows = new AppDatastore(ctx.db).query(target, importedApp.id, 'orders', { limit: 50 }).rows;
    expect(rows.map((r) => r.data.total).sort()).toEqual([42, 99]);

    // Owner relinked to the imported agent.
    const importedOwner = ctx.db.select().from(schema.agents).where(and(eq(schema.agents.workspaceId, target), eq(schema.agents.name, 'Sales Bot'))).get();
    expect(store.get(target, importedApp.id).ownerAgentId).toBe(importedOwner!.id);

    // Brain atoms landed at the right scopes.
    expect(exportBrainForScope(episodes, target, importedOwner!.id)).toHaveLength(1);
    expect(exportBrainForScope(episodes, target, importedApp.id)).toHaveLength(1);
    expect(exportBrainForScope(episodes, target, null)).toHaveLength(1);
  });

  it('never carries embeddings or secret values in a full bundle', () => {
    seedIntelligentWorkspace(ctx.workspace.id);
    ctx.db.insert(schema.credentials).values({ id: randomUUID(), workspaceId: ctx.workspace.id, userId: ctx.user.id, name: 'stripe', credentialType: 'api_key', encryptedValue: 'cipher-secret-xyz' }).run();
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share', { fidelity: 'full' });
    const json = JSON.stringify(envelope);
    expect(json).not.toContain('cipher-secret-xyz');
    expect(json).not.toContain('encryptedValue');
    expect(json).not.toContain('"embedding"');
  });
});

describe('Intelligence bundle — structural enforcement', () => {
  it('shareable carries no brains or rows even when the selection asks', () => {
    seedIntelligentWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share', {
      fidelity: 'shareable',
      selection: { includeAgentBrains: true, includeAppBrains: true, includeWorkspaceBrain: true, includeCollectionData: true },
    });
    expect(envelope.fidelity).toBe('shareable');
    expect(envelope.manifest.agents[0]?.brain).toBeUndefined();
    expect(envelope.manifest.workspaceBrain).toBeUndefined();
    expect(envelope.manifest.apps[0]?.brain).toBeUndefined();
    expect(envelope.manifest.apps[0]?.collections[0]?.seed).toHaveLength(0);
    // But the agent DEFINITION (and its App linkage) still travels.
    expect(envelope.manifest.apps[0]?.agents.some((a) => a.name === 'Sales Bot')).toBe(true);
  });

  it('selection narrows a full bundle — excluding collection data drops the rows only', () => {
    seedIntelligentWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share', {
      fidelity: 'full',
      selection: { includeCollectionData: false },
    });
    expect(envelope.manifest.apps[0]?.collections[0]?.seed).toHaveLength(0);
    // Brains still travel (not excluded).
    expect(envelope.manifest.workspaceBrain?.atoms).toHaveLength(1);
  });
});

describe('Intelligence bundle — owner relink safety', () => {
  it('adopting an existing agent as App owner does not clear its reportsTo (no staffApp detach)', () => {
    const { appId } = seedIntelligentWorkspace(ctx.workspace.id);
    const appPackager = new AppPackager(ctx.db);
    const manifest = appPackager.toManifest(ctx.workspace.id, appId, { fidelity: 'full', brain: new EpisodicBrainPort(episodes) });

    // Target workspace already has the owner agent, wired into an org chart.
    const target = makeWorkspace('target');
    const manager = seedAgent(target, 'Manager', { role: 'manager' });
    const existingOwner = seedAgent(target, 'Sales Bot', { reportsTo: manager });
    const nameMap = new Map<string, string>([['Sales Bot', existingOwner]]);

    const { appId: newAppId } = appPackager.fromManifest(target, ctx.user.id, manifest, {
      brain: new EpisodicBrainPort(episodes),
      agentNameToId: nameMap,
    });

    // Owner relinked to the EXISTING agent…
    expect(new AppStore(ctx.db).get(target, newAppId).ownerAgentId).toBe(existingOwner);
    // …and that agent's org-chart wiring is intact (the staffApp bug would null it).
    const row = ctx.db.select().from(schema.agents).where(eq(schema.agents.id, existingOwner)).get();
    expect(row!.reportsTo).toBe(manager);
    // No duplicate agent was created.
    const sameName = ctx.db.select().from(schema.agents).where(and(eq(schema.agents.workspaceId, target), eq(schema.agents.name, 'Sales Bot'))).all();
    expect(sameName).toHaveLength(1);
  });
});

describe('Intelligence bundle — back-compat', () => {
  it('installs a legacy manifest with no fidelity/brain/seed fields', () => {
    const legacyOwner = seedAgent(ctx.workspace.id, 'Legacy Bot');
    void legacyOwner;
    // A shareable export IS the legacy shape (no brains/rows, fidelity defaults).
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share');
    // Strip the new self-describing fields to mimic a pre-feature file.
    const legacy = structuredClone(envelope);
    delete (legacy as { fidelity?: unknown }).fidelity;
    delete (legacy.manifest as { fidelity?: unknown }).fidelity;
    delete (legacy.manifest as { bundleContentVersion?: unknown }).bundleContentVersion;

    const target = makeWorkspace('legacy-target');
    const result = packager.installBundle(
      { workspaceId: target, ambientId: null, userId: ctx.user.id },
      legacy,
      { permissionsAcknowledged: true },
    );
    expect(result.brainAtoms).toBe(0);
    expect(result.collectionRows).toBe(0);
    expect(result.agents).toBe(1);
  });
});

describe('brainExport — lossless projection', () => {
  it('maps an episode to a portable atom without id/scope/embedding, and filters workspace scope by tag', () => {
    const agentId = seedAgent(ctx.workspace.id, 'Mapper Bot');
    episodes.write({ workspaceId: ctx.workspace.id, scopeId: agentId, agentId, type: 'decision', title: 'T', summary: 'S', details: 'D', source: 'agent_write', confidence: 0.8, importance: 0.6, trust: 0.7, tags: ['x'], entities: ['e1'], outcomeStatus: 'good' });
    // A workspace-scoped run lesson WITHOUT the plane tag must be excluded.
    episodes.write({ workspaceId: ctx.workspace.id, scopeId: null, type: 'failure', title: 'noise', summary: 'run noise', source: 'run_promotion', tags: ['run'] });
    episodes.write({ workspaceId: ctx.workspace.id, scopeId: null, type: 'observation', title: 'keep', summary: 'brand voice', source: 'operator_write', tags: ['plane:workspace_memory'] });

    const [atom] = exportBrainForScope(episodes, ctx.workspace.id, agentId);
    expect(atom).toMatchObject({ type: 'decision', title: 'T', summary: 'S', details: 'D', confidence: 0.8, tags: ['x'], entities: ['e1'], outcomeStatus: 'good' });
    expect(atom).not.toHaveProperty('id');
    expect(atom).not.toHaveProperty('scopeId');
    expect(atom).not.toHaveProperty('embedding');

    const wsAtoms = exportBrainForScope(episodes, ctx.workspace.id, null);
    expect(wsAtoms.map((a) => a.title)).toEqual(['keep']);
  });
});
