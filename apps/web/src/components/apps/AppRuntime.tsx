/**
 * AppRuntime - the end-user renderer for an Agentic App surface.
 *
 * It loads a surface tree, binds it to the app-client, and lets the App
 * navigate/state/update inside Agentis itself. The unified App editor uses it
 * as the Interface facet's live preview.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { createInProcessAppClient } from '@agentis/app-client';
import type { AppSurface } from '@agentis/core';
import { REALTIME_EVENTS } from '@agentis/core';
import { appsApi } from '../../lib/appsApi';
import { apiErrorMessage } from '../../lib/api';
import { useRealtime, type RealtimeEnvelope } from '../../lib/realtime';
import { RuntimeProvider, ViewRenderer, useDataRevision } from './ViewRenderer';

export function AppRuntime({ appId, surfaceName }: { appId: string; surfaceName?: string }) {
  const [surface, setSurface] = useState<AppSurface | null>(null);
  const [allowCustomCode, setAllowCustomCode] = useState(false);
  const [uiState, setUiState] = useState<Record<string, unknown>>({});
  const uiStateRef = useRef(uiState);
  const [activeSurfaceName, setActiveSurfaceName] = useState(surfaceName ?? 'home');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dataRevision = useDataRevision(appId);

  useEffect(() => {
    uiStateRef.current = uiState;
  }, [uiState]);

  useEffect(() => {
    setActiveSurfaceName(surfaceName ?? 'home');
  }, [surfaceName]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([appsApi.get(appId), appsApi.listSurfaces(appId)])
      .then(([app, surfaces]) => {
        if (cancelled) return;
        setAllowCustomCode(app.policy.customCode === 'allowed');
        const match = surfaces.find((s) => s.name === activeSurfaceName) ?? surfaces[0] ?? null;
        setSurface(match);
        if (!match) setError('This app has no surface yet. Ask the agent to render one.');
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [activeSurfaceName, appId, reloadKey]);

  const onSurfaceEvent = useCallback(
    (env: RealtimeEnvelope) => {
      const payload = env.payload as { appId?: string; region?: string } | undefined;
      if (payload?.appId && payload.appId !== appId) return;
      // Performed-region pushes (Phase M3) carry a `region` and are handled in
      // place by the matching AgentRegion node — a full reload would wipe the
      // transient (un-pinned) content, so skip it here.
      if (payload?.region) return;
      setReloadKey((k) => k + 1);
    },
    [appId],
  );
  useRealtime(useMemo(() => [REALTIME_EVENTS.SURFACE_RENDER, REALTIME_EVENTS.SURFACE_PATCH], []), onSurfaceEvent);

  const invokeAction = useCallback(
    async (action: string, args?: Record<string, unknown>) => {
      if (!surface) return undefined;
      return appsApi.dispatchAction(appId, surface.name, action, args ?? {});
    },
    [appId, surface],
  );

  const query = useCallback(
    async (collection: string, q?: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number }) => {
      const res = await appsApi.query(appId, collection, q ?? {});
      return res.rows.map((r) => ({ id: r.id, ...r.data }));
    },
    [appId],
  );

  const setStateValue = useCallback((key: string, value: unknown) => {
    setUiState((prev) => setPath(prev, key, value));
  }, []);

  const navigate = useCallback((targetSurface: string, params?: Record<string, unknown>) => {
    setUiState((prev) => ({ ...prev, params: params ?? {} }));
    setActiveSurfaceName(targetSurface);
  }, []);

  const client = useMemo(
    () =>
      createInProcessAppClient({
        appId,
        surface: surface?.name ?? activeSurfaceName,
        query,
        invokeAction,
        getState: (key) => (key ? getPath(uiStateRef.current, key) : uiStateRef.current),
        setState: setStateValue,
        navigate,
      }),
    [activeSurfaceName, appId, invokeAction, navigate, query, setStateValue, surface?.name],
  );

  const ctx = useMemo(
    () =>
      surface
        ? {
            appId,
            surface: surface.name,
            client,
            surfaceActions: surface.actions,
            uiState,
            allowCustomCode,
            dataRevision,
          }
        : null,
    [allowCustomCode, appId, client, dataRevision, surface, uiState],
  );

  if (error) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="flex items-center gap-2 rounded-card border border-line bg-surface px-4 py-3 text-[13px] text-text-secondary">
          <AlertTriangle size={16} className="text-warn" />
          {error}
        </div>
      </div>
    );
  }
  if (!surface || !ctx) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-text-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }
  return (
    <RuntimeProvider value={ctx}>
      <div className="w-full p-4 sm:p-6">
        {surface.view ? <ViewRenderer node={surface.view} /> : <p className="text-text-muted">Empty surface.</p>}
      </div>
    </RuntimeProvider>
  );
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object' || Array.isArray(acc)) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}

function setPath(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return source;
  const [head, ...rest] = parts;
  if (!head) return source;
  if (rest.length === 0) return { ...source, [head]: value };
  const child = source[head];
  return {
    ...source,
    [head]: setPath(child && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : {}, rest.join('.'), value),
  };
}
