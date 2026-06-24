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

export function buildAppStores(deps: { db: AgentisSqliteDb; bus?: AppRealtimePublisher }): AppStores {
  const bus = deps.bus;
  const store = new AppStore(deps.db);
  const data = new AppDatastore(deps.db, (e) => {
    if (!bus) return;
    const payload = { appId: e.appId, collection: e.collection, op: e.op, id: e.id };
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
