/**
 * Capability-aware self-heal (AGENT-WORKFLOW-CAPABILITY-10X E4). A missing
 * capability/provider/tool/binary must escalate honestly, not trigger an LLM
 * replan that pointlessly swaps the agent/model. The classifier is high-precision:
 * it matches only the platform's explicit "not configured/wired/available" /
 * "requires <binary>" phrasings, so genuine structural failures still get repaired.
 */
import { describe, it, expect } from 'vitest';
import { capabilityGapReason } from '../../src/engine/WorkflowEngine.js';

describe('capabilityGapReason', () => {
  it('flags missing providers / unwired tools / missing binaries as capability gaps', () => {
    for (const err of [
      'web_search provider is not configured',
      'call_workflow is not wired in this runtime',
      'workflow actions are not enabled in this runtime',
      'tool actions are not enabled in this runtime',
      'code (python) requires a python interpreter on PATH: spawn python ENOENT',
    ]) {
      expect(capabilityGapReason(err), err).not.toBeNull();
    }
  });

  it('does NOT flag genuine structural / data / contract failures', () => {
    for (const err of [
      "Node 'prospect-search' failed: inputs is not defined",
      'declared output key "candidates" missing from agent output',
      'Cannot read properties of undefined (reading "map")',
      'claude_code exited 1',
      'Workflow graph contains a cycle',
    ]) {
      expect(capabilityGapReason(err), err).toBeNull();
    }
  });
});
