import type { BrainNode } from '@agentis/core';

export const BRAIN_LAYER_COLORS = {
  core: '#e2e8f0',
  knowledge: '#22d3ee',
  memory: '#a78bfa',
  judgment: '#f59e0b',
} as const;

export function brainLayerColor(layer: BrainNode['layer']): string {
  return BRAIN_LAYER_COLORS[layer] ?? '#94a3b8';
}

/** Secondary visual signal. Layer remains the fill/legend contract. */
export function brainNodeAccentColor(node: BrainNode): string | null {
  if (node.type === 'scope_owner') return '#fbbf24';
  if (node.type === 'skill') return '#34d399';
  if (node.type === 'example') return '#f472b6';
  if (node.type === 'warning') return '#fb7185';
  if (node.type === 'gap') return '#94a3b8';
  const tags = node.metadata?.tags;
  const firstTag = Array.isArray(tags) && typeof tags[0] === 'string' ? tags[0] : null;
  return firstTag ? stableTagColor(firstTag) : null;
}

function stableTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return hslToHex(Math.abs(hash % 360), 75, 68);
}

function hslToHex(h: number, s: number, l: number): string {
  const lightness = l / 100;
  const a = (s * Math.min(lightness, 1 - lightness)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lightness - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
