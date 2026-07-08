/**
 * OrchestratorModelRouter — per-role model selection (OMNICHANNEL §4.4).
 *
 * Pure unit test: HermesAdapter makes no network call at construction, so we can
 * assert profile resolution, the single-model-for-everything fallback, per-role
 * overrides, and adapter caching without any I/O.
 */

import { describe, expect, it } from 'vitest';
import {
  OrchestratorModelRouter,
  type OrchestratorEnv,
} from '../../src/services/orchestrator/orchestratorModelRouter.js';

describe('OrchestratorModelRouter', () => {
  it('is disabled and resolves nothing when no model is configured', () => {
    const router = OrchestratorModelRouter.fromEnv({});
    expect(router.enabled).toBe(false);
    expect(router.resolve('conversation')).toBeUndefined();
    expect(router.resolve('planning')).toBeUndefined();
    expect(router.profile('conversation')).toBeNull();
  });

  it('single high model for everything: only the default profile is set', () => {
    const env: OrchestratorEnv = {
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_API_KEY: 'k',
      AGENTIS_ORCHESTRATOR_MODEL: 'claude-opus-4-8',
    };
    const router = OrchestratorModelRouter.fromEnv(env);
    expect(router.enabled).toBe(true);
    // Every role lands on the one high model.
    for (const role of ['conversation', 'planning', 'synthesis', 'evaluation', 'vision', 'transcription'] as const) {
      expect(router.profile(role)?.model).toBe('claude-opus-4-8');
    }
    // ...and they share a single adapter instance (cached by profile).
    expect(router.resolve('conversation')).toBe(router.resolve('planning'));
    expect(router.resolve('conversation')).toBe(router.resolve('synthesis'));
  });

  it('routes an env default flagship down to balanced for unpinned simple text', () => {
    const router = OrchestratorModelRouter.fromEnv({
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_API_KEY: 'k',
      AGENTIS_ORCHESTRATOR_MODEL: 'claude-opus-4-8',
    });

    const routed = router.routeProfile({
      role: 'conversation',
      task: 'Write a short welcome email.',
      purpose: 'conversation',
    });

    expect(router.profile('conversation')?.model).toBe('claude-opus-4-8');
    expect(routed.profile?.model).toBe('claude-sonnet-5');
    expect(routed.decision.explicitPin).toBe(false);
    expect(routed.decision.modelTier).toBe('balanced');
    expect(routed.decision.alternatives.some((alt) => alt.model === 'claude-opus-4-8')).toBe(true);
  });

  it('keeps an explicit route pin even when the task is simple', () => {
    const router = OrchestratorModelRouter.fromEnv({
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_MODEL: 'claude-sonnet-4-6',
    });

    const routed = router.routeProfile({
      role: 'conversation',
      task: 'Write a short welcome email.',
      purpose: 'conversation',
      explicitModel: 'claude-opus-4-8',
    });

    expect(routed.profile?.model).toBe('claude-opus-4-8');
    expect(routed.decision.explicitPin).toBe(true);
    expect(routed.decision.source).toBe('explicit_pin');
  });

  it('binds inherited agent runtimes with an explicit model pin when provided', async () => {
    const router = OrchestratorModelRouter.fromEnv({
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_MODEL: 'claude-opus-4-8',
    });

    const adapter = router.resolveForAgent('agent_1', 'ws_1', 'Write a short welcome email.', 'claude-opus-4-8');
    const context = await adapter?.getRuntimeContext?.();

    expect(context?.currentModel).toBe('claude-opus-4-8');
  });

  it('binds inherited agent runtimes to balanced candidates when unpinned', async () => {
    const router = OrchestratorModelRouter.fromEnv({
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_MODEL: 'claude-opus-4-8',
    });

    const adapter = router.resolveForAgent('agent_1', 'ws_1', 'Write a short welcome email.');
    const context = await adapter?.getRuntimeContext?.();

    expect(context?.currentModel).toBe('claude-sonnet-5');
  });

  it('per-role override: planning and synthesis target different models', () => {
    const env: OrchestratorEnv = {
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_MODEL: 'claude-haiku-4-5',
      AGENTIS_ORCHESTRATOR_PLANNING_MODEL: 'claude-opus-4-8',
      WORKFLOW_SYNTHESIS_BASE_URL: 'https://synth.example.com',
      WORKFLOW_SYNTHESIS_MODEL: 'gpt-4o-mini',
    };
    const router = OrchestratorModelRouter.fromEnv(env);
    expect(router.profile('conversation')?.model).toBe('claude-haiku-4-5');
    expect(router.profile('planning')?.model).toBe('claude-opus-4-8');
    // Planning inherits the default base URL since it set only a model.
    expect(router.profile('planning')?.baseUrl).toBe('https://api.example.com');
    expect(router.profile('synthesis')?.model).toBe('gpt-4o-mini');
    expect(router.profile('synthesis')?.baseUrl).toBe('https://synth.example.com');

    // Distinct profiles → distinct adapter instances.
    expect(router.resolve('conversation')).not.toBe(router.resolve('planning'));
    expect(router.resolve('planning')).not.toBe(router.resolve('synthesis'));
  });

  it('legacy fallback: orchestrator model inherits the evaluator endpoint', () => {
    const env: OrchestratorEnv = {
      AGENTIS_EVALUATOR_BASE_URL: 'https://eval.example.com',
      AGENTIS_EVALUATOR_API_KEY: 'ek',
      AGENTIS_EVALUATOR_MODEL: 'gpt-4o-mini',
    };
    const router = OrchestratorModelRouter.fromEnv(env);
    expect(router.enabled).toBe(true);
    expect(router.profile('conversation')).toEqual({
      baseUrl: 'https://eval.example.com',
      model: 'gpt-4o-mini',
      apiKey: 'ek',
    });
    expect(router.profile('evaluation')?.model).toBe('gpt-4o-mini');
  });

  it('per-workspace override wins and inherits the env base URL / key', () => {
    const router = OrchestratorModelRouter.fromEnv({
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_API_KEY: 'env-key',
      AGENTIS_ORCHESTRATOR_MODEL: 'env-default',
    });
    router.setConfigProvider((workspaceId, role) =>
      workspaceId === 'ws-1' && role === 'conversation' ? { model: 'claude-opus-4-8' } : null);

    // No workspace → env default.
    expect(router.profile('conversation')?.model).toBe('env-default');
    // Workspace with an override → override model, env base/key merged in.
    expect(router.profile('conversation', 'ws-1')).toEqual({
      baseUrl: 'https://api.example.com',
      model: 'claude-opus-4-8',
      apiKey: 'env-key',
    });
    // A different workspace (no override) → env default.
    expect(router.profile('conversation', 'ws-2')?.model).toBe('env-default');
    // Distinct resolved adapters for distinct effective profiles.
    expect(router.resolve('conversation', 'ws-1')).not.toBe(router.resolve('conversation', 'ws-2'));
  });

  it('per-workspace conversation model becomes the default for every role', () => {
    // No env config at all — the workspace only sets its conversation model.
    const router = OrchestratorModelRouter.fromEnv({});
    router.setConfigProvider((workspaceId, role) =>
      workspaceId === 'ws-1' && role === 'conversation'
        ? { model: 'gpt-5.4-mini', baseUrl: 'https://api.example.com/v1', apiKey: 'k' }
        : null);

    // Conversation resolves to the override...
    expect(router.profile('conversation', 'ws-1')?.model).toBe('gpt-5.4-mini');
    // ...and so do synthesis / planning / evaluation (the build path!) — they
    // inherit the workspace's chosen orchestrator model instead of going null.
    for (const role of ['synthesis', 'planning', 'evaluation', 'vision'] as const) {
      expect(router.profile(role, 'ws-1')).toEqual({
        baseUrl: 'https://api.example.com/v1', model: 'gpt-5.4-mini', apiKey: 'k',
      });
    }
    // A different workspace with no config still resolves nothing.
    expect(router.profile('synthesis', 'ws-2')).toBeNull();
  });

  it('treats a workspace conversation model as a routing candidate for other roles', () => {
    const router = OrchestratorModelRouter.fromEnv({});
    router.setConfigProvider((workspaceId, role) =>
      workspaceId === 'ws-1' && role === 'conversation'
        ? { model: 'claude-opus-4-8', baseUrl: 'https://api.example.com/v1', apiKey: 'k' }
        : null);

    const routed = router.routeProfile({
      role: 'synthesis',
      workspaceId: 'ws-1',
      task: 'Build a simple workflow that formats incoming text.',
      purpose: 'workflow_synthesis',
    });

    expect(router.profile('synthesis', 'ws-1')?.model).toBe('claude-opus-4-8');
    expect(routed.profile).toEqual({
      baseUrl: 'https://api.example.com/v1',
      model: 'claude-sonnet-5',
      apiKey: 'k',
    });
    expect(routed.decision.explicitPin).toBe(false);
  });

  it('an explicit env role profile beats the per-workspace conversation default', () => {
    const router = OrchestratorModelRouter.fromEnv({
      WORKFLOW_SYNTHESIS_BASE_URL: 'https://synth.example.com/v1',
      WORKFLOW_SYNTHESIS_MODEL: 'synth-model',
    });
    router.setConfigProvider((_ws, role) =>
      role === 'conversation' ? { model: 'conv-model', baseUrl: 'https://c/v1' } : null);
    // synthesis has an explicit env profile → it wins over the conversation default.
    expect(router.profile('synthesis', 'ws-1')?.model).toBe('synth-model');
    // planning has no env profile → falls back to the conversation default.
    expect(router.profile('planning', 'ws-1')?.model).toBe('conv-model');
  });

  it('an override may carry its own base URL + key', () => {
    const router = OrchestratorModelRouter.fromEnv({
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_MODEL: 'env-default',
    });
    router.setConfigProvider(() => ({ model: 'gpt-4o', baseUrl: 'https://oai.example.com/v1', apiKey: 'sk-x' }));
    expect(router.profile('planning', 'ws-1')).toEqual({
      baseUrl: 'https://oai.example.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-x',
    });
  });

  it('describe() reports the model bound to each role', () => {
    const router = OrchestratorModelRouter.fromEnv({
      AGENTIS_ORCHESTRATOR_BASE_URL: 'https://api.example.com',
      AGENTIS_ORCHESTRATOR_MODEL: 'm-default',
      AGENTIS_ORCHESTRATOR_PLANNING_MODEL: 'm-planning',
    });
    const described = router.describe();
    expect(described.conversation).toBe('m-default');
    expect(described.planning).toBe('m-planning');
    expect(described.evaluation).toBe('m-default');
  });
});
