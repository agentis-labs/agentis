/**
 * Chat panel state — Zustand store, persisted to localStorage.
 *
 * State machine: hidden ↔ docked. Workspace switches
 * trigger a reset that re-fetches rooms/threads.
 */

import { create } from 'zustand';
import type { ViewportContext } from '@agentis/core';

export type ChatPanelState = 'hidden' | 'docked' | 'fullscreen';
export type ChatPanelThread = {
  kind: 'room' | 'agent';
  id: string;
  name: string;
  conversationId?: string | null;
  archivedAt?: string | null;
} | null;

const STORAGE_KEY = 'agentis.chatPanel.state';
const WIDTH_STORAGE_KEY = 'agentis.chatPanel.dockedWidth';
const DEFAULT_DOCKED_WIDTH = 480;
const MIN_DOCKED_WIDTH = 320;
const MAX_DOCKED_WIDTH = 720;

function readStored(): ChatPanelState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'docked') return 'docked';
    if (v === 'fullscreen' || v === 'floating') return 'fullscreen';
    if (v === 'hidden') return 'hidden';
  } catch { /* ignore */ }
  return 'hidden';
}

function clampDockedWidth(width: number): number {
  return Math.min(MAX_DOCKED_WIDTH, Math.max(MIN_DOCKED_WIDTH, Math.round(width)));
}

function readDockedWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_DOCKED_WIDTH;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampDockedWidth(parsed);
  } catch { /* ignore */ }
  return DEFAULT_DOCKED_WIDTH;
}

interface ChatPanelStore {
  state: ChatPanelState;
  setState: (s: ChatPanelState) => void;
  openChat: (options?: ChatPanelOpenOptions) => void;
  toggle: () => void;
  dockedWidth: number;
  setDockedWidth: (width: number) => void;
  unreadCount: number;
  setUnreadCount: (n: number) => void;
  selectedThread: ChatPanelThread;
  selectThread: (t: ChatPanelThread) => void;
  launchContext: ChatPanelLaunchContext | null;
  setLaunchContext: (context: ChatPanelLaunchContext | null) => void;
  openRequestId: number;
  markOpenRequested: () => void;
  returnPath: string;
  setReturnPath: (path: string) => void;
  /**
   * The agent task currently executing in chat (multi-step build/run). Drives
   * the pulsing badge on the header button and the FloatingTaskProgress card
   * shown when the panel is closed mid-task. Null when nothing is running.
   */
  activeTask: ActiveTaskState | null;
  setActiveTask: (task: ActiveTaskState | null) => void;
  updateActiveTask: (patch: Partial<ActiveTaskState>) => void;
  /** Per-scope (agent id) unread message counts. */
  unreadByScope: Record<string, number>;
  incrementUnread: (scopeId: string) => void;
  clearUnread: (scopeId: string) => void;
  resetForWorkspace: () => void;
}

export interface ActiveTaskState {
  agentId: string;
  agentName: string;
  label: string;
  done: number;
  total: number;
  startedAt: number;
}

export interface ChatPanelLaunchContext {
  initialDraft?: string;
  initialViewportOverride?: ViewportContext | null;
  autoSendInitialDraft?: boolean;
  /** When set, the panel opens in app-building mode (orchestrator designs the app). */
  buildSession?: boolean;
}

export interface ChatPanelOpenOptions {
  state?: Exclude<ChatPanelState, 'hidden'>;
  thread?: ChatPanelThread;
  launchContext?: ChatPanelLaunchContext | null;
  returnPath?: string;
}

function persistState(state: ChatPanelState): void {
  try { localStorage.setItem(STORAGE_KEY, state); } catch { /* ignore */ }
}

export const useChatPanelStore = create<ChatPanelStore>((set) => ({
  state: readStored(),
  setState: (s) => {
    persistState(s);
    set({ state: s });
  },
  openChat: (options) => set((state) => {
    const nextState = options?.state ?? 'docked';
    persistState(nextState);
    return {
      state: nextState,
      selectedThread: Object.prototype.hasOwnProperty.call(options ?? {}, 'thread')
        ? options?.thread ?? null
        : state.selectedThread,
      launchContext: Object.prototype.hasOwnProperty.call(options ?? {}, 'launchContext')
        ? options?.launchContext ?? null
        : state.launchContext,
      returnPath: options?.returnPath || state.returnPath || '/home',
      openRequestId: state.openRequestId + 1,
    };
  }),
  toggle: () => set((cur) => {
    const next: ChatPanelState = cur.state === 'hidden' ? 'docked' : 'hidden';
    persistState(next);
    return { state: next };
  }),
  dockedWidth: readDockedWidth(),
  setDockedWidth: (width) => {
    const next = clampDockedWidth(width);
    try { localStorage.setItem(WIDTH_STORAGE_KEY, String(next)); } catch { /* ignore */ }
    set({ dockedWidth: next });
  },
  unreadCount: 0,
  setUnreadCount: (n) => set({ unreadCount: n }),
  selectedThread: null,
  selectThread: (t) => set({ selectedThread: t }),
  launchContext: null,
  setLaunchContext: (context) => set({ launchContext: context }),
  openRequestId: 0,
  markOpenRequested: () => set((state) => ({ openRequestId: state.openRequestId + 1 })),
  returnPath: '/home',
  setReturnPath: (path) => set({ returnPath: path || '/home' }),
  activeTask: null,
  setActiveTask: (task) => set({ activeTask: task }),
  updateActiveTask: (patch) => set((state) => (state.activeTask ? { activeTask: { ...state.activeTask, ...patch } } : {})),
  unreadByScope: {},
  incrementUnread: (scopeId) => set((state) => ({
    unreadByScope: { ...state.unreadByScope, [scopeId]: (state.unreadByScope[scopeId] ?? 0) + 1 },
  })),
  clearUnread: (scopeId) => set((state) => {
    const next = { ...state.unreadByScope };
    delete next[scopeId];
    return { unreadByScope: next };
  }),
  resetForWorkspace: () => set({ selectedThread: null, unreadCount: 0, unreadByScope: {}, launchContext: null, openRequestId: 0, activeTask: null }),
}));

// Global keyboard shortcut: ⌘/ toggles chat
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '/') {
      const target = e.target as Element;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (target as HTMLElement).isContentEditable) return;
      e.preventDefault();
      useChatPanelStore.getState().toggle();
    }
  });
}
