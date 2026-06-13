/**
 * Specialists API client + shared types for the web UI.
 *
 * Thin wrapper around `api()` mirroring `/v1/specialists`
 * (docs/SPECIALISTS-10X-ARCHITECTURE-PLAN.md). A specialist is an expert *role*
 * — platform, custom, AI-generated, or community — that may or may not be
 * materialized as a runnable agent yet.
 */

import { api } from './api';

export type SpecialistSource = 'platform' | 'custom' | 'community' | 'generated';
export type SpecialistStatus = 'live' | 'offline' | 'draft';

export interface SpecialistSummary {
  role: string;
  name: string;
  description: string;
  source: SpecialistSource;
  status: SpecialistStatus;
  agentId: string | null;
  tools: string[];
  capabilityTags: string[];
  avatarGlyph: string;
  colorHex: string;
}

export interface SpecialistProfile {
  id: string;
  role: string;
  name: string;
  title: string | null;
  description: string | null;
  identityPrompt: string | null;
  responsibilityContract: string | null;
  boundaries: string | null;
  status: 'draft' | 'ready' | 'degraded' | 'archived';
  runtimeProfile: Record<string, unknown>;
  version: number;
}

export interface SpecialistMind {
  role: string;
  summary: string | null;
  status: string;
  sources: Array<{ id: string; kind: string; title: string | null; uri: string | null; trust: string; status: string; rawExcerpt: string | null; createdAt: string }>;
  atoms: Array<{ id: string; sourceId: string | null; atomType: string; content: string; confidence: number; tags: string[]; createdAt: string }>;
  media: Array<{ id: string; sourceId: string | null; mimeType: string | null; caption: string | null; palette: string[]; layoutNotes: string | null; tags: string[]; createdAt: string }>;
}

export interface SpecialistLoadoutEntry {
  id: string;
  role: string;
  abilityId: string;
  mode: 'required' | 'preferred' | 'optional' | 'forbidden';
  priority: number;
  minRelevanceScore: number | null;
  conflictPolicy: string;
  enabled: boolean;
  ability: { id: string; name: string; slug: string; description: string | null; domainTag: string | null; compileStatus: string } | null;
}

export interface SpecialistEvalCase {
  id: string;
  role: string;
  name: string;
  input: string;
  expected: string | null;
  rubric: string | null;
  tags: string[];
  createdAt: string;
}

export interface SpecialistEvalRun {
  id: string;
  evalCaseId: string;
  role: string;
  status: string;
  score: number;
  output: string | null;
  reasoning: string | null;
  promotedAtomId: string | null;
  createdAt: string;
}

export interface SpecialistRun {
  id: string;
  role: string;
  agentId: string | null;
  topology: string;
  status: string;
  task: string;
  trace: Array<{ at: string; event: string; summary: string; metadata?: Record<string, unknown> }>;
  outputSummary: string | null;
  artifactId: string | null;
  createdAt: string;
}

export interface CreateSpecialistBody {
  role?: string;
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  tools?: string[];
  capabilityTags?: string[];
  colorHex?: string;
  avatarGlyph?: string;
}

export const specialistsApi = {
  list(): Promise<{ specialists: SpecialistSummary[]; count: number }> {
    return api('/v1/specialists');
  },
  create(body: CreateSpecialistBody): Promise<{ specialist: SpecialistSummary; created: boolean }> {
    return api('/v1/specialists', { method: 'POST', body: JSON.stringify(body) });
  },
  get(role: string): Promise<{ profile: SpecialistProfile; loadout: Array<{ name: string; mode: string }> }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}`);
  },
  patch(role: string, body: Partial<Pick<SpecialistProfile, 'name' | 'title' | 'description' | 'identityPrompt' | 'responsibilityContract' | 'boundaries' | 'status'>> & { runtimeProfile?: Record<string, unknown> }): Promise<{ profile: SpecialistProfile }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  compile(role: string): Promise<{ profile: SpecialistProfile; mind: { atomCount: number; summary: string }; evals: { cases: number } }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/compile`, { method: 'POST' });
  },
  compileStatus(role: string): Promise<{ status: Record<string, unknown> }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/compile-status`);
  },
  mind(role: string): Promise<{ mind: SpecialistMind }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/mind`);
  },
  addMindSource(role: string, body: { kind?: string; title?: string; content?: string; uri?: string; imageBase64?: string; mimeType?: string; caption?: string; trust?: string }): Promise<{ sourceId: string; atomCount?: number; mediaId?: string; extracted?: boolean }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/mind/sources`, { method: 'POST', body: JSON.stringify(body) });
  },
  compileMind(role: string): Promise<{ mind: { atomCount: number; summary: string } }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/mind/compile`, { method: 'POST' });
  },
  abilities(role: string): Promise<{ role: string; loadout: SpecialistLoadoutEntry[]; abilities: Array<{ id: string; name: string; slug: string; description: string | null; domainTag: string | null; compileStatus: string }> }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/abilities`);
  },
  setAbility(role: string, abilityId: string, body: { mode?: string; priority?: number; minRelevanceScore?: number | null; enabled?: boolean }): Promise<{ entry: SpecialistLoadoutEntry }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/abilities/${encodeURIComponent(abilityId)}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  removeAbility(role: string, abilityId: string): Promise<{ ok: true }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/abilities/${encodeURIComponent(abilityId)}`, { method: 'DELETE' });
  },
  evals(role: string): Promise<{ cases: SpecialistEvalCase[]; runs: SpecialistEvalRun[]; qualityEvents: Array<{ id: string; summary: string; severity: string; createdAt: string }> }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/evals`);
  },
  addEvalCase(role: string, body: { name: string; input: string; expected?: string | null; rubric?: string | null; tags?: string[] }): Promise<{ case: SpecialistEvalCase }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/evals`, { method: 'POST', body: JSON.stringify(body) });
  },
  runEval(role: string, caseId: string, output?: string): Promise<{ run: SpecialistEvalRun }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/evals/${encodeURIComponent(caseId)}/run`, { method: 'POST', body: JSON.stringify({ output }) });
  },
  promoteEval(role: string, runId: string): Promise<{ run: SpecialistEvalRun }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/evals/runs/${encodeURIComponent(runId)}/promote`, { method: 'POST' });
  },
  request(body: { task: string; modality?: string; desiredTopology?: string; materialize?: boolean }): Promise<{ route: { traceId: string; selectedRole: string; selectedAgentId: string | null; topology: string; score: number; explanation: string; specialistRun: SpecialistRun | null } }> {
    return api('/v1/specialists/request', { method: 'POST', body: JSON.stringify(body) });
  },
  runs(role: string): Promise<{ runs: SpecialistRun[] }> {
    return api(`/v1/specialists/${encodeURIComponent(role)}/runs`);
  },
};
