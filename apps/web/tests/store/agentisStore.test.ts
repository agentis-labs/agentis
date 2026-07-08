/**
 * agentisStore — pure-state actions, no DOM required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAgentisStore,
  selectActiveRunCount,
  selectPresence,
} from '../../src/store/agentisStore';

beforeEach(() => {
  // Reset the store between tests — zustand keeps state across modules.
  useAgentisStore.setState({
    workspaceId: null,
    ambientId: null,
    conversationDockOpen: false,
    paletteOpen: false,
    presenceByAgent: {},
    activeRuns: {},
  });
});

describe('agentisStore — context', () => {
  it('setContext sets workspace + ambient', () => {
    useAgentisStore.getState().setContext('w1', 'a1');
    expect(useAgentisStore.getState().workspaceId).toBe('w1');
    expect(useAgentisStore.getState().ambientId).toBe('a1');
  });

  it('clearContext nulls both', () => {
    useAgentisStore.getState().setContext('w1', 'a1');
    useAgentisStore.getState().clearContext();
    expect(useAgentisStore.getState().workspaceId).toBeNull();
    expect(useAgentisStore.getState().ambientId).toBeNull();
  });
});

describe('agentisStore — UI flags', () => {
  it('toggleConversationDock flips state', () => {
    expect(useAgentisStore.getState().conversationDockOpen).toBe(false);
    useAgentisStore.getState().toggleConversationDock();
    expect(useAgentisStore.getState().conversationDockOpen).toBe(true);
    useAgentisStore.getState().toggleConversationDock();
    expect(useAgentisStore.getState().conversationDockOpen).toBe(false);
  });

  it('togglePalette flips state', () => {
    useAgentisStore.getState().togglePalette();
    expect(useAgentisStore.getState().paletteOpen).toBe(true);
  });

  it('setPaletteOpen sets explicit value', () => {
    useAgentisStore.getState().setPaletteOpen(true);
    expect(useAgentisStore.getState().paletteOpen).toBe(true);
    useAgentisStore.getState().setPaletteOpen(false);
    expect(useAgentisStore.getState().paletteOpen).toBe(false);
  });
});

describe('agentisStore — presence map', () => {
  it('upsertPresence inserts and overwrites by agentId', () => {
    useAgentisStore.getState().upsertPresence({
      agentId: 'a1',
      state: 'online',
      lastSeen: '2026-01-01T00:00:00Z',
    });
    expect(selectPresence('a1')(useAgentisStore.getState())?.state).toBe('online');
    useAgentisStore.getState().upsertPresence({
      agentId: 'a1',
      state: 'busy',
      lastSeen: '2026-01-01T00:00:01Z',
    });
    expect(selectPresence('a1')(useAgentisStore.getState())?.state).toBe('busy');
  });

  it('clearPresence empties the map', () => {
    useAgentisStore.getState().upsertPresence({
      agentId: 'a1',
      state: 'online',
      lastSeen: 'x',
    });
    useAgentisStore.getState().clearPresence();
    expect(useAgentisStore.getState().presenceByAgent).toEqual({});
  });
});

describe('agentisStore — active runs', () => {
  it('upsertActiveRun + removeActiveRun manage the keyed map', () => {
    useAgentisStore.getState().upsertActiveRun({
      runId: 'r1',
      workflowId: 'wf1',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
    });
    expect(selectActiveRunCount(useAgentisStore.getState())).toBe(1);
    useAgentisStore.getState().removeActiveRun('r1');
    expect(selectActiveRunCount(useAgentisStore.getState())).toBe(0);
  });

  it('selectActiveRunCount counts unique runIds', () => {
    useAgentisStore.getState().upsertActiveRun({
      runId: 'r1', workflowId: 'wf', status: 'running', startedAt: 'x',
    });
    useAgentisStore.getState().upsertActiveRun({
      runId: 'r2', workflowId: 'wf', status: 'queued', startedAt: 'x',
    });
    expect(selectActiveRunCount(useAgentisStore.getState())).toBe(2);
  });
});
