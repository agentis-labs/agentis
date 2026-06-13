/**
 * Local secrets management.
 *
 * On first boot, generates:
 *  - JWT RS256 keypair (PEM)
 *  - AES-256-GCM credential-encryption key (32 bytes, base64)
 * and writes them to AGENTIS_DATA_DIR/secrets.json with mode 0600. Subsequent
 * boots reuse the same keys. Env vars override the file values, which is how
 * Railway / docker-compose deployments inject managed secrets.
 *
 * Generated locally, never sent over the wire, never logged.
 */

import { generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentisEnv } from './env.js';

export interface AgentisSecrets {
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  /** base64-encoded 32-byte key for AES-256-GCM. */
  credentialKeyB64: string;
  /**
   * Auto-login token for the local CLI launch flow.
   * Written to AGENTIS_DATA_DIR/token; the CLI opens the browser
   * with ?token=<launchToken> and the /v1/auth/launch route exchanges
   * it for a normal JWT session without requiring a password.
   *
   * Not present when secrets come from environment variables (server deploy).
   */
  launchToken?: string;
  /** Verify a matching local launch token. */
  consumeLaunchToken?: (candidate: string) => boolean;
}

interface SecretsFile {
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  credentialKeyB64: string;
  generatedAt: string;
}

export function loadOrCreateSecrets(env: AgentisEnv): AgentisSecrets {
  // Env-provided secrets win. This is how production injects managed values
  // (Railway, GitHub Actions, etc.) without touching disk.
  if (env.AGENTIS_JWT_PRIVATE_KEY && env.AGENTIS_JWT_PUBLIC_KEY && env.AGENTIS_CREDENTIAL_KEY) {
    return {
      jwtPrivateKeyPem: env.AGENTIS_JWT_PRIVATE_KEY,
      jwtPublicKeyPem: env.AGENTIS_JWT_PUBLIC_KEY,
      credentialKeyB64: env.AGENTIS_CREDENTIAL_KEY,
      // No launchToken in server/env-var deployments — operators use passwords.
    };
  }

  const path = join(env.AGENTIS_DATA_DIR, 'secrets.json');
  const tokenPath = join(env.AGENTIS_DATA_DIR, 'token');

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as SecretsFile;
    // Read (or generate) the launch token from the token file.
    let launchToken: string | undefined;
    if (existsSync(tokenPath)) {
      launchToken = readFileSync(tokenPath, 'utf8').trim();
    } else {
      launchToken = randomBytes(32).toString('base64url');
      writeFileSync(tokenPath, launchToken, { encoding: 'utf8' });
      try { chmodSync(tokenPath, 0o600); } catch { /* Windows */ }
    }
    return {
      jwtPrivateKeyPem: parsed.jwtPrivateKeyPem,
      jwtPublicKeyPem: parsed.jwtPublicKeyPem,
      credentialKeyB64: parsed.credentialKeyB64,
      launchToken,
      consumeLaunchToken: createLaunchTokenVerifier(() => launchToken),
    };
  }

  // First boot — generate everything.
  mkdirSync(dirname(path), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const credentialKey = randomBytes(32).toString('base64');
  let launchToken: string | undefined = randomBytes(32).toString('base64url');

  const file: SecretsFile = {
    jwtPrivateKeyPem: privateKey,
    jwtPublicKeyPem: publicKey,
    credentialKeyB64: credentialKey,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(path, JSON.stringify(file, null, 2), { encoding: 'utf8' });
  // 0o600 keeps secrets out of other users' reach on POSIX. No-op on Windows.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows */
  }

  writeFileSync(tokenPath, launchToken, { encoding: 'utf8' });
  try { chmodSync(tokenPath, 0o600); } catch { /* Windows */ }

  return {
    jwtPrivateKeyPem: file.jwtPrivateKeyPem,
    jwtPublicKeyPem: file.jwtPublicKeyPem,
    credentialKeyB64: file.credentialKeyB64,
    launchToken,
    consumeLaunchToken: createLaunchTokenVerifier(() => launchToken),
  };
}

function createLaunchTokenVerifier(
  readToken: () => string | undefined,
): (candidate: string) => boolean {
  return (candidate) => {
    const expected = readToken();
    if (!expected || !constantTimeEqual(expected, candidate)) return false;
    return true;
  };
}

function constantTimeEqual(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}
