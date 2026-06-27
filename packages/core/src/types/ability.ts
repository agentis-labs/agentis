/**
 * Ability types — compiled behavioral specialization units (docs/brain/ABILITIES.md).
 *
 * An Ability is a workspace-level asset that any agent can acquire. Dispatch
 * semantically scores all workspace abilities against the current task and
 * injects the most relevant ones into the agent's preamble; agents may also pin
 * specific abilities for always-on behavior.
 */

/**
 * Real phases the AbilityCompilerService walks through. The UI uses these
 * verbatim to render progress instead of a cosmetic phase ticker.
 */
export type AbilityCompileStage =
  | 'queued'
  | 'embedding_examples'
  | 'contextualizing_knowledge'
  | 'generating_synthetic_examples'
  | 'synthesizing_persona'
  | 'indexing_brain'
  | 'finalizing';

export type AbilityCompileStatus =
  | 'pending'
  | 'compiling'
  | 'ready'
  | 'failed'
  | 'dirty';

export type AbilityExampleSource =
  | 'user_curated'
  | 'synthetic'
  | 'promoted_from_run'
  | 'imported';

export type AbilityKnowledgeSourceType =
  | 'document'
  | 'image'
  | 'audio'
  | 'url'
  | 'manual';

/**
 * ABILITIES-10X — the specialization "depth" dial. The greater the ability, the
 * greater the agent's specialty. Every depth is zero-cost (pure behavior, never
 * weights). The engine activates the shallowest depth that wins on evals.
 */
export type AbilityDepth =
  | 'd0_instinct'   // persona + specs + rules + tool hints
  | 'd1_knowledge'  // + examples + embedded domain knowledge
  | 'd2_tuned'      // + instructions/examples optimized against the ability's evals
  | 'd3_method'     // + execution policy (tool plan / verify-retry / sub-graph)
  | 'd4_conductor'; // + routing policy (model/tool/path per task signal)

export const ABILITY_DEPTH_ORDER: AbilityDepth[] = [
  'd0_instinct', 'd1_knowledge', 'd2_tuned', 'd3_method', 'd4_conductor',
];

export type AbilityVisibility = 'private' | 'workspace' | 'unlisted' | 'hub';

/** Which creation on-ramp produced an ability (provenance). */
export type AbilityOriginKind =
  | 'intent'    // one-sentence natural-language description
  | 'examples'  // inferred from input→output pairs
  | 'material'  // distilled from a doc / url / transcript / codebase
  | 'run'       // promoted from a real agent run (the flywheel)
  | 'fork'      // cloned/specialized from another ability
  | 'manual';   // hand-authored in the form

export interface AbilityOrigin {
  kind: AbilityOriginKind;
  /** Free-form prompt/seed the on-ramp started from (truncated). */
  seed?: string;
  /** Source ability id when kind === 'fork'. */
  sourceAbilityId?: string;
  /** Run id when kind === 'run'. */
  runId?: string;
  /** Provenance for a graduated ability (LIVING-APPS-10X M2): scopeId / appId / outcome. */
  scopeId?: string | null;
  appId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AbilitySpecs {
  stack?: string;
  styling?: string;
  components?: string;
  icons?: string;
  animation?: string;
  grid_unit?: string;
  breakpoints?: string;
  accessibility?: string;
  output_format?: string;
  /** Arbitrary domain specs — operators define their own keys. */
  [key: string]: string | undefined;
}

export interface AbilityGate {
  requiresEnv?: string[];
  requiresAffordances?: ('browser' | 'terminal' | 'fileSystem' | 'computerUse')[];
  os?: 'windows' | 'mac' | 'linux';
  always?: boolean;
}

export interface AbilityRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  slug: string;
  description: string | null;
  domainTag: string | null;
  iconEmoji: string | null;
  authorId: string | null;
  compiledPrompt: string | null;
  specs: AbilitySpecs;
  rulesAlways: string[];
  rulesNever: string[];
  toolHints: string[];
  
  // -- V2 Features --
  mode: 'compiled' | 'static';
  slashCommand: string | null;
  commandDispatch: 'model' | 'tool' | null;
  commandToolName: string | null;
  envKeys: string[];
  envSecretIds: string[];
  gate: AbilityGate | null;
  minRelevanceScore: number | null;
  preferredModel: string | null;
  
  domainEmbedding: number[] | null;
  exampleCount: number;
  knowledgeCount: number;
  compileStatus: AbilityCompileStatus;
  /** Human-readable phase the worker last reported (null when idle). */
  compileStage: AbilityCompileStage | null;
  /** True when a Cancel was requested but the worker hasn't acknowledged yet. */
  compileCancelRequested: boolean;
  lastCompiledAt: string | null;
  compileError: string | null;
  isPublic: boolean;
  hubSlug: string | null;
  hubVersion: string;
  installCount: number;
  tokenBudget: number | null;
  version: string;
  kbDocumentId: string | null;

  // -- ABILITIES-10X --
  depth: AbilityDepth;
  visibility: AbilityVisibility;
  /** SHA-256 of the compiled behavioral payload; drives the Ability Cache. */
  contentHash: string | null;
  origin: AbilityOrigin | null;
  executionPolicy: AbilityExecutionPolicy | null;
  routingPolicy: AbilityRoutingPolicy | null;

