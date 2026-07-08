/**
 * Grounding — shared contracts (docs/brain/AGENTIS_ORGANIZATIONAL_INTELLIGENCE_ARCHITECTURE.md).
 *
 * Grounding is the engineering name for the Workspace Brain's continuous
 * organizational reasoning engine. These types are the §7/§8/§9 contracts:
 * the `KnowledgeSource` ingestion interface (deliberately NOT named "adapter"
 * — that word means harness adapters — and NOT "connector" — that means
 * integration workflow connectors), the canonical evidence model, and the
 * agent access grants. Services in this directory implement them.
 */

// ── Source fabric (§7) ─────────────────────────────────────

export interface SourceCapabilities {
  supportsBackfill: boolean;
  supportsIncrementalCursor: boolean;
  supportsWebhooks: boolean;
  supportsDeletes: boolean;
  supportsAclSync: boolean;
  supportsIdentityDirectory: boolean;
  supportsAttachments: boolean;
  supportsHistory: boolean;
  consistency: 'strong' | 'eventual' | 'best_effort';
}

export interface SourceSyncContext {
  workspaceId: string;
  connectionId: string;
  /** Credential vault row id (provenance only — the secret never persists in Grounding tables). */
  credentialId?: string | null;
  /**
   * Decrypted bearer/API token, resolved by the Source Fabric through the
   * credential vault at sync time. Held in memory for the duration of the
   * sync only; never written to evidence, claims, or logs (RFC §16.4).
   */
  accessToken?: string | null;
  includedScopes: string[];
  excludedScopes: string[];
  signal?: AbortSignal;
}

export interface BackfillRequest extends SourceSyncContext {
  /** ISO time — bounded history start (RFC §7.2). */
  since?: string;
  /** Resume checkpoint from a prior interrupted run. */
  checkpoint?: Record<string, unknown>;
}

export interface IncrementalSyncRequest extends SourceSyncContext {
  cursor?: string | null;
}

export interface SourceChangeBatch {
  objects: CanonicalSourceObject[];
  /** Tombstones — external ids the source reports deleted/inaccessible. */
  deletions: Array<{ externalId: string; state: 'deleted' | 'inaccessible'; at?: string }>;
  /** Durable cursor committed only after the batch persists. */
  cursor?: string | null;
  checkpoint?: Record<string, unknown>;
  done?: boolean;
}

export interface SourceConnectionHealth {
  ok: boolean;
  detail?: string;
}

export interface DiscoveredSourceScope {
  id: string;
  label: string;
  kind: string;
  recommended: boolean;
}

/**
 * The §7.1 ingestion contract. Generalizes the resumable-ingestion mechanics
 * Agentis already has (DatasetIngestion checkpoints, listener cursors,
 * workspace KV) with source versions, tombstones, ACLs, and principals.
 */
export interface KnowledgeSource {
  readonly sourceType: string;
  readonly displayName: string;
  readonly capabilities: SourceCapabilities;

  validateConnection(ctx: SourceSyncContext): Promise<SourceConnectionHealth>;
  discoverScopes(ctx: SourceSyncContext): Promise<DiscoveredSourceScope[]>;
  backfill(request: BackfillRequest): AsyncIterable<SourceChangeBatch>;
  synchronize(request: IncrementalSyncRequest): AsyncIterable<SourceChangeBatch>;
  resolvePrincipals?(ctx: SourceSyncContext): AsyncIterable<SourcePrincipalInput>;
  /**
   * ACL-fidelity pass (§9.1): re-capture access policies for already-synced
   * objects so permission CHANGES propagate without waiting for a content
   * change. Sources that capture exact ACLs at crawl time may omit this.
   */
  resolveAcl?(ctx: SourceSyncContext): AsyncIterable<{ externalId: string; acl: AccessPolicy }>;
  revoke?(ctx: SourceSyncContext): Promise<void>;
}

// ── Canonical evidence model (§8) ──────────────────────────

export interface InformationBoundary {
  origin: 'public_external' | 'private_external' | 'agentis_native' | 'owner_authored';
  confidentiality: 'public' | 'internal' | 'confidential' | 'restricted' | 'unknown';
  audience: 'anyone' | 'customers' | 'owner_only' | 'delegated_agents' | 'named_principals';
  customerSafe: boolean;
  trainingAllowed: boolean;
  exportAllowed: boolean;
  policySource: 'source_acl' | 'owner_rule' | 'classifier' | 'inherited';
}

export interface AccessPolicy {
  mode: 'explicit' | 'inherited' | 'owner' | 'public' | 'unknown';
  allow: string[];
  deny: string[];
  fidelity: 'exact' | 'partial' | 'unavailable';
  capturedAt: string;
}

