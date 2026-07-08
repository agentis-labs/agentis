/**
 * Node Handler Registry (NATIVE-ADVANCEMENT Proposal 4).
 *
 * The first decomposition seam for the WorkflowEngine "God Object": a node kind
 * can move its logic OUT of the engine's dispatch switch into a self-contained,
 * independently-testable handler, and the engine simply delegates to the
 * registry. Adding/changing such a kind no longer means editing the engine.
 *
 * This first cut covers PURE node kinds — those whose output is a pure function
 * of (config, inputData, template-context) with no side effects and no run-state
 * mutation (transform, filter, …). Side-effecting / ctx-coupled kinds (agent,
 * integration, http, subflow, swarm) remain in the engine for now and can be
 * migrated incrementally behind this same seam.
 */

import type { TemplateContext } from '../templateResolver.js';

export interface PureNodeContext {
  inputData: Record<string, unknown>;
  /** Template context snapshot for `{{...}}` / expression resolution. */
  tctx: TemplateContext;
}

export interface PureNodeHandler<TConfig = unknown> {
  readonly kind: string;
  /** Compute the node's output. Pure: no side effects, no run-state mutation. */
  execute(config: TConfig, ctx: PureNodeContext): Record<string, unknown>;
}

export class NodeHandlerRegistry {
  readonly #handlers = new Map<string, PureNodeHandler>();

  register(handler: PureNodeHandler): void {
    this.#handlers.set(handler.kind, handler);
  }

  get(kind: string): PureNodeHandler | undefined {
    return this.#handlers.get(kind);
  }

  has(kind: string): boolean {
    return this.#handlers.has(kind);
  }

  kinds(): string[] {
    return [...this.#handlers.keys()];
  }
}
