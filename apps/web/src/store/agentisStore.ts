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

export type SettingsTab = 'profile' | 'data' | 'workspace' | 'channels' | 'mcp' | 'integrations' | 'security' | 'budget' | 'runtimes' | 'governance';

export interface AgentisStore {
  // Workspace + ambient context
  workspaceId: string | null;
  ambientId: string | null;
  setContext: (workspaceId: string, ambientId: string | null) => void;
  clearContext: () => void;

  // UI shell flags
  conversationDockOpen: boolean;
  setConversationDockOpen: (open: boolean) => void;
  toggleConversationDock: () => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;

  settingsOpen: boolean;
  settingsTab: SettingsTab;
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  closeSettings: () => void;

  // Realtime-derived state — keyed by agentId / runId so selectors can
  // subscribe to a single key without watching the whole map.
  presenceByAgent: Record<string, AgentPresence>;
  upsertPresence: (p: AgentPresence) => void;
  clearPresence: () => void;

  activeRuns: Record<string, ActiveRunSummary>;
  upsertActiveRun: (run: ActiveRunSummary) => void;
  removeActiveRun: (runId: string) => void;

  // Resource-name registry — pages that fetch an entity (app, workflow, agent,
  // extension, …) register its human name here, keyed `${kind}:${id}`, so any
  // id-only surface (the "Viewing" pill, node labels) can resolve a real name
  // instead of leaking the raw identifier. See lib/resourceNames.
  resourceNames: Record<string, string>;
  registerResourceName: (kind: string, id: string, name: string) => void;
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

  settingsOpen: false,
  settingsTab: 'profile',
  setSettingsOpen: (open, tab) => set((s) => ({ 
    settingsOpen: open, 
    settingsTab: tab ?? s.settingsTab 
  })),
  closeSettings: () => set({ settingsOpen: false }),

  presenceByAgent: {},
  upsertPresence: (p) =>
    set((s) => {
      const current = s.presenceByAgent[p.agentId];
      if (samePresence(current, p)) return s;
      return { presenceByAgent: { ...s.presenceByAgent, [p.agentId]: p } };
    }),
  clearPresence: () => set({ presenceByAgent: {} }),

  activeRuns: {},
  upsertActiveRun: (run) =>
    set((s) => {
      const current = s.activeRuns[run.runId];
      if (sameActiveRun(current, run)) return s;
      return { activeRuns: { ...s.activeRuns, [run.runId]: run } };
    }),
  removeActiveRun: (runId) =>
    set((s) => {
      // Object spread + delete — cheaper than Object.fromEntries(filter).
      const next = { ...s.activeRuns };
      delete next[runId];
      return { activeRuns: next };
    }),

  resourceNames: {},
  registerResourceName: (kind, id, name) =>
    set((s) => {
      const key = `${kind}:${id}`;
      const value = name.trim();
      if (!value || s.resourceNames[key] === value) return s;
      return { resourceNames: { ...s.resourceNames, [key]: value } };
    }),
}));

// Selector helpers — call sites import these instead of slicing the
// store inline so the dependency surface is grep-able.
export const selectPresence = (agentId: string) => (s: AgentisStore) =>
  s.presenceByAgent[agentId];
export const selectActiveRunCount = (s: AgentisStore) =>
  Object.keys(s.activeRuns).length;
export const selectResourceName = (kind: string, id: string) => (s: AgentisStore) =>
  s.resourceNames[`${kind}:${id}`];

function samePresence(a: AgentPresence | undefined, b: AgentPresence): boolean {
  return Boolean(a)
    && a!.agentId === b.agentId
    && a!.state === b.state
    && a!.lastSeen === b.lastSeen;
}

function sameActiveRun(a: ActiveRunSummary | undefined, b: ActiveRunSummary): boolean {
  return Boolean(a)
    && a!.runId === b.runId
    && a!.workflowId === b.workflowId
    && a!.status === b.status
    && a!.startedAt === b.startedAt;
}



