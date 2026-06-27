/**
 * Abilities API client + shared types for the web UI.
 *
 * Thin wrapper around `api()` that mirrors `/v1/abilities` (docs/brain/ABILITIES.md
 * §8). Kept here so pages, panels, and the create wizard can share request shapes
 * without each rebuilding their own fetcher.
 */

import { api } from './api';

export type AbilityCompileStatus = 'pending' | 'compiling' | 'ready' | 'failed' | 'dirty';
export type AbilityCompileStage =
  | 'queued'
  | 'embedding_examples'
  | 'contextualizing_knowledge'
  | 'generating_synthetic_examples'
  | 'synthesizing_persona'
  | 'indexing_brain'
  | 'finalizing';
export type AbilityExampleSource = 'user_curated' | 'synthetic' | 'promoted_from_run' | 'imported';
export type AbilityKnowledgeSourceType = 'document' | 'image' | 'audio' | 'url' | 'manual';

export interface Ability {
  id: string;
  workspaceId: string | null;
  name: string;
  slug: string;
  description: string | null;
  domainTag: string | null;
  iconEmoji: string | null;
  compiledPrompt: string | null;
  specs: Record<string, string | undefined>;
  rulesAlways: string[];
  rulesNever: string[];
  toolHints: string[];
  exampleCount: number;
  knowledgeCount: number;
  compileStatus: AbilityCompileStatus;
  compileStage: AbilityCompileStage | null;
  compileCancelRequested: boolean;
  lastCompiledAt: string | null;
  compileError: string | null;
  isPublic: boolean;
  hubSlug: string | null;
  hubVersion: string;
  installCount: number;
  tokenBudget: number | null;
  version: string;
  kbDocumentId: string | null;
  // -- ABILITIES-10X --
  depth?: AbilityDepth;
  visibility?: AbilityVisibility;
  contentHash?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AbilityDepth = 'd0_instinct' | 'd1_knowledge' | 'd2_tuned' | 'd3_method' | 'd4_conductor';
export type AbilityVisibility = 'private' | 'workspace' | 'unlisted' | 'hub';

export const ABILITY_DEPTH_LABELS: Record<AbilityDepth, string> = {
  d0_instinct: 'Instinct',
  d1_knowledge: 'Knowledge',
  d2_tuned: 'Tuned',
  d3_method: 'Method',
  d4_conductor: 'Conductor',
};

export interface AbilityDraftResult {
  ability: Ability;
  synthesized: boolean;
  notes: string[];
}

export interface AbilityEvalRun {
  id: string;
  abilityId: string;
  kind: 'self_eval' | 'regression' | 'candidate_vs_base';
  score: number;
  passed: boolean;
  caseCount: number;
  failures: Array<{ input: string; reason: string; score?: number }>;
  summary: string | null;
  createdAt: string;
}

export interface AbilitySelfEvalResult {
  run: AbilityEvalRun;
  promotable: boolean;
}

export interface AbilityExample {
  id: string;
  abilityId: string;
  inputText: string;
  outputText: string;
  inputMediaUrl: string | null;
  mediaDescription: string | null;
  qualityScore: number;
  source: AbilityExampleSource;
  originRunId: string | null;
  createdAt: string;
}

export interface AbilityKnowledge {
  id: string;
  abilityId: string;
  kbChunkId: string | null;
  title: string | null;
  content: string;
  contextPrefix: string | null;
  sourceType: AbilityKnowledgeSourceType;
  sourceUrl: string | null;
  importanceScore: number;
  createdAt: string;
}

export interface AbilityPin {
  agentId: string;
  abilityId: string;
  enabled: boolean;
  createdAt: string;
}

export interface AbilityPackage {
  format_version: '1.0';
  manifest: {
    name: string;
    slug: string;
    version: string;
    domain_tag: string;
    icon_emoji?: string;
    description?: string;
    compiled_prompt: string;
    specs: Record<string, string | undefined>;
    rules_always: string[];
    rules_never: string[];
    tool_hints: string[];
    example_count: number;
  };
  examples: Array<{
    input_text: string;
    output_text: string;
    quality_score: number;
    source: AbilityExampleSource;
    embedding?: number[] | null;
  }>;
  knowledge: Array<{
    title?: string | null;
    content: string;
    importance_score: number;
    source_type: AbilityKnowledgeSourceType;
  }>;
}

export interface CreateAbilityBody {
  name: string;
  slug?: string;
  description?: string | null;
  domainTag?: string | null;
  iconEmoji?: string | null;
  specs?: Record<string, string | undefined>;
  rulesAlways?: string[];
  rulesNever?: string[];
  toolHints?: string[];
  tokenBudget?: number | null;
}

export type UpdateAbilityBody = Partial<CreateAbilityBody> & { isPublic?: boolean; compiledPrompt?: string | null };

export interface CompileConfigResponse {
  workspace: { baseUrl: string | null; model: string | null; adapterType: string | null; hasApiKey: boolean } | null;
  env: { baseUrl: string; model: string } | null;
  hasModel: boolean;
  catalog: {
    adapterType: string;
    models: Array<{
      id: string;
      label: string;
      provider: string;
      tier?: 'flagship' | 'balanced' | 'fast' | 'auto';
      recommended?: boolean;
      description?: string;
    }>;
  };
}

async function generateImageThumbnail(file: File): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const img = new window.Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const MAX = 400;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(null); };
    img.src = objectUrl;
  });
}