export interface CanonicalSourceObject {
  externalId: string;
  externalVersionId?: string;
  objectType: string;
  title?: string;
  nativeUrl?: string;
  parentExternalId?: string;
  authorExternalId?: string;
  participantExternalIds?: string[];
  createdAt?: string;
  modifiedAt?: string;
  observedAt: string;
  /** Normalized text/content parts. Data, never instruction (§8.5). */
  content: string;
  attributes?: Record<string, unknown>;
  boundary: InformationBoundary;
  acl?: AccessPolicy;
}

export interface SourcePrincipalInput {
  externalPrincipalId: string;
  kind: 'person' | 'group' | 'service' | 'channel' | 'domain' | 'public';
  displayName?: string;
  email?: string;
  attributes?: Record<string, unknown>;
}

// ── Requester + grants (§9) ────────────────────────────────

export type Confidentiality = 'public' | 'internal' | 'confidential' | 'restricted';

export interface GroundingRequester {
  workspaceId: string;
  ownerId?: string | null;
  agentId?: string | null;
  purpose?: string;
  interactionAudience?: 'private' | 'customer' | 'public';
}

export type AgentGrantMode = 'none' | 'full_delegated' | 'agent_decides' | 'human_approval';

export interface ResolvedAgentGrant {
  id: string | null;
  agentId: string;
  mode: AgentGrantMode;
  allowedSources: string[];
  allowedDomains: string[];
  maxConfidentiality: Confidentiality;
  allowedAudiences: Array<'private' | 'customer' | 'public'>;
  protectedDomainPolicy: 'deny' | 'approval_required' | 'authoritative_only';
  tokenBudgetPerRun?: number | null;
}

// ── Claims (§10) ───────────────────────────────────────────

export type ClaimType =
  | 'observation' | 'description' | 'procedure' | 'ownership'
  | 'decision' | 'dependency' | 'policy' | 'metric' | 'causal_hypothesis';

export type ClaimStatus = 'candidate' | 'active' | 'disputed' | 'superseded' | 'rejected' | 'expired';

export interface ClaimEvidenceInput {
  evidenceVersionId: string;
  role?: 'supports' | 'contradicts' | 'contextualizes' | 'supersedes';
  directness?: number;
  /** Copied/forwarded text shares one key; corroboration counts distinct keys (§10.6). */
  independenceKey?: string;
  locator?: Record<string, unknown>;
}

export interface ClaimInput {
  workspaceId: string;
  subjectEntityId?: string | null;
  subjectRef?: Record<string, unknown>;
  predicate: string;
  object: unknown;
  claimType?: ClaimType;
  protectedDomain?: boolean;
  evidence: ClaimEvidenceInput[];
  validFrom?: string;
  reasoningVersion?: string;
  accessPolicy?: Partial<InformationBoundary> & { maxConfidentiality?: Confidentiality };
}

/** §10.3 — inspectable computed-confidence components. */
export interface ConfidenceComponents {
  corroboration: number;
  sourceReliability: number;
  directness: number;
  freshness: number;
  consistency: number;
  contradictionPenalty: number;
}

// ── Learning plan + onboarding (§10.8, §14.7) ──────────────

export type LearningStageKind = 'sync' | 'normalize' | 'secure' | 'extract' | 'reason' | 'review' | 'publish';
export type LearningStageStatus = 'pending' | 'running' | 'healthy' | 'attention' | 'paused';

export interface LearningPlanStage {
  kind: LearningStageKind;
  mode: 'deterministic' | 'selective_model' | 'owner_gate';
  status: LearningStageStatus;
}

export interface GroundingSourceCandidate {
  sourceType: string;
  displayName: string;
  connectionId?: string;
  state: 'ready' | 'connect' | 'suggested_later' | 'needs_attention';
  reason: string;
  /** Generated SourceLearningBrief draft (editable, never required). */
  proposedBrief: Record<string, unknown>;
  requiresOwnerAction: boolean;
}

export interface GroundingDiscoveryResult {
  workspaceId: string;
  inferredName?: string;
  inferredCharter?: string;
  detectedSources: GroundingSourceCandidate[];
  suggestedDomains: string[];
  suggestedAgentGrants: Array<{ agentId: string; agentName: string; mode: AgentGrantMode; reason: string }>;
  warnings: string[];
  discoveredAt: string;
}

// ── Agent context bundle (§12.2, §15.5) ────────────────────

export interface GroundingContextItem {
  id: string;
  kind: 'policy' | 'procedure' | 'fact' | 'evidence' | 'contradiction' | 'gap';
  title: string;
  content: string;
  claimId?: string;
  confidence?: number;
  /** Why this item was selected — every high-impact injection is explainable (§12.1). */
  reason: string;
}

export interface GroundingContextBundle {
  items: GroundingContextItem[];
  influenceIds: string[];
  grantMode: AgentGrantMode;
  /** Rendered block appended to the existing buildDispatchContext output. */
  block: string;
}
