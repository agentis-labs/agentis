/**
 * @agentis/core REALTIME_EVENTS / REALTIME_ROOMS — name table integrity.
 *
 * The dashboard's `useRealtime()` hook and every server-side `bus.publish`
 * key off these strings; a typo or a removal would silently break the live
 * UI. Tests here lock in the canonical names.
 */

import { describe, it, expect } from 'vitest';
import {
  REALTIME_EVENTS,
  REALTIME_ROOMS,
  type RealtimeEnvelope,
} from '@agentis/core';

describe('REALTIME_EVENTS', () => {
  it('every value is a dotted lowercase string', () => {
    for (const [key, value] of Object.entries(REALTIME_EVENTS)) {
      expect(typeof value).toBe('string');
      expect(value, `${key}=${value}`).toMatch(/^[a-z][a-z0-9._]*$/);
    }
  });

  it('values are unique (no aliases)', () => {
    const values = Object.values(REALTIME_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('includes the spec §12 essentials', () => {
    expect(REALTIME_EVENTS.RUN_CREATED).toBe('run.created');
    expect(REALTIME_EVENTS.RUN_RUNNING).toBe('run.running');
    expect(REALTIME_EVENTS.RUN_COMPLETED).toBe('run.completed');
    expect(REALTIME_EVENTS.RUN_FAILED).toBe('run.failed');
    expect(REALTIME_EVENTS.NODE_STARTED).toBe('node.started');
    expect(REALTIME_EVENTS.APPROVAL_REQUESTED).toBe('approval.requested');
    expect(REALTIME_EVENTS.LEDGER_EVENT).toBe('ledger.event');
  });
});

describe('REALTIME_ROOMS', () => {
  it('produces deterministic keyed strings', () => {
    expect(REALTIME_ROOMS.workspace('w1')).toBe('workspace:w1');
    expect(REALTIME_ROOMS.run('r1')).toBe('run:r1');
    expect(REALTIME_ROOMS.agent('a1')).toBe('agent:a1');
    expect(REALTIME_ROOMS.user('u1')).toBe('user:u1');
    expect(REALTIME_ROOMS.gateway('g1')).toBe('gateway:g1');
    expect(REALTIME_ROOMS.workflow('wf1')).toBe('workflow:wf1');
    expect(REALTIME_ROOMS.conversation('a1')).toBe('conversation:a1');
  });
});

describe('RealtimeEnvelope shape', () => {
  it('accepts the canonical envelope', () => {
    const env: RealtimeEnvelope = {
      event: REALTIME_EVENTS.RUN_CREATED,
      payload: { runId: 'r1' },
      emittedAt: new Date().toISOString(),
    };
    expect(env.event).toBe('run.created');
    expect(env.emittedAt).toMatch(/T/);
  });
});
