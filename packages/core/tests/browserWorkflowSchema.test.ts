import { describe, expect, it } from 'vitest';
import { workflowNodeSchema } from '../src/schemas/workflow.js';

describe('browser workflow schema parity', () => {
  it('accepts the session operation already supported by the runtime type and executor', () => {
    const parsed = workflowNodeSchema.safeParse({
      id: 'browser-session',
      config: {
        kind: 'browser',
        operation: 'session',
        sessionAction: 'open',
        sessionId: 'collector',
        sessionArgs: { url: 'https://example.com' },
      },
    });
    expect(parsed.success).toBe(true);
  });
});
