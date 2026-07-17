/**
 * Brain ports — the narrow seam between the App packager (`@agentis/app`) and the
 * Brain substrate (`EpisodicMemoryStore`, which lives in `apps/api` and must NOT
 * be imported here). The api wires concrete implementations in; the packager only
 * ever sees these two functions.
 *
 * This is what lets the App manifest carry an agent's / App's learned memory
 * without `@agentis/app` depending on api services (package-boundary rule).
 */

import type { PortableBrainAtom } from '@agentis/core';

/** Reads learned Brain atoms for one intelligence scope, for export. */
export interface BrainReader {
  /**
   * All portable atoms for a scope. `scopeId` is an agentId or appId; `null` means
   * workspace-global memory. Returns bare content atoms (no id/scope/embedding).
   */
  exportScope(workspaceId: string, scopeId: string | null): PortableBrainAtom[];
}

/** Writes learned Brain atoms into one intelligence scope, on install. */
export interface BrainWriter {
  /**
   * Persist atoms at `scopeId` (agentId, appId, or `null` for workspace). `scopeKind`
   * disambiguates so an agent-scoped atom also stamps `agentId` (an app/workspace atom
   * does not). Embeddings are recomputed by the store. Returns how many were written.
   */
  importScope(
    workspaceId: string,
    scopeId: string | null,
    atoms: PortableBrainAtom[],
    scopeKind: 'agent' | 'app' | 'workspace',
  ): number;
}
