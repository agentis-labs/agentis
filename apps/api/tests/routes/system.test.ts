/**
 * /v1/system version comparator — the semver logic behind the
 * "update available" prompt.
 */
import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../../src/routes/system.js';

describe('isNewerVersion', () => {
  it('detects a newer patch, minor, or major', () => {
    expect(isNewerVersion('0.2.2', '0.2.1')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.2.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });

  it('returns false when equal or older', () => {
    expect(isNewerVersion('0.2.1', '0.2.1')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.2.1')).toBe(false);
    expect(isNewerVersion('0.1.9', '1.0.0')).toBe(false);
  });

  it('tolerates a leading v and uneven segment counts', () => {
    expect(isNewerVersion('v0.2.2', '0.2.1')).toBe(true);
    expect(isNewerVersion('0.3', '0.2.9')).toBe(true);
    expect(isNewerVersion('0.2', '0.2.0')).toBe(false);
  });

  it('treats a release as newer than the same-core pre-release', () => {
    expect(isNewerVersion('0.3.0', '0.3.0-rc.1')).toBe(true);
    expect(isNewerVersion('0.3.0-rc.1', '0.3.0')).toBe(false);
  });
});
