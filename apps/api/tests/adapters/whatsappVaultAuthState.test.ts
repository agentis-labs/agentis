/**
 * useVaultAuthState — vault-encrypted baileys auth state (OMNICHANNEL §3.4/§7).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@agentis/db/sqlite';
import { createTestContext, type TestContext } from '../_helpers/createTestContext.js';
import { useVaultAuthState, clearVaultAuthState } from '../../src/adapters/channels/whatsappVaultAuthState.js';

function seedConnection(ctx: TestContext): string {
  const agentId = randomUUID();
  ctx.db.insert(schema.agents).values({
    id: agentId, workspaceId: ctx.workspace.id, ambientId: ctx.ambient.id, userId: ctx.user.id,
    name: 'WA', adapterType: 'http',
  }).run();
  const id = randomUUID();
  ctx.db.insert(schema.channelConnections).values({
    id, workspaceId: ctx.workspace.id, userId: ctx.user.id, agentId,
    kind: 'whatsapp', name: 'WA', tokenEncrypted: ctx.vault.encrypt('x'), status: 'connecting',
  }).run();
  return id;
}

describe('useVaultAuthState', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestContext(); });
  afterEach(() => ctx.close());

  it('persists creds encrypted and reloads them without re-init', async () => {
    const connectionId = seedConnection(ctx);
    const { state, saveCreds } = await useVaultAuthState({ db: ctx.db, vault: ctx.vault, connectionId });
    expect(state.creds.registrationId).toBeGreaterThanOrEqual(0);
    await saveCreds();

    // Stored encrypted (not plaintext JSON), and decrypts back.
    const row = ctx.db.select().from(schema.channelAuthState)
      .where(eq(schema.channelAuthState.key, 'creds')).get()!;
    expect(row.valueEncrypted).toBeTruthy();
    expect(row.valueEncrypted).not.toContain('registrationId');

    // A fresh load reads the persisted creds (same registrationId), not a new init.
    const reloaded = await useVaultAuthState({ db: ctx.db, vault: ctx.vault, connectionId });
    expect(reloaded.state.creds.registrationId).toBe(state.creds.registrationId);
  });

  it('round-trips signal keys via set/get and deletes on null', async () => {
    const connectionId = seedConnection(ctx);
    const { state } = await useVaultAuthState({ db: ctx.db, vault: ctx.vault, connectionId });
    const keys = state.keys as {
      get: (t: string, ids: string[]) => Promise<Record<string, unknown>>;
      set: (d: Record<string, Record<string, unknown>>) => Promise<void>;
    };

    await keys.set({ 'pre-key': { '1': { keyPair: 'data-1' }, '2': { keyPair: 'data-2' } } });
    const got = await keys.get('pre-key', ['1', '2']);
    expect(got).toEqual({ '1': { keyPair: 'data-1' }, '2': { keyPair: 'data-2' } });

    // Setting a key to null removes it.
    await keys.set({ 'pre-key': { '1': null as unknown as Record<string, unknown> } });
    const after = await keys.get('pre-key', ['1', '2']);
    expect(after).toEqual({ '2': { keyPair: 'data-2' } });
  });

  it('clearVaultAuthState wipes creds + keys so the next load starts unregistered', async () => {
    const connectionId = seedConnection(ctx);
    const { state, saveCreds } = await useVaultAuthState({ db: ctx.db, vault: ctx.vault, connectionId });
    await saveCreds();
    const keys = state.keys as { set: (d: Record<string, Record<string, unknown>>) => Promise<void> };
    await keys.set({ 'pre-key': { '1': { keyPair: 'data-1' } } });
    expect(ctx.db.select().from(schema.channelAuthState).where(eq(schema.channelAuthState.connectionId, connectionId)).all().length)
      .toBeGreaterThan(0);

    clearVaultAuthState({ db: ctx.db, connectionId });

    expect(ctx.db.select().from(schema.channelAuthState).where(eq(schema.channelAuthState.connectionId, connectionId)).all()).toEqual([]);
    // A fresh load after clearing gets brand-new unregistered creds, not the
    // dead registered session — this is what lets baileys actually emit a QR
    // instead of silently retrying (and failing) the old link.
    const reloaded = await useVaultAuthState({ db: ctx.db, vault: ctx.vault, connectionId });
    expect(reloaded.state.creds.registrationId).not.toBe(state.creds.registrationId);
  });
});
