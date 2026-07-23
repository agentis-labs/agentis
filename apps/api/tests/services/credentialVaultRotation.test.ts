/**
 * D32 — CredentialVault.rotateAll re-encrypts every at-rest secret.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import { CredentialVault } from '../../src/services/credentialVault.js';
import { createTestContext } from '../_helpers/createTestContext.js';

const newKey = () => randomBytes(32).toString('base64');

describe('CredentialVault.rotateAll', () => {
  it('re-encrypts credentials so the old key fails and the new key succeeds', async () => {
    const ctx = await createTestContext();
    try {
      const oldKeyB64 = ctx.secrets.credentialKeyB64;
      const oldVault = new CredentialVault(oldKeyB64);

      const credId = randomUUID();
      ctx.db.insert(schema.credentials).values({
        id: credId,
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        name: 'openai-key',
        credentialType: 'token',
        encryptedValue: oldVault.encrypt('sk-secret-1234567890'),
      }).run();

      const newKeyB64 = newKey();
      const counts = await CredentialVault.rotateAll({
        db: ctx.db,
        oldKeyB64,
        newKeyB64,
        logger: ctx.logger,
      });

      expect(counts).toEqual({ credentials: 1, oauthAppCredentials: 0 });

      const newVault = new CredentialVault(newKeyB64);
      const credRow = ctx.db.select().from(schema.credentials).all()[0]!;
      expect(newVault.decrypt(credRow.encryptedValue)).toBe('sk-secret-1234567890');
      expect(() => oldVault.decrypt(credRow.encryptedValue)).toThrow();
    } finally {
      ctx.close();
    }
  });

  it('returns zero when there are no credentials to rotate', async () => {
    const ctx = await createTestContext();
    try {
      const counts = await CredentialVault.rotateAll({
        db: ctx.db,
        oldKeyB64: ctx.secrets.credentialKeyB64,
        newKeyB64: newKey(),
        logger: ctx.logger,
      });
      expect(counts).toEqual({ credentials: 0, oauthAppCredentials: 0 });
    } finally {
      ctx.close();
    }
  });

  it('also re-encrypts BYOC OAuth app credentials (client id/secret)', async () => {
    const ctx = await createTestContext();
    try {
      const oldKeyB64 = ctx.secrets.credentialKeyB64;
      const oldVault = new CredentialVault(oldKeyB64);

      ctx.db.insert(schema.oauthAppCredentials).values({
        provider: 'google',
        encryptedValue: oldVault.encrypt(JSON.stringify({ clientId: 'gid', clientSecret: 'gsec' })),
      }).run();

      const newKeyB64 = newKey();
      const counts = await CredentialVault.rotateAll({ db: ctx.db, oldKeyB64, newKeyB64, logger: ctx.logger });
      expect(counts).toEqual({ credentials: 0, oauthAppCredentials: 1 });

      const newVault = new CredentialVault(newKeyB64);
      const row = ctx.db.select().from(schema.oauthAppCredentials).all()[0]!;
      expect(JSON.parse(newVault.decrypt(row.encryptedValue))).toEqual({ clientId: 'gid', clientSecret: 'gsec' });
      expect(() => oldVault.decrypt(row.encryptedValue)).toThrow();
    } finally {
      ctx.close();
    }
  });
});
