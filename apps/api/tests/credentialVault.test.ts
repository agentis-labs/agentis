/**
 * CredentialVault — AES-256-GCM round-trip and tamper detection.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CredentialVault } from '../src/services/credentialVault.js';

const KEY = randomBytes(32).toString('base64');

describe('CredentialVault', () => {
  it('encrypt -> decrypt round-trips', () => {
    const v = new CredentialVault(KEY);
    const ct = v.encrypt('hello');
    expect(ct).not.toBe('hello');
    expect(v.decrypt(ct)).toBe('hello');
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new CredentialVault(Buffer.alloc(16).toString('base64'))).toThrow();
  });

  it('detects ciphertext tampering via the GCM tag', () => {
    const v = new CredentialVault(KEY);
    const ct = v.encrypt('secret-token');
    // Flip the last byte of the base64 payload.
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => v.decrypt(tampered)).toThrow();
  });

  it('safeEqual is constant-time aware', () => {
    expect(CredentialVault.safeEqual(Buffer.from('aa'), Buffer.from('aa'))).toBe(true);
    expect(CredentialVault.safeEqual(Buffer.from('aa'), Buffer.from('ab'))).toBe(false);
    expect(CredentialVault.safeEqual(Buffer.from('a'), Buffer.from('aa'))).toBe(false);
  });
});
