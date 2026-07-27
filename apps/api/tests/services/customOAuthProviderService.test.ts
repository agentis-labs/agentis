/**
 * CustomOAuthProviderService — "bring your own OAuth app" for any service
 * (INTEGRATION-CEILING-10X §2). CRUD + secret encryption + validation.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openSqlite, type AgentisSqliteDb } from '@agentis/db/sqlite';
import { CredentialVault } from '../../src/services/credentialVault.js';
import { CustomOAuthProviderService } from '../../src/services/customOAuthProviderService.js';

let db: AgentisSqliteDb;
let svc: CustomOAuthProviderService;

beforeEach(() => {
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  opened.sqlite.pragma('foreign_keys = OFF');
  svc = new CustomOAuthProviderService({ db, vault: new CredentialVault(randomBytes(32).toString('base64')) });
});

const baseArgs = {
  workspaceId: 'ws-A',
  providerId: 'instagram',
  label: 'Instagram',
  authUrl: 'https://api.instagram.com/oauth/authorize',
  tokenUrl: 'https://api.instagram.com/oauth/access_token',
  clientId: 'ig-client-id',
  clientSecret: 'ig-secret',
};

describe('CustomOAuthProviderService', () => {
  it('creates a provider and round-trips its full def (decrypted) via get()', () => {
    svc.set({ ...baseArgs, scopes: ['user_profile', 'user_media'], pkce: true, tokenAuth: 'basic' });
    const def = svc.get('ws-A', 'instagram');
    expect(def).toMatchObject({
      providerId: 'instagram',
      label: 'Instagram',
      clientId: 'ig-client-id',
      clientSecret: 'ig-secret',
      scopes: ['user_profile', 'user_media'],
      pkce: true,
      tokenAuth: 'basic',
    });
  });

  it('list() never exposes the client secret, only hasClientSecret', () => {
    svc.set(baseArgs);
    const list = svc.list('ws-A');
    expect(list).toHaveLength(1);
    expect(list[0]!.hasClientSecret).toBe(true);
    expect(JSON.stringify(list)).not.toContain('ig-secret');
  });

  it('updating without clientSecret keeps the existing one', () => {
    svc.set(baseArgs);
    svc.set({ ...baseArgs, clientSecret: undefined, label: 'Instagram (renamed)' });
    const def = svc.get('ws-A', 'instagram');
    expect(def!.label).toBe('Instagram (renamed)');
    expect(def!.clientSecret).toBe('ig-secret');
  });

  it('rejects creating a provider with no clientSecret at all', () => {
    expect(() => svc.set({ ...baseArgs, clientSecret: undefined })).toThrow(/clientSecret is required/);
  });

  it('rejects an invalid providerId (must be lowercase slug-safe)', () => {
    expect(() => svc.set({ ...baseArgs, providerId: 'Instagram!' })).toThrow(/providerId/);
  });

  it('rejects a non-URL authUrl/tokenUrl', () => {
    expect(() => svc.set({ ...baseArgs, authUrl: 'not-a-url' })).toThrow(/valid URLs/);
  });

  it('is workspace-scoped — another workspace cannot see or fetch it', () => {
    svc.set(baseArgs);
    expect(svc.list('ws-B')).toHaveLength(0);
    expect(svc.get('ws-B', 'instagram')).toBeNull();
  });

  it('delete removes the provider', () => {
    svc.set(baseArgs);
    svc.delete('ws-A', 'instagram');
    expect(svc.get('ws-A', 'instagram')).toBeNull();
  });

  it('defaults scopeSeparator/pkce/tokenAuth/tokenBodyFormat sensibly when omitted', () => {
    svc.set(baseArgs);
    const def = svc.get('ws-A', 'instagram')!;
    expect(def.scopeSeparator).toBe(' ');
    expect(def.pkce).toBe(false);
    expect(def.tokenAuth).toBe('body');
    expect(def.tokenBodyFormat).toBe('form');
    expect(def.scopes).toEqual([]);
  });
});
