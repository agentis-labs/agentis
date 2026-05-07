/**
 * Chat panel state — Zustand store, persisted to localStorage.
 *
 * State machine: hidden → floating → docked. Workspace switches
 * trigger a reset that re-fetches rooms/threads.
 */

import { create } from 'zustand';

export type ChatPanelState = 'hidden' | 'floating' | 'docked';

const STORAGE_KEY = 'agentis.chatPanel.state';

function readStored(): ChatPanelState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'floating' || v === 'docked' || v === 'hidden') return v;
  } catch { /* ignore */ }
  return 'hidden';
}

interface ChatPanelStore {
  state: ChatPanelState;
  setState: (s: ChatPanelState) => void;
  toggle: () => void;
  unreadCount: number;
  setUnreadCount: (n: number) => void;
  selectedThread: { kind: 'room' | 'agent'; id: string; name: string } | null;
  selectThread: (t: ChatPanelStore['selectedThread']) => void;
  resetForWorkspace: () => void;
}

export const useChatPanelStore = create<ChatPanelStore>((set) => ({
  state: readStored(),
  setState: (s) => {
    try { localStorage.setItem(STORAGE_KEY, s); } catch { /* ignore */ }
    set({ state: s });
  },
  toggle: () => set((cur) => {
    const next: ChatPanelState = cur.state === 'hidden' ? 'floating' : 'hidden';
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    return { state: next };
  }),
  unreadCount: 0,
  setUnreadCount: (n) => set({ unreadCount: n }),
  selectedThread: null,
  selectThread: (t) => set({ selectedThread: t }),
  resetForWorkspace: () => set({ selectedThread: null, unreadCount: 0 }),
}));

// Global keyboard shortcut: ⌘/ toggles chat
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '/') {
      e.preventDefault();
      useChatPanelStore.getState().toggle();
    }
  });
}
