/**
 * CredentialVault — extended coverage beyond the original 4 tests.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CredentialVault } from '../../src/services/credentialVault.js';

const key = () => randomBytes(32).toString('base64');

describe('CredentialVault — extended', () => {
  it('throws when constructed with a non-32-byte key', () => {
    expect(() => new CredentialVault(randomBytes(16).toString('base64'))).toThrow();
    expect(() => new CredentialVault(randomBytes(64).toString('base64'))).toThrow();
  });

  it('accepts an empty plaintext', () => {
    const v = new CredentialVault(key());
    const c = v.encrypt('');
    expect(v.decrypt(c)).toBe('');
  });

  it('handles unicode round-trip', () => {
    const v = new CredentialVault(key());
    const plain = '🔑 secret 你好';
    expect(v.decrypt(v.encrypt(plain))).toBe(plain);
  });

  it('produces unique ciphertexts on repeated encrypts (random IV)', () => {
    const v = new CredentialVault(key());
    const a = v.encrypt('same plaintext');
    const b = v.encrypt('same plaintext');
    expect(a).not.toBe(b);
  });

  it('rejects tampered tag bytes (auth failure)', () => {
    const v = new CredentialVault(key());
    const c = Buffer.from(v.encrypt('hello'), 'base64');
    c[12] = (c[12]! + 1) & 0xff; // flip a byte in the auth tag
    expect(() => v.decrypt(c.toString('base64'))).toThrow();
  });

  it('rejects truncated ciphertexts', () => {
    const v = new CredentialVault(key());
    expect(() => v.decrypt('AAA=')).toThrow();
  });

  it('safeEqual returns false on different lengths without throwing', () => {
    expect(CredentialVault.safeEqual(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
  });

  it('safeEqual is true for equal buffers', () => {
    expect(CredentialVault.safeEqual(Buffer.from('xx'), Buffer.from('xx'))).toBe(true);
  });
});
