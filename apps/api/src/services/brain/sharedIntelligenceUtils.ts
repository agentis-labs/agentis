// §B5.4 — ONE tokenizer for the whole brain.
//
// This module used to carry its own `[^a-z0-9_\s]` tokenizer, and because
// sharedIntelligence.ts (the main write/recall spine) imports from here, that
// ASCII filter silently governed every lexical dedup key, similarity score and
// working-set backfill in the system. Measured consequences: "部署前请务必备份"
// and "Никогда не деплой в пятницу" tokenized to [], and "configuração de
// segurança" to ["configura","de","seguran"] — so non-Latin memory was
// unreachable and Portuguese memory deduped against mangled stems.
//
// `brainText.tokenize` is the Unicode-aware implementation (\p{L}/\p{N} plus
// per-character CJK segmentation) and is ASCII-byte-identical for English
// input. Re-exported rather than copied so a future fix can never again land in
// one tokenizer and miss the other.
export { tokenize } from './brainText.js';

import { tokenize } from './brainText.js';

export function similarity(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = overlap / union;
  const containment = overlap / Math.min(aTokens.size, bTokens.size);
  return jaccard * 0.65 + containment * 0.35;
}

export function uniqueByNormalized(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = tokenize(item).slice(0, 18).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function compactValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  return { type: 'object', keys: Object.keys(value as Record<string, unknown>).slice(0, 8) };
}

export function synthesizePreTaskContext(texts: string[]): string {
  const rules = texts
    .map((text) => text.split('\n').map((line) => line.trim()).filter(Boolean).join(' - '))
    .filter(Boolean)
    .slice(0, 3);
  if (rules.length === 0) return '- No stable prior signal matched this task.';
  return rules.map((rule) => `- Carry forward: ${truncate(rule, 180)}`).join('\n');
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

export function parseJsonRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}...`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
