/**
 * OrchestratorModelRouter — per-role model selection for the orchestrator.
 *
 * The orchestrator does several distinct kinds of cognition — holding a
 * conversation, planning a multi-step build, synthesizing a workflow graph,
 * judging a result. These do not all want the same model: conversation wants
 * fast + cheap, planning/synthesis want strong reasoning, evaluation wants a
 * judge. This router resolves a *role* to a concrete `AgentAdapter` so each
 * call site can ask for the right brain by name.
 *
 * Two configuration modes, both expressible through {@link fromEnv}:
 *
 *   1. **Default model candidate.** Set only the default profile
 *      (e.g. `AGENTIS_ORCHESTRATOR_MODEL=claude-opus-4-8`). `profile()` still
 *      reports that configured fallback for compatibility, but task-aware call
 *      sites use `routeProfile()` / `resolveRouted()` so simple work can choose
 *      a smaller capable sibling model.
 *
 *   2. **Per-role models.** Override individual roles (e.g.
 *      `AGENTIS_ORCHESTRATOR_PLANNING_MODEL`, `WORKFLOW_SYNTHESIS_MODEL`,
 *      `AGENTIS_EVALUATOR_MODEL`). Any role left unset falls back to the
 *      default profile. Mix any provider per role.
 *
 * Adapters are constructed lazily and cached by profile, so two roles that
 * point at the same `(baseUrl, model, apiKey)` share one adapter instance.
 */

import type { AgentAdapter } from '@agentis/core';
import { HermesAdapter } from '../../adapters/HermesAdapter.js';
import type { Logger } from '../../logger.js';
import {
  renderRuntimeRoutingIntelligence,
  routeModelForTask,
  type ModelRoutingCandidate,
  type ModelRoutingDecision,
  type ModelRoutingSource,
} from '../modelRoutingPolicy.js';

export type OrchestratorModelRole =
  | 'conversation'
  | 'planning'
  | 'synthesis'
  | 'evaluation'
  | 'vision'
  | 'transcription';

export const ORCHESTRATOR_MODEL_ROLES: readonly OrchestratorModelRole[] = [
  'conversation',
  'planning',
  'synthesis',
  'evaluation',
  'vision',
  'transcription',
];

