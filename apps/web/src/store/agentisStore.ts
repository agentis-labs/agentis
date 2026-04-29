/**
 * Shared client state — V1 review feedback.
 *
 * The dashboard's prop-passing was getting tangled around two concerns
 * that genuinely span the tree:
 *
 *   1. The active workspace + ambient (set in TopBarPills, read by every
 *      data-fetching page). Today it lives in URL search params + a
 *      one-off context.
 *   2. UI shell flags — whether the conversation dock is open, whether
 *      the command palette is open, what the live presence map looks
 *      like by agent. These are sourced from the realtime bus and need
 *      to be observable from anywhere without re-subscribing per
 *      component.
 *
 * Zustand is intentionally chosen over React context here because:
 *   - Selectors avoid re-rendering the whole tree on a presence tick.
 *   - There is no provider boilerplate to add to the test harness.
 *   - The store is reachable from non-React code paths (e.g. the realtime
 *     bridge in `useRealtime.ts`).
 *
 * Components opt in incrementally — existing prop flow keeps working
 * until each consumer is migrated.
 */

import { create } from 'zustand';

export type AgentPresenceState = 'online' | 'busy' | 'offline';

export interface AgentPresence {
  agentId: string;
  state: AgentPresenceState;
  /** ISO timestamp of the last presence event we observed. */
  lastSeen: string;
}

export interface ActiveRunSummary {
  runId: string;
  workflowId: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  startedAt: string;
}

export interface AgentisStore {
  // Workspace + ambient context
  workspaceId: string | null;
  ambientId: string | null;
  setContext: (workspaceId: string, ambientId: string) => void;
  clearContext: () => void;

  // UI shell flags
  conversationDockOpen: boolean;
  setConversationDockOpen: (open: boolean) => void;
  toggleConversationDock: () => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;

  // Realtime-derived state — keyed by agentId / runId so selectors can
  // subscribe to a single key without watching the whole map.
  presenceByAgent: Record<string, AgentPresence>;
  upsertPresence: (p: AgentPresence) => void;
  clearPresence: () => void;

  activeRuns: Record<string, ActiveRunSummary>;
  upsertActiveRun: (run: ActiveRunSummary) => void;
  removeActiveRun: (runId: string) => void;
}

export const useAgentisStore = create<AgentisStore>((set) => ({
  workspaceId: null,
  ambientId: null,
  setContext: (workspaceId, ambientId) => set({ workspaceId, ambientId }),
  clearContext: () => set({ workspaceId: null, ambientId: null }),

  conversationDockOpen: false,
  setConversationDockOpen: (open) => set({ conversationDockOpen: open }),
  toggleConversationDock: () =>
    set((s) => ({ conversationDockOpen: !s.conversationDockOpen })),

  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),

  presenceByAgent: {},
  upsertPresence: (p) =>
    set((s) => ({ presenceByAgent: { ...s.presenceByAgent, [p.agentId]: p } })),
  clearPresence: () => set({ presenceByAgent: {} }),

  activeRuns: {},
  upsertActiveRun: (run) =>
    set((s) => ({ activeRuns: { ...s.activeRuns, [run.runId]: run } })),
  removeActiveRun: (runId) =>
    set((s) => {
      // Object spread + delete — cheaper than Object.fromEntries(filter).
      const next = { ...s.activeRuns };
      delete next[runId];
      return { activeRuns: next };
    }),
}));

// Selector helpers — call sites import these instead of slicing the
// store inline so the dependency surface is grep-able.
export const selectPresence = (agentId: string) => (s: AgentisStore) =>
  s.presenceByAgent[agentId];
export const selectActiveRunCount = (s: AgentisStore) =>
  Object.keys(s.activeRuns).length;
