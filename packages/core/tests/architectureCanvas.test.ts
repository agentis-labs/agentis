import { describe, expect, it } from 'vitest';
import { normalizeAgentPlanText } from '../src/architectureCanvas.js';

describe('normalizeAgentPlanText', () => {
  it('keeps readable plan markdown and removes the legacy canvas protocol', () => {
    const text = `Here is the plan.

<proposed_plan>
## Build
1. Fetch the news.
2. Email the digest.
</proposed_plan>

<architecture_canvas>{"kind":"app","nodes":[{"id":"fetch"}]}</architecture_canvas>

Tell me the recipient.`;

    expect(normalizeAgentPlanText(text)).toBe(`Here is the plan.

## Build
1. Fetch the news.
2. Email the digest.

Tell me the recipient.`);
  });

  it('hides an incomplete architecture block while a response is streaming', () => {
    expect(normalizeAgentPlanText(`
<proposed_plan>
1. Inspect
2. Build
</proposed_plan>
<architecture_canvas>{"kind":"app"`)).toBe('1. Inspect\n2. Build');
  });

  it('leaves ordinary chat messages unchanged', () => {
    expect(normalizeAgentPlanText('A normal answer.')).toBe('A normal answer.');
  });
});