export interface ModelProfile {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ModelProfileCandidate extends ModelProfile {
  source: ModelRoutingSource;
  role: OrchestratorModelRole;
  verified: boolean;
}

export interface RoutedModelProfile {
  profile: ModelProfile | null;
  decision: ModelRoutingDecision;
}

export interface OrchestratorModelRouterConfig {
  /**
   * Explicit per-role profiles. A role with no entry (or a null entry) falls
   * back to {@link OrchestratorModelRouterConfig.default}.
   */
  roles?: Partial<Record<OrchestratorModelRole, ModelProfile | null>>;
  /** The catch-all profile. "One high model for everything" lives here. */
  default?: ModelProfile | null;
  /**
   * Per-workspace override source (WorkspaceModelConfigService). Returns a
   * partial profile `{ model, baseUrl?, apiKey? }`; missing baseUrl/apiKey are
   * merged from the env default for that role. Null = no override.
   */
  configProvider?: (workspaceId: string, role: OrchestratorModelRole) => Partial<ModelProfile> | null;
  /**
   * Last-resort, zero-config source: a full profile derived from the workspace
   * itself (e.g. the first agent runtime the operator configured). Consulted
   * BELOW env + Settings so explicit config always wins, but it means a user who
   * has connected any model — without touching `.env` or the model-config page —
   * still gets a working evaluation/session brain. Null = nothing to derive.
   */
  fallbackProvider?: (workspaceId?: string) => ModelProfile | null;
  logger?: Logger;
}

function profileKey(p: ModelProfile): string {
  return `${p.baseUrl}\u001f${p.model}\u001f${p.apiKey ?? ''}`;
}

/** Default output-token ceiling for orchestrator runtimes, overridable via
 *  `AGENTIS_ORCHESTRATOR_MAX_TOKENS`. Sized to leave headroom for reasoning
 *  models so the final answer is never starved out of the budget. */
const DEFAULT_ORCHESTRATOR_MAX_TOKENS = 8192;
function resolveOrchestratorMaxTokens(): number {
  const fromEnv = Number(process.env.AGENTIS_ORCHESTRATOR_MAX_TOKENS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : DEFAULT_ORCHESTRATOR_MAX_TOKENS;
}

export class OrchestratorModelRouter {
  readonly #roles: Partial<Record<OrchestratorModelRole, ModelProfile | null>>;
  readonly #default: ModelProfile | null;
  readonly #logger: Logger | undefined;
  readonly #cache = new Map<string, AgentAdapter>();
  #configProvider: OrchestratorModelRouterConfig['configProvider'];
  #fallbackProvider: OrchestratorModelRouterConfig['fallbackProvider'];

  constructor(config: OrchestratorModelRouterConfig = {}) {
    this.#roles = config.roles ?? {};
    this.#default = config.default ?? null;
    this.#logger = config.logger;
    this.#configProvider = config.configProvider;
    this.#fallbackProvider = config.fallbackProvider;
  }

  /** Wire (or replace) the per-workspace override source after construction. */
  setConfigProvider(provider: OrchestratorModelRouterConfig['configProvider']): void {
    this.#configProvider = provider;
  }

  /** Wire (or replace) the zero-config derived-default source after construction. */
  setFallbackProvider(provider: OrchestratorModelRouterConfig['fallbackProvider']): void {
    this.#fallbackProvider = provider;
  }

  /**
   * The model profile that would answer this role, in precedence order:
   *   1. per-workspace override for this exact role
   *   2. explicit env role-specific profile (e.g. WORKFLOW_SYNTHESIS_*)
   *   3. per-workspace **conversation** override — the workspace's chosen
   *      orchestrator model acts as the default for EVERY role, so "set the
   *      orchestrator to opus" makes planning/synthesis/evaluation use it too
   *      (compatibility path only; task-aware execution treats it as a candidate)
   *   4. env catch-all default (AGENTIS_ORCHESTRATOR_* / AGENTIS_EVALUATOR_*)
   * Returns null only when nothing at all is configured.
   */
  profile(role: OrchestratorModelRole, workspaceId?: string): ModelProfile | null {
    // 1. explicit per-workspace override for this role
    const roleOverride = this.#workspaceOverride(role, workspaceId);
    if (roleOverride) return roleOverride;
    // 2. explicit env role-specific profile (not the catch-all default)
    const roleEnv = this.#roles[role];
    if (roleEnv) return roleEnv;
    // 3. the workspace's chosen conversation model = its default for all roles
    if (role !== 'conversation') {
      const conversationDefault = this.#workspaceOverride('conversation', workspaceId);
      if (conversationDefault) return conversationDefault;
    }
    // 4. env catch-all default
    if (this.#default) return this.#default;
    // 5. zero-config: derive from the workspace's first configured agent runtime
    return this.#fallbackProvider?.(workspaceId) ?? null;
  }

  /**
   * All profiles that can serve a role, in historical precedence order. Routing
   * treats these as candidates, not an automatic winner, unless a caller passes
   * an explicit pin.
   */
  profileCandidates(role: OrchestratorModelRole, workspaceId?: string): ModelProfileCandidate[] {
    const candidates: ModelProfileCandidate[] = [];
    const push = (profile: ModelProfile | null | undefined, source: ModelRoutingSource) => {
      if (!profile) return;
      if (candidates.some((candidate) => profileKey(candidate) === profileKey(profile))) return;
      candidates.push({ ...profile, role, source, verified: source === 'runtime_detected' });
    };

    push(this.#workspaceOverride(role, workspaceId), 'workspace_role');
    push(this.#roles[role], 'env_role');
    if (role !== 'conversation') push(this.#workspaceOverride('conversation', workspaceId), 'workspace_default');
    push(this.#default, 'env_default');
    push(this.#fallbackProvider?.(workspaceId), 'fallback');
    return candidates;
  }

  route(args: {
    role: OrchestratorModelRole;
    workspaceId?: string;
    task?: string | null;
    purpose?: string | null;
    explicitModel?: string | null;
    requiredAffordances?: string[];
  }): ModelRoutingDecision {
    const candidates = this.profileCandidates(args.role, args.workspaceId);
    const current = candidates[0]?.model ?? null;
    const decision = routeModelForTask({
      task: args.task,
      purpose: args.purpose ?? args.role,
      role: args.role,
      runtime: `orchestrator:${args.role}`,
      explicitModel: args.explicitModel,
      currentModel: current,
      candidateModels: candidates.map<ModelRoutingCandidate>((candidate) => ({
        model: candidate.model,
        runtime: `orchestrator:${args.role}`,
        source: candidate.source,
        verified: candidate.verified,
      })),
      requiredAffordances: args.requiredAffordances,
    });
    this.#logger?.debug?.('orchestrator.model.route_decision', {
      role: args.role,
      workspaceId: args.workspaceId ?? null,
      taskClass: decision.taskClass,
      selectedModel: decision.selectedModel,
      selectedRuntime: decision.selectedRuntime,
      modelTier: decision.modelTier,
      explicitPin: decision.explicitPin,
      reason: decision.reason,
    });
    return decision;
  }

  routeProfile(args: {
    role: OrchestratorModelRole;
    workspaceId?: string;
    task?: string | null;
    purpose?: string | null;
    explicitModel?: string | null;
    requiredAffordances?: string[];
  }): RoutedModelProfile {
    const candidates = this.profileCandidates(args.role, args.workspaceId);
    const base = candidates[0] ?? null;
    const decision = this.route(args);
    if (!base || !decision.selectedModel) return { profile: null, decision };
    const sameModel = candidates.find((candidate) =>
      candidate.model.trim().toLowerCase() === decision.selectedModel!.trim().toLowerCase());
    const profileBase = sameModel ?? base;
    const profile: ModelProfile = {
      baseUrl: profileBase.baseUrl,
      model: decision.selectedModel,
      ...(profileBase.apiKey ? { apiKey: profileBase.apiKey } : {}),
    };
    return { profile, decision };
  }

  /** A per-workspace override for a role, merged with env base URL/key, or null. */
  #workspaceOverride(role: OrchestratorModelRole, workspaceId?: string): ModelProfile | null {
    if (!workspaceId || !this.#configProvider) return null;
    const override = this.#configProvider(workspaceId, role);
    if (!override?.model) return null;
    const base = this.#roles[role] ?? this.#default;
    const baseUrl = override.baseUrl ?? base?.baseUrl;
    if (!baseUrl) {
      this.#logger?.warn?.('orchestrator.model.override_missing_base_url', { role, workspaceId });
      return null;
    }
    const apiKey = override.apiKey ?? base?.apiKey;
    return { baseUrl, model: override.model, ...(apiKey ? { apiKey } : {}) };
  }

  /** True when at least one model is configured (any role is answerable). */
  get enabled(): boolean {
    if (this.#default) return true;
    return Object.values(this.#roles).some((p) => Boolean(p));
  }

  /**
   * Resolve a role to a chat-capable adapter. Returns undefined when no model
   * is configured for the role and there is no default — callers then fall back
   * to the agent's own adapter (conversation) or the deterministic path
   * (synthesis), exactly as before this router existed.
   */
  resolve(role: OrchestratorModelRole, workspaceId?: string): AgentAdapter | undefined {
    const profile = this.profile(role, workspaceId);
    if (!profile) return undefined;
    const key = profileKey(profile);
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const adapter = new HermesAdapter({
      agentId: `orchestrator-${role}`,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      // Give the orchestrator brain enough output room that a reasoning model at
      // high effort cannot spend its whole budget thinking and return an empty
      // answer (the "I didn't produce a reply" dead-turn). Overridable per deploy.
      maxTokens: resolveOrchestratorMaxTokens(),
      logger: this.#logger ?? noopLogger,
    });
    this.#cache.set(key, adapter);
    this.#logger?.info?.('orchestrator.model.resolved', { role, model: profile.model });
    return adapter;
  }

  resolveRouted(args: {
    role: OrchestratorModelRole;
    workspaceId?: string;
    task?: string | null;
    purpose?: string | null;
    explicitModel?: string | null;
    requiredAffordances?: string[];
  }): AgentAdapter | undefined {
    const { profile, decision } = this.routeProfile(args);
    if (!profile) return undefined;
    const key = profileKey(profile);
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const adapter = new HermesAdapter({
      agentId: `orchestrator-${args.role}`,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      maxTokens: resolveOrchestratorMaxTokens(),
      logger: this.#logger ?? noopLogger,
    });
    this.#cache.set(key, adapter);
    this.#logger?.info?.('orchestrator.model.routed', {
      role: args.role,
      workspaceId: args.workspaceId ?? null,
      selectedModel: profile.model,
      taskClass: decision.taskClass,
      explicitPin: decision.explicitPin,
      reason: decision.reason,
    });
    return adapter;
  }

  /**
   * Mint (and cache) a real model-backed runtime BOUND TO A SPECIFIC AGENT id,
   * using the workspace's conversation-role model. This is how a specialist with
   * no explicitly configured adapter still gets a working brain for `agent_task`
   * — its thoughts/tool-calls attribute to the agent because the adapter carries
   * the agent's id. Cached per (agent, profile) so repeated dispatches reuse one
   * instance. Returns undefined only when no model is configured at all.
   */
  resolveForAgent(agentId: string, workspaceId?: string, task?: string | null, explicitModel?: string | null): AgentAdapter | undefined {
    const profile = task
      ? this.routeProfile({ role: 'conversation', workspaceId, task, purpose: 'agent_task', explicitModel }).profile
      : this.profile('conversation', workspaceId);
    if (!profile) return undefined;
    const key = `agent:${agentId}:${profileKey(profile)}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const adapter = new HermesAdapter({
      agentId,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      maxTokens: resolveOrchestratorMaxTokens(),
      logger: this.#logger ?? noopLogger,
    });
    this.#cache.set(key, adapter);
    this.#logger?.info?.('orchestrator.model.agent_runtime_bound', { agentId, model: profile.model });
    return adapter;
  }

  /** A compact snapshot for logging / the `/v1` health surface. */
  describe(): Record<OrchestratorModelRole, string | null> {
    const out = {} as Record<OrchestratorModelRole, string | null>;
    for (const role of ORCHESTRATOR_MODEL_ROLES) {
      out[role] = this.profile(role)?.model ?? null;
    }
    return out;
  }

  describeRouting(workspaceId?: string, task?: string | null): string {
    const decision = task
      ? this.route({ role: 'conversation', workspaceId, task, purpose: 'conversation' })
      : null;
    return renderRuntimeRoutingIntelligence({
      decision,
      availableRuntimes: ORCHESTRATOR_MODEL_ROLES.map((role) => ({
        runtime: `orchestrator:${role}`,
        models: this.profileCandidates(role, workspaceId).map((candidate) => candidate.model),
        affordances: role === 'synthesis' ? ['workflow_synthesis'] : role === 'evaluation' ? ['evaluation'] : ['chat'],
        healthy: this.profile(role, workspaceId) ? true : null,
      })),
    });
  }

  /**
   * Build a router from the environment, preserving the historical fallback
   * chains so existing single-endpoint deployments keep working unchanged:
   *
   *   default      ← AGENTIS_ORCHESTRATOR_* ?? AGENTIS_EVALUATOR_*
   *   conversation ← default
   *   planning     ← AGENTIS_ORCHESTRATOR_PLANNING_MODEL (own base/key or default's)
   *   synthesis    ← WORKFLOW_SYNTHESIS_* ?? default
   *   evaluation   ← AGENTIS_EVALUATOR_* ?? default
   *   vision       ← AGENTIS_BRAIN_VISION_MODEL on the default/eval base
   *   transcription← AGENTIS_BRAIN_TRANSCRIPTION_MODEL on the default/eval base
   */
  static fromEnv(env: OrchestratorEnv, logger?: Logger): OrchestratorModelRouter {
    const evalBase = env.AGENTIS_EVALUATOR_BASE_URL;
    const evalKey = env.AGENTIS_EVALUATOR_API_KEY;
    const evalModel = env.AGENTIS_EVALUATOR_MODEL;

    const defaultBase = env.AGENTIS_ORCHESTRATOR_BASE_URL ?? evalBase;
    const defaultKey = env.AGENTIS_ORCHESTRATOR_API_KEY ?? evalKey;
    const defaultModel = env.AGENTIS_ORCHESTRATOR_MODEL ?? evalModel;

    const mk = (
      base: string | undefined,
      model: string | undefined,
      key: string | undefined,
    ): ModelProfile | null => (base && model ? { baseUrl: base, model, ...(key ? { apiKey: key } : {}) } : null);

    const defaultProfile = mk(defaultBase, defaultModel, defaultKey);

    const roles: Partial<Record<OrchestratorModelRole, ModelProfile | null>> = {
      conversation: defaultProfile,
      planning: mk(
        env.AGENTIS_ORCHESTRATOR_PLANNING_BASE_URL ?? defaultBase,
        env.AGENTIS_ORCHESTRATOR_PLANNING_MODEL ?? undefined,
        env.AGENTIS_ORCHESTRATOR_PLANNING_API_KEY ?? defaultKey,
      ),
      synthesis: mk(
        env.WORKFLOW_SYNTHESIS_BASE_URL ?? defaultBase,
        env.WORKFLOW_SYNTHESIS_MODEL ?? undefined,
        env.WORKFLOW_SYNTHESIS_API_KEY ?? defaultKey,
      ),
      evaluation: mk(evalBase, evalModel, evalKey),
      vision: mk(evalBase ?? defaultBase, env.AGENTIS_BRAIN_VISION_MODEL ?? undefined, evalKey ?? defaultKey),
      transcription: mk(
        evalBase ?? defaultBase,
        env.AGENTIS_BRAIN_TRANSCRIPTION_MODEL ?? undefined,
        evalKey ?? defaultKey,
      ),
    };

    const config: OrchestratorModelRouterConfig = { roles, default: defaultProfile };
    if (logger) config.logger = logger;
    return new OrchestratorModelRouter(config);
  }
}

/** The subset of env vars the router reads. Kept structural for easy testing. */
export interface OrchestratorEnv {
  AGENTIS_ORCHESTRATOR_BASE_URL?: string | undefined;
  AGENTIS_ORCHESTRATOR_API_KEY?: string | undefined;
  AGENTIS_ORCHESTRATOR_MODEL?: string | undefined;
  AGENTIS_ORCHESTRATOR_PLANNING_BASE_URL?: string | undefined;
  AGENTIS_ORCHESTRATOR_PLANNING_API_KEY?: string | undefined;
  AGENTIS_ORCHESTRATOR_PLANNING_MODEL?: string | undefined;
  WORKFLOW_SYNTHESIS_BASE_URL?: string | undefined;
  WORKFLOW_SYNTHESIS_API_KEY?: string | undefined;
  WORKFLOW_SYNTHESIS_MODEL?: string | undefined;
  AGENTIS_EVALUATOR_BASE_URL?: string | undefined;
  AGENTIS_EVALUATOR_API_KEY?: string | undefined;
  AGENTIS_EVALUATOR_MODEL?: string | undefined;
  AGENTIS_BRAIN_VISION_MODEL?: string | undefined;
  AGENTIS_BRAIN_TRANSCRIPTION_MODEL?: string | undefined;
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;
