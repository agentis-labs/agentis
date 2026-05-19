/**
 * useBackgroundInstall — React hook for subscribing to background install progress.
 *
 * Uses useSyncExternalStore to efficiently react to the module-level store
 * without context providers or re-renders of unrelated trees.
 */

import { useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  getInstallSession,
  hasActiveInstall,
  getAllInstallSessions,
  type InstallSession,
} from '../lib/backgroundInstall';

/**
 * Subscribe to install progress for a specific agent.
 * Returns undefined when no install is in progress or completed for this agent.
 */
export function useAgentInstallSession(agentId: string | undefined): InstallSession | undefined {
  const _version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!agentId) return undefined;
  return getInstallSession(agentId);
}

/**
 * Check if an agent currently has an active (in-progress) background install.
 */
export function useAgentInstalling(agentId: string | undefined): boolean {
  const _version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!agentId) return false;
  return hasActiveInstall(agentId);
}

/**
 * Get all active install sessions (for a global progress indicator).
 */
export function useAllInstallSessions(): InstallSession[] {
  const _version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getAllInstallSessions();
}
