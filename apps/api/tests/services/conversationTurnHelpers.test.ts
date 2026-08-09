import { describe, expect, it } from 'vitest';
import { createStreamedChatMetadata, finalizeTurnTrace } from '../../src/services/conversation/conversationTurnHelpers.js';

describe('conversation turn verdicts', () => {
  it('persists an operator cancellation as interrupted rather than failed', () => {
    const metadata = createStreamedChatMetadata('turn-1', '2026-08-08T00:00:00.000Z');
    finalizeTurnTrace(metadata, 'interrupted', '2026-08-08T00:00:02.000Z', 2_000);

    expect(metadata.turn).toMatchObject({
      finishReason: 'interrupted',
      status: 'interrupted',
      durationMs: 2_000,
    });
  });
});
