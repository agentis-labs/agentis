/**
 * BrowserAuthStateStore — encrypted, workspace-scoped "log in once" profiles
 * (BROWSERPOOL-10X §Auth). Verifies the storageState round-trips through the
 * vault, is encrypted at rest, and never leaks across workspaces.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openSqlite, schema, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import { CredentialVault } from '../../src/services/credentialVault.js';
import { BrowserAuthStateStore } from '../../src/services/browser/browserAuthStateStore.js';

let db: AgentisSqliteDb;
let store: BrowserAuthStateStore;

const sampleState = () => ({ cookies: [{ name: 'session', value: 'abc123', domain: 'example.com' }], origins: [] });

beforeEach(() => {
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  opened.sqlite.pragma('foreign_keys = OFF');
  const vault = new CredentialVault(randomBytes(32).toString('base64'));
  store = new BrowserAuthStateStore(db, vault);
});

describe('BrowserAuthStateStore', () => {
  it('round-trips storageState through save/load', async () => {
    await store.save('ws-A', 'u-A', 'olx-login', sampleState());
    const loaded = await store.load('ws-A', 'olx-login');
    expect(loaded).toEqual(sampleState());
  });

  it('encrypts the state at rest (ciphertext is not the plaintext JSON)', async () => {
    await store.save('ws-A', 'u-A', 'olx-login', sampleState());
    const row = db
      .select({ value: schema.browserAuthStates.encryptedValue })
      .from(schema.browserAuthStates)
      .where(eq(schema.browserAuthStates.name, 'olx-login'))
      .get();
    expect(row?.value).toBeDefined();
    expect(row!.value).not.toContain('abc123');
    expect(row!.value).not.toContain('session');
  });

  it('is workspace-scoped — another workspace cannot load the profile', async () => {
    await store.save('ws-A', 'u-A', 'shared-name', sampleState());
    expect(await store.load('ws-B', 'shared-name')).toBeNull();
  });

  it('upserts by (workspace, name) — a second save overwrites, not duplicates', async () => {
    await store.save('ws-A', 'u-A', 'p', sampleState());
    await store.save('ws-A', 'u-A', 'p', { cookies: [{ name: 'session', value: 'NEW', domain: 'x' }], origins: [] });
    const rows = db.select().from(schema.browserAuthStates).where(eq(schema.browserAuthStates.name, 'p')).all();
    expect(rows).toHaveLength(1);
    const loaded = (await store.load('ws-A', 'p')) as { cookies: Array<{ value: string }> };
    expect(loaded.cookies[0]!.value).toBe('NEW');
  });

  it('allows a null userId (provenance is optional)', async () => {
    await store.save('ws-A', null, 'anon', sampleState());
    expect(await store.load('ws-A', 'anon')).toEqual(sampleState());
  });

  it('remove deletes a profile and reports whether a row was removed', async () => {
    await store.save('ws-A', 'u-A', 'p', sampleState());
    expect(await store.remove('ws-A', 'p')).toBe(true);
    expect(await store.load('ws-A', 'p')).toBeNull();
    expect(await store.remove('ws-A', 'p')).toBe(false);
  });

  it('returns null (not throw) when a stored value cannot be decrypted', async () => {
    // Simulate a tampered/foreign row: valid-looking base64 that the vault rejects.
    const now = new Date().toISOString();
    db.insert(schema.browserAuthStates)
      .values({ id: 'x', workspaceId: 'ws-A', userId: null, name: 'corrupt', encryptedValue: 'AAAA', createdAt: now, updatedAt: now })
      .run();
    expect(await store.load('ws-A', 'corrupt')).toBeNull();
  });
});
