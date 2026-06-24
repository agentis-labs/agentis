/**
 * Agentic Apps client (AGENTIC-APPS-10X §3/§4/§5). Thin typed wrappers over the
 * `/v1/apps` routes used by the Apps pages and the AppRuntime renderer.
 */
import type {
  AppEnvironment,
  AppManifest,
  AppRecord,
  AppSurface,
  CollectionRecord,
  CollectionInfo,
  AppManifestEnvelope,
  AppInstallPreview,
  SurfaceAction,
  ViewNode,
} from '@agentis/core';
import { api } from './api';

/** Result of agent-assisted surface generation (`POST /:id/surfaces/generate`). */
export interface GeneratedSurface {
  view: ViewNode;
  actions: SurfaceAction[];
  /** `model` when the agent authored it; `fallback` for the deterministic scaffold. */
  source: 'model' | 'fallback';
}

/** The agent operating an App — drives the AgentConsole presence + command line. */
export interface AppOperator {
  agentId: string;
  name: string;
  status: 'online' | 'busy' | 'offline' | 'error' | string;
  colorHex: string | null;
  role: 'operator' | 'worker' | string;
  /** True when a command can be dispatched (a workflow + engine are wired). */
  canCommand: boolean;
}

interface Wrapped<T> {
  data: T;
}

export type AppUpdatePayload = Partial<{
  name: AppRecord['name'];
  description: AppRecord['description'];
  icon: AppRecord['icon'];
  status: AppRecord['status'];
  version: AppRecord['version'];
  entrySurfaceId: AppRecord['entrySurfaceId'];
  domainId: AppRecord['domainId'];
  ownerAgentId: AppRecord['ownerAgentId'];
  manifest: Partial<AppRecord['manifest']>;
  policy: Partial<AppRecord['policy']>;
  source: AppRecord['source'];
  installedChecksum: AppRecord['installedChecksum'];
}>;

