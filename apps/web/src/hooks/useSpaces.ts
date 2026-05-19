import { useEffect, useState, useCallback } from 'react';
import { REALTIME_EVENTS } from '@agentis/core';
import { api } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { useAgentisStore } from '../store/agentisStore';

export interface SpaceRow {
  id: string;
  workspaceId: string;
  name: string;
  color: string | null;
  teamId: string | null;
  appCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * useSpaces — UIUX-AND-ARCHITECTURE-UPDATES.md \u00a723.
 *
 * Returns the workspace's Spaces, refreshes on SPACE_* realtime events,
 * and supports manual refresh() for mutation call sites.
 */
export function useSpaces(): {
  spaces: SpaceRow[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const workspaceId = useAgentisStore((s) => s.workspaceId);
  const [spaces, setSpaces] = useState<SpaceRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setSpaces([]);
      return;
    }
    setLoading(true);
    try {
      const data = await api<{ spaces: SpaceRow[] }>('/v1/spaces');
      setSpaces(data.spaces ?? []);
    } catch {
      setSpaces([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime(
    [
      REALTIME_EVENTS.SPACE_CREATED,
      REALTIME_EVENTS.SPACE_UPDATED,
      REALTIME_EVENTS.SPACE_DELETED,
    ],
    () => {
      void refresh();
    },
  );

  return { spaces, loading, refresh };
}
