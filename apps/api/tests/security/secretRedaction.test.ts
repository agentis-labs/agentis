import { describe, it, expect } from 'vitest';
import {
  isSensitiveFieldName,
  redactForLogging,
  redactSecretString,
} from '../../src/services/security/secretRedaction.js';

describe('redactSecretString', () => {
  it('masks common secret shapes inside a string', () => {
    expect(redactSecretString('key sk-ABCDEFGHIJKLMNOP1234')).not.toContain('ABCDEFGHIJKLMNOP');
    expect(redactSecretString('Authorization: Bearer abcdef0123456789ABCDEF')).not.toContain('abcdef0123456789');
    expect(redactSecretString('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toContain('«redacted»');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecretString('the quick brown fox')).toBe('the quick brown fox');
  });
});

describe('isSensitiveFieldName', () => {
  it('flags secret-looking field names', () => {
    for (const k of ['authorization', 'apiKey', 'api_key', 'password', 'clientSecret', 'refresh_token', 'cookie']) {
      expect(isSensitiveFieldName(k), k).toBe(true);
    }
  });
  it('does not flag ordinary field names', () => {
    for (const k of ['name', 'status', 'workspaceId', 'durationMs']) {
      expect(isSensitiveFieldName(k), k).toBe(false);
    }
  });
});

describe('redactForLogging', () => {
  it('masks sensitive keys wholesale and secret-shaped values under innocent keys', () => {
    const out = redactForLogging({
      workspaceId: 'ws1',
      authorization: 'Bearer supersecrettoken1234567890',
      nested: { apiKey: 'sk-shouldbemasked1234567', note: 'contains sk-ANOTHERSECRETKEY123456' },
      list: ['plain', 'ghp_ABCDEFGHIJKLMNOPQRST1234'],
    });
    expect(out.workspaceId).toBe('ws1');
    expect(out.authorization).toBe('«redacted»');
    expect((out.nested as { apiKey: string }).apiKey).toBe('«redacted»');
    expect((out.nested as { note: string }).note).toContain('«redacted»');
    expect((out.list as string[])[0]).toBe('plain');
    expect((out.list as string[])[1]).toContain('«redacted»');
  });

  it('does not mutate the input and handles cycles', () => {
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;
    const out = redactForLogging(input);
    expect(input.self).toBe(input); // original untouched
    expect((out as { self: unknown }).self).toBe('«circular»');
  });
});
