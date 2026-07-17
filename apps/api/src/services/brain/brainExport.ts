/**
 * Brain export/import — the concrete bridge between the packagers and the Brain
 * substrate for carrying LEARNED INTELLIGENCE across export/import.
 *
 * A portable Brain atom is the content of one `memory_episodes` row minus its
 * identity, scope, embedding, and lifecycle flags. Export drops those; import
 * re-assigns scope (by which bucket the atom travels in) and lets
 * `EpisodicMemoryStore.write` RECOMPUTE the embedding — sync providers inline,
 * async providers via the re-embed sweep — so no embedding vectors ever travel.
 *
 * `EpisodicBrainPort` implements both `@agentis/app` ports so the App packager can
 * carry an App's / agent's brain without importing this api service directly
 * (package-boundary rule): the api constructs the port and injects it.
 */

import type { BrainReader, BrainWriter } from '@agentis/app';
import type {
  PortableBrainAtom,
  RuntimeEpisode,
  RuntimeEpisodeSource,
  RuntimeEpisodeType,
} from '@agentis/core';
import type { EpisodicMemoryStore } from '../episodicMemoryStore.js';

/** Tag marking workspace-global memory (`scope_id = null`) worth carrying. */
const WORKSPACE_MEMORY_TAG = 'plane:workspace_memory';

/** Default per-scope cap (also the store's own `list` ceiling). */
const DEFAULT_SCOPE_CAP = 500;

function toPortableAtom(e: RuntimeEpisode): PortableBrainAtom {
  return {
    type: e.type,
    title: e.title,
    summary: e.summary,
    details: e.details ?? null,
    source: e.source,
    confidence: e.confidence,
    importance: e.importance,
    trust: e.trust,
    tags: e.tags,
    entities: e.entities,
    outcomeStatus: e.outcomeStatus ?? null,
    metadata: e.metadata,
    createdAt: e.createdAt,
  };
}

/**
 * Read learned atoms for one intelligence scope. `scopeId` is an agentId or appId;
 * `null` reads workspace-global memory — filtered to the `plane:workspace_memory`
 * tag so we don't drag every execution lesson into a shared bundle.
 */
export function exportBrainForScope(
  store: EpisodicMemoryStore,
  workspaceId: string,
  scopeId: string | null,
  cap = DEFAULT_SCOPE_CAP,
): PortableBrainAtom[] {
  if (scopeId) {
    return store.list({ workspaceId, scopeId, includeArchived: false, limit: cap }).map(toPortableAtom);
  }
  return store
    .list({ workspaceId, includeArchived: false, limit: cap })
    .filter((e) => (e.scopeId ?? null) === null && e.tags.includes(WORKSPACE_MEMORY_TAG))
    .map(toPortableAtom);
}

/**
 * Write portable atoms into a scope. For an `agent` scope the atom also stamps
 * `agentId` (so agent-private recall, keyed on both, still resolves it); for
 * `app`/`workspace` scopes `agentId` stays null. Embeddings recompute inside
 * `write`.
 */
export function importBrainForScope(
  store: EpisodicMemoryStore,
  workspaceId: string,
  scopeId: string | null,
  atoms: PortableBrainAtom[],
  scopeKind: 'agent' | 'app' | 'workspace',
): number {
  let written = 0;
  for (const atom of atoms) {
    store.write({
      workspaceId,
      scopeId: scopeId ?? null,
      agentId: scopeKind === 'agent' ? scopeId : null,
      type: atom.type as RuntimeEpisodeType,
      title: atom.title,
      summary: atom.summary,
      details: atom.details ?? null,
      source: atom.source as RuntimeEpisodeSource,
      confidence: atom.confidence,
      importance: atom.importance,
      trust: atom.trust,
      tags: atom.tags,
      entities: atom.entities,
      outcomeStatus: atom.outcomeStatus ?? null,
      metadata: atom.metadata,
    });
    written += 1;
  }
  return written;
}

/** Concrete `BrainReader` + `BrainWriter` over an `EpisodicMemoryStore`. */
export class EpisodicBrainPort implements BrainReader, BrainWriter {
  constructor(
    private readonly store: EpisodicMemoryStore,
    private readonly cap = DEFAULT_SCOPE_CAP,
  ) {}

  exportScope(workspaceId: string, scopeId: string | null): PortableBrainAtom[] {
    return exportBrainForScope(this.store, workspaceId, scopeId, this.cap);
  }

  importScope(
    workspaceId: string,
    scopeId: string | null,
    atoms: PortableBrainAtom[],
    scopeKind: 'agent' | 'app' | 'workspace',
  ): number {
    return importBrainForScope(this.store, workspaceId, scopeId, atoms, scopeKind);
  }
}