export const abilitiesApi = {
  list(): Promise<{ abilities: Ability[] }> {
    return api('/v1/abilities');
  },
  get(id: string): Promise<{ ability: Ability }> {
    return api(`/v1/abilities/${id}`);
  },
  create(body: CreateAbilityBody): Promise<{ ability: Ability }> {
    return api('/v1/abilities', { method: 'POST', body: JSON.stringify(body) });
  },
  update(id: string, body: UpdateAbilityBody): Promise<{ ability: Ability }> {
    return api(`/v1/abilities/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  delete(id: string): Promise<{ ok: true }> {
    return api(`/v1/abilities/${id}`, { method: 'DELETE' });
  },
  compile(id: string): Promise<{ ability: Ability }> {
    return api(`/v1/abilities/${id}/compile`, { method: 'POST', body: '{}' });
  },
  cancelCompile(id: string): Promise<{ ability: Ability }> {
    return api(`/v1/abilities/${id}/cancel-compile`, { method: 'POST', body: '{}' });
  },
  status(id: string): Promise<{
    compileStatus: AbilityCompileStatus;
    compileStage: AbilityCompileStage | null;
    compileCancelRequested: boolean;
    compileError: string | null;
    lastCompiledAt: string | null;
    exampleCount: number;
    knowledgeCount: number;
  }> {
    return api(`/v1/abilities/${id}/compile-status`);
  },
  getCompileConfig(): Promise<CompileConfigResponse> {
    return api('/v1/abilities/compile-config');
  },
  setCompileConfig(body: {
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
    adapterType?: string | null;
  }): Promise<{ ok: true }> {
    return api('/v1/abilities/compile-config', { method: 'PUT', body: JSON.stringify(body) });
  },
  listExamples(id: string): Promise<{ examples: AbilityExample[] }> {
    return api(`/v1/abilities/${id}/examples`);
  },
  addExample(
    id: string,
    body: { inputText: string; outputText: string; qualityScore?: number; source?: AbilityExampleSource },
  ): Promise<{ example: AbilityExample }> {
    return api(`/v1/abilities/${id}/examples`, { method: 'POST', body: JSON.stringify(body) });
  },
  updateExample(
    id: string,
    exampleId: string,
    body: { inputText?: string; outputText?: string; qualityScore?: number },
  ): Promise<{ example: AbilityExample }> {
    return api(`/v1/abilities/${id}/examples/${exampleId}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  deleteExample(id: string, exampleId: string): Promise<{ ok: true }> {
    return api(`/v1/abilities/${id}/examples/${exampleId}`, { method: 'DELETE' });
  },
  listKnowledge(id: string): Promise<{ knowledge: AbilityKnowledge[] }> {
    return api(`/v1/abilities/${id}/knowledge`);
  },
  addKnowledge(
    id: string,
    body: { title?: string | null; content: string; importanceScore?: number; sourceType?: AbilityKnowledgeSourceType; sourceUrl?: string | null },
  ): Promise<{ knowledge: AbilityKnowledge }> {
    return api(`/v1/abilities/${id}/knowledge`, { method: 'POST', body: JSON.stringify(body) });
  },
  deleteKnowledge(id: string, knowledgeId: string): Promise<{ ok: true }> {
    return api(`/v1/abilities/${id}/knowledge/${knowledgeId}`, { method: 'DELETE' });
  },
  async uploadKnowledgeFile(id: string, file: File): Promise<{ knowledge: AbilityKnowledge }> {
    const form = new FormData();
    form.set('file', file);
    form.set('name', file.name);
    form.set('mimeType', file.type || '');
    if (file.type.startsWith('image/')) {
      const thumbnail = await generateImageThumbnail(file);
      if (thumbnail) form.set('previewDataUrl', thumbnail);
    }
    return api<{ knowledge: AbilityKnowledge }>(`/v1/abilities/${id}/knowledge/upload`, {
      method: 'POST',
      body: form,
    });
  },
  export(id: string): Promise<AbilityPackage> {
    return api(`/v1/abilities/${id}/export`);
  },
  import(pkg: AbilityPackage): Promise<{ ability: Ability }> {
    return api('/v1/abilities/import', { method: 'POST', body: JSON.stringify(pkg) });
  },

  // ── ABILITIES-10X: the 10x creation engine ──────────────────
  /** Draft a finished, compiling specialist from an on-ramp (zero-cost). */
  draft(body: {
    from: 'intent' | 'examples' | 'material';
    intent?: string;
    examples?: Array<{ inputText: string; outputText: string }>;
    material?: string;
    materialTitle?: string;
    name?: string;
    domainTag?: string;
  }): Promise<AbilityDraftResult> {
    return api('/v1/abilities/draft', { method: 'POST', body: JSON.stringify(body) });
  },
  /** Clone-and-specialize an existing ability. */
  fork(sourceAbilityId: string, name?: string): Promise<AbilityDraftResult> {
    return api('/v1/abilities/fork', { method: 'POST', body: JSON.stringify({ sourceAbilityId, name }) });
  },
  /** Gap-fill positive + negative coverage examples. */
  refine(id: string): Promise<{ added: number; synthesized: boolean; notes: string[] }> {
    return api(`/v1/abilities/${id}/refine`, { method: 'POST', body: '{}' });
  },
  /** Run a zero-cost self-eval (the depth-promotion gate). */
  selfEval(id: string): Promise<AbilitySelfEvalResult> {
    return api(`/v1/abilities/${id}/eval`, { method: 'POST', body: '{}' });
  },
  evalRuns(id: string): Promise<{ evalRuns: AbilityEvalRun[] }> {
    return api(`/v1/abilities/${id}/eval-runs`);
  },
  /** Promote one rung up the depth ladder (eval-gated for d2+). */
  promote(id: string): Promise<{ from: AbilityDepth; to: AbilityDepth; promoted: boolean; reason: string; ability: Ability }> {
    return api(`/v1/abilities/${id}/promote`, { method: 'POST', body: '{}' });
  },
  /** Recent activation-ledger rows for the workspace (the flywheel). */
  activations(): Promise<{ activations: Array<{ id: string; abilityIds: string[]; outcome: string | null; createdAt: string }> }> {
    return api('/v1/abilities/activations');
  },
  hubInstall(hubSlug: string): Promise<{ ability: Ability }> {
    return api('/v1/abilities/hub-install', { method: 'POST', body: JSON.stringify({ hubSlug }) });
  },
  pins: {
    list(agentId: string): Promise<{ pins: AbilityPin[] }> {
      return api(`/v1/abilities/agents/${agentId}/pins`);
    },
    pin(agentId: string, abilityId: string): Promise<{ pin: AbilityPin }> {
      return api(`/v1/abilities/agents/${agentId}/pins/${abilityId}`, { method: 'PUT' });
    },
    setEnabled(agentId: string, abilityId: string, enabled: boolean): Promise<{ pin: AbilityPin }> {
      return api(`/v1/abilities/agents/${agentId}/pins/${abilityId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
    },
    unpin(agentId: string, abilityId: string): Promise<{ ok: true }> {
      return api(`/v1/abilities/agents/${agentId}/pins/${abilityId}`, { method: 'DELETE' });
    },
  },
};

export const DOMAIN_TAGS: Array<{ value: string; label: string }> = [
  { value: 'ui_engineering', label: 'UI Engineering' },
  { value: 'backend_engineering', label: 'Backend Engineering' },
  { value: 'devops', label: 'DevOps & Infrastructure' },
  { value: 'data_analysis', label: 'Data & Analytics' },
  { value: 'legal', label: 'Legal' },
  { value: 'sales', label: 'Sales & Marketing' },
  { value: 'content', label: 'Content & Writing' },
  { value: 'finance', label: 'Finance' },
  { value: 'design', label: 'Visual Design' },
  { value: 'research', label: 'Research' },
  { value: 'custom', label: 'Custom' },
];

export function compileStatusLabel(status: AbilityCompileStatus): string {
  switch (status) {
    case 'pending': return 'Not compiled';
    case 'compiling': return 'Compiling…';
    case 'ready': return 'Ready';
    case 'failed': return 'Compile failed';
    case 'dirty': return 'Needs recompile';
  }
}

export const COMPILE_STAGE_LABELS: Record<AbilityCompileStage, string> = {
  queued: 'Queued — waiting for specialist',
  embedding_examples: 'Embedding examples',
  contextualizing_knowledge: 'Contextualising knowledge',
  generating_synthetic_examples: 'Generating synthetic examples',
  synthesizing_persona: 'Synthesising specialist persona',
  indexing_brain: 'Indexing to workspace brain',
  finalizing: 'Finalising',
};

export const COMPILE_STAGE_ORDER: AbilityCompileStage[] = [
  'queued',
  'embedding_examples',
  'contextualizing_knowledge',
  'generating_synthetic_examples',
  'synthesizing_persona',
  'indexing_brain',
  'finalizing',
];

/**
 * Rough token cost the compile pipeline spends per run. Used for the picker
 * cost estimate so operators can plan budget before configuring a model.
 *   - probe (~30 tokens)
 *   - up to 3 synthetic-example calls (~3 × 1,200 tokens in/out)
 *   - persona synthesis (~1,500 tokens in/out)
 * Numbers are intentionally upper-bound estimates.
 */
export function estimateCompileTokens(): { min: number; max: number } {
  return { min: 1_200, max: 6_500 };
}

export function compileStatusTone(status: AbilityCompileStatus): 'neutral' | 'amber' | 'green' | 'red' {
  switch (status) {
    case 'ready': return 'green';
    case 'compiling': return 'amber';
    case 'dirty': return 'amber';
    case 'failed': return 'red';
    case 'pending': return 'neutral';
  }
}

/** Download an exported ability package as a .agentisab file. */
export function downloadAbilityPackage(pkg: AbilityPackage, slug: string): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug || 'ability'}.agentisab`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
