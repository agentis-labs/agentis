import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { EvaluatorRuntime } from '../../src/services/evaluatorRuntime.js';
import { StructuredEvaluatorRuntime } from '../../src/services/structuredEvaluatorRuntime.js';
import type { StructuredCompleter } from '../../src/services/structuredCompleter.js';

describe('StructuredEvaluatorRuntime', () => {
  it('treats a canceled structured completion as a runtime failure, not a failed quality verdict', async () => {
    const completer: StructuredCompleter = {
      label: 'agent:orchestrator',
      lastError: 'Codex request was canceled',
      async completeStructured() {
        return null;
      },
    };
    const evaluator = new StructuredEvaluatorRuntime(completer, createLogger({ level: 'error' }));

    await expect(evaluator.evaluate({
      workspaceId: 'workspace-1',
      target: { digest: 'hello' },
      criteria: 'must be useful',
    })).rejects.toThrow('evaluator runtime did not produce a valid verdict: Codex request was canceled');
  });

  it('treats a malformed HTTP judge response as a runtime failure too', async () => {
    const evaluator = new EvaluatorRuntime({
      baseUrl: 'https://judge.example.test/v1',
      model: 'test-judge',
      logger: createLogger({ level: 'error' }),
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: 'not valid JSON' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    await expect(evaluator.evaluate({
      workspaceId: 'workspace-1',
      target: { digest: 'hello' },
      criteria: 'must be useful',
    })).rejects.toThrow('evaluator runtime did not produce a valid verdict');
  });
});
