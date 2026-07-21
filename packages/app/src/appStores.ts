/**
 * buildAppStores — single construction point for the Agentic App stores with
 * realtime emit wired to the bus (AGENTIC-APPS-10X §4/§5).
 *
 * Shared by the `/v1/apps` routes and the chat tool-handler family so both
 * paths emit identical `DATA_CHANGED` / `SURFACE_RENDER` / `SURFACE_PATCH`
 * events and there is exactly one wiring of the bus → store seam.
 */

import { REALTIME_EVENTS, REALTIME_ROOMS } from '@agentis/core';
import type { AgentisSqliteDb } from '@agentis/db/sqlite';
import { AppStore } from './appStore.js';
import { AppDatastore } from './appDatastore.js';
import { AppSurfaceStore } from './appSurfaceStore.js';

export interface AppStores {
  store: AppStore;
  data: AppDatastore;
  surfaces: AppSurfaceStore;
}

export interface AppRealtimePublisher {
  publish(room: string, event: string, payload: unknown): void;
}

const APP_LIFECYCLE_EVENT = {
  created: REALTIME_EVENTS.APP_CREATED,
  updated: REALTIME_EVENTS.APP_UPDATED,
  deleted: REALTIME_EVENTS.APP_DELETED,
} as const;

export function buildAppStores(deps: { db: AgentisSqliteDb; bus?: AppRealtimePublisher }): AppStores {
  const bus = deps.bus;
  const store = new AppStore(deps.db, (e) => {
    if (!bus) return;
    // App-entity/membership change → app room (open App view) + workspace room
    // (the app list / home), the same dual-publish pattern as DATA_CHANGED so the
    // web refetches without a manual reload.
    const payload = { appId: e.appId, op: e.op };
    bus.publish(REALTIME_ROOMS.app(e.appId), APP_LIFECYCLE_EVENT[e.op], payload);
    bus.publish(REALTIME_ROOMS.workspace(e.workspaceId), APP_LIFECYCLE_EVENT[e.op], payload);
  });
  const data = new AppDatastore(deps.db, (e) => {
    if (!bus) return;
    // Carry the changed row (flattened to the client's `{id, ...data}` shape) so a
    // bound view can apply a row-level DELTA in place instead of re-querying the
    // whole collection. Delete/bulk omit it → the view falls back to a refetch.
    const row = e.record ? { id: e.record.id, ...e.record.data } : undefined;
    const payload = { appId: e.appId, collection: e.collection, op: e.op, id: e.id, ...(row ? { record: row } : {}) };
    bus.publish(REALTIME_ROOMS.app(e.appId), REALTIME_EVENTS.DATA_CHANGED, payload);
    bus.publish(REALTIME_ROOMS.workspace(e.workspaceId), REALTIME_EVENTS.DATA_CHANGED, payload);
  });
  const surfaces = new AppSurfaceStore({
    db: deps.db,
    emit: (e) => {
      if (!bus) return;
      const event = e.event === 'render' ? REALTIME_EVENTS.SURFACE_RENDER : REALTIME_EVENTS.SURFACE_PATCH;
      const payload = { appId: e.appId, surfaceId: e.surfaceId, revision: e.revision, ...(e.payload as object) };
      bus.publish(REALTIME_ROOMS.app(e.appId), event, payload);
      bus.publish(REALTIME_ROOMS.workspace(e.workspaceId), event, payload);
    },
  });
  return { store, data, surfaces };
}



