import { describe, it, expect } from 'vitest';
import { SYNTHESIS_SYSTEM_PROMPT } from '../../src/services/agentisToolHandlers/build.js';
import { SUPPORTED_NODE_KINDS } from '../../src/engine/validateGraph.js';

/**
 * Contract-drift guard (Workstream D). The synthesis prompt is what the model is
 * told it may emit; `SUPPORTED_NODE_KINDS` is what the validator accepts. If the
 * catalog ever teaches a kind the validator rejects, every workflow that uses it
 * hard-fails — so the two MUST stay reconciled. This test makes the validator the
 * single source of truth: every `kind: "X"` mentioned anywhere in the prompt
 * (per-kind config shapes AND the worked examples) must be supported.
 */
describe('synthesis catalog ↔ validator contract', () => {
  it('every node kind taught in the synthesis prompt is accepted by the validator', () => {
    // Nested config discriminators that are NOT top-level node kinds (and so are
    // not in SUPPORTED_NODE_KINDS): the persistent_listener source kind.
    const NON_NODE_KINDS = new Set(['extension']);
    const mentioned = new Set<string>();
    for (const match of SYNTHESIS_SYSTEM_PROMPT.matchAll(/"kind"\s*:\s*"([a-z_]+)"|kind:\s*"([a-z_]+)"/g)) {
      const kind = match[1] ?? match[2];
      if (kind && !NON_NODE_KINDS.has(kind)) mentioned.add(kind);
    }
    // Sanity: the regex actually found kinds (guards against a format change
    // silently making this test vacuous).
    expect(mentioned.size).toBeGreaterThan(8);

    const unsupported = [...mentioned].filter((kind) => !SUPPORTED_NODE_KINDS.has(kind));
    expect(unsupported).toEqual([]);
  });

  it('does NOT advertise the deprecated knowledge_ingest or a separate agent_session kind', () => {
    expect(SYNTHESIS_SYSTEM_PROMPT).not.toContain('"kind": "knowledge_ingest"');
    expect(SYNTHESIS_SYSTEM_PROMPT).not.toContain('kind: "knowledge_ingest"');
    expect(SYNTHESIS_SYSTEM_PROMPT).not.toContain('kind: "agent_session"');
  });
});
