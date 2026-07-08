/**
 * SurfaceCanvas — the WYSIWYG builder canvas.
 *
 * Renders the *draft* (unsaved) ViewNode tree through the real {@link ViewRenderer}
 * in edit mode, so what you build is pixel-true to what ships. It provides a
 * design-mode app client: data queries run for real (bound tables/charts show
 * live rows) while actions are inert. Structural edits (select, move, duplicate,
 * remove, inline text) are applied to the draft via the pure `viewTree` helpers
 * and surfaced back through `onChange`.
 */
import { useMemo } from 'react';
import { createInProcessAppClient } from '@agentis/app-client';
import type { ViewNode } from '@agentis/core';
import { appsApi } from '../../lib/appsApi';
import { RuntimeProvider, SurfaceEditProvider, ViewRenderer, useDataRevision, type SurfaceEditContext } from './ViewRenderer';
import { duplicateNodeAtPath, moveNodeAtPath, removeNodeAtPath, updateNodeAtPath } from './viewTree';

export function SurfaceCanvas({
  appId,
  view,
  selectedPath,
  onSelect,
  onChange,
}: {
  appId: string;
  view: ViewNode;
  selectedPath: number[];
  onSelect: (path: number[]) => void;
  onChange: (view: ViewNode) => void;
}) {
  const dataRevision = useDataRevision(appId);

  const client = useMemo(
    () =>
      createInProcessAppClient({
        appId,
        surface: '(draft)',
        query: async (collection, q) => {
          const res = await appsApi.query(appId, collection, q ?? {});
          return res.rows.map((r) => ({ id: r.id, ...r.data }));
        },
        // Design mode: actions never fire while building.
        invokeAction: async () => undefined,
        getState: () => undefined,
        setState: () => {},
        navigate: () => {},
      }),
    [appId],
  );

  const runtimeCtx = useMemo(
    () => ({
      appId,
      surface: '(draft)',
      client,
      surfaceActions: [],
      uiState: {},
      allowCustomCode: false,
      dataRevision,
    }),
    [appId, client, dataRevision],
  );

  const editCtx = useMemo<SurfaceEditContext>(
    () => ({
      selectedPath,
      onSelect,
      onMove: (path, dir) => onChange(moveNodeAtPath(view, path, dir)),
      onDuplicate: (path) => onChange(duplicateNodeAtPath(view, path)),
      onRemove: (path) => {
        onChange(removeNodeAtPath(view, path));
        onSelect([]);
      },
      onSetValue: (path, value) => onChange(updateNodeAtPath(view, path, (node) => ({ ...node, value }) as ViewNode)),
    }),
    [onChange, onSelect, selectedPath, view],
  );

  return (
    <RuntimeProvider value={runtimeCtx}>
      <SurfaceEditProvider value={editCtx}>
        <ViewRenderer node={view} />
      </SurfaceEditProvider>
    </RuntimeProvider>
  );
}



