import { createHash, randomBytes } from 'node:crypto';

export function createApiKeySecret(): string {
  return `agt_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
