/**
 * WorkspaceEvaluatorRuntimeFactory — per-workspace synthesis/evaluation (§4.4).
 */
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { OrchestratorModelRouter } from '../../src/services/orchestratorModelRouter.js';
import { WorkspaceEvaluatorRuntimeFactory } from '../../src/services/workspaceEvaluatorRuntimeFactory.js';

const logger = createLogger({ level: 'error' });

describe('WorkspaceEvaluatorRuntimeFactory', () => {
  it('returns undefined when no model is configured', () => {
    const router = OrchestratorModelRouter.fromEnv({});
    const factory = new WorkspaceEvaluatorRuntimeFactory({ router, logger });
    expect(factory.for('ws-1', 'synthesis')).toBeUndefined();
  });

  it('builds a runtime from the env default and caches by profile', () => {
    const router = OrchestratorModelRouter.fromEnv({
      WORKFLOW_SYNTHESIS_BASE_URL: 'https://synth.example.com/v1',
      WORKFLOW_SYNTHESIS_MODEL: 'gpt-4o-mini',
    });
    const factory = new WorkspaceEvaluatorRuntimeFactory({ router, logger });
    const a = factory.for('ws-1', 'synthesis');
    const b = factory.for('ws-2', 'synthesis');
    expect(a).toBeDefined();
    // No override → same env profile → same cached instance across workspaces.
    expect(a).toBe(b);
  });

  it('gives a distinct runtime when a workspace overrides the model', () => {
    const router = OrchestratorModelRouter.fromEnv({
      WORKFLOW_SYNTHESIS_BASE_URL: 'https://synth.example.com/v1',
      WORKFLOW_SYNTHESIS_MODEL: 'gpt-4o-mini',
    });
    router.setConfigProvider((workspaceId, role) =>
      workspaceId === 'ws-1' && role === 'synthesis' ? { model: 'claude-opus-4-8' } : null);
    const factory = new WorkspaceEvaluatorRuntimeFactory({ router, logger });
    expect(factory.for('ws-1', 'synthesis')).not.toBe(factory.for('ws-2', 'synthesis'));
  });
});
