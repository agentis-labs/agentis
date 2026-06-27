/**
 * Agentic Apps client (AGENTIC-APPS-10X §3/§4/§5). Thin typed wrappers over the
 * `/v1/apps` routes used by the Apps pages and the AppRuntime renderer.
 */
import type {
  AppPresenceViewer,
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

/** One seat in an App's cast (the Team strip — Phase R birth-staff). */
export interface AppTeamMember {
  agentId: string;
  memberRole: 'operator' | 'worker' | string;
  name: string;
  functionalRole: string | null;
  colorHex: string | null;
  avatarGlyph: string | null;
  status: string;
  isOwner: boolean;
}

export interface AppTeam {
  ownerAgentId: string | null;
  members: AppTeamMember[];
}

/** A live App conversation (Phase 1 — the real channel thread, not a datastore row). */
export interface AppConversation {
  id: string;
  title: string;
  channel: string | null;
  lastMessageAt: string | null;
  unread: number;
  /** 'human' when an operator has taken over the thread (Phase 2). */
  handoffState: 'human' | null;
}

export interface AppConversationMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  at: string;
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
    entryWorkflowGraph?: Record<string, unknown>;
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
  // Phase M3 — operator pin/dismiss of a performed AgentRegion.
  performRegion: (id: string, surface: string, body: { region: string; pin?: boolean; clear?: boolean; reason?: string }) =>
    api<Wrapped<AppSurface>>(`/v1/apps/${id}/surfaces/${encodeURIComponent(surface)}/perform-region`, {
      method: 'POST', body: JSON.stringify(body),
    }).then((r) => r.data),

  // Operator (the agentic core)
  operator: (id: string) => api<Wrapped<AppOperator | null>>(`/v1/apps/${id}/operator`).then((r) => r.data),
  team: (id: string) => api<Wrapped<AppTeam>>(`/v1/apps/${id}/team`).then((r) => r.data),
  conversations: (id: string) => api<Wrapped<AppConversation[]>>(`/v1/apps/${id}/conversations`).then((r) => r.data),
  conversationMessages: (id: string, conversationId: string) =>
    api<Wrapped<AppConversationMessage[]>>(`/v1/apps/${id}/conversations/${conversationId}/messages`).then((r) => r.data),
  takeoverConversation: (id: string, conversationId: string, active: boolean) =>
    api<Wrapped<{ conversationId: string; handoffState: 'human' | null }>>(`/v1/apps/${id}/conversations/${conversationId}/takeover`, {
      method: 'POST', body: JSON.stringify({ active }),
    }).then((r) => r.data),
  sendToConversation: (id: string, conversationId: string, body: string) =>
    api<Wrapped<{ conversationId: string; delivered: boolean }>>(`/v1/apps/${id}/conversations/${conversationId}/send`, {
      method: 'POST', body: JSON.stringify({ body }),
    }).then((r) => r.data),
  // Live co-presence (G9) — heartbeat while viewing; leave on unmount. Ephemeral.
  presence: (id: string, conversationId?: string | null) =>
    api<Wrapped<{ viewers: AppPresenceViewer[] }>>(`/v1/apps/${id}/presence`, {
      method: 'POST', body: JSON.stringify({ conversationId: conversationId ?? null }),
    }).then((r) => r.data.viewers),
  leavePresence: (id: string) =>
    api<Wrapped<{ viewers: AppPresenceViewer[] }>>(`/v1/apps/${id}/presence`, { method: 'DELETE' }).then((r) => r.data.viewers),
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
