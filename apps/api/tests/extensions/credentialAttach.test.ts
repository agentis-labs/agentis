/**
 * attachExtensionCredential — the host-side-only credential attachment that
 * makes a sandboxed extension's `ctx.http.fetch({credential:'key'})` work
 * without ever handing the decrypted secret to untrusted code
 * (INTEGRATION-CEILING-10X §3).
 */
import { describe, expect, it } from 'vitest';
import { attachExtensionCredential } from '../../src/extensions/credentialAttach.js';

describe('attachExtensionCredential', () => {
  it('does nothing when no credential key is requested', () => {
    const headers: Record<string, string> = {};
    attachExtensionCredential(headers, undefined, { k: { value: 'secret' } });
    expect(headers).toEqual({});
  });

  it('defaults to an "authorization: Bearer <value>" header', () => {
    const headers: Record<string, string> = {};
    attachExtensionCredential(headers, 'instagram_token', { instagram_token: { value: 'ig-secret-123' } });
    expect(headers.authorization).toBe('Bearer ig-secret-123');
  });

  it('honors a custom header name and template', () => {
    const headers: Record<string, string> = {};
    attachExtensionCredential(headers, 'k', { k: { value: 'abc', headerName: 'x-api-key', headerTemplate: '{value}' } });
    expect(headers['x-api-key']).toBe('abc');
    expect(headers.authorization).toBeUndefined();
  });

  it('throws (fails closed) when the requested key is not in the resolved map', () => {
    const headers: Record<string, string> = {};
    expect(() => attachExtensionCredential(headers, 'not_bound', {})).toThrow(/not available/);
  });

  it('never leaks the secret value into the thrown error for an unresolved key', () => {
    try {
      attachExtensionCredential({}, 'missing_key', { other_key: { value: 'super-secret-should-not-appear' } });
      throw new Error('expected attachExtensionCredential to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-should-not-appear');
    }
  });
});
