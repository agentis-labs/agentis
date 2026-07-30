import type { ComponentType } from 'react';

export interface UiPackBlockProps {
  props: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
}

type PackBlock = ComponentType<UiPackBlockProps>;
const installedBlocks = new Map<string, PackBlock>();

/** Called only by trusted, installed extension bundles during application boot. */
export function registerUiPackBlock(pack: string, block: string, component: PackBlock): () => void {
  const key = `${pack}:${block}`;
  installedBlocks.set(key, component);
  return () => {
    if (installedBlocks.get(key) === component) installedBlocks.delete(key);
  };
}

export function getUiPackBlock(pack: string, block: string): PackBlock | undefined {
  return installedBlocks.get(`${pack}:${block}`);
}