export const appsApi = {
  list: () => api<Wrapped<AppRecord[]>>('/v1/apps').then((r) => r.data),
  get: (id: string) => api<Wrapped<AppRecord>>(`/v1/apps/${id}`).then((r) => r.data),
  create: (body: {
    name: string;
    description?: string;
    domainId?: string | null;
    ownerAgentId?: string | null;
    entryWorkflowId?: string;
    createEntryWorkflow?: boolean;
    entryWorkflowTitle?: string;
  }) =>
    api<Wrapped<AppRecord>>('/v1/apps', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data),
  promoteWorkflow: (workflowId: string) =>
    api<Wrapped<AppRecord>>(`/v1/apps/from-workflow/${encodeURIComponent(workflowId)}`, { method: 'POST' }).then((r) => r.data),
  update: (id: string, body: AppUpdatePayload) =>
    api<Wrapped<AppRecord>>(`/v1/apps/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.data),
  remove: (id: string) => api(`/v1/apps/${id}`, { method: 'DELETE' }),

  // Surfaces
  listSurfaces: (id: string) => api<Wrapped<AppSurface[]>>(`/v1/apps/${id}/surfaces`).then((r) => r.data),
  getSurface: (id: string, name: string) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(name)}`).then((r) => r.data),
  renameSurface: (id: string, name: string, nextName: string) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: nextName }),
    }).then((r) => r.data),
  removeSurface: (id: string, name: string) =>
    api<Wrapped<{ ok: true }>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.data),
  upsertSurface: (id: string, body: { name: string; kind?: string; view?: unknown; actions?: unknown[]; shareable?: boolean }) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces`, { method: 'PUT', body: JSON.stringify(body) }).then((r) => r.data),
  generateSurface: (id: string, body: { prompt: string; surface?: string }) =>
    api<Wrapped<GeneratedSurface>>(`/v1/apps/${id}/surfaces/generate`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.data),

  // Operator (the agentic core)
  operator: (id: string) => api<Wrapped<AppOperator | null>>(`/v1/apps/${id}/operator`).then((r) => r.data),
  runOperatorCommand: (id: string, command: string) =>
    api<Wrapped<unknown>>(`/v1/apps/${id}/operator/command`, { method: 'POST', body: JSON.stringify({ command }) }).then((r) => r.data),
  exportApp: (id: string) => api<Wrapped<AppManifestEnvelope>>(`/v1/apps/${id}/export`).then((r) => r.data),
  previewImport: (envelope: AppManifestEnvelope) =>
    api<Wrapped<AppInstallPreview>>('/v1/apps/import/preview', { method: 'POST', body: JSON.stringify(envelope) }).then((r) => r.data),
  importApp: (envelope: AppManifestEnvelope, permissionsAcknowledged: string[]) =>
    api<Wrapped<{ appId: string }>>('/v1/apps/import', {
      method: 'POST',
      body: JSON.stringify({ envelope, permissionsAcknowledged }),
    }).then((r) => r.data),
  listEnvironments: (id: string) =>
    api<Wrapped<AppEnvironment[]>>(`/v1/apps/${id}/environments`).then((r) => r.data),
  snapshotEnvironment: (id: string, name: string, kind: 'dev' | 'staging' | 'production') =>
    api<Wrapped<AppEnvironment>>(`/v1/apps/${id}/environments/${encodeURIComponent(name)}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ kind }),
    }).then((r) => r.data),
  upsertEnvironment: (id: string, name: string, body: { kind: 'dev' | 'staging' | 'production'; manifest: AppManifest }) =>
    api<Wrapped<AppEnvironment>>(`/v1/apps/${id}/environments/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }).then((r) => r.data),
  promoteEnvironment: (
    id: string,
    name: string,
    body: { targetName: string; targetKind: 'dev' | 'staging' | 'production'; applyToRuntime: boolean },
  ) =>
    api<Wrapped<{ environment: AppEnvironment; runtimeUpgrade?: unknown }>>(`/v1/apps/${id}/environments/${encodeURIComponent(name)}/promote`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((r) => r.data),
  listWorkflowIds: (id: string) => api<Wrapped<string[]>>(`/v1/apps/${id}/workflows`).then((r) => r.data),
  adoptWorkflow: (id: string, workflowId: string) =>
    api<Wrapped<string[]>>(`/v1/apps/${id}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ workflowId }),
    }).then((r) => r.data),
  dispatchAction: (id: string, surface: string, action: string, args: Record<string, unknown>) =>
    api<Wrapped<unknown>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(surface)}/actions/${encodeURIComponent(action)}`, {
      method: 'POST',
      body: JSON.stringify({ args }),
    }),

  // Datastore
  listCollections: (id: string) => api<Wrapped<CollectionInfo[]>>(`/v1/apps/${id}/collections`).then((r) => r.data),
  query: (
    id: string,
    collection: string,
    q: { filter?: Record<string, unknown>; sort?: Array<{ field: string; dir: 'asc' | 'desc' }>; limit?: number; cursor?: string },
  ) =>
    api<{ rows: CollectionRecord[]; nextCursor?: string }>(
      `/v1/apps/${id}/collections/${encodeURIComponent(collection)}/query`,
      { method: 'POST', body: JSON.stringify(q) },
    ),

  // Public, unauthed share (AGENTIC-APPS-10X §4.7)
  publicSurface: (token: string) =>
    api<Wrapped<{ app: { name: string; icon: string | null }; surface: AppSurface }>>(`/v1/apps/public/surfaces/${encodeURIComponent(token)}`).then((r) => r.data),
  publicQuery: (token: string, collection: string, q: Record<string, unknown>) =>
    api<{ rows: CollectionRecord[]; nextCursor?: string }>(
      `/v1/apps/public/surfaces/${encodeURIComponent(token)}/query`,
      { method: 'POST', body: JSON.stringify({ collection, ...q }) },
    ),
};
