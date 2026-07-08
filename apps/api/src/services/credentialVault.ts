/**
 * Credential vault — AES-256-GCM symmetric encryption.
 *
 * Format on disk (in credentials.encrypted_value): base64 of
 *   [12-byte IV][16-byte auth tag][ciphertext]
 *
 * Why GCM: authenticated encryption — tampering with the ciphertext is
 * detected by the tag mismatch, not by the application getting back garbage.
 *
 * The same vault is used for OpenClaw device tokens, channel bridge bot
 * tokens, and generic extension credentials. There is intentionally no
 * plaintext-storage fallback path.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { schema } from '@agentis/db/sqlite';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { eq } from 'drizzle-orm';
import type { Logger } from '../logger.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

export class CredentialVault {
  readonly #key: Buffer;

  constructor(keyB64: string) {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) {
      throw new Error('CredentialVault requires a 32-byte (256-bit) key');
    }
    this.#key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
  }

  decrypt(payloadB64: string): string {
    const buf = Buffer.from(payloadB64, 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES) {
      throw new Error('CredentialVault: ciphertext too short');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /** Constant-time comparison helper for downstream HMAC checks. */
  static safeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Re-encrypt every at-rest secret with `newKeyB64` (D32).
   *
   * Strategy:
   *   1. Decrypt with the *current* vault (whatever key it was constructed with).
   *   2. Encrypt with a fresh vault built around `newKeyB64`.
   *   3. UPDATE the row.
   *
   * After a successful run, rotate the on-disk `secrets.json` to use
   * `newKeyB64` and restart the process.
   *
   * Returns the per-table counts so the operator CLI can confirm coverage.
   */
  static async rotateAll(args: {
    db: AgentisSqliteDb;
    oldKeyB64: string;
    newKeyB64: string;
    logger?: Logger;
  }): Promise<{ credentials: number }> {
    const oldVault = new CredentialVault(args.oldKeyB64);
    const newVault = new CredentialVault(args.newKeyB64);
    const counts = { credentials: 0 };

    const credRows = args.db.select().from(schema.credentials).all();
    const credPlans = credRows.map((row) => ({
      id: row.id,
      next: newVault.encrypt(oldVault.decrypt(row.encryptedValue)),
    }));

    for (const plan of credPlans) {
      args.db
        .update(schema.credentials)
        .set({ encryptedValue: plan.next })
        .where(eq(schema.credentials.id, plan.id))
        .run();
      counts.credentials += 1;
    }

    args.logger?.info('credential_vault.rotation_complete', counts);
    return counts;
  }
}
