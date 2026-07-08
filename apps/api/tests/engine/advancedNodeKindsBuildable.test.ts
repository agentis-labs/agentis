/**
 * Guards that the advanced multi-agent node kinds — `planner`, `agent_swarm`,
 * `dynamic_swarm` — stay AGENT-BUILDABLE end to end. They were suspected of being
 * "forward-built but unreachable", but they are actually wired the whole way:
 *   1. documented with full grammar in the workflow-architect prompt (so the
 *      author agent knows how to emit them),
 *   2. present in `SUPPORTED_NODE_KINDS` (so `validateWorkflowGraph` accepts a
 *      graph that contains them at every entry point), and
 *   3. dispatched by real handlers in the engine.
 * This test locks (1) and (2) so a future refactor can't silently drop them from
 * the grammar or the allowlist and quietly make them un-buildable again.
 */
import { describe, expect, it } from 'vitest';
import { SUPPORTED_NODE_KINDS } from '../../src/engine/validateGraph.js';
import { SYNTHESIS_SYSTEM_PROMPT } from '../../src/services/agentisToolHandlers/build.js';

const ADVANCED_AGENT_KINDS = ['planner', 'agent_swarm', 'dynamic_swarm'] as const;

describe('advanced multi-agent node kinds are agent-buildable', () => {
  it('are in the run allowlist (validateWorkflowGraph accepts them)', () => {
    for (const kind of ADVANCED_AGENT_KINDS) {
      expect(SUPPORTED_NODE_KINDS.has(kind)).toBe(true);
    }
  });

  it('are documented with grammar in the workflow-architect prompt', () => {
    const prompt = SYNTHESIS_SYSTEM_PROMPT;
    for (const kind of ADVANCED_AGENT_KINDS) {
      expect(prompt).toContain(`kind: "${kind}"`);
    }
  });
});
