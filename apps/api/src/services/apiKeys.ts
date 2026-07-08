import { randomBytes, scryptSync } from 'node:crypto';

const API_KEY_HASH_SALT = 'agentis-api-key-v1';

export function createApiKeySecret(): string {
  return `agt_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(secret: string): string {
  const digest = scryptSync(secret, API_KEY_HASH_SALT, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return `scrypt$v=1$n=16384$r=8$p=1$${digest.toString('base64url')}`;
}
