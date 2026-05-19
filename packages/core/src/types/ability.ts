/**
 * Agent Abilities — BRAIN-ABILITIES-REPLAN.md Part IV.
 *
 * An ability is procedural how-to knowledge: how an agent role performs its
 * job well. Distinct from brain atoms (world facts) and skills (executable
 * code). Stored as a Markdown document in the DB, refined over time by the
 * background reviewer, the operator, or seeded from a package.
 */

/** Lifecycle state of an ability version. */
export type AbilityStatus =
  | 'active'
  | 'stale'
  | 'archived'
  | 'superseded'
  | 'pending_review';

/** How an ability came to exist. */
export type AbilitySource =
  | 'package_seed'
  | 'background_review'
  | 'operator_write'
  | 'operator_rollback';

/** A testable example scenario carried by an ability. */
export interface AbilityAssertion {
  scenario: string;
  expectedBehavior: string;
  lastVerifiedAt?: string;
  lastResult?: 'pass' | 'fail' | 'skip';
}

/** A fully-hydrated ability row as returned by the API. */
export interface AgentAbility {
  id: string;
  workspaceId: string;
  agentId: string | null;
  workflowId: string | null;
  teamRole: string | null;
  title: string;
  content: string;
  tags: string[];
  version: number;
  parentAbilityId: string | null;
  changelog: string[];
  confidence: number;
  reinforceCount: number;
  usageCount: number;
  source: AbilitySource;
  derivedFromPackage: string | null;
  derivedFromRunIds: string[];
  assertions: AbilityAssertion[];
  managed: boolean;
  status: AbilityStatus;
  pinnedAt: string | null;
  lastUsedAt: string | null;
  contextAtoms: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/** Package-manifest seed shape for an ability (U8). */
export interface AbilitySeed {
  title: string;
  content: string;
  tags?: string[];
  confidence?: number;
  assertions?: AbilityAssertion[];
}

/** Per-agent ability seed bundle in a package manifest. */
export interface AgentAbilitySeedGroup {
  agentSlug: string;
  abilities: AbilitySeed[];
}
