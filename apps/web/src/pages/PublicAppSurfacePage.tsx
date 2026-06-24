/**
 * PublicAppSurfacePage - renders a shared Agentic App surface read-only.
 *
 * Public links can query token-gated data, but actions and CustomView execution
 * stay disabled unless a future public policy model deliberately grants them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { createInProcessAppClient } from '@agentis/app-client';
import type { AppSurface } from '@agentis/core';
import { appsApi } from '../lib/appsApi';
import { apiErrorMessage } from '../lib/api';
import { RuntimeProvider, ViewRenderer } from '../components/apps/ViewRenderer';

export function PublicAppSurfacePage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<{ app: { name: string; icon: string | null }; surface: AppSurface } | null>(null);
  const [uiState, setUiState] = useState<Record<string, unknown>>({});
  const uiStateRef = useRef(uiState);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    uiStateRef.current = uiState;
  }, [uiState]);

  useEffect(() => {
    let cancelled = false;
    appsApi
      .publicSurface(token)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(apiErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const query = useCallback(
    (collection: string, q?: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number }) =>
      appsApi.publicQuery(token, collection, q ?? {}).then((res) => res.rows.map((r) => ({ id: r.id, ...r.data }))),
    [token],
  );

  const client = useMemo(
    () =>
      createInProcessAppClient({
        appId: '',
        surface: data?.surface.name ?? 'public',
        query,
        invokeAction: async () => undefined,
        getState: (key) => (key ? uiStateRef.current[key] : uiStateRef.current),
        setState: (key, value) => setUiState((prev) => ({ ...prev, [key]: value })),
        navigate: () => undefined,
      }),
    [data?.surface.name, query],
  );

  const ctx = useMemo(
    () =>
      data
        ? {
            appId: '',
            surface: data.surface.name,
            client,
            surfaceActions: data.surface.actions,
            uiState,
            allowCustomCode: false,
            dataRevision: 0,
          }
        : null,
    [client, data, uiState],
  );

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 text-text-primary">
        <div className="w-full max-w-md rounded-card border border-line bg-surface p-5 text-center shadow-card">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-btn bg-danger-soft text-danger"><AlertTriangle size={18} /></div>
          <h1 className="mt-3 text-[16px] font-semibold">Surface unavailable</h1>
          <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }
  if (!data || !ctx) {
    return <div className="flex min-h-screen items-center justify-center bg-canvas text-text-muted"><Loader2 className="animate-spin" /></div>;
  }
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface px-4 py-3">
        <span className="flex items-center gap-1.5 text-[14px] font-semibold text-text-primary">
          {data.app.icon ? (
            data.app.icon.startsWith('http://') || data.app.icon.startsWith('https://') || data.app.icon.startsWith('data:image/') ? (
              <img src={data.app.icon} alt="" className="h-4 w-4 shrink-0 rounded-sm object-cover" />
            ) : (
              <span>{data.app.icon}</span>
            )
          ) : (
            <span className="text-text-muted">App</span>
          )}
          <span>{data.app.name}</span>
        </span>
      </header>
      <RuntimeProvider value={ctx}>
        <div className="mx-auto w-full max-w-3xl p-4">
          {data.surface.view ? <ViewRenderer node={data.surface.view} /> : <p className="text-text-muted">Empty surface.</p>}
        </div>
      </RuntimeProvider>
    </div>
  );
}
