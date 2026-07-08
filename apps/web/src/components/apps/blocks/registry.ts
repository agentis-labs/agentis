/**
 * Block registry — the open seam for the App Interface renderer.
 *
 * The renderer no longer hard-codes a giant `switch (node.type)`. Instead every
 * block KIND registers a renderer here, and `ViewRenderer` dispatches through the
 * registry. That makes the block set OPEN: built-in blocks register at module
 * load, and an agent / plugin / workspace can `registerBlock` its own named kind
 * the same way (last registration wins, so a built-in can be overridden). An
 * unregistered kind renders a visible marker instead of vanishing.
 *
 * Pure module — it imports only TYPES, never `ViewRenderer`, so extenders can pull
 * the seam without dragging in the whole renderer. Blocks recurse into their
 * children through {@link BlockContext.renderChild}, not by importing the renderer.
 */
import type { ReactNode } from 'react';
import type { ViewNode } from '@agentis/core';
import type { ResolvedTheme } from '../theme';

/** Binding scope: the current data row (inside a row template) + global UI state. */
export interface ResolveScope {
  row?: Record<string, unknown>;
  state: Record<string, unknown>;
}

/**
 * Everything a block renderer needs beyond its own node. Built once per node by
 * `ViewRenderer` and handed to the registered renderer.
 */
export interface BlockContext {
  /** Raw row scope — passed down to children and to bindables resolving against the row. */
  scope?: Record<string, unknown>;
  /** Resolved scope (`{ row, state }`) for direct bindable resolution at this node. */
  resolvedScope: ResolveScope;
  /** Index path from the surface root (selection + child react keys). */
  path: number[];
  /** Effective theme at this node (density, content width, design language). */
  theme: ResolvedTheme;
  /** True when inside an elevated container — nested boxes flatten to avoid triple frames. */
  boxed: boolean;
  /**
   * Render a child node — the recursion seam. A block renders its descendants
   * through this instead of importing `ViewRenderer`, so blocks stay decoupled
   * from the host renderer and can live in their own modules.
   */
  renderChild: (node: ViewNode, path: number[], scope?: Record<string, unknown>) => ReactNode;
}

/**
 * A renderer for one block kind. `node` is the broad `ViewNode`: a block narrows it
 * by a control-flow check on `node.type` (the registry guarantees the kind already).
 * We deliberately do NOT type `node` as `Extract<ViewNode, { type: K }>` — `ViewNode`
 * is `ViewNodeBase & { style? }` (an intersection), so generic `Extract` collapses to
 * `never`. Control-flow narrowing (`node.type === 'X'`) is the correct, reliable seam.
 */
export type BlockRenderer = (node: ViewNode, ctx: BlockContext) => ReactNode;

const REGISTRY = new Map<string, BlockRenderer>();

/**
 * Register a renderer for a block `kind`. Built-in kinds get editor autocomplete via
 * `ViewNode['type']`; an arbitrary new kind (agent/plugin/workspace block) is allowed
 * via `string`. Last registration wins, so a built-in can be overridden.
 */
export function registerBlock(kind: ViewNode['type'] | (string & {}), renderer: BlockRenderer): void {
  REGISTRY.set(kind, renderer);
}

export function getBlock(kind: string): BlockRenderer | undefined {
  return REGISTRY.get(kind);
}

export function hasBlock(kind: string): boolean {
  return REGISTRY.has(kind);
}

/** All registered block kinds — for discovery (palettes, validation, docs). */
export function listBlockKinds(): string[] {
  return [...REGISTRY.keys()];
}
