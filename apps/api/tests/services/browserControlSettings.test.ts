/**
 * Real-Chrome-control opt-in — default OFF, per-workspace, env master override.
 */
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { openSqlite, type AgentisSqliteDb } from '@agentis/db/sqlite';
import {
  isRealChromeControlEnabled,
  setRealChromeControlEnabled,
  realChromeEnvMaster,
  resolveRealChromeAllowed,
} from '../../src/services/browser/browserControlSettings.js';

let db: AgentisSqliteDb;
const prev = process.env.AGENTIS_BROWSER_ALLOW_CDP;

beforeEach(() => {
  const opened = openSqlite({ path: ':memory:' });
  db = opened.db;
  opened.sqlite.pragma('foreign_keys = OFF');
  delete process.env.AGENTIS_BROWSER_ALLOW_CDP;
});
afterEach(() => {
  if (prev === undefined) delete process.env.AGENTIS_BROWSER_ALLOW_CDP;
  else process.env.AGENTIS_BROWSER_ALLOW_CDP = prev;
});

describe('browserControlSettings', () => {
  it('is OFF by default (security-first)', () => {
    expect(isRealChromeControlEnabled(db, 'ws')).toBe(false);
    expect(resolveRealChromeAllowed(db, 'ws')).toBe(false);
  });

  it('the per-workspace switch persists and gates the decision', () => {
    setRealChromeControlEnabled(db, 'ws', true);
    expect(isRealChromeControlEnabled(db, 'ws')).toBe(true);
    expect(resolveRealChromeAllowed(db, 'ws')).toBe(true);
    // isolated per workspace
    expect(resolveRealChromeAllowed(db, 'other')).toBe(false);
    setRealChromeControlEnabled(db, 'ws', false);
    expect(resolveRealChromeAllowed(db, 'ws')).toBe(false);
  });

  it('env master force-DENIES regardless of the switch', () => {
    setRealChromeControlEnabled(db, 'ws', true);
    process.env.AGENTIS_BROWSER_ALLOW_CDP = 'false';
    expect(realChromeEnvMaster()).toBe(false);
    expect(resolveRealChromeAllowed(db, 'ws')).toBe(false);
  });

  it('env master force-ALLOWS regardless of the switch', () => {
    process.env.AGENTIS_BROWSER_ALLOW_CDP = 'true';
    expect(realChromeEnvMaster()).toBe(true);
    expect(resolveRealChromeAllowed(db, 'ws')).toBe(true); // switch never set
  });

  it('unset env master defers to the switch', () => {
    expect(realChromeEnvMaster()).toBeNull();
    setRealChromeControlEnabled(db, 'ws', true);
    expect(resolveRealChromeAllowed(db, 'ws')).toBe(true);
  });
});
