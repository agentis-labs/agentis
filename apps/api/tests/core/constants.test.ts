/**
 * @agentis/core CONSTANTS — shape + invariants.
 *
 * These constants are referenced from the dashboard, the engine, services
 * and the spec. We don't pin every numeric value — that would freeze
 * tuning. We do pin the invariants that the rest of the codebase relies on.
 */

import { describe, it, expect } from 'vitest';
import { CONSTANTS } from '@agentis/core';

describe('CONSTANTS', () => {
  it('exposes a non-empty agent color palette of hex strings', () => {
    expect(CONSTANTS.AGENT_COLOR_PALETTE.length).toBeGreaterThan(0);
    for (const c of CONSTANTS.AGENT_COLOR_PALETTE) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('keeps timeouts > heartbeat interval', () => {
    expect(CONSTANTS.AGENT_TASK_RESPONSE_TIMEOUT_MS).toBeGreaterThan(
      CONSTANTS.AGENT_HEARTBEAT_INTERVAL_MS,
    );
  });

  it('webhook tolerance is at least one minute (anti-replay window)', () => {
    expect(CONSTANTS.WEBHOOK_TIMESTAMP_TOLERANCE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('extension execution max ≥ default', () => {
    expect(CONSTANTS.EXTENSION_EXECUTION_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(
      CONSTANTS.EXTENSION_EXECUTION_TIMEOUT_MS,
    );
  });

  it('jwt refresh expiry > access expiry', () => {
    expect(CONSTANTS.JWT_REFRESH_TOKEN_EXPIRY_SECONDS).toBeGreaterThan(
      CONSTANTS.JWT_ACCESS_TOKEN_EXPIRY_SECONDS,
    );
  });

  it('password length min ≤ max', () => {
    expect(CONSTANTS.PASSWORD_MIN_LENGTH).toBeLessThanOrEqual(CONSTANTS.PASSWORD_MAX_LENGTH);
  });

  it('default port is 3737 (V1-SPEC §0.4)', () => {
    expect(CONSTANTS.DEFAULT_HTTP_PORT).toBe(3737);
  });

  it('command palette result limit is positive integer', () => {
    expect(Number.isInteger(CONSTANTS.COMMAND_PALETTE_RESULT_LIMIT)).toBe(true);
    expect(CONSTANTS.COMMAND_PALETTE_RESULT_LIMIT).toBeGreaterThan(0);
  });
});
