import { describe, expect, it } from 'vitest';
import { captureChatDeltaMetadata, createStreamedChatMetadata, explainRuntimeFailure, finalizeTurnTrace } from '../../src/services/conversation/conversationTurnHelpers.js';

describe('conversation turn verdicts', () => {
  it('turns an exhausted provider balance into an actionable chat failure', () => {
    expect(explainRuntimeFailure('HTTP 402: insufficient credits')).toMatch(/out of credits or quota/i);
  });

  it('persists an operator cancellation as interrupted rather than failed', () => {
    const metadata = createStreamedChatMetadata('turn-1', '2026-08-08T00:00:00.000Z');
    finalizeTurnTrace(metadata, 'interrupted', '2026-08-08T00:00:02.000Z', 2_000);

    expect(metadata.turn).toMatchObject({
      finishReason: 'interrupted',
      status: 'interrupted',
      durationMs: 2_000,
    });
  });

  it('updates progressive commentary in place and removes its provisional row on promotion', () => {
    const metadata = createStreamedChatMetadata('turn-1', '2026-08-08T00:00:00.000Z');
    captureChatDeltaMetadata(metadata, {
      type: 'commentary',
      id: 'progress-1',
      text: 'I found the workflow.',
      source: 'assistant_preamble',
      createdAt: '2026-08-08T00:00:01.000Z',
    });
    captureChatDeltaMetadata(metadata, {
      type: 'commentary',
      id: 'progress-1',
      text: 'I found the workflow. I am loading its repair capability.',
      source: 'assistant_preamble',
      createdAt: '2026-08-08T00:00:02.000Z',
    });

    expect(metadata.commentary).toHaveLength(1);
    expect(metadata.commentary[0]?.text).toContain('repair capability');

    captureChatDeltaMetadata(metadata, {
      type: 'commentary',
      id: 'progress-1',
      text: '',
      source: 'assistant_preamble',
      createdAt: '2026-08-08T00:00:03.000Z',
    });
    expect(metadata.commentary).toEqual([]);
  });
});
