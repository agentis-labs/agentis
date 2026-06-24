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
    expect(decision.selectedModel).toBe('claude-sonnet-4-6');
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