  createdAt: string;
  updatedAt: string;
}

/** D3 — how a specialist *works*, not just how it answers. */
export interface AbilityExecutionPolicy {
  /** Ordered tool plan hint the agent should prefer for this domain. */
  toolPlan?: string[];
  /** Self-verify the output against these checks before returning. */
  verify?: string[];
  /** Max self-correction retries when verification fails. */
  maxRetries?: number;
}

/** D4 — which engine to use per task signal. */
export interface AbilityRoutingPolicy {
  /** Preferred model for tasks this ability dominates. */
  preferredModel?: string;
  /** Cheaper model for low-stakes variants. */
  fallbackModel?: string;
  /** Free-form natural-language routing hint. */
  hint?: string;
}

/** Ability-scoped self-eval evidence (a promotion gate, not a proof). */
export interface AbilityEvalRun {
  id: string;
  abilityId: string;
  workspaceId: string | null;
  kind: 'self_eval' | 'regression' | 'candidate_vs_base';
  /** 0–1 aggregate. */
  score: number;
  passed: boolean;
  caseCount: number;
  failures: Array<{ input: string; reason: string; score?: number }>;
  summary: string | null;
  model: string | null;
  createdAt: string;
}

/** One row of the activation ledger — the free improvement flywheel. */
export interface AbilityActivation {
  id: string;
  workspaceId: string | null;
  runId: string | null;
  agentId: string | null;
  model: string | null;
  abilityIds: string[];
  conflictsResolved: Array<{ kind: string; detail: string }>;
  outcome: string | null;
  qualityScore: number | null;
  consentScope: 'workspace_private' | 'unlisted' | 'hub_opt_in';
  createdAt: string;
}

// ── Creation Engine (the 10x on-ramps) ──────────────────────

/** A finished, populated draft — never a blank form. */
export interface AbilityDraftBlueprint {
  name: string;
  slug?: string;
  description?: string;
  domainTag?: string;
  iconEmoji?: string;
  specs?: AbilitySpecs;
  rulesAlways?: string[];
  rulesNever?: string[];
  toolHints?: string[];
  /** Seed examples synthesized/inferred by the on-ramp. */
  examples?: Array<{ inputText: string; outputText: string }>;
  /** Knowledge to embed (material on-ramp). */
  knowledge?: Array<{ title?: string; content: string }>;
}

export interface AbilityDraftResult {
  ability: AbilityRecord;
  /** True when an LLM synthesized the blueprint; false = deterministic fallback. */
  synthesized: boolean;
  blueprint: AbilityDraftBlueprint;
  notes: string[];
}

export interface AbilityRefineResult {
  added: number;
  examples: AbilityExample[];
  synthesized: boolean;
  notes: string[];
}

export interface AbilitySelfEvalResult {
  run: AbilityEvalRun;
  /** Whether the ability may be promoted to the next depth on this evidence. */
  promotable: boolean;
}

export interface AbilityExample {
  id: string;
  abilityId: string;
  inputText: string;
  outputText: string;
  inputMediaUrl: string | null;
  mediaDescription: string | null;
  qualityScore: number;
  source: AbilityExampleSource;
  embedding: number[] | null;
  originRunId: string | null;
  createdAt: string;
}

export interface AbilityKnowledge {
  id: string;
  abilityId: string;
  kbChunkId: string | null;
  title: string | null;
  content: string;
  contextPrefix: string | null;
  embedding: number[] | null;
  sourceType: AbilityKnowledgeSourceType;
  sourceUrl: string | null;
  importanceScore: number;
  createdAt: string;
}

export interface AgentAbilityPin {
  agentId: string;
  abilityId: string;
  enabled: boolean;
  createdAt: string;
}

export interface AbilityManifest {
  name: string;
  slug: string;
  version: string;
  domain_tag: string;
  icon_emoji?: string;
  description?: string;
  compiled_prompt: string;
  specs: AbilitySpecs;
  rules_always: string[];
  rules_never: string[];
  tool_hints: string[];
  example_count: number;
  mode?: 'compiled' | 'static';
  slash_command?: string | null;
  command_dispatch?: 'model' | 'tool' | null;
  command_tool_name?: string | null;
  env_keys?: string[];
  env_secret_ids?: string[];
  gate?: AbilityGate | null;
  min_relevance_score?: number | null;
  preferred_model?: string | null;
}

/** Shape of the .ability export file (JSON; gzipping is a transport concern). */
export interface AbilityPackage {
  format_version: '1.0';
  manifest: AbilityManifest;
  examples: Array<{
    input_text: string;
    output_text: string;
    input_media_url?: string | null;
    media_description?: string | null;
    quality_score: number;
    source: AbilityExampleSource;
    embedding?: number[] | null;
  }>;
  knowledge: Array<{
    title?: string | null;
    content: string;
    context_prefix?: string | null;
    embedding?: number[] | null;
    source_type: AbilityKnowledgeSourceType;
    source_url?: string | null;
    importance_score: number;
  }>;
}

/** Scored result returned by the dispatch-time semantic pool. */
export interface AbilityInjection {
  abilityId: string;
  name: string;
  score: number;
  tokens: number;
}
