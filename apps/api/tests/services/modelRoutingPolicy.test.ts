import { describe, expect, it } from 'vitest';
import {
  inferModelTierFromId,
  routeModelForTask,
} from '../../src/services/modelRoutingPolicy.js';

describe('modelRoutingPolicy', () => {
  it('routes simple Claude text work to balanced Sonnet instead of Opus', () => {
    const decision = routeModelForTask({
      task: 'Write a short friendly product update email.',
      purpose: 'conversation',
      runtime: 'claude_code',
      currentModel: 'claude-opus-4-8',
    });

    expect(decision.taskClass).toBe('simple_text');
    // Reconciled to the policy's current balanced-tier Claude id (source
    // upgraded claude-sonnet-4-6 → claude-sonnet-5; the test had gone stale).
    expect(decision.selectedModel).toBe('claude-sonnet-5');
    expect(decision.modelTier).toBe('balanced');
    expect(decision.explicitPin).toBe(false);
    expect(decision.alternatives.some((alt) => alt.model === 'claude-opus-4-8')).toBe(true);
  });

  it('preserves explicit model pins even for simple tasks', () => {
    const decision = routeModelForTask({
      task: 'Write a short friendly product update email.',
      purpose: 'conversation',
      runtime: 'claude_code',
      explicitModel: 'claude-opus-4-8',
    });

    expect(decision.selectedModel).toBe('claude-opus-4-8');
    expect(decision.modelTier).toBe('flagship');
    expect(decision.explicitPin).toBe(true);
    expect(decision.source).toBe('explicit_pin');
  });

  it('routes a coding task to a code-specialized model instead of the general flagship', () => {
    const decision = routeModelForTask({
      task: 'Refactor the auth module and fix the failing unit tests in the typescript codebase.',
      purpose: 'agent_task',
      runtime: 'codex',
      currentModel: 'gpt-5.5',
    });

    expect(decision.selectedModel).toContain('codex');
    expect(decision.selectedModel).not.toBe('gpt-5.5');
    expect(decision.reason.toLowerCase()).toContain('code');
    expect(decision.alternatives.some((alt) => alt.model === 'gpt-5.5')).toBe(true);
  });

  it('prefers a code model when the task declares code capability tags', () => {
    const decision = routeModelForTask({
      task: 'Implement the feature.',
      purpose: 'agent_task',
      runtime: 'openai',
      currentModel: 'gpt-5.5',
      requiredAffordances: ['coding', 'fileSystem'],
    });

    expect(decision.selectedModel).toContain('codex');
  });

  it('does NOT divert non-code work to a code model (capability is task-driven)', () => {
    const decision = routeModelForTask({
      task: 'Write a friendly announcement about our new pricing.',
      purpose: 'conversation',
      runtime: 'openai',
      currentModel: 'gpt-5.5',
    });

    expect(decision.selectedModel).not.toContain('codex');
  });

  it('keeps unknown custom models selectable with safe balanced metadata', () => {
    const decision = routeModelForTask({
      task: 'Write a concise announcement.',
      purpose: 'conversation',
      runtime: 'http',
      explicitModel: 'acme-internal-writer-v7',
    });

    expect(decision.selectedModel).toBe('acme-internal-writer-v7');
    expect(decision.modelTier).toBe('balanced');
    expect(decision.explicitPin).toBe(true);
    expect(inferModelTierFromId('acme-internal-writer-v7')).toBe('balanced');
  });
});
