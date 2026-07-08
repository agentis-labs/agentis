/**
 * Auth service — bcrypt password hashing + RS256 JWTs via jose.
 *
 * V1 is single-operator local auth. SSO/OAuth land in V2/V3 (V1-SPEC §0.3).
 */

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  importSPKI,
  exportJWK,
  calculateJwkThumbprint,
  type KeyLike,
  type JWK,
} from 'jose';
import { CONSTANTS, AgentisError } from '@agentis/core';
import type { AgentisSecrets } from '../secrets.js';

export interface AuthClaims {
  sub: string; // user id
  username: string;
  /** Token kind so refresh tokens can't be used for resource access. */
  kind: 'access' | 'refresh';
}

export interface AuthIssueResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export class AuthService {
  #privateKey: KeyLike | null = null;
  #publicKey: KeyLike | null = null;
  #publicJwk: JWK | null = null;
  #kid: string | null = null;

  constructor(private readonly secrets: AgentisSecrets) {}

  async #priv(): Promise<KeyLike> {
    if (!this.#privateKey) {
      this.#privateKey = await importPKCS8(this.secrets.jwtPrivateKeyPem, 'RS256');
    }
    return this.#privateKey;
  }
  async #pub(): Promise<KeyLike> {
    if (!this.#publicKey) {
      this.#publicKey = await importSPKI(this.secrets.jwtPublicKeyPem, 'RS256');
    }
    return this.#publicKey;
  }

  /**
   * RFC 7638 thumbprint of the public key. Stable as long as the key
   * doesn't rotate, which lets verifiers cache the JWK by `kid` and pivot
   * cleanly when a new key is published.
   */
  async kid(): Promise<string> {
    if (this.#kid) return this.#kid;
    const jwk = await this.#publicJwkOnce();
    this.#kid = await calculateJwkThumbprint(jwk, 'sha256');
    return this.#kid;
  }

  async #publicJwkOnce(): Promise<JWK> {
    if (this.#publicJwk) return this.#publicJwk;
    this.#publicJwk = await exportJWK(await this.#pub());
    return this.#publicJwk;
  }

  /**
   * JWKS payload for `/.well-known/jwks.json`. Returns a single key entry
   * with `use:'sig'`, `alg:'RS256'`, and the cached `kid` thumbprint.
   */
  async jwks(): Promise<{ keys: JWK[] }> {
    const jwk = { ...(await this.#publicJwkOnce()) };
    jwk.kid = await this.kid();
    jwk.use = 'sig';
    jwk.alg = 'RS256';
    return { keys: [jwk] };
  }

  async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, CONSTANTS.BCRYPT_COST);
  }

  async verifyPassword(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  }

  async issueTokens(userId: string, username: string): Promise<AuthIssueResult> {
    const privateKey = await this.#priv();
    const kid = await this.kid();
    const now = Math.floor(Date.now() / 1000);

    const accessToken = await new SignJWT({ username, kind: 'access' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + CONSTANTS.JWT_ACCESS_TOKEN_EXPIRY_SECONDS)
      .setIssuer('agentis')
      .setAudience('agentis-dashboard')
      .sign(privateKey);

    const refreshToken = await new SignJWT({ username, kind: 'refresh' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + CONSTANTS.JWT_REFRESH_TOKEN_EXPIRY_SECONDS)
      .setIssuer('agentis')
      .setAudience('agentis-dashboard')
      .sign(privateKey);

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: CONSTANTS.JWT_ACCESS_TOKEN_EXPIRY_SECONDS,
    };
  }

  async verify(token: string, expectedKind: AuthClaims['kind'] = 'access'): Promise<AuthClaims> {
    const publicKey = await this.#pub();
    try {
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: 'agentis',
        audience: 'agentis-dashboard',
      });
      const claims = payload as unknown as AuthClaims;
      if (claims.kind !== expectedKind) {
        throw new AgentisError('AUTH_TOKEN_INVALID', 'Wrong token kind for this endpoint');
      }
      return claims;
    } catch (err) {
      if (err instanceof AgentisError) throw err;
      throw new AgentisError('AUTH_TOKEN_INVALID', 'Invalid or expired token');
    }
  }
}
