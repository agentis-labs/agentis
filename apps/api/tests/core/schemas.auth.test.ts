/**
 * @agentis/core schemas/auth — login + refresh request validation.
 */

import { describe, it, expect } from 'vitest';
import { schemas, CONSTANTS } from '@agentis/core';

describe('loginRequestSchema', () => {
  it('accepts a username + password meeting the policy', () => {
    expect(() =>
      schemas.loginRequestSchema.parse({
        username: 'operator',
        password: 'a'.repeat(CONSTANTS.PASSWORD_MIN_LENGTH),
      }),
    ).not.toThrow();
  });

  it('rejects empty username', () => {
    expect(() =>
      schemas.loginRequestSchema.parse({ username: '   ', password: 'x'.repeat(20) }),
    ).toThrow();
  });

  it('rejects short password', () => {
    expect(() =>
      schemas.loginRequestSchema.parse({ username: 'op', password: 'short' }),
    ).toThrow();
  });

  it('rejects oversized password', () => {
    expect(() =>
      schemas.loginRequestSchema.parse({
        username: 'op',
        password: 'x'.repeat(CONSTANTS.PASSWORD_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it('trims username whitespace', () => {
    const out = schemas.loginRequestSchema.parse({
      username: '  operator  ',
      password: 'x'.repeat(CONSTANTS.PASSWORD_MIN_LENGTH),
    });
    expect(out.username).toBe('operator');
  });
});

describe('refreshRequestSchema', () => {
  it('rejects too-short tokens', () => {
    expect(() => schemas.refreshRequestSchema.parse({ refreshToken: 'short' })).toThrow();
  });

  it('accepts realistic token strings', () => {
    expect(() =>
      schemas.refreshRequestSchema.parse({ refreshToken: 'x'.repeat(64) }),
    ).not.toThrow();
  });
});
