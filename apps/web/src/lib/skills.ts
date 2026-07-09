

import { api } from './api';

export interface SkillListItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  confidence: number;
  scopeId: string | null;
  updatedAt: string;
}

export interface SkillDetail extends SkillListItem {
  workspaceId: string;
  body: string;
  createdAt: string;
}

export interface LinkedAtom {
  id: string;
  title: string;
  content: string;
}

export interface SkillExample {
  id: string;
  title: string;
  content: string;
  scopeId: string | null;
  updatedAt: string;
}

export interface SkillScopeOptions {
  scopeId?: string | null;
  includeWorkspace?: boolean;
}

function scopedPath(base: string, options?: SkillScopeOptions): string {
  const params = new URLSearchParams();
  if (options?.scopeId) params.set('scopeId', options.scopeId);
  if (options?.includeWorkspace === false) params.set('includeWorkspace', 'false');
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export const skillsApi = {
  list: (options?: SkillScopeOptions) => api<{ skills: SkillListItem[] }>(scopedPath('/v1/skills', options)),
  examples: (options?: SkillScopeOptions) => api<{ examples: SkillExample[] }>(scopedPath('/v1/skills/examples', options)),
  get: (id: string) => api<{ skill: SkillDetail; examples: LinkedAtom[]; lessons: LinkedAtom[] }>(`/v1/skills/${id}`),
  create: (input: { name: string; description: string; body: string; scopeId?: string | null }) =>
    api<{ skill: SkillDetail }>('/v1/skills', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: { name?: string; description?: string; body?: string }) =>
    api<{ skill: SkillDetail }>(`/v1/skills/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => api<{ ok: boolean }>(`/v1/skills/${id}`, { method: 'DELETE' }),
  createExample: (skillId: string, body: { inputText: string; outputText: string }) =>
    api<{ id: string }>(`/v1/skills/${skillId}/examples`, { method: 'POST', body: JSON.stringify(body) }),
};



