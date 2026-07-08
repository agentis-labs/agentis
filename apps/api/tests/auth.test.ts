/**
 * AuthService — bcrypt + RS256 JWT round-trip + kind-claim enforcement.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { AgentisError } from '@agentis/core';
import { AuthService } from '../src/services/auth.js';
import type { AgentisSecrets } from '../src/secrets.js';

let secrets: AgentisSecrets;
let auth: AuthService;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  secrets = {
    jwtPrivateKeyPem: privateKey,
    jwtPublicKeyPem: publicKey,
    credentialKeyB64: randomBytes(32).toString('base64'),
  };
  auth = new AuthService(secrets);
});

describe('AuthService', () => {
  it('hashes + verifies passwords', async () => {
    const hash = await auth.hashPassword('hunter2');
    expect(await auth.verifyPassword('hunter2', hash)).toBe(true);
    expect(await auth.verifyPassword('hunter3', hash)).toBe(false);
  });

  it('issues an access + refresh pair that verify under the right kind', async () => {
    const tokens = await auth.issueTokens('u1', 'operator');
    const access = await auth.verify(tokens.accessToken, 'access');
    const refresh = await auth.verify(tokens.refreshToken, 'refresh');
    expect(access.sub).toBe('u1');
    expect(access.username).toBe('operator');
    expect(access.kind).toBe('access');
    expect(refresh.kind).toBe('refresh');
  });

  it('rejects refresh tokens used as access tokens (D04)', async () => {
    const tokens = await auth.issueTokens('u1', 'operator');
    await expect(auth.verify(tokens.refreshToken, 'access')).rejects.toThrow(
      AgentisError,
    );
    await expect(auth.verify(tokens.accessToken, 'refresh')).rejects.toThrow(
      AgentisError,
    );
  });

  it('rejects forged or tampered tokens', async () => {
    const tokens = await auth.issueTokens('u1', 'operator');
    const tampered = tokens.accessToken.slice(0, -4) + 'XXXX';
    await expect(auth.verify(tampered, 'access')).rejects.toThrow(AgentisError);
    await expect(auth.verify('not.a.jwt', 'access')).rejects.toThrow();
  });
});
