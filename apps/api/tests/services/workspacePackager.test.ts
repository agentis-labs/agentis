/**
 * WorkspacePackager round-trip tests — the `.agentis` whole-workspace bundle.
 *
 * Proves the spine: a `share` export captures every entity, NEVER leaks secret
 * values (only credential slots), and re-imports into a fresh workspace; the
 * envelope is tamper-evident; `sell` blocks when the payload carries a secret;
 * and install refuses without an explicit permission acknowledgement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { AppStore, AppDatastore, AppSurfaceStore } from '@agentis/app';
import { WorkspacePackager } from '../../src/services/workspacePackager.js';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';

const SECRET_VALUE = 'cipher-AKIAEXAMPLE-do-not-travel';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'; // matches the scanner's aws-access-key rule

// Mirror of the packager's canonical checksum (stable key-sorted JSON → sha256),
// so a test can forge a manifest WITH a matching checksum to exercise signature checks.
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`;
}
function stableSha(manifest: unknown): string {
  return createHash('sha256').update(stableJson(manifest)).digest('hex');
}

function seedAgent(ctx: TestContext, workspaceId: string, name: string, instructions = ''): void {
  ctx.db.insert(schema.agents).values({
    id: randomUUID(),
    workspaceId,
    userId: ctx.user.id,
    name,
    adapterType: 'codex',
    capabilityTags: ['sales'],
    config: {},
    status: 'offline',
    colorHex: '#888888',
    instructions: instructions || null,
    role: 'specialist',
  }).run();
}

function makeWorkspace(ctx: TestContext, slug: string): string {
  const id = randomUUID();
  ctx.db.insert(schema.workspaces).values({ id, userId: ctx.user.id, name: `WS ${slug}`, slug }).run();
  return id;
}

describe('WorkspacePackager', () => {
  let ctx: TestContext;
  let packager: WorkspacePackager;

  beforeEach(async () => {
    ctx = await createTestContext();
    packager = new WorkspacePackager({ db: ctx.db, logger: ctx.logger });
  });
  afterEach(() => { ctx.close(); });

  function seedRichWorkspace(workspaceId: string): { appId: string } {
    seedAgent(ctx, workspaceId, 'Sales Bot');
    // A bare workflow (no owning app).
    ctx.db.insert(schema.workflows).values({
      id: randomUUID(), workspaceId, userId: ctx.user.id, title: 'Nightly digest',
      graph: { version: 1, nodes: [], edges: [] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    // An extension.
    ctx.db.insert(schema.extensions).values({
      id: randomUUID(), workspaceId, userId: ctx.user.id, name: 'CSV tool', slug: 'csv-tool', version: '1.0.0',
      runtime: 'node_worker', manifest: { name: 'CSV tool', slug: 'csv-tool', version: '1.0.0', runtime: 'node_worker', operations: [{ name: 'execute', inputSchema: {}, outputSchema: {} }] },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    // A credential — its VALUE must never travel.
    ctx.db.insert(schema.credentials).values({
      id: randomUUID(), workspaceId, userId: ctx.user.id, name: 'stripe', credentialType: 'api_key', encryptedValue: SECRET_VALUE,
    }).run();
    // An app with a surface + a collection (schema only travels).
    const app = new AppStore(ctx.db).create(workspaceId, ctx.user.id, { name: 'Store', description: 'Shop' });
    new AppDatastore(ctx.db).defineCollection(workspaceId, app.id, {
      name: 'orders', schema: { fields: [{ key: 'total', type: 'number', required: true }] },
    });
    new AppSurfaceStore({ db: ctx.db }).upsert(workspaceId, app.id, {
      name: 'Home', kind: 'page', view: null, actions: [],
    });
    return { appId: app.id };
  }

  it('share export captures every entity and never leaks secret values', () => {
    seedRichWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share');

    expect(envelope.format).toBe('.agentis');
    expect(envelope.profile).toBe('share');
    expect(envelope.manifest.agents).toHaveLength(1);
    expect(envelope.manifest.apps).toHaveLength(1);
    expect(envelope.manifest.workflows).toHaveLength(1); // bare workflow only
    expect(envelope.manifest.extensions).toHaveLength(1);
    expect(envelope.manifest.apps[0]?.collections).toHaveLength(1);

    // Credential travels as a SLOT (requirement), never the encrypted value.
    expect(envelope.manifest.credentialSlots).toEqual([
      expect.objectContaining({ key: 'stripe', service: 'api_key' }),
    ]);
    expect(JSON.stringify(envelope)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(envelope)).not.toContain('encryptedValue');
  });

  it('re-imports a share bundle into a fresh workspace', () => {
    seedRichWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share');

    const targetWs = makeWorkspace(ctx, 'imported');
    const result = packager.installBundle(
      { workspaceId: targetWs, ambientId: null, userId: ctx.user.id },
      envelope,
      { permissionsAcknowledged: true },
    );

    expect(result.agents).toBe(1);
    expect(result.apps).toBe(1);
    expect(result.requiredCredentials).toEqual([expect.objectContaining({ key: 'stripe' })]);

    // Entities really landed in the target workspace.
    const agents = ctx.db.select().from(schema.agents).where(eq(schema.agents.workspaceId, targetWs)).all();
    expect(agents.map((a) => a.name)).toContain('Sales Bot');
    const bareWfs = ctx.db.select().from(schema.workflows)
      .where(and(eq(schema.workflows.workspaceId, targetWs), isNull(schema.workflows.appId))).all();
    expect(bareWfs.map((w) => w.title)).toContain('Nightly digest');
    const apps = new AppStore(ctx.db).list(targetWs);
    expect(apps.map((a) => a.name)).toContain('Store');
    const cols = new AppDatastore(ctx.db).listCollections(targetWs, apps[0]!.id);
    expect(cols.map((c) => c.name)).toContain('orders');

    // No secret leaked into the target.
    const creds = ctx.db.select().from(schema.credentials).where(eq(schema.credentials.workspaceId, targetWs)).all();
    expect(creds).toHaveLength(0);
  });

  it('rejects a tampered envelope on deserialize', () => {
    seedRichWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share');
    const tampered = structuredClone(envelope);
    tampered.manifest.agents[0]!.name = 'Evil Bot';
    expect(() => packager.deserialize(tampered)).toThrowError(/checksum mismatch/);
  });

  it('refuses to install without permissionsAcknowledged', () => {
    seedRichWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share');
    expect(() => packager.installBundle(
      { workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id },
      envelope,
      { permissionsAcknowledged: false },
    )).toThrowError(/permissionsAcknowledged/);
  });

  it('blocks a sell export when the payload carries a secret (scrub gate)', () => {
    const sellWs = makeWorkspace(ctx, 'forsale');
    seedAgent(ctx, sellWs, 'Leaky Bot', `Use this key: ${AWS_KEY}`);
    expect(() => packager.exportWorkspace(sellWs, 'sell')).toThrowError(/cannot sell/);
    // The same workspace exports fine as a share bundle (no scrub gate there).
    expect(() => packager.exportWorkspace(sellWs, 'share')).not.toThrow();
  });

  it('signs a sell bundle and verifies it; rejects a re-checksummed tamper', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const signing = new WorkspacePackager({ db: ctx.db, logger: ctx.logger, signer: { privateKeyPem: privateKey, publicKeyPem: publicKey } });
    const sellWs = makeWorkspace(ctx, 'signed');
    seedAgent(ctx, sellWs, 'Clean Bot'); // no secrets → passes the sell scrub gate

    const envelope = signing.exportWorkspace(sellWs, 'sell');
    expect(envelope.signature).toBeTruthy();
    expect(envelope.signerPublicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(() => signing.deserialize(envelope)).not.toThrow();

    // A tamperer who edits the manifest AND fixes the checksum still fails the signature.
    const forged = structuredClone(envelope);
    forged.manifest.agents[0]!.name = 'Hijacked Bot';
    forged.checksum = stableSha(forged.manifest);
    expect(() => signing.deserialize(forged)).toThrowError(/signature verification failed/);
  });

  it('refuses to install a backup-profile bundle through the manifest path', () => {
    seedRichWorkspace(ctx.workspace.id);
    const envelope = packager.exportWorkspace(ctx.workspace.id, 'share');
    const asBackup = { ...envelope, profile: 'backup' as const };
    expect(() => packager.installBundle(
      { workspaceId: ctx.workspace.id, ambientId: null, userId: ctx.user.id },
      asBackup,
      { permissionsAcknowledged: true },
    )).toThrowError(/backup/);
  });
});
