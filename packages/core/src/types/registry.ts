/**
 * Skill registry contract — V1-SPEC §8.
 *
 * The registry is an anonymous, read-only third-party source of
 * shareable agent packages, workflows and skills. This file is the
 * sole shared contract between the API surface, the install pipeline
 * and the dashboard browser.
 *
 * The shape is deliberately registry-source-agnostic: any provider that
 * exposes (slug, version, sha256-checked artifact bytes) can back the
 * `RegistryClient` without changes here.
 */

export type RegistryEntryType =
  | 'agent_package'
  | 'workflow'
  | 'skill'
  | 'workflow_template';

export type RegistryArtifactType =
  | 'workflow_graph'
  | 'skill_bundle'
  | 'agent_package'
  | 'workflow_template';

export interface RegistryArtifact {
  artifactType: RegistryArtifactType;
  /** SHA-256 hex of the bytes at downloadUrl. Verified locally before install. */
  sha256: string;
  /** Public URL the client fetches to obtain the artifact bytes. */
  downloadUrl: string;
}

export interface RegistryEntry {
  /** Stable identifier — typically equal to `slug` for anonymous registries. */
  entryId: string;
  entryType: RegistryEntryType;
  slug: string;
  title: string;
  summary: string;
  version: string;
  author: {
    username: string;
    displayName: string;
  };
  artifacts: RegistryArtifact[];
}
