/**
 * Typed client for the MCP / A2A / governance / interaction surfaces
 * (UNIVERSAL-HARNESS Pillars 4-6). Thin wrappers over the shared `api()` client.
 */

import { api } from './api';

// ─── MCP: consume (external servers) ────────────────────────────────────────

export interface McpServer {
  id: string;
  name: string;
  url: string;
  headerKeys: string[];
  /** Vault credential resolved into headers at call time (secrets plane). */
  credentialId?: string;
  /** Least-privilege tool allowlist; empty/absent = all tools. */
  allowedTools?: string[];
  createdAt: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export function listMcpServers() {
  return api<{ servers: McpServer[] }>('/v1/mcp-servers');
}

export function addMcpServer(input: { name: string; url: string; headers?: Record<string, string>; credentialId?: string; allowedTools?: string[] }) {
  return api<{ server: McpServer }>('/v1/mcp-servers', { method: 'POST', body: JSON.stringify(input) });
}

export function updateMcpServer(id: string, patch: { allowedTools?: string[] | null; credentialId?: string | null; allowPrivateNetwork?: boolean }) {
  return api<{ server: McpServer }>(`/v1/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteMcpServer(id: string) {
  return api<{ ok: true }>(`/v1/mcp-servers/${id}`, { method: 'DELETE' });
}

export function listMcpServerTools(id: string) {
  return api<{ serverId: string; tools: McpTool[] }>(`/v1/mcp-servers/${id}/tools`);
}

/** Actually handshake a mounted server — the truthful "is it connected?" check. */
export function verifyMcpServer(id: string) {
  return api<{ ok: boolean; serverId: string; toolCount?: number; tools?: string[]; error?: string }>(
    `/v1/mcp-servers/${id}/verify`, { method: 'POST' },
  );
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  category: string;
  url: string;
  authType: 'none' | 'oauth' | 'token' | 'header';
  authHint: string;
  description: string;
  docsUrl?: string;
  connectorService?: string;
}

export function listMcpCatalog() {
  return api<{ catalog: McpCatalogEntry[] }>('/v1/mcp-servers/catalog');
}

/** Begin the spec-compliant "Connect with X" OAuth flow for a mounted server. */
export function beginMcpOAuth(serverId: string, origin: string) {
  return api<{ url: string }>(`/v1/mcp-oauth/${serverId}/authorize`, {
    method: 'POST', body: JSON.stringify({ origin }),
  });
}

// ─── MCP: expose (Agentis as a server) ──────────────────────────────────────

export interface McpServerCard {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  toolCount: number;
  endpoint: string;
}

export function getMcpServerCard() {
  return api<McpServerCard>('/v1/mcp/server-card');
}

// ─── A2A: agent cards ───────────────────────────────────────────────────────

export interface AgentCardSkill { id: string; name: string; description: string; tags: string[] }
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; affordances?: string[] };
  skills: AgentCardSkill[];
}

export function getWorkspaceAgentCard() {
  return api<AgentCard>('/v1/a2a/agent-card.json');
}

export function listAgentCards() {
  return api<{ agents: AgentCard[] }>('/v1/a2a/agents');
}

// ─── Governance / fleet ─────────────────────────────────────────────────────

export interface GovernanceSummary {
  fleet: {
    totalAgents: number;
    connected: number;
    byAdapter: Record<string, { total: number; connected: number; online: number; spendCents: number }>;
  };
  cost: { spendTodayCents: number; monthlySpendCents: number; limitHitsToday: number };
  approvals: { pending: number };
  audit: { recentCount: number; latestAt: string | null };
}

export function getGovernanceSummary() {
  return api<GovernanceSummary>('/v1/governance/summary');
}

// ─── Agent interaction feed ─────────────────────────────────────────────────

export interface InteractionEvent {
  id: string;
  at: string;
  kind: 'message' | 'activity';
  eventType: string;
  actor: { type: string; id: string | null };
  summary: string;
  roomId?: string;
  entity?: { type: string; id: string };
}

export function listInteractions(params: { agentId?: string; roomId?: string; limit?: number; before?: string } = {}) {
  const q = new URLSearchParams();
  if (params.agentId) q.set('agentId', params.agentId);
  if (params.roomId) q.set('roomId', params.roomId);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.before) q.set('before', params.before);
  const qs = q.toString();
  return api<{ events: InteractionEvent[]; nextBefore: string | null }>(`/v1/interactions${qs ? `?${qs}` : ''}`);
}

export function centsToUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Harness memory ingestion (the agent's "transition into Agentis") ─────────

export interface IngestCandidate {
  hash: string;
  title: string;
  summary: string;
  type: string;
  section: string;
  quality: number;
  duplicateOf?: { episodeId: string; kind: 'exact' | 'semantic' } | null;
  origin: { adapterType: string; fileName: string };
}

export interface IngestPreview {
  agentId: string;
  scannedFiles: Array<{ fileName: string; source: string; candidateCount: number; skipped: boolean }>;
  candidates: IngestCandidate[];
  minQuality: number;
}

export interface IngestResult {
  written: number;
  reinforced: number;
  skipped: number;
  episodeIds: string[];
}

export function previewHarnessMemory(agentId: string) {
  return api<IngestPreview>(`/v1/agents/${agentId}/memory/ingest/preview`);
}

export function commitHarnessMemory(agentId: string, acceptHashes: string[]) {
  return api<IngestResult>(`/v1/agents/${agentId}/memory/ingest`, {
    method: 'POST',
    body: JSON.stringify({ acceptHashes }),
  });
}
