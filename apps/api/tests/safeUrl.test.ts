/**
 * assertSafeUrl — SSRF guard. V1-SPEC §14 + D11.
 *
 * IP-literal cases avoid DNS dependency, keeping these tests deterministic
 * in CI environments without network access.
 */
import { describe, it, expect } from 'vitest';
import { assertSafeUrl } from '../src/services/safeUrl.js';

describe('assertSafeUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow(/protocol/i);
    await expect(assertSafeUrl('ftp://example.com')).rejects.toThrow(/protocol/i);
  });

  it('rejects loopback IPv4 by default', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/x')).rejects.toThrow();
    await expect(assertSafeUrl('http://10.0.0.1/x')).rejects.toThrow();
    await expect(assertSafeUrl('http://192.168.1.1/x')).rejects.toThrow();
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
  });

  it('rejects loopback IPv6 by default', async () => {
    await expect(assertSafeUrl('http://[::1]/x')).rejects.toThrow();
  });

  it('allows private addresses when explicitly opted in', async () => {
    const url = await assertSafeUrl('http://127.0.0.1/x', { allowPrivate: true });
    expect(url.hostname).toBe('127.0.0.1');
  });

  it('enforces allowedDomains when provided', async () => {
    await expect(
      assertSafeUrl('http://evil.example.com/x', {
        allowPrivate: true,
        allowedDomains: ['safe.example.com'],
      }),
    ).rejects.toThrow(/allowedDomains/);

    const url = await assertSafeUrl('http://api.safe.example.com/x', {
      allowPrivate: true,
      allowedDomains: ['safe.example.com'],
    });
    expect(url.hostname).toBe('api.safe.example.com');
  });

  it('rejects malformed URLs', async () => {
    await expect(assertSafeUrl('not a url')).rejects.toThrow(/Invalid URL/);
  });
});
