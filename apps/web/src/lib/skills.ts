/**
 * Skills API client — the operator surface for Living Skills (the /v1/skills route).
 *
 * A Skill is a Brain `skill` atom: a name + discoverable description + a SKILL.md
 * body (the procedure), carrying a live confidence score that moves with run
 * outcomes. Examples are `skill`-library `example` atoms.
 */

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

export const skillsApi = {
  list: () => api<{ skills: SkillListItem[] }>('/v1/skills'),
  examples: () => api<{ examples: SkillExample[] }>('/v1/skills/examples'),
  get: (id: string) => api<{ skill: SkillDetail; examples: LinkedAtom[]; lessons: LinkedAtom[] }>(`/v1/skills/${id}`),
  create: (input: { name: string; description: string; body: string; scopeId?: string | null }) =>
    api<{ skill: SkillDetail }>('/v1/skills', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, patch: { name?: string; description?: string; body?: string }) =>
    api<{ skill: SkillDetail }>(`/v1/skills/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => api<{ ok: boolean }>(`/v1/skills/${id}`, { method: 'DELETE' }),
};
