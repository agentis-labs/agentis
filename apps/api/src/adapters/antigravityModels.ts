/** Canonical model ids accepted by the `agy` CLI. */
export const ANTIGRAVITY_MODELS = [
  { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
  { id: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)' },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
] as const;

const MODEL_BY_ALIAS = new Map<string, string>();
for (const model of ANTIGRAVITY_MODELS) {
  MODEL_BY_ALIAS.set(model.id.toLowerCase(), model.id);
  MODEL_BY_ALIAS.set(model.label.toLowerCase(), model.id);
  MODEL_BY_ALIAS.set(model.label.replace(/ \((high|medium|low)\)$/i, '').toLowerCase(), model.id);
}

/** Convert legacy picker labels and valid ids into the id accepted by `agy`. */
export function normalizeAntigravityModel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const exact = MODEL_BY_ALIAS.get(trimmed.toLowerCase());
  if (exact) return exact;
  const effort = / \((high|medium|low)\)$/i.exec(trimmed)?.[1]?.toLowerCase();
  const withoutEffort = trimmed.replace(/ \((high|medium|low)\)$/i, '').toLowerCase();
  const base = MODEL_BY_ALIAS.get(withoutEffort);
  if (base && effort) {
    const withRequestedEffort = base.replace(/-(high|medium|low)$/i, `-${effort}`);
    return withRequestedEffort;
  }
  // The chat effort control may compose a canonical id with a display suffix,
  // e.g. `gemini-3.6-flash-high (medium)`.
  const idBase = withoutEffort.replace(/-(high|medium|low)$/i, '');
  const matching = ANTIGRAVITY_MODELS.find((model) => model.id.replace(/-(high|medium|low)$/i, '') === idBase);
  if (matching && effort) {
    const candidate = matching.id.replace(/-(high|medium|low)$/i, `-${effort}`);
    return candidate;
  }
  return base ?? trimmed;
}

export function antigravityModelLabel(value: string | null | undefined): string | null {
  const id = normalizeAntigravityModel(value);
  return ANTIGRAVITY_MODELS.find((model) => model.id === id)?.label ?? id;
}
