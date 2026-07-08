/**
 * WorkspaceEvaluatorRuntimeFactory — per-workspace EvaluatorRuntime resolution
 * (OMNICHANNEL-ORCHESTRATOR-10X §4.4).
 *
 * The synthesis / evaluation roles are served by `EvaluatorRuntime`, whose
 * constructor takes exactly the model router's profile shape `{ baseUrl, model,
 * apiKey }`. This factory resolves the effective profile for a (workspace, role)
 * via the router — honoring per-workspace model overrides — and returns a cached
 * `EvaluatorRuntime` for it. Returns undefined when no model is configured, so
 * callers keep their existing env-default fallback.
 */

import { EvaluatorRuntime } from '../evaluatorRuntime.js';
import type { OrchestratorModelRouter, OrchestratorModelRole } from '../orchestrator/orchestratorModelRouter.js';
import type { Logger } from '../../logger.js';

export class WorkspaceEvaluatorRuntimeFactory {
  readonly #cache = new Map<string, EvaluatorRuntime>();

  constructor(private readonly deps: { router: OrchestratorModelRouter; logger: Logger }) {}

  /** The EvaluatorRuntime for a workspace+role, or undefined when unconfigured. */
  for(workspaceId: string, role: OrchestratorModelRole): EvaluatorRuntime | undefined {
    const profile = this.deps.router.profile(role, workspaceId);
    return this.#runtimeForProfile(profile);
  }

  /** Task-aware runtime resolution. Defaults/env/workspace models become candidates. */
  forTask(
    workspaceId: string,
    role: OrchestratorModelRole,
    task: string,
    purpose?: string,
    explicitModel?: string | null,
  ): EvaluatorRuntime | undefined {
    const { profile, decision } = this.deps.router.routeProfile({
      role,
      workspaceId,
      task,
      purpose: purpose ?? role,
      explicitModel,
    });
    this.deps.logger.debug?.('workspace_evaluator_runtime.routed', {
      workspaceId,
      role,
      selectedModel: decision.selectedModel,
      taskClass: decision.taskClass,
      explicitPin: decision.explicitPin,
      reason: decision.reason,
    });
    return this.#runtimeForProfile(profile);
  }

  #runtimeForProfile(profile: ReturnType<OrchestratorModelRouter['profile']>): EvaluatorRuntime | undefined {
    if (!profile) return undefined;
    const key = `${profile.baseUrl}|${profile.model}|${profile.apiKey ?? ''}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const runtime = new EvaluatorRuntime({
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      logger: this.deps.logger,
    });
    this.#cache.set(key, runtime);
    return runtime;
  }
}
